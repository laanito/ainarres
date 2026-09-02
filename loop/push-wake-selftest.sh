#!/usr/bin/env bash
# Push-wake selftest (M28 Slice B / ADR 0027 D4-D5) — SUBSTRATE-FREE: no docker, no
# database, no ports. It stubs the LISTEN stream with WAKE_LISTEN_CMD and drives the
# wake primitives directly, so it can run anywhere, including while a real service is up
# on the loop substrate.
#
# What it pins: idle_wait must return on the EARLIER of {a notification, the poll
# interval}; a burst must coalesce to ONE wake; disabling push-wake must behave exactly
# like v7; and NO failure of the notification path may ever kill the service or hang it
# longer than the interval.
#
# Run: bash loop/push-wake-selftest.sh   (or `make push-wake-selftest`)
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Stand alone: define RUN_DIR ourselves (never the real loop/run) and source push-wake.sh
# directly. We do NOT source driver-lib.sh.
RUN_DIR="$TMP"
export RUN_DIR

# shellcheck source=/dev/null
. loop/push-wake.sh

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  ✗ $1"; }

# Reset the listener state between phases: stop whatever is up, then start fresh with the
# given WAKE_LISTEN_CMD stub.
reset_listener() {
  wake_listener_stop
  WAKE_LISTEN_CMD="$1"
  wake_listener_start
}

# Elapsed seconds since a `date +%s` start.
elapsed() { echo "$(( $(date +%s) - $1 ))"; }

echo "push-wake-selftest: idle_wait returns on the earlier of {notification, poll} (M28)"

# 1. WAKE ≪ POLL — a notification must wake well before the interval.
reset_listener 'sleep 1; echo dev'
t0="$(date +%s)"
idle_wait 30 >/dev/null 2>&1
d="$(elapsed "$t0")"
if [ "$d" -le 5 ]; then
  pass "wake ≪ poll: idle_wait 30 returned in ${d}s (≤5s) — did not wait for the interval"
else
  fail "wake ≪ poll: idle_wait 30 took ${d}s (>5s)"
fi

# 2. BACKSTOP INTACT — with no notification, the interval still bounds the wait.
reset_listener 'sleep 300'
t0="$(date +%s)"
idle_wait 3 >/dev/null 2>&1
d="$(elapsed "$t0")"
if [ "$d" -ge 3 ] && [ "$d" -le 6 ]; then
  pass "backstop intact: idle_wait 3 returned after ${d}s (≥3, ≤6) — the poll still bounds the wait"
else
  fail "backstop intact: idle_wait 3 returned after ${d}s (expected ≥3, ≤6)"
fi

# 3. COALESCING — a burst collapses to ONE wake, not five spurious ones.
reset_listener 'sleep 1; printf "dev\ndev\ndev\ndev\ndev\n"'
t0="$(date +%s)"
idle_wait 30 >/dev/null 2>&1
d1="$(elapsed "$t0")"
t0="$(date +%s)"
idle_wait 3 >/dev/null 2>&1
d2="$(elapsed "$t0")"
if [ "$d1" -le 5 ] && [ "$d2" -ge 3 ]; then
  pass "coalescing: first wake fast (${d1}s ≤5), second wait timed out (${d2}s ≥3) — burst became one wake"
else
  fail "coalescing: first=${d1}s (≤5), second=${d2}s (≥3) — got ${d1}s/${d2}s"
fi

# 4. DISABLED = V7 — LOOP_PUSH_WAKE=0 creates no FIFO, stays inactive, sleeps the interval.
wake_listener_stop
LOOP_PUSH_WAKE=0
rm -f "$WAKE_FIFO"
out="$(wake_listener_start 2>&1)"
if [ "$WAKE_ACTIVE" = "0" ] && [ ! -e "$WAKE_FIFO" ] && printf '%s' "$out" | grep -q "disabled"; then
  pass "disabled = v7: no FIFO, WAKE_ACTIVE=0, disabled state logged"
else
  fail "disabled = v7: WAKE_ACTIVE=$WAKE_ACTIVE, fifo=$([ -e "$WAKE_FIFO" ] && echo present || echo absent), out=$out"
fi
t0="$(date +%s)"
idle_wait 3 >/dev/null 2>&1
d="$(elapsed "$t0")"
if [ "$d" -ge 3 ] && [ "$d" -le 6 ]; then
  pass "disabled = v7: idle_wait 3 slept the full ${d}s (≥3, ≤6)"
else
  fail "disabled = v7: idle_wait 3 slept ${d}s (expected ≥3, ≤6)"
fi
LOOP_PUSH_WAKE=1

# 5. BROKEN LISTENER NEVER KILLS THE SERVICE — a listener that exits non-zero must still
#    leave wake_listener_start returning 0 and idle_wait falling back to the poll. Run
#    under `set -euo pipefail` so a stray non-zero return is caught as the failure it
#    would be in the supervisor.
wake_listener_stop
if bash -c '
  set -euo pipefail
  REPO="'"$REPO"'"
  RUN_DIR="'"$TMP"'"
  export RUN_DIR
  WAKE_LISTEN_CMD="exit 1"
  . "$REPO/loop/push-wake.sh"
  wake_listener_start
  t0="$(date +%s)"
  idle_wait 3 >/dev/null 2>&1
  d="$(( $(date +%s) - t0 ))"
  [ "$d" -ge 3 ] && [ "$d" -le 6 ]
'; then
  pass "broken listener: start returned 0, idle_wait 3 fell back to the poll (≈3s) under set -euo pipefail"
else
  fail "broken listener: a non-zero listener return killed the service or misbehaved"
fi

# 6. TEARDOWN IS CLEAN AND IDEMPOTENT.
reset_listener 'sleep 300'
pid="$WAKE_LISTENER_PID"
wake_listener_stop
if ! kill -0 "$pid" 2>/dev/null && [ ! -e "$WAKE_FIFO" ]; then
  pass "teardown: listener pid gone and FIFO removed"
else
  fail "teardown: listener still alive or FIFO still present"
fi
if wake_listener_stop >/dev/null 2>&1; then
  pass "teardown: second wake_listener_stop is silent and returns 0"
else
  fail "teardown: second wake_listener_stop did not return 0"
fi

# 7. NO FIFO / MISSING LISTENER DOES NOT HANG — remove the FIFO under a live WAKE_ACTIVE=1
#    and assert idle_wait still returns within ~6s.
reset_listener 'sleep 300'
rm -f "$WAKE_FIFO"
t0="$(date +%s)"
idle_wait 3 >/dev/null 2>&1
d="$(elapsed "$t0")"
if [ "$d" -le 6 ]; then
  pass "no fifo: idle_wait 3 returned within ${d}s (≤6) — no hang"
else
  fail "no fifo: idle_wait 3 took ${d}s (>6) — hung"
fi
wake_listener_stop

if [ "$FAIL" = 0 ]; then
  echo "✓ push-wake-selftest PASSED"
  exit 0
fi
echo "✗ push-wake-selftest FAILED"
exit 1
