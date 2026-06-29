#!/usr/bin/env bash
# loop/roles.sh — the ONLY place that knows "which harness runs which role"
# (ADR 0020). Sourced by driver.sh and poller.sh. It is pure configuration: no
# coordination, no routing. The driver/pollers read this and nothing here decides
# which task goes where — the substrate does that.
#
# Cast for v3 (ADR 0020, serialized): two standing pollers.
#   cheap-implementer  opencode + qwen3.6   role:implementer            (the default)
#   frontier           grok + grok-build    designer/reviewer/integrator/escalated-impl
# When M12 escalates an implementing task to tier:2, the cheap poller is no longer
# eligible and the frontier poller picks it up — automatically, no routing here.
#
# LOOP_MODE=mock swaps every harness for loop/mock-harness.sh (a deterministic
# stand-in) and trims the frontier's implementer/tier:2 features so the mock plumbing
# test is race-free (the cheap poller is the sole implementer). Escalation itself is
# unit-tested (test/escalation.test.ts) and exercised live in the M15 gate, not here.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AINARRES=(node "$REPO/bin/ainarres.mjs")
LOOP_LANE="dev"
LOOP_MODE="${LOOP_MODE:-real}"           # real | mock
POLL_INTERVAL="${POLL_INTERVAL:-5}"      # seconds a poller sleeps between sweeps
RUN_DIR="${RUN_DIR:-$REPO/loop/run}"     # logs + stop sentinel (gitignored)
STOP_FILE="$RUN_DIR/STOP"

# The standing pollers the driver launches.
LOOP_POLLERS=(cheap-implementer frontier)

# Token features per poller. The substrate trusts the signed token's features
# (minus denials) — ADR 0007 — so this is the authoritative capability grant for
# the run. In mock mode the frontier drops implementer/tier:2 (see header).
role_features() {
  case "$1" in
    cheap-implementer) echo "lane:dev,role:implementer" ;;
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
    cheap-implementer) echo "opencode+qwen3.6" ;;
    oversight)         echo "loop+driver" ;;
    *)                 echo "grok+grok-build" ;;   # frontier + designer hand-off
  esac
}

# The Postgres role claim (ADR 0007: role claim = Postgres role). Pollers act as
# 'agent'; the driver reads oversight views as 'oversight'.
role_pg() { case "$1" in oversight) echo "oversight" ;; *) echo "agent" ;; esac; }

# How to run the harness for a poller for ONE sweep. The harness self-claims and
# acts per its skill until claim returns empty, then exits; poller.sh relaunches it
# after POLL_INTERVAL until the driver stops it. AINARRES_TOKEN / AINARRES_BASE_URL
# are already exported by poller.sh. $1 = poller name, $2 = optional brief file.
#
# REAL harness wiring (owner-run; Claude Code cannot spawn grok --always-approve —
# the auto-mode guard, retro m11-bootstrap — so the loop is owner-started by design):
#   - grok      : ~/.grok/bin/grok --output-format json  (Claude-compatible skills,
#                 permission_mode always-approve) pointed at the role skill(s).
#   - opencode  : the qwen implementer agent in .opencode/ (see opencode-local memory).
# These are intentionally thin shims here; the real invocations are filled in during
# the M14 assisted shakeout / left to the operator's harness config.
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
