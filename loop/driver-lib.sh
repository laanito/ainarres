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

# One merged JSON array of board rows across every lane this run works (roles.sh
# LOOP_LANES — (dev) for the batch driver, (dev intake) for the standing service). Every
# reader below goes through here, so a lane absent from LOOP_LANES is invisible to the
# demand gate — which is exactly why the service adds `intake`.
# Returns 1 if ANY lane read failed, so a caller can tell "unreachable" from "drained"
# (the 2026-07-04 board-wipe lesson: a failed read must never look like an empty board).
# Collect through a TEMP FILE, never a nested pipeline. The obvious shape —
#   out="$(ai board …)"        … then …        printf '%s' "$buf" | node -e …
# put a command substitution and a pipeline inside a function that its callers ALSO pipe
# into node (counts/board_total/board_sig all do `board_rows | node`). That nesting made the
# supervisor hang INTERMITTENTLY after an activation: a command substitution or pipe stage
# waits for EOF, EOF needs every write end closed, and any process that inherited one — a
# grandchild of a `node` invocation, a straggler from the round just finished — holds it
# open. When it happened the service stopped ticking entirely while still alive: no crash,
# no log line, just a supervisor that never looks at the board again. For an unattended
# process that is the worst failure shape there is.
#
# Redirect-to-file has no EOF handshake, so the class cannot occur. The cost is one temp
# file per board read; the benefit is a poll loop that cannot wedge.
board_rows() {
  local lane rc=0
  : > "$BOARD_RAW"
  for lane in "${LOOP_LANES[@]}"; do
    if ai board --lane "$lane" --token "$OVERSIGHT_TOKEN" >>"$BOARD_RAW" 2>/dev/null; then
      printf '\n' >>"$BOARD_RAW"
    else
      rc=1
    fi
  done
  node -e 'const fs=require("fs");const rows=[];for(const line of fs.readFileSync(process.argv[1],"utf8").split("\n")){const t=line.trim();if(!t)continue;let r;try{r=JSON.parse(t)}catch{continue}if(Array.isArray(r))rows.push(...r)}fs.writeFileSync(process.argv[2],JSON.stringify(rows))' \
    "$BOARD_RAW" "$BOARD_JSON" 2>/dev/null || { echo "[]" > "$BOARD_JSON"; rc=1; }
  return "$rc"
}

# One board read per tick, through FILES — no pipelines, no command substitution around a
# pipeline, anywhere in the poll loop.
#
# WHY THIS SHAPE. The obvious bash idiom is `x="$(fn)"` where `fn` ends in `… | node`. Both
# halves are EOF handshakes: the substitution waits for every write end of its pipe to close,
# and so does each pipe stage. Any process that inherited one holds it open — a grandchild of
# a node invocation, a straggler from the round just finished. When that happened here the
# supervisor STOPPED TICKING while still alive: no crash, no log line, no status update, just
# a process that never looks at the board again. Intermittent, and invisible until you notice
# nothing has moved for an hour. For an unattended service that is the worst failure shape
# there is, so the construct is gone rather than tuned.
#
# It is also cheaper: the tick used to fetch the board THREE times (counts, board_total,
# board_sig) and start three node processes. Now it fetches once and each reader parses the
# same snapshot file.
board_refresh() {
  board_rows
}

# active + blocked counts from the current snapshot. Prints "A B".
counts() {
  node -e 'const fs=require("fs");let r=[];try{r=JSON.parse(fs.readFileSync(process.argv[1],"utf8"))}catch{r=[]};if(!Array.isArray(r))r=[];const a=r.filter(x=>!x.is_terminal&&!x.blocked).length;const b=r.filter(x=>x.blocked).length;process.stdout.write(a+" "+b)' "$BOARD_JSON" 2>/dev/null || echo "0 0"
}

# Total rows + whether the read SUCCEEDED. Prints "N R" (R=0 ⇒ unreachable, never "drained").
board_total() {
  local rc=0
  board_refresh || rc=1
  if [ "$rc" -ne 0 ]; then echo "0 0"; return; fi
  node -e 'const fs=require("fs");let r=[];try{r=JSON.parse(fs.readFileSync(process.argv[1],"utf8"))}catch{r=[]};if(!Array.isArray(r))r=[];process.stdout.write(r.length+" 1")' "$BOARD_JSON" 2>/dev/null || echo "0 0"
}

# A stable signature of the snapshot (task → stage/blocked): unchanged after a full round
# ⇒ nothing moved.
board_sig() {
  node -e 'const fs=require("fs");let r=[];try{r=JSON.parse(fs.readFileSync(process.argv[1],"utf8"))}catch{r=[]};if(!Array.isArray(r))r=[];process.stdout.write(r.map(x=>x.task_id+":"+x.stage+":"+(x.blocked?"b":"")).sort().join("|"))' "$BOARD_JSON" 2>/dev/null || true
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
  rm -f "$BOARD_RAW" "$BOARD_JSON" >/dev/null 2>&1 || true
}

# If a finished sweep left a task claimed (it stopped without advancing OR releasing —
# e.g. it implemented but never committed), release it so the next tier/round can pick
# it up. Safe because a sweep is SERIALIZED with respect to its own worker: when the
# sweep returns, that worker is provably done, so any task it still holds is stranded.
# release bumps `attempts`, which feeds M12 escalation — exactly the right effect.
release_stranded() {
  local sub="$1" tok="$2" held
  board_refresh
  held="$(node -e 'const fs=require("fs");const sub=process.argv[2];let r=[];try{r=JSON.parse(fs.readFileSync(process.argv[1],"utf8"))}catch{r=[]};if(!Array.isArray(r))r=[];const t=r.find(x=>x.claimed_by===sub&&!x.is_terminal);process.stdout.write(t?t.task_id:"")' "$BOARD_JSON" "$sub")"
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

# A pool member that claimed nothing leaves a log holding only its worktree line — by v8,
# 189 per-sweep files had piled up in loop/run/, 125 of them under 100 bytes, which makes
# the directory useless for eyeballing the run that matters. Drop those, and ONLY those:
# pruning requires the sweep to have exited 0, so a short log that is short BECAUSE the
# harness failed (e.g. "opencode: not found") is always kept. Opt out with
# LOOP_KEEP_EMPTY_LOGS=1.
prune_noop_log() {
  local f="$1" rc="${2:-0}" size
  [ "${LOOP_KEEP_EMPTY_LOGS:-0}" = "1" ] && return 0
  [ "$rc" -eq 0 ] || return 0
  [ -f "$f" ] || return 0
  size="$(wc -c < "$f" 2>/dev/null | tr -d ' ')"
  [ "${size:-0}" -le 200 ] && rm -f "$f"
  return 0
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
  local mrc
  for i in "${!pids[@]}"; do
    mrc=0
    wait "${pids[$i]}" || mrc=$?           # a member failing is fine; the board is the truth
    record_usage "$tier" "${subs[$i]}" "$RUN_DIR/$tier-${subs[$i]}.log"
    release_stranded "${subs[$i]}" "${toks[$i]}"
    prune_noop_log "$RUN_DIR/$tier-${subs[$i]}.log" "$mrc"
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

# ── Consume governance (design/service.md D6) — skip a temp-banned family ─────
# The standing service reads the SAME revocation the substrate already enforces
# (api.governance_status, M21/M22) and declines to SPAWN a family that is banned for a
# capability its role needs — pure waste-avoidance (a spawned-anyway banned family would
# just fail to claim). This is CONSUMING governance, never ROUTING: it only says "don't
# launch this useless worker", never "send this task to that worker".
#
# Best-effort + resilient (the M18/M19 measured-not-enforced rule): an unreadable
# governance_status degrades to "spawn anyway" so a governance outage never stalls the
# loop. Gated by LOOP_CONSUME_GOVERNANCE (the SERVICE sets =1; the batch driver leaves it
# unset → refresh is skipped, GOV_BANNED stays empty → skip_if_banned always proceeds →
# the batch driver's behaviour is byte-for-byte unchanged).
GOV_BANNED=""     # newline-separated "family|capability" pairs currently banned=true

# Refresh GOV_BANNED from api.governance_status (oversight token). Best-effort: any
# error / non-array / empty leaves GOV_BANNED empty (→ nobody skipped). Called once per
# round so a ban that heals (or appears) between rounds is picked up next round.
refresh_governance() {
  GOV_BANNED="$(ai governance-status --token "$OVERSIGHT_TOKEN" 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let r;try{r=JSON.parse(s)}catch{r=[]};if(!Array.isArray(r))r=[];process.stdout.write(r.filter(x=>x&&x.banned===true).map(x=>x.family+"|"+x.capability).join("\n"))})' || true)"
  [ -n "$GOV_BANNED" ] && echo "  ↳ governance: banned $(printf '%s' "$GOV_BANNED" | tr '\n' ',' | sed 's/,$//')"
  return 0
}

# skip_if_banned <poller>: return 0 (SKIP) iff the poller's FAMILY is banned for a
# capability its ROLE uses (role_family + role_features vs the cached GOV_BANNED);
# return 1 (PROCEED) otherwise. Matches on the tier's actual role features, so a family
# banned for one capability (e.g. grok for capability:integrate) is only skipped for the
# tier that needs THAT capability, not over-skipped.
skip_if_banned() {
  local poller="$1" fam cap
  [ -n "$GOV_BANNED" ] || return 1        # no bans (or read failed/unused) → proceed
  fam="$(role_family "$poller")"
  local IFS=','
  for cap in $(role_features "$poller"); do
    [ -n "$cap" ] || continue
    if printf '%s\n' "$GOV_BANNED" | grep -qxF "$fam|$cap"; then
      return 0                            # banned for a capability this poller needs → skip
    fi
  done
  return 1
}

# Where each tick's board snapshot lands (raw concatenation + merged JSON), keyed by PID.
# Per-process on purpose: a fixed path is shared state between any two runtimes pointed at
# the same RUN_DIR — a service and a batch driver, or two services — and then one reads a
# snapshot the other took. That produced a board read of "0 active" while three tasks sat at
# `proposed`, which the service correctly (and uselessly) treated as drained.
BOARD_RAW="${RUN_DIR:-/tmp}/.board-raw.$$.json"
BOARD_JSON="${RUN_DIR:-/tmp}/.board.$$.json"

# ── M27: demand-shaped scaling (v7.1 · ADR 0026 · design/precise-service.md D2) ──
# v7 spawned EVERY configured tier whenever the board had any claimable task at all: one
# task at `reviewing` booted the whole implementer pool, a process start and a model session
# each, for workers that would find nothing to claim. Every one of those was paid in tokens.
#
# The fix has two halves that meet here. The substrate says WHAT IS WAITING, in capability
# terms only (api.demand — bundles + counts, no task, no worker, no tier). The service says
# WHAT IT CAN RUN (roles.sh::role_features, filtered to backends that answer). A tier is
# spawned iff some demanded bundle ⊆ its features, it is live, and it is not banned.
#
# THE BRIGHT LINE (ADR 0026 / vision): this reads counts by capability bundle — never a
# task's id, priority, subject or content, and never to pick a winner among capable families.
# Tiers still self-claim via SKIP LOCKED. The service decides only WHICH KINDS of live worker
# to launch. The moment it reads task content to prefer one capable family over another, it
# is routing, and routing is the orchestrator this project exists to abolish.
#
# EVERY PART DEGRADES TO SPAWN-ANYWAY. Demand unreadable (view absent, request failed) ⇒
# every live tier counts as demanded. Probe unavailable ⇒ the tier counts as live. Either
# outage collapses to v7's coarse gate: an outage changes cost, never correctness.
#
# Bash 3.2 (macOS) has no associative arrays, so both maps are newline-delimited strings.
LOOP_CONSUME_DEMAND="${LOOP_CONSUME_DEMAND:-1}"   # 0 = v7 behaviour (spawn every tier)
CAPMAP_DOWN=""      # newline-separated "tier|why"
DEMAND=""           # newline-separated "count|feat,feat,…"  (bundle features sorted)
UNSERVICEABLE=""    # newline-separated "count|feat,feat,…|cause"
UNSERVICEABLE_LOGGED=""   # what we last said out loud, so a standing condition is said ONCE

# Every tier this run could spawn, deduped, in no particular order.
all_tiers() {
  printf '%s\n' "${LOOP_DESIGN_TIERS[@]:-}" "${LOOP_PRE_TIERS[@]:-}" "$LOOP_POOL_TIER" \
                 "${LOOP_SERIAL_TIERS[@]:-}" "${LOOP_FRONTIER_PEERS[@]:-}" \
    | awk 'NF && !seen[$0]++'
}

tier_is_live() {
  printf '%s\n' "$CAPMAP_DOWN" | grep -q "^$1|" && return 1
  return 0
}

# Mark a tier unreachable until the next re-probe. Called when a sweep EXITS NON-ZERO —
# which is how a retired CLOUD model gets caught (the probe can only see local reachability;
# qwen3-coder-next answered 410 on every activation for six weeks and was spawned every time).
mark_tier_down() {
  local tier="$1" why="${2:-sweep exited non-zero}"
  tier_is_live "$tier" || return 0
  CAPMAP_DOWN="$(printf '%s\n%s' "$CAPMAP_DOWN" "$tier|$why" | awk 'NF')"
  echo "  ↳ capability map: '$tier' marked DOWN ($why) — not spawned again until re-probe"
}

# Probe every configured tier once, at start. Best-effort and timeboxed inside tier_probe;
# an unknown answer means LIVE.
build_capability_map() {
  local tier down=""
  CAPMAP_DOWN=""
  for tier in $(all_tiers); do
    tier_probe "$tier" || down="$(printf '%s\n%s' "$down" "$tier|backend unreachable at start" | awk 'NF')"
  done
  CAPMAP_DOWN="$down"
  if [ -n "$CAPMAP_DOWN" ]; then
    echo "→ capability map: DOWN → $(printf '%s' "$CAPMAP_DOWN" | cut -d'|' -f1 | tr '\n' ',' | sed 's/,$//')"
  fi
  return 0
}

# Re-probe only the tiers currently marked down: a backend that comes back is picked up with
# no restart (a model finishing a pull, ollama restarted, a key renewed).
refresh_capability_map() {
  local entry tier still=""
  [ -n "$CAPMAP_DOWN" ] || return 0
  while IFS= read -r entry; do
    [ -n "$entry" ] || continue
    tier="${entry%%|*}"
    if tier_probe "$tier"; then
      echo "  ↳ capability map: '$tier' is reachable again — back in service"
    else
      still="$(printf '%s\n%s' "$still" "$entry" | awk 'NF')"
    fi
  done <<< "$CAPMAP_DOWN"
  CAPMAP_DOWN="$still"
  return 0
}

# Read api.demand → DEMAND. Unreadable (no view, no substrate, error) leaves it EMPTY, which
# tier_has_demand reads as "everything is demanded" — the v7 gate.
refresh_demand() {
  [ "${LOOP_CONSUME_DEMAND:-1}" = "1" ] || { DEMAND=""; return 0; }
  DEMAND="$(ai demand --token "$OVERSIGHT_TOKEN" 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let r;try{r=JSON.parse(s)}catch{r=[]};if(!Array.isArray(r))r=[];process.stdout.write(r.filter(x=>x&&Array.isArray(x.bundle)).map(x=>x.pending+"|"+x.bundle.slice().sort().join(",")).join("\n"))})' || true)"
  return 0
}

# Is every feature of $2 (comma-separated) present in $1 (comma-separated)?
features_subset() {
  local hay=",$1," f
  local IFS=','
  for f in $2; do
    [ -n "$f" ] || continue
    case "$hay" in *",$f,"*) ;; *) return 1 ;; esac
  done
  return 0
}

# Does any demanded bundle fit inside this tier's features? Empty DEMAND ⇒ yes (degrade).
tier_has_demand() {
  local tier="$1" feats line
  [ -n "$DEMAND" ] || return 0
  feats="$(role_features "$tier")"
  [ -n "$feats" ] || return 1
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    features_subset "$feats" "${line#*|}" && return 0
  done <<< "$DEMAND"
  return 1
}

# The largest demanded count this tier can serve — the implementer pool's floor. Empty
# DEMAND ⇒ the configured pool size (degrade to v7).
demand_count_for() {
  local tier="$1" feats line best=0 n
  [ -n "$DEMAND" ] || { echo "$LOOP_POOL_SIZE"; return 0; }
  feats="$(role_features "$tier")"
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    n="${line%%|*}"
    if features_subset "$feats" "${line#*|}"; then
      [ "$n" -gt "$best" ] && best="$n"
    fi
  done <<< "$DEMAND"
  echo "$best"
  # `return 0` is load-bearing, not tidiness. Without it this function inherits the status of
  # its last comparison — 1 whenever the final bundle did not raise `best` — and the caller's
  # `pool_n="$(demand_count_for …)"` is a plain assignment, so under `set -e` the SUPERVISOR
  # EXITS. It did: the service vanished mid-run leaving its status file frozen on the last
  # good tick, which reads exactly like a hang. Every helper here returns explicitly for the
  # same reason.
  return 0
}

# The one gate every spawn passes: live, demanded, not banned. Prints WHY when it declines,
# so a quiet round is legible rather than mysterious.
should_spawn() {
  local tier="$1" round="${2:-}"
  if ! tier_is_live "$tier"; then
    echo "→ round $round: SKIP '$tier' — backend unreachable (capability map)"; return 1
  fi
  if skip_if_banned "$tier"; then
    echo "→ round $round: SKIP '$tier' — family banned (consuming governance)"; return 1
  fi
  if ! tier_has_demand "$tier"; then
    echo "→ round $round: SKIP '$tier' — no pending work needs its capabilities (demand-shaped)"; return 1
  fi
  return 0
}

# Is ANY demanded bundle served by a live tier? Empty demand ⇒ yes (degrade to v7: the
# service activates and the tiers sort it out). Used by the standing service to decline an
# activation it already knows nothing can move — the D3 "predictive, no wasted fleet-spawn".
has_serviceable_demand() {
  local line tier feats
  [ -n "$DEMAND" ] || return 0
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    for tier in $(all_tiers); do
      tier_is_live "$tier" || continue
      feats="$(role_features "$tier")"
      [ -n "$feats" ] || continue
      features_subset "$feats" "${line#*|}" && return 0
    done
  done <<< "$DEMAND"
  return 1
}

# Demanded bundles that NO live tier can serve, split by cause (design D3). Predictive: the
# service names them without burning an activation to discover them, and holds rather than
# spinning. Narrows `stalled` to its true meaning — "a live, capable family kept failing".
compute_unserviceable() {
  local line bundle count tier feats served_live served_cfg out=""
  UNSERVICEABLE=""
  [ -n "$DEMAND" ] || return 0
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    count="${line%%|*}"; bundle="${line#*|}"
    served_live=0; served_cfg=""
    for tier in $(all_tiers); do
      feats="$(role_features "$tier")"
      [ -n "$feats" ] || continue
      if features_subset "$feats" "$bundle"; then
        served_cfg="$tier"
        tier_is_live "$tier" && { served_live=1; break; }
      fi
    done
    [ "$served_live" = "1" ] && continue
    if bundle_is_human_held "$bundle"; then
      # THE THIRD CAUSE, which the design note could not foresee: some capabilities are
      # unseated ON PURPOSE because a person holds them (roles.sh::LOOP_HUMAN_FEATURES —
      # role:intaker, role:auditor). Advising "seat a family" here would be advice to
      # dismantle the human boundary M24/M22 deliberately built. The work is not
      # unserviceable; it is waiting for you.
      out="$(printf '%s\n%s' "$out" "$count|$bundle|awaiting a human|this capability is human-held by design; a person must act" | awk 'NF')"
    elif [ -n "$served_cfg" ]; then
      out="$(printf '%s\n%s' "$out" "$count|$bundle|unserviceable|the family that provides it is unreachable ($served_cfg is down)" | awk 'NF')"
    else
      out="$(printf '%s\n%s' "$out" "$count|$bundle|unserviceable|no configured family provides it; seat one" | awk 'NF')"
    fi
  done <<< "$DEMAND"
  UNSERVICEABLE="$out"
  # Say it when it CHANGES, not on every poll: an idle service re-reads demand every
  # LOOP_IDLE_POLL_SECS, and a standing condition repeated 240 times an hour is noise that
  # buries the run it sits beside.
  if [ -n "$UNSERVICEABLE" ] && [ "$UNSERVICEABLE" != "$UNSERVICEABLE_LOGGED" ]; then
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      printf '%s\n' "$line" | awk -F'|' '{printf "⚠ %s: %s task(s) need {%s} — %s\n", $3, $1, $2, $4}' >&2
    done <<< "$UNSERVICEABLE"
  fi
  UNSERVICEABLE_LOGGED="$UNSERVICEABLE"
  return 0
}

# Does this bundle's demand rest on a capability a PERSON holds (roles.sh::LOOP_HUMAN_FEATURES)?
bundle_is_human_held() {
  local bundle="$1" f h
  local IFS=','
  for f in $bundle; do
    for h in "${LOOP_HUMAN_FEATURES[@]:-}"; do
      [ -n "$h" ] && [ "$f" = "$h" ] && return 0
    done
  done
  return 1
}

# The single worst cause currently outstanding, for the service's status note.
unserviceable_summary() {
  [ -n "$UNSERVICEABLE" ] || return 0
  printf '%s' "$UNSERVICEABLE" | head -1 \
    | awk -F'|' '{printf "%s: %s task(s) need {%s} — %s", $3, $1, $2, $4}' || true
  return 0
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
  local round=0 before after active blocked tier pool_n
  while true; do
    [ "${DRAINING:-0}" = 1 ] && return 3
    round=$((round + 1))
    board_refresh
    before="$(board_sig)"
    # Consume governance (D6): refresh the banned set once per round (service only —
    # LOOP_CONSUME_GOVERNANCE; the batch driver leaves GOV_BANNED empty so skip_if_banned
    # always proceeds and behaviour is unchanged).
    [ "${LOOP_CONSUME_GOVERNANCE:-0}" = 1 ] && refresh_governance
    # M27: what is waiting (capability terms) and what can still answer. Both degrade to
    # "spawn anyway" when unavailable, so a failure here costs money, never correctness.
    refresh_capability_map
    refresh_demand
    compute_unserviceable
    # Design pass (LOOP_DESIGN_TIERS — empty for the BATCH driver, which decomposes the
    # brief ONCE upfront; ('designer') for the standing SERVICE, where decomposition is
    # CONTINUOUS — proposed dev tasks and, later, accepted intake briefs keep arriving and
    # must be decomposed each round before the implementers can claim them). A designer
    # sweep with no brief just advances/decomposes whatever proposed work is on the board.
    for tier in "${LOOP_DESIGN_TIERS[@]:-}"; do
      [ -n "$tier" ] || continue
      should_spawn "$tier" "$round" || continue
      echo "→ round $round: design tier '$tier' sweeping…"
      if ! run_sweep "$tier"; then
        echo "  (design tier '$tier' sweep exited non-zero — continuing)"
        mark_tier_down "$tier"
      fi
    done
    # Tier-0 pre-pass: cheapest implementer(s) drain what they can BEFORE the pool fans
    # out (roles.sh::LOOP_PRE_TIERS). Single serial sweeps (a 1-session backend belongs
    # here, never in the ×LOOP_POOL_SIZE pool).
    for tier in "${LOOP_PRE_TIERS[@]:-}"; do
      [ -n "$tier" ] || continue
      should_spawn "$tier" "$round" || continue
      echo "→ round $round: pre-pool tier '$tier' sweeping…"
      if ! run_sweep "$tier"; then
        echo "  (pre-pool tier '$tier' sweep exited non-zero — continuing)"
        mark_tier_down "$tier"
      fi
    done
    if should_spawn "$LOOP_POOL_TIER" "$round"; then
      # The pool sizes to demand: one pending task spawns ONE implementer, not three. The
      # LOOP_POOL_SIZE cap is unchanged; only the floor now tracks what is waiting.
      pool_n="$(demand_count_for "$LOOP_POOL_TIER" || echo "$LOOP_POOL_SIZE")"
      [ "$pool_n" -gt "$LOOP_POOL_SIZE" ] && pool_n="$LOOP_POOL_SIZE"
      [ "$pool_n" -lt 1 ] && pool_n=1
      echo "→ round $round: ${pool_n} concurrent '${LOOP_POOL_TIER}' implementers (cap ${LOOP_POOL_SIZE})…"
      run_pool "$LOOP_POOL_TIER" "$pool_n"
    fi
    for tier in "${LOOP_SERIAL_TIERS[@]}"; do
      should_spawn "$tier" "$round" || continue
      echo "→ round $round: tier '$tier' sweeping…"
      if ! run_sweep "$tier"; then
        echo "  (tier '$tier' sweep exited non-zero — continuing)"
        mark_tier_down "$tier"
      fi
    done
    # Frontier peers: filter out any banned peer, run the rest concurrently.
    local peers=() p
    for p in "${LOOP_FRONTIER_PEERS[@]}"; do
      if should_spawn "$p" "$round"; then peers+=("$p"); fi
    done
    if [ "${#peers[@]}" -gt 0 ]; then
      echo "→ round $round: frontier peers concurrently: ${peers[*]}…"
      run_concurrent "${peers[@]}"
    else
      echo "→ round $round: no frontier peer to spawn this round (no demand, banned, or unreachable)"
    fi
    board_refresh
    read -r active blocked <<<"$(counts)"
    after="$(board_sig)"
    echo "  round $round complete: ${active} active, ${blocked} blocked"
    ACTIVATION_ACTIVE="$active"; ACTIVATION_BLOCKED="$blocked"; ACTIVATION_ROUNDS="$round"
    if [ "$active" -eq 0 ]; then return 0; fi
    if [ "$after" = "$before" ]; then return 1; fi
    if [ "$round" -ge "$LOOP_MAX_ROUNDS" ]; then return 2; fi
  done
}
