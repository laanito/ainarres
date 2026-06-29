#!/usr/bin/env bash
# loop/roles.sh — the ONLY place that knows "which harness runs which role"
# (ADR 0020). Sourced by driver.sh. It is pure configuration: no coordination, no
# routing. The driver reads this and nothing here decides which task goes where —
# the substrate does that.
#
# Cast for v3 — worker TIERS in capability order (cheapest first):
#   cheap-implementer  opencode + qwen3.6   role:implementer            (the default)
#   frontier           grok + grok-build    designer/reviewer/integrator/escalated-impl
# The driver sweeps the tiers IN THIS ORDER each round (see driver.sh): the cheap
# tier drains the `implementing` work it can before the frontier runs, so the
# frontier only picks up what's left (review/integrate + M12-escalated tasks the
# cheap tier couldn't claim). Tiering — not concurrency — is what keeps the cheap
# tier doing the heavy lifting and the frontier as the escalation ceiling.
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
# each round. The two cheap tiers (qwen, then a free-API fallback) each get a turn
# before a task escalates to the frontier (escalate_after = 2 on the dev implementing
# stage): qwen does the work; the fallback covers qwen being down/slow/depleted AND
# retries a task qwen failed; grok is the escalation ceiling.
LOOP_TIERS=(cheap-implementer fallback-implementer frontier)

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
    cheap-implementer)    echo "opencode+qwen3.6" ;;
    fallback-implementer) echo "opencode+big-pickle" ;;   # free, rate-limited API model
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
  case "$poller" in
    cheap-implementer)
      eval "${OPENCODE_IMPLEMENTER_CMD:-bash \"$REPO/loop/opencode-implementer.sh\"}" ;;
    fallback-implementer)
      # Same opencode wrapper, a different (free-API) model. Override either var to swap.
      OPENCODE_MODEL="${OPENCODE_FALLBACK_MODEL:-opencode/big-pickle}" \
        eval "${OPENCODE_FALLBACK_CMD:-bash \"$REPO/loop/opencode-implementer.sh\"}" ;;
    frontier|designer)
      GROK_BRIEF="$brief" eval "${GROK_FRONTIER_CMD:-bash \"$REPO/loop/grok-frontier.sh\"}" ;;
    *) echo "roles.sh: no real harness for poller '$poller'" >&2; return 2 ;;
  esac
}

# Mint a token and print just the JWT. Operator holds JWT_SECRET (from loop.env).
mint_token() {
  local poller="$1" ttl="${2:-7200}"
  "${AINARRES[@]}" token \
    --family "$(role_family "$poller")" \
    --role "$(role_pg "$poller")" \
    --features "$(role_features "$poller")" \
    --ttl "$ttl" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).token))'
}
