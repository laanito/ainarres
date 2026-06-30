#!/usr/bin/env bash
# loop/roles.sh — the ONLY place that knows "which harness runs which role"
# (ADR 0020). Sourced by driver.sh. It is pure configuration: no coordination, no
# routing. The driver reads this and nothing here decides which task goes where —
# the substrate does that.
#
# Cast for v3 — worker TIERS in capability order (cheapest first):
#   cheap-implementer     opencode + big-pickle        role:implementer  (primary, free API)
#   fallback-implementer  opencode + nemotron-3-ultra  role:implementer  (fallback, free API)
#   frontier              grok + grok-build            designer/reviewer/integrator/escalated-impl
# The driver sweeps the tiers IN THIS ORDER each round (see driver.sh): each cheap
# tier drains the `implementing` work it can before the next runs, so the fallback
# only sees what the primary left (it down/depleted, or a task it failed) and the
# frontier only sees what both cheap tiers couldn't finish (review/integrate +
# M12-escalated tasks). Tiering — not concurrency — keeps the cheap tiers doing the
# heavy lifting with the frontier as the escalation ceiling. (qwen3.6, the local
# model, was dropped from the loop: it implemented correctly but didn't reliably
# COMPLETE the loop — commit/advance/release — so it stranded tasks.)
#
# LOOP_MODE=mock swaps every harness for loop/mock-harness.sh (a deterministic
# stand-in) and trims the frontier's implementer/tier:2 features so the mock test is
# fully deterministic (the cheap tier is the sole implementer). Escalation itself is
# unit-tested (test/escalation.test.ts) and exercised live in the M15 gate, not here.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AINARRES=(node "$REPO/bin/ainarres.mjs")
LOOP_LANE="dev"
LOOP_MODE="${LOOP_MODE:-real}"           # real | mock
RUN_DIR="${RUN_DIR:-$REPO/loop/run}"     # per-tier sweep logs (gitignored)

# Worker tiers, ordered LOW→HIGH capability. The driver sweeps them in this order
# each round. The two cheap (free-API) tiers each get a turn before a task escalates
# to the frontier (escalate_after = 2 on the dev implementing stage): big-pickle does
# the work; the nemotron fallback covers big-pickle being down/depleted AND retries a
# task it failed; grok is the escalation ceiling.
LOOP_TIERS=(cheap-implementer fallback-implementer frontier)

# M18 split (ADR 0021): the primary cheap implementer is FANNED OUT into a concurrent
# pool (LOOP_POOL_SIZE members per round — the swarm's throughput); the remaining tiers
# run once each, serially, AFTER the pool, preserving tiering (fallback covers the
# primary; frontier reviews/integrates + is the escalation ceiling). Integration stays
# single (the frontier integrator IS the merge queue, parallel-loop.md D2).
LOOP_POOL_TIER="${LOOP_POOL_TIER:-cheap-implementer}"
LOOP_SERIAL_TIERS=(fallback-implementer frontier)

# Token features per poller. The substrate trusts the signed token's features
# (minus denials) — ADR 0007 — so this is the authoritative capability grant for
# the run. In mock mode the frontier drops implementer/tier:2 (see header).
role_features() {
  case "$1" in
    cheap-implementer)    echo "lane:dev,role:implementer" ;;
    fallback-implementer) echo "lane:dev,role:implementer" ;;  # same role, different (free-API) model
    frontier)
      if [ "$LOOP_MODE" = "mock" ]; then
        echo "lane:dev,role:designer,role:reviewer,role:integrator,capability:integrate"
      else
        echo "lane:dev,role:designer,role:reviewer,role:integrator,capability:integrate,role:implementer,tier:2"
      fi ;;
    designer) echo "lane:dev,role:designer" ;;   # used for the one-shot brief hand-off
    oversight) echo "" ;;
    *) echo "" ;;
  esac
}

# Agent family (harness+model) for a poller — the durable identity (ADR 0007).
role_family() {
  case "$1" in
    cheap-implementer)    echo "opencode+big-pickle" ;;        # primary cheap implementer (free API)
    fallback-implementer) echo "opencode+nemotron-3-ultra" ;;  # fallback (free API, more capable)
    oversight)            echo "loop+driver" ;;
    *)                    echo "grok+grok-build" ;;   # frontier + designer hand-off
  esac
}

# The Postgres role claim (ADR 0007: role claim = Postgres role). Tiers act as
# 'agent'; the driver reads oversight views as 'oversight'.
role_pg() { case "$1" in oversight) echo "oversight" ;; *) echo "agent" ;; esac; }

# Run the harness for a tier for ONE sweep. The harness self-claims and acts per its
# skill until claim returns empty, then exits; the driver re-runs it next round if
# the board still has work. AINARRES_TOKEN / AINARRES_BASE_URL are exported by the
# driver. $1 = tier name, $2 = optional brief file (the one-shot designer decompose).
#
# REAL harness wiring is the wrapper scripts loop/{grok-frontier,opencode-implementer}.sh
# (owner-run; Claude Code cannot spawn grok --always-approve — the auto-mode guard,
# retro m11-bootstrap — so the loop is owner-started by design). Override the commands
# below with GROK_FRONTIER_CMD / OPENCODE_IMPLEMENTER_CMD to swap in a different model.
harness_sweep() {
  local poller="$1" brief="${2:-}"
  if [ "$LOOP_MODE" = "mock" ]; then
    bash "$REPO/loop/mock-harness.sh" "$poller" "$brief"
    return $?
  fi
  # The real harnesses are the wrapper scripts loop/{grok-frontier,opencode-implementer}.sh.
  # Override with OPENCODE_IMPLEMENTER_CMD / GROK_FRONTIER_CMD to swap in a different
  # invocation (e.g. another model). GROK_BRIEF carries the one-shot decomposition brief.
  # Both cheap tiers run the same opencode wrapper with a different (free-API) model.
  # Override the *_MODEL / *_CMD vars to swap models or invocation.
  case "$poller" in
    cheap-implementer)
      OPENCODE_MODEL="${OPENCODE_PRIMARY_MODEL:-opencode/big-pickle}" \
        eval "${OPENCODE_IMPLEMENTER_CMD:-bash \"$REPO/loop/opencode-implementer.sh\"}" ;;
    fallback-implementer)
      OPENCODE_MODEL="${OPENCODE_FALLBACK_MODEL:-openrouter/nvidia/nemotron-3-ultra-550b-a55b:free}" \
        eval "${OPENCODE_FALLBACK_CMD:-bash \"$REPO/loop/opencode-implementer.sh\"}" ;;
    frontier|designer)
      GROK_BRIEF="$brief" eval "${GROK_FRONTIER_CMD:-bash \"$REPO/loop/grok-frontier.sh\"}" ;;
    *) echo "roles.sh: no real harness for poller '$poller'" >&2; return 2 ;;
  esac
}

# Mint a token and print just the JWT. Operator holds JWT_SECRET (from loop.env).
# Optional explicit sub (2nd arg) so the driver can later release a stranded claim
# left by that worker (a fresh random sub is used when omitted).
mint_token() {
  local poller="$1" sub="${2:-}" ttl="${3:-7200}"
  "${AINARRES[@]}" token \
    --family "$(role_family "$poller")" \
    --role "$(role_pg "$poller")" \
    --features "$(role_features "$poller")" \
    ${sub:+--sub "$sub"} \
    --ttl "$ttl" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).token))'
}
