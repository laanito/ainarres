#!/usr/bin/env bash
# loop/driver-lib.sh — the shared coordination primitives for the loop runtime
# (ADR 0024 / design/service.md). Sourced by BOTH entry points:
#   - loop/driver.sh  — the batch driver (decompose once → drain → EXIT; v3–v6)
#   - loop/service.sh — the standing supervisor (idle → wake → drain → idle; v7)
#
# v7 is an EVOLUTION, not a rewrite (ADR 0024): every spawn/reap/teardown primitive
# the standing service needs already existed inline in driver.sh. This file lifts them
# out verbatim so both entry points share ONE tested implementation, and adds the one
# genuinely new piece — run_activation(): one full "drain attempt" (the round loop),
# returning WHY it stopped so the caller decides what to do (the batch driver reports +
# exits; the service idles or, on a stall, waits — design/service.md D1/D3).
#
# Still makes NO routing/sequencing decision (ADR 0020/0024 — demand-scaler, never a
# router): it knows only the tier ORDER (roles.sh) and "did this round change the board."
#
# Contract for the caller (BEFORE sourcing / calling anything here):
#   - source loop.env and export AINARRES_BASE_URL + JWT_SECRET (CLI target + minting),
#   - source loop/roles.sh (LOOP_LANE, the tier arrays, mint_token, harness_sweep, …),
#   - set OVERSIGHT_TOKEN (mint_token oversight) and mkdir -p "$RUN_DIR",
#   - wire its OWN traps to call stop_active (the batch driver and the service want
#     different stop semantics; the teardown itself is shared, the wiring is not).

# Resolve the repo + the CLI the same way roles.sh does (idempotent if already set).
LIB_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${REPO:-$(cd "$LIB_HERE/.." && pwd)}"
AINARRES=(node "$REPO/bin/ainarres.mjs")
ai() { "${AINARRES[@]}" "$@"; }

# ── Board reads (all via the oversight board view — ADR 0009) ─────────────────

# active+blocked counts of the lane's tasks straight from the board view. Prints "A B".
counts() {
  ai board --lane "$LOOP_LANE" --token "$OVERSIGHT_TOKEN" 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let r;try{r=JSON.parse(s)}catch{r=[]} if(!Array.isArray(r))r=[]; const a=r.filter(x=>!x.is_terminal&&!x.blocked).length; const b=r.filter(x=>x.blocked).length; process.stdout.write(a+" "+b)})'
}

# Total tasks on the board + whether the board was REACHABLE. Prints "N R": N = total
# task rows (terminal ones included — a genuinely drained board still shows its `done`
# tasks), R = 1 if the board view responded (even empty), 0 if the call failed. Lets a
# caller tell "legitimately drained" from "wiped/unreachable" (the 2026-07-04 board-wipe):
# counts() alone reads 0 active/0 blocked for BOTH.
board_total() {
  local out rc
  out="$(ai board --lane "$LOOP_LANE" --token "$OVERSIGHT_TOKEN" 2>/dev/null)"; rc=$?
  if [ "$rc" -ne 0 ]; then echo "0 0"; return; fi
  printf '%s' "$out" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let r;try{r=JSON.parse(s)}catch{r=[]} if(!Array.isArray(r))r=[]; process.stdout.write(r.length+" 1")})'
}

# A stable signature of the board (task → stage/blocked). If a full round leaves this
# unchanged, no tier moved anything → the board is stuck (the batch driver stops; the
# service enters its `stalled` state and waits for the signature to change — a human
# intervening — design/service.md D3).
board_sig() {
  ai board --lane "$LOOP_LANE" --token "$OVERSIGHT_TOKEN" 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let r;try{r=JSON.parse(s)}catch{r=[]} if(!Array.isArray(r))r=[]; process.stdout.write(r.map(x=>x.task_id+":"+x.stage+":"+(x.blocked?"b":"")).sort().join("|"))})'
}

# ── Teardown (shared; each entry point wires its OWN trap to call stop_active) ─
CURRENT_SWEEP_PID=""
POOL_PIDS=()          # pids of the concurrent implementer pool currently in flight
_stopped=0

# Recursively kill a process and all its descendants (a sweep's harness spawns
# git/gh/node; a flat kill would orphan them). pgrep walks the tree (macOS+Linux).
kill_tree() {
  local pid="$1" sig="${2:-TERM}" child
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do kill_tree "$child" "$sig"; done
  kill "-$sig" "$pid" 2>/dev/null || true
}

# Stop the in-flight sweep(s) (if any). Idempotent. So Ctrl-C / kill of the driver or
# the service never leaves a harness doing git/gh work behind it.
stop_active() {
  [ "$_stopped" = 1 ] && return 0
  _stopped=1
  # Kill the single in-flight sweep (designer/fallback/frontier) AND every member of
  # the concurrent implementer pool — none may be left doing git/gh work.
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
  bash "$LIB_HERE/worktree.sh" gc >/dev/null 2>&1 || true
  # Per-sweep opencode state (M18): each implementer sweep parks its private
  # XDG_DATA_HOME under $RUN_DIR/xdg/<sweep>. Clear the tree here. Best-effort.
  rm -rf "$RUN_DIR/xdg" >/dev/null 2>&1 || true
}

# If a finished sweep left a task claimed (it stopped without advancing OR releasing —
# e.g. it implemented but never committed), release it so the next tier/round can pick
# it up. Safe because a sweep is SERIALIZED with respect to its own worker: when the
# sweep returns, that worker is provably done, so any task it still holds is stranded.
# release bumps `attempts`, which feeds M12 escalation — exactly the right effect.
release_stranded() {
  local sub="$1" tok="$2" held
  held="$(ai board --lane "$LOOP_LANE" --token "$OVERSIGHT_TOKEN" 2>/dev/null \
    | node -e 'let s="";const sub=process.argv[1];process.stdin.on("data",d=>s+=d).on("end",()=>{let r;try{r=JSON.parse(s)}catch{r=[]};if(!Array.isArray(r))r=[];const t=r.find(x=>x.claimed_by===sub&&!x.is_terminal);process.stdout.write(t?t.task_id:"")})' "$sub")"
  if [ -n "$held" ]; then
    echo "  ↳ tier left $held claimed without advancing — releasing it for the next tier."
    ai release "$held" --reason "worker sweep ended without advancing or releasing (stranded)" --token "$tok" >/dev/null 2>&1 || true
  fi
}

# M20 (design/track-record.md D1): record a finished sweep's TOKEN spend. Best-effort —
# NEVER fails the run. Writes nothing (noting the miss on stderr → usage.log) when the
# harness emits no parseable token counts or the sweep did no work — an unmeasured family
# reads as "unknown", never "free". $1=poller/tier (→ family), $2=worker sub, $3=sweep log.
record_usage() {
  local poller="$1" sub="$2" logf="$3"
  [ -n "$sub" ] && [ -f "$logf" ] || return 0
  ai record-usage --actor "$sub" --family "$(role_family "$poller")" \
     --from-log "$logf" --sweep "$sub" --token "$OVERSIGHT_TOKEN" \
     >/dev/null 2>>"$RUN_DIR/usage.log" || true
}

# ── Spawn primitives (backgrounded + reaped so a trap can kill the subtree) ────

# Run ONE tier's harness sweep to completion (its skill loops claim→work→advance until
# "nothing claimable", then exits). The token uses a KNOWN sub so we can release a claim
# the sweep stranded. $1 = tier, $2 = optional brief (the one-shot designer decompose).
run_sweep() {
  local tier="$1" brief="${2:-}" rc=0 sub tok
  sub="$(uuidgen | tr 'A-Z' 'a-z')"
  tok="$(mint_token "$tier" "$sub")"
  AINARRES_TOKEN="$tok" LOOP_SWEEP_ID="$sub" harness_sweep "$tier" "$brief" >>"$RUN_DIR/$tier.log" 2>&1 &
  CURRENT_SWEEP_PID=$!
  wait "$CURRENT_SWEEP_PID" || rc=$?
  CURRENT_SWEEP_PID=""
  record_usage "$tier" "$sub" "$RUN_DIR/$tier.log"
  release_stranded "$sub" "$tok"
  return "$rc"
}

# A concurrent pool of implementer sweeps of one tier (M18). SKIP LOCKED makes the
# concurrent pulls race-free; one-active-task-per-instance means N members hold ≤N tasks.
# Each member gets its own sub → its own M17 worktree and its own stranded-release.
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
    record_usage "$tier" "${subs[$i]}" "$RUN_DIR/$tier-${subs[$i]}.log"
    release_stranded "${subs[$i]}" "${toks[$i]}"
  done
  POOL_PIDS=()
}

# Run a set of DISTINCT frontier peers concurrently (M19): each concurrent sweep is a
# DIFFERENT poller (grok reviewer/integrator + the claude reviewer), so the frontier
# ROLE is federated — whoever is free claims the next reviewing task (SKIP LOCKED
# distributes). Only grok holds capability:integrate, so integration stays single.
run_concurrent() {
  local pollers=("$@") i name sub tok pids=() subs=() toks=() names=()
  for name in "${pollers[@]}"; do
    sub="$(uuidgen | tr 'A-Z' 'a-z')"
    tok="$(mint_token "$name" "$sub")"
    AINARRES_TOKEN="$tok" LOOP_SWEEP_ID="$sub" harness_sweep "$name" >>"$RUN_DIR/$name.log" 2>&1 &
    pids+=("$!"); subs+=("$sub"); toks+=("$tok"); names+=("$name")
  done
  POOL_PIDS=("${pids[@]}")                 # expose to stop_active for the kill trap
  for i in "${!pids[@]}"; do
    wait "${pids[$i]}" || true
    record_usage "${names[$i]}" "${subs[$i]}" "$RUN_DIR/${names[$i]}.log"
    release_stranded "${subs[$i]}" "${toks[$i]}"
  done
  POOL_PIDS=()
}

# ── run_activation: ONE full drain attempt (the round loop) ───────────────────
# The v3–v6 round loop, lifted verbatim: fan the primary cheap implementer into a pool
# (throughput), then the serial tiers once each, then the frontier peers concurrently;
# repeat until the board drains OR a full round moves nothing OR the round cap is hit.
# This is the "activation" of design/service.md: the batch driver runs it once per
# feature; the service runs it once per wake. It makes NO routing decision — the tiers
# self-claim via SKIP LOCKED; this only sequences the tier ORDER (roles.sh).
#
# Returns (echoing per-round progress on the way):
#   0 = DRAINED     — no active task left (the good end)
#   1 = NO_PROGRESS — a full round left the board signature unchanged (stuck)
#   2 = MAX_ROUNDS  — hit LOOP_MAX_ROUNDS without draining (safety bound)
#   3 = DRAINING    — a stop was requested (DRAINING=1) between rounds (service only)
# The round cap is the only hard bound, preserving the v3/M18 cost-control property
# (design/service.md D3). The DRAINING check honours the service's graceful stop
# (design/service.md D5): the CURRENT round's sweeps finish (they are synchronous and
# already reaped), but no NEW round starts. It is inert for the batch driver, which
# never sets DRAINING.
ACTIVATION_ACTIVE=0     # active count after the last round (readable by the caller)
ACTIVATION_BLOCKED=0    # blocked count after the last round
ACTIVATION_ROUNDS=0     # rounds this activation ran
run_activation() {
  local round=0 before after active blocked tier
  while true; do
    [ "${DRAINING:-0}" = 1 ] && return 3
    round=$((round + 1))
    before="$(board_sig)"
    # Design pass (LOOP_DESIGN_TIERS — empty for the BATCH driver, which decomposes the
    # brief ONCE upfront; ('designer') for the standing SERVICE, where decomposition is
    # CONTINUOUS — proposed dev tasks and, later, accepted intake briefs keep arriving and
    # must be decomposed each round before the implementers can claim them). A designer
    # sweep with no brief just advances/decomposes whatever proposed work is on the board.
    for tier in "${LOOP_DESIGN_TIERS[@]:-}"; do
      [ -n "$tier" ] || continue
      echo "→ round $round: design tier '$tier' sweeping…"
      run_sweep "$tier" || echo "  (design tier '$tier' sweep exited non-zero — continuing)"
    done
    # Tier-0 pre-pass: cheapest implementer(s) drain what they can BEFORE the pool fans
    # out (roles.sh::LOOP_PRE_TIERS). Single serial sweeps (a 1-session backend belongs
    # here, never in the ×LOOP_POOL_SIZE pool).
    for tier in "${LOOP_PRE_TIERS[@]:-}"; do
      [ -n "$tier" ] || continue
      echo "→ round $round: pre-pool tier '$tier' sweeping…"
      run_sweep "$tier" || echo "  (pre-pool tier '$tier' sweep exited non-zero — continuing)"
    done
    echo "→ round $round: ${LOOP_POOL_SIZE} concurrent '${LOOP_POOL_TIER}' implementers…"
    run_pool "$LOOP_POOL_TIER" "$LOOP_POOL_SIZE"
    for tier in "${LOOP_SERIAL_TIERS[@]}"; do
      echo "→ round $round: tier '$tier' sweeping…"
      run_sweep "$tier" || echo "  (tier '$tier' sweep exited non-zero — continuing)"
    done
    echo "→ round $round: frontier peers concurrently: ${LOOP_FRONTIER_PEERS[*]}…"
    run_concurrent "${LOOP_FRONTIER_PEERS[@]}"
    read -r active blocked <<<"$(counts)"
    after="$(board_sig)"
    echo "  round $round complete: ${active} active, ${blocked} blocked"
    ACTIVATION_ACTIVE="$active"; ACTIVATION_BLOCKED="$blocked"; ACTIVATION_ROUNDS="$round"
    if [ "$active" -eq 0 ]; then return 0; fi
    if [ "$after" = "$before" ]; then return 1; fi
    if [ "$round" -ge "$LOOP_MAX_ROUNDS" ]; then return 2; fi
  done
}
