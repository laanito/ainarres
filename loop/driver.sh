#!/usr/bin/env bash
# loop/driver.sh <brief-file> — the dumb, TIERED BATCH driver (ADR 0020).
#
# The single human input is the feature brief. The driver:
#   1. hands the brief to a designer (one decomposition pass), then
#   2. runs ONE activation — sweeps the worker tiers in capability order (cheapest
#      first), in rounds, until a full round makes NO progress (board drained, or
#      nobody can move it) — then reports and EXITS.
#
# The round loop, the spawn/reap primitives, and the teardown all live in
# loop/driver-lib.sh now (ADR 0024 / design/service.md) — SHARED verbatim with the
# standing service (loop/service.sh), which runs the SAME activation on a wake instead
# of once at startup. This file is the BATCH entry point: decompose → drain → exit.
# `make loop-run` stays the right tool for a one-shot local build / the mock selftest;
# the always-on `make service` is v7's default (design/service.md).
#
# Why tiered + terminating (not two endless concurrent pollers):
#   - Cheapest-first by construction: the cheap tier runs to "nothing claimable" BEFORE
#     the frontier tier runs in the same round, so the cheap implementer claims
#     `implementing` work first. The frontier only picks up what's left.
#   - It ENDS: when a whole round changes nothing on the board, the loop stops instead
#     of polling forever and burning tokens. (The service INVERTS this to idle-safe —
#     it does not exit on drain; design/service.md D1.)
#
# Still makes NO routing/sequencing/escalation decision — those live in the substrate
# (ADR 0001/0019). It knows only the tier ORDER (loop/roles.sh) and "did this round
# change the board." Runs against the isolated loop substrate (M13).
set -euo pipefail

BRIEF_FILE="${1:?usage: driver.sh <brief-file>}"
[ -f "$BRIEF_FILE" ] || { echo "driver: brief file not found: $BRIEF_FILE" >&2; exit 2; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"

# Point the CLI at the loop substrate (ADR 0020 isolation) and load run config.
# Source loop.env for the values the driver needs, but export ONLY what the harness
# children should inherit: AINARRES_BASE_URL (the CLI's loop-substrate target) and
# JWT_SECRET (token minting). CRUCIALLY do NOT export COMPOSE_PROJECT_NAME (or the
# ports): an agent running `make reset` at `validating` would otherwise target the LOOP
# project and wipe the live board mid-run (M11 pollution via a new vector). Keeping it
# unexported preserves M13 isolation.
# shellcheck disable=SC1090,SC1091
source "$REPO/loop.env"
export AINARRES_BASE_URL JWT_SECRET
source "$HERE/roles.sh"

LOOP_MAX_ROUNDS="${LOOP_MAX_ROUNDS:-20}"   # safety bound (full no-progress detection ends it sooner)
LOOP_POOL_SIZE="${LOOP_POOL_SIZE:-3}"      # M18: concurrent cheap implementers per round (ADR 0021 D1)

# The shared coordination primitives (board reads, spawn/reap, teardown, run_activation).
# shellcheck disable=SC1090,SC1091
source "$HERE/driver-lib.sh"

mkdir -p "$RUN_DIR"

# Oversight token: reads the board view (ADR 0009 views are granted to oversight).
OVERSIGHT_TOKEN="$(mint_token oversight)"

# ── Teardown: kill the active sweep's harness subtree on exit/interrupt ────────
trap 'stop_active' EXIT
trap 'printf "\n→ driver: interrupted — stopping the active sweep…\n"; exit 130' INT TERM

echo "→ driver: loop substrate = ${AINARRES_BASE_URL} (mode=$LOOP_MODE)"
if ! ai board --lane "$LOOP_LANE" --token "$OVERSIGHT_TOKEN" >/dev/null 2>&1; then
  echo "driver: cannot reach the loop substrate at $AINARRES_BASE_URL." >&2
  echo "        bring it up first:  make loop-up && make loop-seed" >&2
  exit 2
fi

# 1. Decompose once (designer = frontier family). Skipped on a resume (board has tasks
#    already), so re-running never re-decomposes into duplicates.
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

# Record how many tasks the board holds now that it is seeded, so the end-of-run check
# can tell a legitimate drain (tasks reached `done`, still on the board) from a WIPE
# (tasks vanished — the 2026-07-04 incident; guarded now via loop/guard-bin).
read -r SEEDED_TOTAL _ <<<"$(board_total)"

# 2. ONE activation: the concurrent rounds (M18) — the pool fans out the primary cheap
#    implementer (throughput), then the serial tiers once each, then the frontier peers
#    concurrently (the single grok integrator IS the merge queue). Repeat until a full
#    round moves nothing OR the board drains. (Shared with the service via run_activation.)
echo "→ driver: pre-pool: ${LOOP_PRE_TIERS[*]:-(none)}; pool=${LOOP_POOL_SIZE}× '${LOOP_POOL_TIER}' per round; serial: ${LOOP_SERIAL_TIERS[*]}; frontier peers: ${LOOP_FRONTIER_PEERS[*]}"
# `|| act_rc=$?`, never `; act_rc=$?`: under `set -e` a bare call returning 1 (no progress)
# or 2 (round cap) killed the driver HERE — skipping the warning below and, worse, the
# report + wipe-detection in step 3, which is the account the owner who walked away comes
# back to. Same latent bug as loop/service.sh's; found by v8's stuck-board selftest phase.
act_rc=0
run_activation || act_rc=$?
case "$act_rc" in
  1) echo "⚠ driver: a full round moved nothing — no tier can progress the board. Stopping." ;;
  2) echo "⚠ driver: hit the ${LOOP_MAX_ROUNDS}-round safety bound. Stopping." ;;
esac

# 3. Report. The live board snapshot, then the M16 end-of-run report (what shipped with
# PRs, what failed, escalations, per-family activity) — the account the owner who walked
# away comes back to (ADR 0021 D5).
echo "→ driver: final board:"
ai status --lane "$LOOP_LANE" --token "$OVERSIGHT_TOKEN" || true
echo
ai report --lane "$LOOP_LANE" --token "$OVERSIGHT_TOKEN" || true
read -r active blocked <<<"$(counts)"
read -r final_total reachable <<<"$(board_total)"

# A WIPE masquerades as a drain: counts() reads 0 active/0 blocked whether every task
# reached `done` OR the board was emptied/torn down out from under us. Distinguish them.
# We seeded ${SEEDED_TOTAL} tasks; a genuine drain leaves those tasks on the board at a
# terminal stage. Zero tasks now (or an unreachable board) after seeding > 0 means the
# board was WIPED — fail loudly, never report success (2026-07-04 board-wipe).
if [ "${SEEDED_TOTAL:-0}" -gt 0 ] && { [ "$reachable" -eq 0 ] || [ "$final_total" -eq 0 ]; }; then
  if [ "$reachable" -eq 0 ]; then
    echo "✗ driver: the loop board is UNREACHABLE at the end of the run (was seeded with ${SEEDED_TOTAL} task(s))." >&2
    echo "          the substrate went away mid-run — this is NOT a drain. Check the loop stack / logs." >&2
  else
    echo "✗ driver: the board is EMPTY but was seeded with ${SEEDED_TOTAL} task(s) and shows NO terminal tasks —" >&2
    echo "          it was WIPED mid-run, not drained (a harness likely cleared it; see loop/guard-bin). NOT a success." >&2
  fi
  exit 2
fi

if [ "$active" -eq 0 ] && [ "$blocked" -eq 0 ]; then
  echo "✓ driver: board drained — every dev task reached a terminal stage (${final_total} terminal task(s) on the board)."
  exit 0
fi
echo "✗ driver: run ended with ${active} active / ${blocked} blocked task(s) — needs attention." >&2
exit 1
