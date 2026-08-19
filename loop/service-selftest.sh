#!/usr/bin/env bash
# loop/service-selftest.sh — M25's done-test (design/service.md): drive the STANDING
# SERVICE deterministically through its lifecycle with the MOCK harness, asserting:
#   1. IDLE on an empty board — it spawns nothing and creates no work;
#   2. WAKE + DRAIN — work inserted mid-idle wakes it; it drains to `done` and idles again;
#   3. SECOND ACTIVATION with NO RESTART — a second batch is a second activation, SAME pid;
#   4. GRACEFUL STOP — SIGTERM halts it cleanly (exit 0), status → `stopped`.
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
svc_field()  { node -e 'try{const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(j[process.argv[2]]??""))}catch{process.stdout.write("")}' "$STATUS" "$1"; }

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

echo "→ service-selftest: substrate=$AINARRES_BASE_URL  poll=${LOOP_IDLE_POLL_SECS}s  mock_tasks=$LOOP_MOCK_TASKS"
[ "$(n_total)" -eq 0 ] || fail "expected a fresh (empty) loop board — run via 'make service-selftest' (it loop-resets first). total=$(n_total)"

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

# ── Phase 4: GRACEFUL STOP ────────────────────────────────────────────────────
echo "→ service-selftest: sending SIGTERM (graceful stop)…"
kill -TERM "$SVC_PID"
wait_until 20 bash -c '! kill -0 '"$SVC_PID"' 2>/dev/null' || fail "service did not exit within 20s of SIGTERM"
svc_rc=0; wait "$SVC_PID" 2>/dev/null || svc_rc=$?
[ "$svc_rc" -eq 0 ] || fail "service exited non-zero on graceful stop (rc=$svc_rc)"
[ "$(svc_field state)" = "stopped" ] || fail "status file not marked 'stopped' after stop (state='$(svc_field state)')"
SVC_PID=""   # reaped; don't let cleanup kill an unrelated pid
pass "Phase 4 — SIGTERM drained + halted cleanly (exit 0, state=stopped)"

echo "✓ service-selftest: standing service lifecycle PASSED (idle → wake → drain → idle → second activation → clean stop)."
