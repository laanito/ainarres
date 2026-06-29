#!/usr/bin/env bash
# loop/driver.sh <brief-file> — the DUMB driver (ADR 0020).
#
# The single human input is the feature brief. The driver:
#   1. hands the brief to a designer (one decomposition pass), then
#   2. launches the standing role pollers, then
#   3. watches the board until it drains (no non-terminal, non-blocked dev tasks),
#      then stops the pollers and reports.
#
# It makes NO routing, sequencing, or escalation decisions — those live entirely in
# the substrate (ADR 0001/0019). Its only knowledge is "which harness runs which
# role" (loop/roles.sh) and "is the board empty yet." A driver that started deciding
# which task goes where would be the orchestrator v3 removes.
#
# Runs against the ISOLATED loop substrate (loop.env → localhost:3011), never the
# test substrate (M13). Bring that up first: `make loop-up && make loop-seed`.
set -euo pipefail

BRIEF_FILE="${1:?usage: driver.sh <brief-file>}"
[ -f "$BRIEF_FILE" ] || { echo "driver: brief file not found: $BRIEF_FILE" >&2; exit 2; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"

# Point the CLI at the loop substrate (ADR 0020 isolation) and load run config.
set -a; source "$REPO/loop.env"; set +a
source "$HERE/roles.sh"

LOOP_MAX_SECONDS="${LOOP_MAX_SECONDS:-600}"   # wall-clock safety bound for a run
AINARRES=(node "$REPO/bin/ainarres.mjs")
ai() { "${AINARRES[@]}" "$@"; }

mkdir -p "$RUN_DIR"
rm -f "$STOP_FILE"

# Oversight token: reads the board view (ADR 0009 views are granted to oversight).
OVERSIGHT_TOKEN="$(mint_token oversight)"

# active+blocked counts of dev tasks straight from the board view. Prints "A B".
counts() {
  ai board --lane "$LOOP_LANE" --token "$OVERSIGHT_TOKEN" 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let r;try{r=JSON.parse(s)}catch{r=[]} if(!Array.isArray(r))r=[]; const a=r.filter(x=>!x.is_terminal&&!x.blocked).length; const b=r.filter(x=>x.blocked).length; process.stdout.write(a+" "+b)})'
}

# ── Poller lifecycle: track launched pollers and tear the whole tree down ──────
pids=()        # PIDs of the standing pollers (populated at launch)
_stopped=0     # guard so teardown runs at most once

# Recursively kill a process and all its descendants. A poller spawns a harness
# (grok/opencode), which spawns git/gh/node; a flat `kill <poller>` would orphan
# those, leaving real egress work running unsupervised. pgrep walks the tree
# (portable on macOS + Linux); kill children before the parent.
kill_tree() {
  local pid="$1" sig="${2:-TERM}" child
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do kill_tree "$child" "$sig"; done
  kill "-$sig" "$pid" 2>/dev/null || true
}

# Stop every poller and its harness subtree. Idempotent. STOP sentinel first (so a
# poller resting between sweeps exits cleanly), then TERM the trees, a short grace,
# then KILL any survivor — so killing the driver (or `make loop-run`) never leaves
# runners doing git/gh work behind it.
stop_pollers() {
  [ "$_stopped" = 1 ] && return 0
  _stopped=1
  : >"$STOP_FILE" 2>/dev/null || true
  local pid
  for pid in ${pids[@]+"${pids[@]}"}; do kill_tree "$pid" TERM; done
  local i alive
  for i in 1 2 3 4 5 6; do
    alive=0
    for pid in ${pids[@]+"${pids[@]}"}; do
      if kill -0 "$pid" 2>/dev/null; then alive=1; fi
    done
    [ "$alive" = 0 ] && break
    sleep 1
  done
  for pid in ${pids[@]+"${pids[@]}"}; do kill_tree "$pid" KILL; done
  rm -f "$STOP_FILE" 2>/dev/null || true
}

# Tear down on normal exit, error (set -e), or interrupt. So Ctrl-C or a kill of the
# driver / `make loop-run` takes the pollers and their harnesses down with it.
trap 'stop_pollers' EXIT
trap 'printf "\n→ driver: interrupted — stopping pollers…\n"; exit 130' INT TERM

echo "→ driver: loop substrate = ${AINARRES_BASE_URL} (mode=$LOOP_MODE)"
if ! ai board --lane "$LOOP_LANE" --token "$OVERSIGHT_TOKEN" >/dev/null 2>&1; then
  echo "driver: cannot reach the loop substrate at $AINARRES_BASE_URL." >&2
  echo "        bring it up first:  make loop-up && make loop-seed" >&2
  exit 2
fi

# Decomposition is the one step that creates tasks, so it must run AT MOST once per
# feature. If the board already has dev tasks (a resume after an interrupted run),
# skip it — re-running the driver then just continues against the existing board.
read -r active blocked <<<"$(counts)"
if [ "$active" -gt 0 ] || [ "$blocked" -gt 0 ]; then
  echo "→ driver: board already has ${active} active / ${blocked} blocked dev task(s) — RESUMING (skipping decomposition)."
else
  echo "→ driver: handing the brief to a designer (one decomposition pass)…"
  AINARRES_TOKEN="$(mint_token designer)" harness_sweep designer "$BRIEF_FILE" \
    >"$RUN_DIR/decompose.log" 2>&1 || { echo "driver: decomposition failed (see $RUN_DIR/decompose.log)" >&2; exit 1; }
  read -r active blocked <<<"$(counts)"
  echo "  ✓ board seeded: ${active} active, ${blocked} blocked dev task(s)"
  if [ "$active" -eq 0 ] && [ "$blocked" -eq 0 ]; then
    echo "driver: designer created no tasks — nothing to run." >&2
    exit 1
  fi
fi

echo "→ driver: launching standing pollers: ${LOOP_POLLERS[*]}"
for p in "${LOOP_POLLERS[@]}"; do
  bash "$HERE/poller.sh" "$p" &
  pids+=($!)
done

echo "→ driver: watching the board until it drains (max ${LOOP_MAX_SECONDS}s)…"
start=$(date +%s)
while true; do
  read -r active blocked <<<"$(counts)"
  now=$(date +%s); elapsed=$((now - start))
  printf '\r  board: %s active, %s blocked  (%ss)        ' "$active" "$blocked" "$elapsed"
  if [ "$active" -eq 0 ]; then echo; break; fi
  if [ "$elapsed" -ge "$LOOP_MAX_SECONDS" ]; then
    echo; echo "driver: hit the ${LOOP_MAX_SECONDS}s safety bound with ${active} task(s) still active." >&2
    break
  fi
  sleep "$POLL_INTERVAL"
done

echo "→ driver: stopping pollers…"
stop_pollers

echo "→ driver: final board:"
ai status --lane "$LOOP_LANE" --token "$OVERSIGHT_TOKEN" || true

read -r active blocked <<<"$(counts)"
if [ "$active" -eq 0 ] && [ "$blocked" -eq 0 ]; then
  echo "✓ driver: board drained — every dev task reached a terminal stage."
  exit 0
fi
echo "✗ driver: run ended with ${active} active / ${blocked} blocked task(s) — needs attention." >&2
exit 1
