#!/usr/bin/env bash
# loop/driver.sh <brief-file> — the dumb, TIERED driver (ADR 0020).
#
# The single human input is the feature brief. The driver:
#   1. hands the brief to a designer (one decomposition pass), then
#   2. sweeps the worker tiers in capability order (cheapest first), in rounds,
#      letting each tier drain what it can — until a full round makes NO progress
#      (board drained, or nobody can move it), then stops.
#
# Why tiered + terminating (not two endless concurrent pollers):
#   - Cheapest-first by construction: the cheap tier runs to "nothing claimable"
#     BEFORE the frontier tier runs in the same round, so the cheap implementer
#     claims `implementing` work first. The frontier only picks up what's left —
#     review/integrate and M12-escalated tasks the cheap tier couldn't claim. No
#     race; the cheap tier does the heavy lifting, the frontier is the ceiling.
#   - It ENDS: when a whole round changes nothing on the board, the loop stops
#     instead of polling forever and burning tokens.
#
# (A richer scheduler — token budgets, multiple workers per tier, always-on
#  daemonized tiers — is a later v3+ slice. This is the minimal tiered, terminating
#  loop: every tier gets a turn, and the loop ends when no tier has work left.)
#
# Still makes NO routing/sequencing/escalation decision — those live in the
# substrate (ADR 0001/0019). It knows only the tier ORDER (loop/roles.sh) and
# "did this round change the board." Runs against the isolated loop substrate (M13).
set -euo pipefail

BRIEF_FILE="${1:?usage: driver.sh <brief-file>}"
[ -f "$BRIEF_FILE" ] || { echo "driver: brief file not found: $BRIEF_FILE" >&2; exit 2; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"

# Point the CLI at the loop substrate (ADR 0020 isolation) and load run config.
# Source loop.env for the values the driver needs, but export ONLY what the harness
# children should inherit: AINARRES_BASE_URL (the CLI's loop-substrate target) and
# JWT_SECRET (token minting). CRUCIALLY do NOT export COMPOSE_PROJECT_NAME (or the
# ports): if a harness inherited COMPOSE_PROJECT_NAME=ainarres-loop, an agent running
# `make reset` at the `validating` stage would target the LOOP compose project — tear
# down the live loop board mid-run and let the test suite's dev fixtures repopulate it
# (exactly the M11 pollution, via a new vector — observed wiping a done task). Keeping
# it unexported preserves M13 isolation: an agent's `make reset` hits the default
# `ainarres` (test) project, never the loop.
# shellcheck disable=SC1090,SC1091
source "$REPO/loop.env"
export AINARRES_BASE_URL JWT_SECRET
source "$HERE/roles.sh"

LOOP_MAX_ROUNDS="${LOOP_MAX_ROUNDS:-20}"   # safety bound (full no-progress detection ends it sooner)
LOOP_POOL_SIZE="${LOOP_POOL_SIZE:-3}"      # M18: concurrent cheap implementers per round (ADR 0021 D1)
AINARRES=(node "$REPO/bin/ainarres.mjs")
ai() { "${AINARRES[@]}" "$@"; }
mkdir -p "$RUN_DIR"

# Oversight token: reads the board view (ADR 0009 views are granted to oversight).
OVERSIGHT_TOKEN="$(mint_token oversight)"

# active+blocked counts of dev tasks straight from the board view. Prints "A B".
counts() {
  ai board --lane "$LOOP_LANE" --token "$OVERSIGHT_TOKEN" 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let r;try{r=JSON.parse(s)}catch{r=[]} if(!Array.isArray(r))r=[]; const a=r.filter(x=>!x.is_terminal&&!x.blocked).length; const b=r.filter(x=>x.blocked).length; process.stdout.write(a+" "+b)})'
}

# A stable signature of the board (task → stage/blocked). If a full round leaves
# this unchanged, no tier moved anything → the loop is stuck and we stop.
board_sig() {
  ai board --lane "$LOOP_LANE" --token "$OVERSIGHT_TOKEN" 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let r;try{r=JSON.parse(s)}catch{r=[]} if(!Array.isArray(r))r=[]; process.stdout.write(r.map(x=>x.task_id+":"+x.stage+":"+(x.blocked?"b":"")).sort().join("|"))})'
}

# ── Teardown: kill the active sweep's harness subtree on exit/interrupt ────────
CURRENT_SWEEP_PID=""
POOL_PIDS=()          # M18: pids of the concurrent implementer pool currently in flight
_stopped=0

# Recursively kill a process and all its descendants (a sweep's harness spawns
# git/gh/node; a flat kill would orphan them). pgrep walks the tree (macOS+Linux).
kill_tree() {
  local pid="$1" sig="${2:-TERM}" child
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do kill_tree "$child" "$sig"; done
  kill "-$sig" "$pid" 2>/dev/null || true
}

# Stop the in-flight sweep (if any). Idempotent. So Ctrl-C / kill of the driver (or
# `make loop-run`) never leaves a harness doing git/gh work behind it.
stop_active() {
  [ "$_stopped" = 1 ] && return 0
  _stopped=1
  # Kill the single in-flight sweep (designer/fallback/frontier) AND every member of
  # the concurrent implementer pool (M18) — none may be left doing git/gh work.
  local pid
  for pid in ${CURRENT_SWEEP_PID:-} ${POOL_PIDS[@]:-}; do
    [ -n "$pid" ] || continue
    kill_tree "$pid" TERM
  done
  sleep 1
  for pid in ${CURRENT_SWEEP_PID:-} ${POOL_PIDS[@]:-}; do
    [ -n "$pid" ] || continue
    kill_tree "$pid" KILL
  done
  # Garbage-collect per-sweep worktrees (M17). On exit no sweep is live → gc with no
  # active ids clears them all; a crashed run leaves none behind. Best-effort.
  bash "$HERE/worktree.sh" gc >/dev/null 2>&1 || true
  # Per-sweep opencode state (M18): each implementer sweep parks its private
  # XDG_DATA_HOME under $RUN_DIR/xdg/<sweep> (beside the worktree, never inside it, so
  # `git add -A` can't stage it). The implementer's own teardown trap can't fire on the
  # normal path (it exec's into opencode), so clear the tree here. Best-effort.
  rm -rf "$RUN_DIR/xdg" >/dev/null 2>&1 || true
}
trap 'stop_active' EXIT
trap 'printf "\n→ driver: interrupted — stopping the active sweep…\n"; exit 130' INT TERM

# If a finished sweep left a task claimed (it stopped without advancing OR releasing
# — e.g. it implemented but never committed), release it so the next tier/round can
# pick it up. Safe because the loop is SERIALIZED: when the sweep returns, that worker
# is provably done, so any task it still holds is stranded. release bumps `attempts`,
# which feeds M12 escalation — exactly the right effect. No lease wait, no polling.
release_stranded() {
  local sub="$1" tok="$2" held
  held="$(ai board --lane "$LOOP_LANE" --token "$OVERSIGHT_TOKEN" 2>/dev/null \
    | node -e 'let s="";const sub=process.argv[1];process.stdin.on("data",d=>s+=d).on("end",()=>{let r;try{r=JSON.parse(s)}catch{r=[]};if(!Array.isArray(r))r=[];const t=r.find(x=>x.claimed_by===sub&&!x.is_terminal);process.stdout.write(t?t.task_id:"")})' "$sub")"
  if [ -n "$held" ]; then
    echo "  ↳ tier left $held claimed without advancing — releasing it for the next tier."
    ai release "$held" --reason "worker sweep ended without advancing or releasing (stranded)" --token "$tok" >/dev/null 2>&1 || true
  fi
}

# Run ONE tier's harness sweep to completion (its skill loops claim→work→advance
# until "nothing claimable", then exits). Backgrounded + waited so the trap can kill
# its whole subtree on interrupt. The token uses a KNOWN sub so we can release a
# claim the sweep stranded (see release_stranded).
run_sweep() {
  local tier="$1" brief="${2:-}" rc=0 sub tok
  sub="$(uuidgen | tr 'A-Z' 'a-z')"
  tok="$(mint_token "$tier" "$sub")"
  # LOOP_SWEEP_ID lets an implementer wrapper isolate itself in a per-sweep git
  # worktree (M17): concurrent implementer processes (M18) won't collide on one
  # checkout. The id = the sweep's known sub, so it's unique per process. Only the
  # implementer wrappers act on it; designer/integrator sweeps work in the real repo.
  AINARRES_TOKEN="$tok" LOOP_SWEEP_ID="$sub" harness_sweep "$tier" "$brief" >>"$RUN_DIR/$tier.log" 2>&1 &
  CURRENT_SWEEP_PID=$!
  wait "$CURRENT_SWEEP_PID" || rc=$?
  CURRENT_SWEEP_PID=""
  release_stranded "$sub" "$tok"
  return "$rc"
}

# ── M18: a concurrent pool of implementer sweeps ──────────────────────────────
# Run LOOP_POOL_SIZE implementer sweeps of one tier AT ONCE, then reap them. The
# substrate's SKIP LOCKED claim makes the concurrent pulls race-free (each member
# grabs a distinct task); one-active-task-per-instance means N members hold ≤N tasks.
# Each member gets its own sub → its own M17 worktree (LOOP_SWEEP_ID) and its own
# stranded-release. This is where the swarm's throughput comes from (ADR 0021 D1).
# Parallel indexed arrays (bash 3.2 — no associative arrays).
run_pool() {
  local tier="$1" n="$2" i sub tok pids=() subs=() toks=()
  for ((i = 0; i < n; i++)); do
    sub="$(uuidgen | tr 'A-Z' 'a-z')"
    tok="$(mint_token "$tier" "$sub")"
    AINARRES_TOKEN="$tok" LOOP_SWEEP_ID="$sub" harness_sweep "$tier" >>"$RUN_DIR/$tier-$sub.log" 2>&1 &
    pids+=("$!"); subs+=("$sub"); toks+=("$tok")
  done
  POOL_PIDS=("${pids[@]}")                 # expose to stop_active for the kill trap
  for i in "${!pids[@]}"; do
    wait "${pids[$i]}" || true             # a member failing is fine; the board is the truth
    release_stranded "${subs[$i]}" "${toks[$i]}"
  done
  POOL_PIDS=()
}

# ── M19: run a set of DISTINCT frontier peers concurrently ────────────────────
# Like run_pool, but each concurrent sweep is a DIFFERENT poller (grok reviewer/
# integrator + the claude reviewer), so the frontier ROLE is federated: whoever is
# free claims the next reviewing task (SKIP LOCKED distributes across families). Only
# grok holds capability:integrate, so integration stays single even though review fans
# out. Each peer gets its own sub → its own stranded-release (design/federation.md).
run_concurrent() {
  local pollers=("$@") i name sub tok pids=() subs=() toks=()
  for name in "${pollers[@]}"; do
    sub="$(uuidgen | tr 'A-Z' 'a-z')"
    tok="$(mint_token "$name" "$sub")"
    AINARRES_TOKEN="$tok" LOOP_SWEEP_ID="$sub" harness_sweep "$name" >>"$RUN_DIR/$name.log" 2>&1 &
    pids+=("$!"); subs+=("$sub"); toks+=("$tok")
  done
  POOL_PIDS=("${pids[@]}")                 # expose to stop_active for the kill trap
  for i in "${!pids[@]}"; do
    wait "${pids[$i]}" || true
    release_stranded "${subs[$i]}" "${toks[$i]}"
  done
  POOL_PIDS=()
}

echo "→ driver: loop substrate = ${AINARRES_BASE_URL} (mode=$LOOP_MODE)"
if ! ai board --lane "$LOOP_LANE" --token "$OVERSIGHT_TOKEN" >/dev/null 2>&1; then
  echo "driver: cannot reach the loop substrate at $AINARRES_BASE_URL." >&2
  echo "        bring it up first:  make loop-up && make loop-seed" >&2
  exit 2
fi

# 1. Decompose once (designer = frontier family). Skipped on a resume (board has
#    tasks already), so re-running never re-decomposes into duplicates.
read -r active blocked <<<"$(counts)"
if [ "$active" -gt 0 ]; then
  echo "→ driver: board already has ${active} active task(s) — RESUMING (skipping decomposition)."
elif [ "$blocked" -gt 0 ]; then
  echo "driver: board has ${blocked} blocked task(s) and no active work — a previous run needs attention." >&2
  echo "        reset the loop board (make loop-reset) or unblock before starting a new feature." >&2
  exit 1
else
  echo "→ driver: handing the brief to a designer (one decomposition pass)…"
  run_sweep designer "$BRIEF_FILE" \
    || { echo "driver: decomposition failed (see $RUN_DIR/designer.log)" >&2; exit 1; }
  read -r active blocked <<<"$(counts)"
  echo "  ✓ board seeded: ${active} active, ${blocked} blocked task(s)"
  if [ "$active" -eq 0 ] && [ "$blocked" -eq 0 ]; then
    echo "driver: designer created no tasks — nothing to run." >&2
    exit 1
  fi
fi

# 2. Concurrent rounds (M18): each round fans the primary cheap implementer out into
#    a pool of LOOP_POOL_SIZE simultaneous sweeps (the throughput), then runs the
#    serial tiers once each (fallback ceiling, then frontier review/integrate — the
#    single integrator IS the merge queue). Repeat until a full round moves nothing
#    OR the board drains. Termination is unchanged in spirit: board empty AND no
#    sweep in flight (run_pool/run_sweep both reap before returning, so when the round
#    body finishes nothing is running — D4).
echo "→ driver: pool=${LOOP_POOL_SIZE}× '${LOOP_POOL_TIER}' per round; serial: ${LOOP_SERIAL_TIERS[*]}; frontier peers: ${LOOP_FRONTIER_PEERS[*]}"
round=0
while true; do
  round=$((round + 1))
  before="$(board_sig)"
  echo "→ round $round: ${LOOP_POOL_SIZE} concurrent '${LOOP_POOL_TIER}' implementers…"
  run_pool "$LOOP_POOL_TIER" "$LOOP_POOL_SIZE"
  for tier in "${LOOP_SERIAL_TIERS[@]}"; do
    echo "→ round $round: tier '$tier' sweeping…"
    run_sweep "$tier" || echo "  (tier '$tier' sweep exited non-zero — continuing)"
  done
  # M19: the frontier peers (grok + claude reviewer) sweep CONCURRENTLY — review fans
  # across families, integration stays single (only grok holds capability:integrate).
  echo "→ round $round: frontier peers concurrently: ${LOOP_FRONTIER_PEERS[*]}…"
  run_concurrent "${LOOP_FRONTIER_PEERS[@]}"
  read -r active blocked <<<"$(counts)"
  after="$(board_sig)"
  echo "  round $round complete: ${active} active, ${blocked} blocked"
  if [ "$active" -eq 0 ]; then break; fi
  if [ "$after" = "$before" ]; then
    echo "⚠ driver: a full round moved nothing — no tier can progress the board. Stopping."
    break
  fi
  if [ "$round" -ge "$LOOP_MAX_ROUNDS" ]; then
    echo "⚠ driver: hit the ${LOOP_MAX_ROUNDS}-round safety bound. Stopping."
    break
  fi
done

# 3. Report. The live board snapshot, then the M16 end-of-run report (what
# shipped with PRs, what failed, escalations, per-family activity) — the account
# the owner who walked away comes back to (ADR 0021 D5).
echo "→ driver: final board:"
ai status --lane "$LOOP_LANE" --token "$OVERSIGHT_TOKEN" || true
echo
ai report --lane "$LOOP_LANE" --token "$OVERSIGHT_TOKEN" || true
read -r active blocked <<<"$(counts)"
if [ "$active" -eq 0 ] && [ "$blocked" -eq 0 ]; then
  echo "✓ driver: board drained — every dev task reached a terminal stage."
  exit 0
fi
echo "✗ driver: run ended with ${active} active / ${blocked} blocked task(s) — needs attention." >&2
exit 1
