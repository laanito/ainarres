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

echo "→ driver: loop substrate = ${AINARRES_BASE_URL} (mode=$LOOP_MODE)"
if ! ai board --lane "$LOOP_LANE" --token "$OVERSIGHT_TOKEN" >/dev/null 2>&1; then
  echo "driver: cannot reach the loop substrate at $AINARRES_BASE_URL." >&2
  echo "        bring it up first:  make loop-up && make loop-seed" >&2
  exit 2
fi

echo "→ driver: handing the brief to a designer (one decomposition pass)…"
AINARRES_TOKEN="$(mint_token designer)" harness_sweep designer "$BRIEF_FILE" \
  >"$RUN_DIR/decompose.log" 2>&1 || { echo "driver: decomposition failed (see $RUN_DIR/decompose.log)" >&2; exit 1; }
read -r active blocked <<<"$(counts)"
echo "  ✓ board seeded: ${active} active, ${blocked} blocked dev task(s)"
if [ "$active" -eq 0 ] && [ "$blocked" -eq 0 ]; then
  echo "driver: designer created no tasks — nothing to run." >&2
  exit 1
fi

echo "→ driver: launching standing pollers: ${LOOP_POLLERS[*]}"
pids=()
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
: >"$STOP_FILE"
for pid in "${pids[@]}"; do wait "$pid" 2>/dev/null || true; done
rm -f "$STOP_FILE"

echo "→ driver: final board:"
ai status --lane "$LOOP_LANE" --token "$OVERSIGHT_TOKEN" || true

read -r active blocked <<<"$(counts)"
if [ "$active" -eq 0 ] && [ "$blocked" -eq 0 ]; then
  echo "✓ driver: board drained — every dev task reached a terminal stage."
  exit 0
fi
echo "✗ driver: run ended with ${active} active / ${blocked} blocked task(s) — needs attention." >&2
exit 1
