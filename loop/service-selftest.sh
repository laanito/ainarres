#!/usr/bin/env bash
# loop/service-selftest.sh — M25's done-test (design/service.md): drive the STANDING
# SERVICE deterministically through its lifecycle with the MOCK harness, asserting:
#   1. IDLE on an empty board — it spawns nothing and creates no work;
#   2. WAKE + DRAIN — work inserted mid-idle wakes it; it drains to `done` and idles again;
#   3. SECOND ACTIVATION with NO RESTART — a second batch is a second activation, SAME pid;
#   4. THE INTAKE BRIDGE (v8 step 1) — an UNREFINED brief is left alone (the human intaker's
#      step: the service burns one activation, makes no progress, and holds `stalled` rather
#      than spinning); once refined to `briefed`, the standing designer accepts it, the dev
#      tasks it decomposes into appear, and the board drains;
#   5. CONSUME GOVERNANCE — a temp-banned family is skipped, the board still drains;
#   6. GRACEFUL STOP — SIGTERM halts it cleanly (exit 0), status → `stopped`.
#
# Run via `make service-selftest` (which loop-resets first) with LOOP_MODE=mock. It does
# NOT do real git/gh — the mock harness records references only (the loop substrate is a
# coordination board). It targets the isolated LOOP substrate (M13), never the test one.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
cd "$REPO"

# shellcheck disable=SC1090,SC1091
source "$REPO/loop.env"
export AINARRES_BASE_URL JWT_SECRET
source "$HERE/roles.sh"

export LOOP_MODE=mock
export LOOP_IDLE_POLL_SECS="${LOOP_IDLE_POLL_SECS:-1}"   # snappy polling for the test
export LOOP_MOCK_TASKS="${LOOP_MOCK_TASKS:-3}"

AINARRES=(node "$REPO/bin/ainarres.mjs")
ai() { "${AINARRES[@]}" "$@"; }
OVERSIGHT_TOKEN="$(mint_token oversight)"
DESIGNER_TOKEN="$(mint_token designer)"

# Source the shared lib so we can unit-check skip_if_banned's matching logic directly
# (Phase 0), independent of the live service.
# shellcheck disable=SC1090,SC1091
source "$HERE/driver-lib.sh"

# psql into the LOOP substrate (for seeding a governance ban in the skip test). Mirrors
# the Makefile's COMPOSE_LOOP. Not a harness sweep, so guard-bin doesn't apply here.
loop_psql() { docker compose -p ainarres-loop --env-file "$REPO/loop.env" exec -T db psql -v ON_ERROR_STOP=1 -U postgres -d ainarres "$@"; }

STATUS="$RUN_DIR/service.status"
SVC_LOG="$RUN_DIR/service-selftest.svc.log"
mkdir -p "$RUN_DIR"
rm -f "$STATUS"

SVC_PID=""
cleanup() { [ -n "$SVC_PID" ] && kill -KILL "$SVC_PID" 2>/dev/null || true; }
trap cleanup EXIT
fail() { echo "✗ service-selftest: $*" >&2; echo "── last 30 service log lines ──" >&2; tail -30 "$SVC_LOG" >&2 2>/dev/null || true; exit 1; }
pass() { echo "  ✓ $*"; }

# ── small JSON readers ────────────────────────────────────────────────────────
board_json() { ai board --lane dev --token "$OVERSIGHT_TOKEN" 2>/dev/null; }
n_active()   { board_json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let r;try{r=JSON.parse(s)}catch{r=[]}if(!Array.isArray(r))r=[];process.stdout.write(String(r.filter(x=>!x.is_terminal&&!x.blocked).length))})'; }
n_total()    { board_json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let r;try{r=JSON.parse(s)}catch{r=[]}if(!Array.isArray(r))r=[];process.stdout.write(String(r.length))})'; }
n_terminal() { board_json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let r;try{r=JSON.parse(s)}catch{r=[]}if(!Array.isArray(r))r=[];process.stdout.write(String(r.filter(x=>x.is_terminal).length))})'; }
jget()       { node -e 'const p=process.argv[1].split(".");let v=JSON.parse(require("fs").readFileSync(0,"utf8"));for(const k of p){v=(v==null)?undefined:v[k]}process.stdout.write(v==null?"":String(v))' "$1"; }
svc_field()  { node -e 'try{const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(j[process.argv[2]]??""))}catch{process.stdout.write("")}' "$STATUS" "$1"; }

# Intake-lane readers (the service now works dev AND intake — roles.sh LOOP_LANES).
intake_json()     { ai board --lane intake --token "$OVERSIGHT_TOKEN" 2>/dev/null; }
intake_stage_of() { intake_json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let r;try{r=JSON.parse(s)}catch{r=[]}if(!Array.isArray(r))r=[];const t=r.find(x=>x.task_id===process.argv[1]);process.stdout.write(t?String(t.stage):"")})' "$1"; }
intake_terminal() { intake_json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let r;try{r=JSON.parse(s)}catch{r=[]}if(!Array.isArray(r))r=[];const t=r.find(x=>x.task_id===process.argv[1]);process.stdout.write(t&&t.is_terminal?"1":"0")})' "$1"; }

# Poll `cond` (a command) up to $1 seconds (0.5s cadence). Returns 0 if it becomes true.
wait_until() {
  local timeout="$1"; shift
  local deadline=$(( $(date +%s) + timeout ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if "$@"; then return 0; fi
    sleep 0.5
  done
  return 1
}
is_state()   { [ "$(svc_field state)" = "$1" ]; }
board_empty(){ [ "$(n_active)" -eq 0 ]; }
board_all_done() { local t; t="$(n_total)"; [ "$t" -gt 0 ] && [ "$(n_terminal)" -eq "$t" ]; }

# Create N trivial dev tasks as the designer (D4: dev-lane create needs role:designer),
# mimicking a decomposition — the work the standing service then drains.
create_tasks() {
  local n="$1" i
  for i in $(seq 1 "$n"); do
    AINARRES_TOKEN="$DESIGNER_TOKEN" node "$REPO/bin/ainarres.mjs" create --lane dev \
      --payload "$(node -e 'process.stdout.write(JSON.stringify({goal:"mock svc task #"+process.argv[1],instructions:"noop",files:[],validate:"true",acceptance:"board drains to done"}))' "$i")" \
      >/dev/null || fail "create task #$i failed"
  done
}

# The intake channel's identity (ADR 0025): a human/external family holding ONLY
# lane:intake + role:intaker. There is no intaker POLLER — refining a brief is the human's
# step, which is precisely what Phase 4 asserts the service leaves alone.
INTAKER_TOKEN="$(ai token --family human+intaker --role agent --features lane:intake,role:intaker \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).token))')"

# Open a brief exactly as the channel does: create it at proposed_brief. Prints its id.
open_brief() {
  ai create --lane intake --token "$INTAKER_TOKEN" \
    --payload '{"request":"selftest: the standing designer should decompose this","submitted_via":"service-selftest"}' \
    | jget task.id
}

# The human intaker's refine step: claim the brief and advance it to `briefed`.
refine_brief() {
  local id="$1" claimed
  claimed="$(ai claim --lane intake --token "$INTAKER_TOKEN" | jget task.id)"
  [ "$claimed" = "$id" ] || fail "intaker claimed '$claimed', expected the brief '$id'"
  ai advance "$id" --to briefed --token "$INTAKER_TOKEN" --note "selftest: refined by the human intaker" >/dev/null \
    || fail "intaker could not advance the brief to briefed"
}

echo "→ service-selftest: substrate=$AINARRES_BASE_URL  poll=${LOOP_IDLE_POLL_SECS}s  mock_tasks=$LOOP_MOCK_TASKS"
[ "$(n_total)" -eq 0 ] || fail "expected a fresh (empty) loop board — run via 'make service-selftest' (it loop-resets first). total=$(n_total)"

# ── Phase 0: skip_if_banned matching logic (pure, no service) ─────────────────
# Set GOV_BANNED by hand and check the family+capability matching directly.
GOV_BANNED="opencode+big-pickle|role:implementer"
skip_if_banned cheap-implementer || fail "skip_if_banned: pool family banned for role:implementer must SKIP"
skip_if_banned qwen-implementer && fail "skip_if_banned: a DIFFERENT family (qwen) must NOT be skipped"
skip_if_banned frontier && fail "skip_if_banned: grok (not banned) must NOT be skipped"
GOV_BANNED="grok+grok-4.6|capability:integrate"
skip_if_banned frontier || fail "skip_if_banned: grok banned for capability:integrate must SKIP the frontier tier"
skip_if_banned frontier-claude-reviewer && fail "skip_if_banned: the claude reviewer (no capability:integrate) must NOT be skipped"
GOV_BANNED=""
skip_if_banned cheap-implementer && fail "skip_if_banned: empty ban set must never skip"
GOV_BANNED=""   # reset for the live service (it manages its own)
pass "Phase 0 — skip_if_banned matches on (family, capability): banned tier skipped, others proceed, empty set never skips"

# ── Start the standing service in the background ──────────────────────────────
bash "$HERE/service.sh" >"$SVC_LOG" 2>&1 &
SVC_PID=$!
echo "→ service-selftest: started service pid=$SVC_PID"

# ── Phase 1: IDLE on an empty board ───────────────────────────────────────────
wait_until 15 is_state idle || fail "service did not reach 'idle' on an empty board (state='$(svc_field state)')"
kill -0 "$SVC_PID" 2>/dev/null || fail "service process died during idle"
[ "$(svc_field pid)" = "$SVC_PID" ] || fail "status pid '$(svc_field pid)' != service pid '$SVC_PID'"
sleep 2   # let a couple more polls pass — an idle service must NOT create work
[ "$(n_total)" -eq 0 ] || fail "idle service created board work (total=$(n_total)) — it must spawn nothing"
[ "$(svc_field activation)" = "0" ] || fail "idle service ran an activation (activation=$(svc_field activation)) on an empty board"
pass "Phase 1 — idles on empty board (no spawn, no work, activation=0)"

# ── Phase 2: WAKE + DRAIN ─────────────────────────────────────────────────────
create_tasks "$LOOP_MOCK_TASKS"
echo "→ service-selftest: inserted $LOOP_MOCK_TASKS task(s) mid-idle — expecting a wake…"
wait_until 20 is_state running || echo "  (note: activation may have completed before we caught 'running' — checking drain)"
wait_until 120 board_all_done || fail "service did not drain the board to done (active=$(n_active), terminal=$(n_terminal)/$(n_total))"
wait_until 15 is_state idle || fail "service did not return to 'idle' after draining (state='$(svc_field state)')"
kill -0 "$SVC_PID" 2>/dev/null || fail "service process died after first drain"
[ "$(svc_field activation)" -ge 1 ] || fail "activation count did not advance (activation=$(svc_field activation))"
pass "Phase 2 — woke, drained $LOOP_MOCK_TASKS task(s) to done, returned to idle (activation=$(svc_field activation))"

# ── Phase 3: SECOND ACTIVATION, NO RESTART ────────────────────────────────────
first_activation="$(svc_field activation)"
create_tasks "$LOOP_MOCK_TASKS"
echo "→ service-selftest: inserted a SECOND batch — expecting a second activation, same process…"
wait_until 120 board_all_done || fail "service did not drain the second batch (active=$(n_active), terminal=$(n_terminal)/$(n_total))"
wait_until 15 is_state idle || fail "service did not return to idle after the second drain"
[ "$(svc_field pid)" = "$SVC_PID" ] || fail "service RESTARTED between features (pid $(svc_field pid) != $SVC_PID) — it must persist"
[ "$(svc_field activation)" -gt "$first_activation" ] || fail "second batch did not trigger a new activation ($(svc_field activation) !> $first_activation)"
pass "Phase 3 — second activation (#$(svc_field activation)) on the SAME process (pid=$SVC_PID), no restart"

# ── Phase 4: THE INTAKE BRIDGE (v8 step 1) ────────────────────────────────────
# 4a — an UNREFINED brief is the human intaker's work, and the substrate keeps it that way:
# proposed_brief→briefed needs role:intaker, which no tier holds, so the designer cannot
# claim it. The service therefore burns exactly ONE activation, makes no progress, and
# holds `stalled` (D3) instead of spinning — quiescent, not busy.
dev_before="$(n_total)"
brief_id="$(open_brief)"
[ -n "$brief_id" ] || fail "could not open a brief on the intake lane"
echo "→ service-selftest: opened brief $brief_id at proposed_brief — expecting the service to LEAVE IT ALONE…"
wait_until 40 is_state stalled \
  || fail "service did not settle into 'stalled' beside an unrefined brief (state='$(svc_field state)')"
[ "$(intake_stage_of "$brief_id")" = "proposed_brief" ] \
  || fail "the unrefined brief moved (stage='$(intake_stage_of "$brief_id")') — refining is the human's step"
[ "$(n_total)" -eq "$dev_before" ] \
  || fail "the service created dev work from an unrefined brief (dev total $(n_total) != $dev_before)"
pass "Phase 4a — left the unrefined brief at proposed_brief, created no dev work, held 'stalled' (no spin)"

# 4b — the human refines it. The board signature changes, so the service resumes: the
# standing designer claims the `briefed` brief, creates the dev tasks, and accepts it LAST.
refine_brief "$brief_id"
echo "→ service-selftest: brief refined to briefed — expecting the designer to accept it and the dev work to drain…"
brief_accepted() { [ "$(intake_terminal "$brief_id")" = "1" ]; }
wait_until 90 brief_accepted \
  || fail "the designer did not accept the refined brief (stage='$(intake_stage_of "$brief_id")')"
[ "$(intake_stage_of "$brief_id")" = "accepted" ] \
  || fail "brief reached a terminal stage that is not 'accepted' (stage='$(intake_stage_of "$brief_id")')"
[ "$(n_total)" -gt "$dev_before" ] \
  || fail "accepting the brief produced no dev tasks (dev total still $dev_before)"
wait_until 120 board_all_done \
  || fail "the dev work from the brief did not drain (active=$(n_active), terminal=$(n_terminal)/$(n_total))"
wait_until 15 is_state idle || fail "service did not return to idle after the intake drain"
pass "Phase 4b — refined brief accepted by the designer, $(( $(n_total) - dev_before )) dev task(s) created and drained to done"

# ── Phase 5: CONSUME GOVERNANCE — skip a temp-banned family (D6) ──────────────
# Temp-ban the pool family (opencode+big-pickle) for role:implementer in the LOOP
# substrate, insert work, and assert the running service SKIPS the pool tier (log line)
# yet still DRAINS — the other (unbanned) implementer tiers pick the work up.
echo "→ service-selftest: temp-banning the pool family (opencode+big-pickle / role:implementer)…"
loop_psql -c "
  insert into app.governance_strikes (family_id, feature_id, strikes, ban_count, first_strike_at, last_strike_at)
  select af.id, f.id, 5, 1, now() - interval '1 day', now()
  from app.agent_families af, app.features f
  where af.key = 'opencode+big-pickle' and f.name = 'role:implementer'
  on conflict (family_id, feature_id) do nothing;
  insert into app.feature_denials (family_id, feature_id, reason, expires_at)
  select af.id, f.id, 'service-selftest temp ban', now() + interval '1 hour'
  from app.agent_families af, app.features f
  where af.key = 'opencode+big-pickle' and f.name = 'role:implementer'
  on conflict (family_id, feature_id) do nothing;
" >/dev/null || fail "could not seed the governance ban"

banned_activation="$(svc_field activation)"
create_tasks "$LOOP_MOCK_TASKS"
echo "→ service-selftest: inserted work under the ban — expecting a pool SKIP + drain via other tiers…"
wait_until 120 board_all_done || fail "board did not drain while the pool family was banned (active=$(n_active), terminal=$(n_terminal)/$(n_total))"
wait_until 15 is_state idle || fail "service did not return to idle after the banned-run drain"
grep -q "SKIP pool tier 'cheap-implementer' — family banned" "$SVC_LOG" \
  || fail "service did not log skipping the temp-banned pool family (expected a SKIP line in $SVC_LOG)"
[ "$(svc_field activation)" -gt "$banned_activation" ] || fail "the banned-run did not trigger a new activation"
# Clear the ban so it doesn't linger.
loop_psql -c "
  delete from app.feature_denials where family_id = (select id from app.agent_families where key='opencode+big-pickle') and feature_id = (select id from app.features where name='role:implementer');
  delete from app.governance_strikes where family_id = (select id from app.agent_families where key='opencode+big-pickle') and feature_id = (select id from app.features where name='role:implementer');
" >/dev/null || true
pass "Phase 5 — consumed governance: SKIPPED the temp-banned pool family, drained via the other tiers"

# ── Phase 6: GRACEFUL STOP ────────────────────────────────────────────────────
echo "→ service-selftest: sending SIGTERM (graceful stop)…"
kill -TERM "$SVC_PID"
wait_until 20 bash -c '! kill -0 '"$SVC_PID"' 2>/dev/null' || fail "service did not exit within 20s of SIGTERM"
svc_rc=0; wait "$SVC_PID" 2>/dev/null || svc_rc=$?
[ "$svc_rc" -eq 0 ] || fail "service exited non-zero on graceful stop (rc=$svc_rc)"
[ "$(svc_field state)" = "stopped" ] || fail "status file not marked 'stopped' after stop (state='$(svc_field state)')"
SVC_PID=""   # reaped; don't let cleanup kill an unrelated pid
pass "Phase 6 — SIGTERM drained + halted cleanly (exit 0, state=stopped)"

echo "✓ service-selftest: standing service lifecycle PASSED (idle → wake → drain → idle → second activation → clean stop)."
