#!/usr/bin/env bash
# loop/service.sh — the STANDING SUPERVISOR (v7 / ADR 0024 / design/service.md).
#
# The v7 flip: retire the crank. Where loop/driver.sh decomposes a brief once, drains
# the board, and EXITS (batch), the service stands: it watches the loop board and, when
# there is claimable work, runs ONE activation (the SAME run_activation the batch driver
# uses — the round loop, verbatim, from driver-lib.sh), draining it; when the board is
# empty it IDLES (sleeps, holding no workers) and wakes on the next poll. AINARRES stops
# being a script you run and becomes a process that runs.
#
# It makes NO routing decision (ADR 0024 — demand-scaler, NEVER a router): its only
# question is the board's, "is there claimable work?" (active > 0). The tiers self-claim
# via SKIP LOCKED exactly as in batch mode; the service only decides run-an-activation
# vs. idle. It does NOT decompose — briefs arrive the existing way (an INSERT / the CLI,
# and in v7's M26 a local channel); the service delivers whatever is on the board.
#
# State machine (written to $SERVICE_STATUS_FILE each tick — design/service.md D4;
# a local file, NOT substrate truth: a service is fungible and holds no truth the
# substrate doesn't):
#   starting → idle ⇄ running → idle            (the normal cycle: wake, drain, idle)
#             idle → stalled (→ idle when a human changes the board)   (D3: no-progress)
#             any  → stopped                     (D5: graceful stop, SIGTERM/service-stop)
#
# Cost-control is preserved (design/service.md D3): idle spawns nothing and holds no
# lease; a no-progress activation does NOT spin — the service records the stuck board
# signature, enters `stalled`, and will NOT re-activate that same board until its
# signature CHANGES (a human intervening). The stall is the human-facing signal (the
# status file + a loud log); stranded CLAIMS remain surfaced by the M23 auditor health
# watch via api.abandoned (design/service.md D3 reconciliation — a whole-board stall has
# no single family to attribute a substrate flag to, and the health watch already names
# the ones that do).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"

# Same substrate targeting + isolation discipline as the batch driver (see driver.sh):
# export ONLY AINARRES_BASE_URL + JWT_SECRET to harness children, never the compose
# project/ports (M13 isolation — a harness `make reset` must hit the test project, never
# the loop).
# shellcheck disable=SC1090,SC1091
source "$REPO/loop.env"
export AINARRES_BASE_URL JWT_SECRET
source "$HERE/roles.sh"

LOOP_MAX_ROUNDS="${LOOP_MAX_ROUNDS:-20}"          # per-activation safety bound (D3)
LOOP_POOL_SIZE="${LOOP_POOL_SIZE:-3}"             # concurrent cheap implementers per round
LOOP_IDLE_POLL_SECS="${LOOP_IDLE_POLL_SECS:-15}"  # how often the idle service re-checks the board (D1)

# The standing service DECOMPOSES continuously: unlike the batch driver (one upfront
# designer pass on the brief), the service keeps seeing proposed dev tasks and, in v7's
# M26, accepted intake briefs — so the designer is a standing poller that runs each round
# before the implementers (run_activation's design pass). The batch driver leaves this
# empty (it already decomposed) — the one activation-shape difference between the two.
LOOP_DESIGN_TIERS=("${LOOP_DESIGN_TIERS[@]:-designer}")

# Consume governance (design/service.md D6): before spawning a tier, the service reads
# api.governance_status and skips a family temp-banned for the capability its role needs
# (best-effort — an unreadable view degrades to spawn-anyway). The batch driver leaves
# this off (0), so only the standing service consumes governance.
export LOOP_CONSUME_GOVERNANCE="${LOOP_CONSUME_GOVERNANCE:-1}"

# The shared coordination primitives (board reads, spawn/reap, teardown, run_activation).
# shellcheck disable=SC1090,SC1091
source "$HERE/driver-lib.sh"

mkdir -p "$RUN_DIR"
SERVICE_STATUS_FILE="${SERVICE_STATUS_FILE:-$RUN_DIR/service.status}"
OVERSIGHT_TOKEN="$(mint_token oversight)"

# ── Liveness status file (D4) — a plain local JSON, one line rewritten each tick ──
# Fields are all service-controlled (no user input), so a printf'd JSON is safe. The
# PRETTY human readout (`ainarres service-status` / a report line) is the Slice B pure
# formatter — swarm-built; this only has to be valid, readable JSON.
ACTIVATION_COUNT=0     # how many activations we've run since start
LAST_ACTIVE=0          # active count at the last poll
LAST_BLOCKED=0         # blocked count at the last poll
service_status() {
  local state="$1" note="${2:-}"
  printf '{"pid":%d,"state":"%s","activation":%d,"round":%d,"active":%d,"blocked":%d,"poll_secs":%d,"note":"%s","last_tick":"%s"}\n' \
    "$$" "$state" "$ACTIVATION_COUNT" "${ACTIVATION_ROUNDS:-0}" "$LAST_ACTIVE" "$LAST_BLOCKED" \
    "$LOOP_IDLE_POLL_SECS" "$note" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    > "$SERVICE_STATUS_FILE"
}

# ── Graceful stop (D5) ────────────────────────────────────────────────────────
# SIGTERM / SIGINT (or `make service-stop`, which sends SIGTERM to our pid) requests a
# DRAIN-THEN-HALT: finish the in-flight activation's current round (run_activation returns
# 3 before starting a NEW round — the sweeps already reaped), decline new work, then the
# EXIT trap runs stop_active (kill any straggler subtree, gc worktrees) and marks stopped.
DRAINING=0
request_stop() { DRAINING=1; printf '\n→ service: stop requested — draining in-flight work, will halt…\n'; }
on_exit() { stop_active; service_status stopped "halted"; }
trap 'request_stop' INT TERM
trap 'on_exit' EXIT

# ── Startup ───────────────────────────────────────────────────────────────────
echo "→ service: loop substrate = ${AINARRES_BASE_URL} (mode=$LOOP_MODE)"
echo "→ service: standing supervisor up (poll ${LOOP_IDLE_POLL_SECS}s; design: ${LOOP_DESIGN_TIERS[*]}; pool=${LOOP_POOL_SIZE}× '${LOOP_POOL_TIER}'; serial: ${LOOP_SERIAL_TIERS[*]}; frontier: ${LOOP_FRONTIER_PEERS[*]}; consume-governance=${LOOP_CONSUME_GOVERNANCE})"
echo "→ service: status file = ${SERVICE_STATUS_FILE}  ·  stop with: make service-stop (or SIGTERM)"
service_status starting "supervisor up"

# STALLED_SIG holds the board signature of a stuck board (set after a no-progress
# activation). While the board still matches it, the service stays `stalled` and does
# NOT re-activate — only a human changing the board (which changes the signature) resumes
# normal service. Empty = not stalled.
STALLED_SIG=""

# ── The idle/wake loop (D1/D2) ──────────────────────────────────────────────────
while true; do
  [ "$DRAINING" = 1 ] && break

  # Reachability first: an unreachable board is NOT an empty one (the wipe/tear-down
  # lesson). Don't run an activation against it and don't call it drained — log, hold
  # idle, retry next tick.
  read -r _total reachable <<<"$(board_total)"
  if [ "$reachable" -ne 1 ]; then
    echo "⚠ service: loop board unreachable at ${AINARRES_BASE_URL} — holding idle, will retry."
    service_status idle "board unreachable"
    sleep "$LOOP_IDLE_POLL_SECS" || true
    continue
  fi

  read -r active blocked <<<"$(counts)"
  LAST_ACTIVE="$active"; LAST_BLOCKED="$blocked"
  sig="$(board_sig)"

  # Empty board → idle. (blocked>0 with active==0 is a board needing attention, but the
  # service neither decomposes nor unblocks — it holds idle; the blocked tasks are the
  # human's / the auditor's to see. It is quiescent, not stuck-spinning.)
  if [ "$active" -eq 0 ]; then
    STALLED_SIG=""
    service_status idle "$([ "$blocked" -gt 0 ] && echo "board drained; ${blocked} blocked awaiting a human" || echo "board drained")"
    sleep "$LOOP_IDLE_POLL_SECS" || true
    continue
  fi

  # Active work exists but we already know THIS board is stuck (a prior activation made
  # no progress and nothing has changed since) → stay stalled, DON'T re-activate (D3).
  if [ -n "$STALLED_SIG" ] && [ "$sig" = "$STALLED_SIG" ]; then
    service_status stalled "board stuck: ${active} active make no progress — awaiting a human"
    sleep "$LOOP_IDLE_POLL_SECS" || true
    continue
  fi

  # Fresh (or changed) work → run one activation. The board signature changed since any
  # stall, so clear it and drain.
  STALLED_SIG=""
  ACTIVATION_COUNT=$((ACTIVATION_COUNT + 1))
  echo "→ service: activation #${ACTIVATION_COUNT} — ${active} active task(s); draining…"
  service_status running "activation #${ACTIVATION_COUNT}"
  run_activation; act_rc=$?
  case "$act_rc" in
    0)
      echo "  ✓ service: activation #${ACTIVATION_COUNT} drained — back to idle."
      # (loop top will read the board again; if new work arrived it activates again.)
      ;;
    1|2)
      # No progress / hit the round cap: the board is stuck. Record its signature and
      # enter `stalled` — do NOT spin re-activating it (D3). A human changing the board
      # (unblock / reset / reassign) changes the signature and resumes normal service.
      STALLED_SIG="$(board_sig)"
      if [ "$act_rc" = 1 ]; then
        echo "⚠ service: activation #${ACTIVATION_COUNT} made NO progress — board stuck. Holding stalled, awaiting a human." >&2
      else
        echo "⚠ service: activation #${ACTIVATION_COUNT} hit the ${LOOP_MAX_ROUNDS}-round cap without draining — board stuck. Holding stalled, awaiting a human." >&2
      fi
      read -r active blocked <<<"$(counts)"; LAST_ACTIVE="$active"; LAST_BLOCKED="$blocked"
      service_status stalled "board stuck after activation #${ACTIVATION_COUNT}: ${active} active make no progress — awaiting a human"
      ;;
    3)
      echo "→ service: activation #${ACTIVATION_COUNT} stopped mid-drain (stop requested)."
      ;;
  esac
done

echo "→ service: stopped cleanly."
# The EXIT trap (on_exit) runs stop_active + marks the status file `stopped`.
