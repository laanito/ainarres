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
  if [ -n "$CURRENT_SWEEP_PID" ]; then
    kill_tree "$CURRENT_SWEEP_PID" TERM
    sleep 1
    kill_tree "$CURRENT_SWEEP_PID" KILL
  fi
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
  AINARRES_TOKEN="$tok" harness_sweep "$tier" "$brief" >>"$RUN_DIR/$tier.log" 2>&1 &
  CURRENT_SWEEP_PID=$!
  wait "$CURRENT_SWEEP_PID" || rc=$?
  CURRENT_SWEEP_PID=""
  release_stranded "$sub" "$tok"
  return "$rc"
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

# 2. Tiered rounds: cheapest tier first, until a full round makes no progress.
echo "→ driver: worker tiers (low→high): ${LOOP_TIERS[*]}"
round=0
while true; do
  round=$((round + 1))
  before="$(board_sig)"
  for tier in "${LOOP_TIERS[@]}"; do
    echo "→ round $round: tier '$tier' sweeping…"
    run_sweep "$tier" || echo "  (tier '$tier' sweep exited non-zero — continuing)"
  done
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

# 3. Report.
echo "→ driver: final board:"
ai status --lane "$LOOP_LANE" --token "$OVERSIGHT_TOKEN" || true
read -r active blocked <<<"$(counts)"
if [ "$active" -eq 0 ] && [ "$blocked" -eq 0 ]; then
  echo "✓ driver: board drained — every dev task reached a terminal stage."
  exit 0
fi
echo "✗ driver: run ended with ${active} active / ${blocked} blocked task(s) — needs attention." >&2
exit 1
