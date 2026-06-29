#!/usr/bin/env bash
# loop/poller.sh <poller-name> — a single standing role poller (ADR 0020).
#
# It is deliberately dumb: mint this poller's token, then relaunch its harness for
# one sweep, sleep, and repeat — until the driver drops a STOP sentinel. All the
# claim→work→advance logic lives in the harness's skill; all the routing lives in
# the substrate. The poller adds only: identity (token), the relaunch loop, and a
# clean stop. A poller holds at most one task at a time (one-task-per-instance,
# ADR 0008), so a single cheap poller naturally serializes the cheap implementer.
#
# Resilience: if the harness dies mid-task, the held task's lease expires and the
# substrate hands it out again on a later claim (lazy reclaim, ADR 0009) — so a
# killed/restarted poller is recovered with no driver involvement.
set -euo pipefail

POLLER="${1:?usage: poller.sh <poller-name>}"
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/roles.sh"

mkdir -p "$RUN_DIR"
LOG="$RUN_DIR/$POLLER.log"

# loop.env (sourced by the driver and exported) points AINARRES at the loop
# substrate; here we just need this poller's identity.
export AINARRES_TOKEN
AINARRES_TOKEN="$(mint_token "$POLLER")"

log() { echo "[$(date -u +%H:%M:%S) $POLLER] $*" >>"$LOG"; }

log "poller up (mode=$LOOP_MODE family=$(role_family "$POLLER") features=$(role_features "$POLLER"))"

sweeps=0
while [ ! -f "$STOP_FILE" ]; do
  sweeps=$((sweeps + 1))
  log "sweep $sweeps"
  # One sweep = the harness self-claims and works until its stage is empty, then
  # exits. A non-zero exit is logged but does not kill the poller — transient
  # harness/network failures are recovered by the next sweep + lazy reclaim.
  if ! harness_sweep "$POLLER" >>"$LOG" 2>&1; then
    log "sweep $sweeps: harness exited non-zero (will retry)"
  fi
  [ -f "$STOP_FILE" ] && break
  sleep "$POLL_INTERVAL"
done

log "poller stopped after $sweeps sweeps"
