#!/usr/bin/env bash
# loop/push-wake.sh — the supervisor's wake primitives (ADR 0027 / design/precise-service.md
# D4-D5). Sourced by loop/service.sh ONLY; never executed directly.
#
# What push-wake is: an OPTIMIZATION OVER the interval poll, never instead of it. The
# standing supervisor idles by `sleep "$LOOP_IDLE_POLL_SECS"` and therefore notices new work
# up to a full interval late. ADR 0027 replaces that sleep with "wait for the EARLIER of {a
# database notification, the poll interval}" — the board fires `pg_notify('ainarres_activity',
# <lane key>)` (the M28 substrate trigger), this file listens, and the supervisor wakes at
# once. The poll STAYS as a permanent backstop: every failure of the notification path must
# degrade to exactly today's behaviour — sleep the interval. Never hang, never error out,
# never longer than the interval.
#
# The LISTEN connection is SERVICE-side infrastructure only, on the correct side of the
# harness guard (loop/guard-bin denies psql/docker/make to harness children). It must never
# be reachable by a harness child, and the zero-dependency agent CLI (bin/ainarres.mjs) must
# not grow a pg driver. Nothing here belongs in bin/ or in a harness wrapper.
#
# The batch driver (loop/driver.sh, `make loop-run`) stays byte-for-byte v7 and must NOT
# source this file — the LISTEN lives only here and only for the supervisor.
#
# SAFETY CONTRACT (the supervisor runs under `set -euo pipefail`): every function here
# returns 0 in every reachable case — a non-zero return would KILL the standing service.
# A broken listener, a vanished FIFO, a non-integer interval: all degrade to the poll.

WAKE_CHANNEL="${WAKE_CHANNEL:-ainarres_activity}"     # must match the substrate trigger
LOOP_PUSH_WAKE="${LOOP_PUSH_WAKE:-1}"                 # 0 = poll only (v7 behaviour)
WAKE_FIFO="${WAKE_FIFO:-$RUN_DIR/wake.fifo}"          # RUN_DIR comes from driver-lib.sh
WAKE_FD=9
WAKE_DRAIN_SECS="${WAKE_DRAIN_SECS:-1}"               # coalescing window after a wake
WAKE_ACTIVE=0                                          # 1 while the listener is up
WAKE_LISTENER_PID=""
WAKE_LISTEN_CMD="${WAKE_LISTEN_CMD:-}"                # test/override hook; empty = default

# ── The listener stream ────────────────────────────────────────────────────────
# Writes ONE line to stdout per notification, forever. If $WAKE_LISTEN_CMD is non-empty,
# `eval` that instead (the seam the selftest and a future non-docker deployment use).
#
# The default implementation streams an endless series of short statements into a psql
# session inside the loop db container, and filters psql's notification lines. psql only
# reports notifications between statements, so the endless `pg_sleep(0.5)` stream bounds
# delivery latency at ~0.5s. `awk … fflush()` keeps the pipeline line-buffered (BSD awk on
# macOS supports fflush). `exec -T` and an explicit stdin from the generator matter — the
# listener must never inherit and steal the supervisor's stdin (a documented trap in
# loop/service-selftest.sh).
wake_listen_stream() {
  if [ -n "$WAKE_LISTEN_CMD" ]; then
    eval "$WAKE_LISTEN_CMD"
    return 0
  fi
  { echo "listen $WAKE_CHANNEL;"; while :; do echo "select pg_sleep(0.5);"; done; } \
    | docker compose -p ainarres-loop --env-file "$REPO/loop.env" exec -T db \
        psql -X -U "$POSTGRES_USER" -d "$POSTGRES_DB" 2>/dev/null \
    | awk '/Asynchronous notification/ { print "wake"; fflush() }'
  return 0
}

# ── Listener lifecycle ─────────────────────────────────────────────────────────
# Start the listener + FIFO. If LOOP_PUSH_WAKE != 1: log the disabled state, WAKE_ACTIVE=0,
# return 0 (verbatim v7). Otherwise set up the FIFO and background the listener. ANY failure
# along the way: log a degrade, WAKE_ACTIVE=0, and STILL return 0 — a broken listener must
# never stop the service from starting.
wake_listener_start() {
  if [ "${LOOP_PUSH_WAKE:-1}" != "1" ]; then
    echo "push-wake disabled — interval poll only"
    WAKE_ACTIVE=0
    return 0
  fi
  local fifo_dir
  fifo_dir="$(dirname "$WAKE_FIFO")"
  if ! mkdir -p "$fifo_dir" 2>/dev/null; then
    echo "push-wake DEGRADE: cannot mkdir $fifo_dir — interval poll only"
    WAKE_ACTIVE=0
    return 0
  fi
  rm -f "$WAKE_FIFO" 2>/dev/null || true
  if ! mkfifo "$WAKE_FIFO" 2>/dev/null; then
    echo "push-wake DEGRADE: cannot mkfifo $WAKE_FIFO — interval poll only"
    WAKE_ACTIVE=0
    return 0
  fi
  # Open the FIFO read-write on the fixed fd (bash 3.2 has no dynamic fds). The read-write
  # open succeeds immediately, and the supervisor is itself a writer so the fd never hits
  # EOF. Opening read-only would BLOCK until a writer appeared — the hang this fd trick
  # exists to avoid.
  if ! exec 9<>"$WAKE_FIFO" 2>/dev/null; then
    echo "push-wake DEGRADE: cannot open $WAKE_FIFO — interval poll only"
    rm -f "$WAKE_FIFO" 2>/dev/null || true
    WAKE_ACTIVE=0
    return 0
  fi
  # Start the listener, its stdout fed into the FIFO. The self-held fd guarantees the
  # writer's open does not block.
  wake_listen_stream >>"$WAKE_FIFO" 2>/dev/null &
  WAKE_LISTENER_PID=$!
  WAKE_ACTIVE=1
  echo "push-wake live: listening on channel '$WAKE_CHANNEL' via $WAKE_FIFO"
  return 0
}

# Return 0 iff the listener is alive (pid set and kill -0 succeeds).
wake_listener_alive() {
  [ -n "$WAKE_LISTENER_PID" ] || return 1
  kill -0 "$WAKE_LISTENER_PID" 2>/dev/null
}

# Stop the listener and clean up. Idempotent: calling it twice, or with no listener ever
# started, must be silent and return 0.
wake_listener_stop() {
  if [ -n "$WAKE_LISTENER_PID" ]; then
    pkill -P "$WAKE_LISTENER_PID" 2>/dev/null || true
    kill "$WAKE_LISTENER_PID" 2>/dev/null || true
    WAKE_LISTENER_PID=""
  fi
  exec 9<&- 2>/dev/null || true
  rm -f "$WAKE_FIFO" 2>/dev/null || true
  WAKE_ACTIVE=0
  return 0
}

# ── idle_wait: the whole point ─────────────────────────────────────────────────
# Wait for the EARLIER of {a notification, the poll interval}. Return 0 ALWAYS.
#   <secs>   the poll interval (integer; bash 3.2 read -t rejects decimals)
#   [reason] optional log label
idle_wait() {
  local secs="$1" reason="${2:-}"
  # Coerce/validate <secs> to a non-negative integer so `read -t` never errors under set -e.
  case "$secs" in
    ''|*[!0-9]*) secs=0 ;;
  esac

  # Disabled, or no listener up → verbatim v7: sleep the interval.
  if [ "${LOOP_PUSH_WAKE:-1}" != "1" ] || [ "$WAKE_ACTIVE" != "1" ]; then
    if [ "${LOOP_PUSH_WAKE:-1}" = "1" ] && ! wake_listener_alive; then
      # Best-effort re-establish: the listener died. Log it, try once, fall back to the
      # pure poll — re-establishes on the next tick (D4).
      echo "push-wake DEGRADE: listener lost — re-establishing, interval poll only this tick"
      wake_listener_start
    fi
    sleep "$secs" || true
    return 0
  fi

  # If the listener died since the last call: log the loss once, WAKE_ACTIVE=0, fall into
  # the sleep branch above.
  if ! wake_listener_alive; then
    echo "push-wake DEGRADE: listener lost — interval poll only"
    WAKE_ACTIVE=0
    sleep "$secs" || true
    return 0
  fi

  # Otherwise wait on the FIFO for up to <secs>.
  local line rc
  if read -r -t "$secs" line <&9; then
    # A notification arrived. COALESCE: drain the burst so it becomes ONE wake.
    local drained
    while read -r -t "$WAKE_DRAIN_SECS" drained <&9; do :; done
    if [ -n "$reason" ]; then
      echo "push-wake: woke ($reason)${line:+ lane=$line}"
    else
      echo "push-wake: woke${line:+ lane=$line}"
    fi
    return 0
  fi
  rc=$?
  if [ "$rc" -gt 128 ]; then
    # Timeout — the backstop fired. Silent.
    return 0
  fi
  # Any other non-zero → broken stream. Log, WAKE_ACTIVE=0, return 0.
  echo "push-wake DEGRADE: stream error (rc=$rc) — interval poll only"
  WAKE_ACTIVE=0
  return 0
}
