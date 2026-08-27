#!/usr/bin/env bash
# loop/roles.sh — the ONLY place that knows "which harness runs which role"
# (ADR 0020). Sourced by driver.sh. It is pure configuration: no coordination, no
# routing. The driver reads this and nothing here decides which task goes where —
# the substrate does that.
#
# Cast (v3 tiers + M19 federated frontier peers) in capability order (cheapest first):
#   nano-implementer           opencode + nemotron-3-nano   role:implementer  (tier-0; DISABLED — hallucinated tools, LOOP_PRE_TIERS=())
#   cheap-implementer          opencode + big-pickle        role:implementer  (primary pool, free API)
#   qwen-implementer           opencode + qwen3-coder-next  role:implementer  (cheap serial, big-pickle par; 1 session — NEVER pooled)
#   muse-implementer           opencode + muse-glimmer      role:implementer  (cheap serial, local MLX 30B; 1 session — NEVER pooled)
#   cursor-implementer         cursor-agent + composer-2.5  role:implementer  (fallback, higher quality; not frontier)
#   fallback-implementer       opencode + nemotron-3-ultra  role:implementer  (fallback, free API)
#   designer                   claude-code + opus           role:designer     (one-shot decomposition)
#   frontier                   grok + grok-4.6            reviewer + the SINGLE integrator (+escalated impl)
#   frontier-claude-reviewer   claude-code + sonnet         role:reviewer     (M19 peer, never integrates)
# The frontier ROLE is federated: grok and the claude reviewer run CONCURRENTLY each
# round as peers (LOOP_FRONTIER_PEERS), neither privileged — only grok can integrate.
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

# The lanes an activation WORKS. The batch driver decomposes one brief and drains dev, so
# it stays dev-only; the standing SERVICE overrides this to (dev intake) — it is the entry
# point that must also see briefs the intaker has refined (M24/M26). Every board read in
# driver-lib.sh iterates this set, so a lane absent here is invisible to the demand gate:
# adding one here is what makes work on it wake the runtime at all. Always set (never
# unset) so `"${LOOP_LANES[@]}"` is safe under `set -u` on bash 3.2.
LOOP_LANES=(dev)
LOOP_MODE="${LOOP_MODE:-real}"           # real | mock
RUN_DIR="${RUN_DIR:-$REPO/loop/run}"     # per-tier sweep logs (gitignored)

# Worker tiers, ordered LOW→HIGH capability. The driver sweeps them in this order
# each round. The cheap (free-API) tiers each get a turn before a task escalates
# to the frontier (escalate_after = 2 on the dev implementing stage): nano takes the
# first crack (cheapest), big-pickle does the bulk of the work; the nemotron-ultra
# fallback covers big-pickle being down/depleted AND retries a task it failed; grok is
# the escalation ceiling. (Adding a tier ahead means the LAST cheap tier now rarely runs
# before escalate_after=2 fires — bump the dev implementing stage's escalate_after in the
# loop seed if you want all three cheap tiers to attempt before grok.)
LOOP_TIERS=(cheap-implementer qwen-implementer muse-implementer cursor-implementer fallback-implementer frontier)

# M18 split (ADR 0021): the primary cheap implementer is FANNED OUT into a concurrent
# pool (LOOP_POOL_SIZE members per round — the swarm's throughput); the remaining tiers
# run once each, serially, AFTER the pool, preserving tiering (fallback covers the
# primary). Integration stays single (the grok integrator IS the merge queue,
# parallel-loop.md D2).
LOOP_POOL_TIER="${LOOP_POOL_TIER:-cheap-implementer}"
# Serial tiers, run once each (in THIS order) after the pool. qwen-implementer
# (opencode + qwen3-coder-next, an 80B ~big-pickle-par cheap implementer) takes the first
# serial crack — it's a single sweep because its :cloud backend allows only 1 concurrent
# session, so it can't join the ×N pool. Then the higher-quality fallbacks: cursor-implementer
# (cursor-agent + composer-2.5), backed by nemotron-3-ultra. All single serial sweeps.
LOOP_SERIAL_TIERS=(qwen-implementer muse-implementer cursor-implementer fallback-implementer)

# Tier-0 pre-pass: tiers swept ONCE, serially, BEFORE the concurrent pool each round
# (driver.sh). nano is the cheapest implementer and drains the easy work it can before
# big-pickle's pool fans out on the rest. It runs as a SINGLE sweep on purpose — the
# nemotron-3-nano backend allows only ONE concurrent session, so it must NEVER be the
# pool tier (a ×LOOP_POOL_SIZE fan-out would collide on the backend).
#
# DISABLED 2026-07-07: nemotron-3-nano kept hallucinating a `str_replace_editor` tool
# (not in opencode's toolset: bash/edit/glob/grep/read/skill/task/todowrite/write) and
# looped on the rejection, holding a task's 2h lease while making zero progress — until
# the lease lapsed and a real tier reclaimed it (a wasted-work lease race). A tier-0 that
# can't drive the harness's actual tools is worse than none. The nano wiring (family seed,
# role_family/role_features/harness_sweep) stays as a template; set this back to
# (nano-implementer) with a tooling-capable OPENCODE_NANO_MODEL to re-enable.
LOOP_PRE_TIERS=()

# M19 federation (design/federation.md): the frontier ROLE is shared by MULTIPLE
# families as peers, none privileged. These pollers run CONCURRENTLY each round (after
# the serial tiers), so a reviewing task is claimed by whoever is free — grok or the
# claude reviewer — and cross-family review happens naturally (SKIP LOCKED distributes;
# measured, not enforced — D3). grok additionally holds capability:integrate and is the
# SINGLE integrator (the merge queue); the claude reviewer never integrates (D1/D5). The
# one-shot designer (below) is a claude+opus peer; grok stays co-eligible for design.
LOOP_FRONTIER_PEERS=(frontier frontier-claude-reviewer)

# Token features per poller. The substrate trusts the signed token's features
# (minus denials) — ADR 0007 — so this is the authoritative capability grant for
# the run. In mock mode the frontier drops implementer/tier:2 (see header).
role_features() {
  case "$1" in
    nano-implementer)     echo "lane:dev,role:implementer" ;;  # tier-0 (disabled): same role, cheapest model
    cheap-implementer)    echo "lane:dev,role:implementer" ;;
    qwen-implementer)     echo "lane:dev,role:implementer" ;;  # cheap serial: same role, big-pickle-par model
    muse-implementer)     echo "lane:dev,role:implementer" ;;  # cheap serial: same role, local MLX 30B model
    cursor-implementer)   echo "lane:dev,role:implementer" ;;  # fallback: same role, higher-quality harness (not frontier — no tier:2)
    fallback-implementer) echo "lane:dev,role:implementer" ;;  # same role, different (free-API) model
    frontier)
      if [ "$LOOP_MODE" = "mock" ]; then
        echo "lane:dev,role:designer,role:reviewer,role:integrator,capability:integrate"
      else
        echo "lane:dev,role:designer,role:reviewer,role:integrator,capability:integrate,role:implementer,tier:2"
      fi ;;
    frontier-claude-reviewer) echo "lane:dev,role:reviewer" ;;  # M19 peer: reviews, never integrates (no capability:integrate)
    # The designer works BOTH lanes: it decomposes dev-lane `proposed` work, and it is the
    # role M24 D2 named for briefed→accepted — accepting a refined brief for decomposition.
    # lane:intake is what lets it CLAIM the brief; role:intaker is deliberately absent, so
    # the substrate itself keeps the designer out of proposed_brief (no outbound transition
    # it is eligible for ⇒ an unrefined brief is invisible to its claim). The human/operator
    # intaker still owns the refine step.
    designer) echo "lane:dev,lane:intake,role:designer" ;;   # brief hand-off + standing decompose (claude+opus peer)
    oversight) echo "" ;;
    *) echo "" ;;
  esac
}

# Agent family (harness+model) for a poller — the durable identity (ADR 0007).
role_family() {
  case "$1" in
    nano-implementer)         echo "opencode+nemotron-3-nano" ;;   # tier-0 (disabled): cheapest implementer (1 concurrent session)
    cheap-implementer)        echo "opencode+big-pickle" ;;        # primary cheap implementer (free API)
    qwen-implementer)         echo "opencode+qwen3-coder-next" ;;  # cheap serial: 80B, big-pickle par (1 concurrent session)
    muse-implementer)         echo "opencode+muse-glimmer" ;;      # cheap serial: 30B local MLX (1 concurrent session)
    cursor-implementer)       echo "cursor-agent+composer-2.5" ;;  # fallback: cursor-agent harness, composer-2.5 model
    fallback-implementer)     echo "opencode+nemotron-3-ultra" ;;  # fallback (free API, more capable)
    designer)                 echo "claude-code+opus" ;;           # M19: opus for design judgment
    frontier-claude-reviewer) echo "claude-code+sonnet" ;;         # M19: sonnet for review (distinct family)
    oversight)                echo "loop+driver" ;;
    *)                        echo "grok+grok-4.6" ;;            # frontier (reviewer + the single integrator)
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
    nano-implementer)
      # tier-0 cheapest: nemotron-3-nano via opencode's ollama provider. ONE concurrent
      # session only — the driver runs this as a single serial pre-pool sweep, never pooled.
      OPENCODE_MODEL="${OPENCODE_NANO_MODEL:-ollama/nemotron-3-nano:30b-cloud}" \
        eval "${OPENCODE_NANO_CMD:-bash \"$REPO/loop/opencode-implementer.sh\"}" ;;
    cheap-implementer)
      OPENCODE_MODEL="${OPENCODE_PRIMARY_MODEL:-opencode/big-pickle}" \
        eval "${OPENCODE_IMPLEMENTER_CMD:-bash \"$REPO/loop/opencode-implementer.sh\"}" ;;
    qwen-implementer)
      # cheap serial: qwen3-coder-next via opencode's ollama provider. Reuses the opencode
      # implementer wrapper (like big-pickle/nano), different model. 1 concurrent session
      # ⇒ a single serial sweep, never pooled.
      OPENCODE_MODEL="${OPENCODE_QWEN_MODEL:-ollama/qwen3-coder-next:cloud}" \
        eval "${OPENCODE_QWEN_CMD:-bash \"$REPO/loop/opencode-implementer.sh\"}" ;;
    muse-implementer)
      # cheap serial: muse-glimmer (30B local MLX) via opencode's ollama provider. Reuses
      # the opencode implementer wrapper (like big-pickle/qwen), different model. A local
      # MLX model loads one at a time (1 concurrent session) ⇒ a single serial sweep, never pooled.
      OPENCODE_MODEL="${OPENCODE_MUSE_MODEL:-ollama/muse-glimmer:30b-mlx}" \
        eval "${OPENCODE_MUSE_CMD:-bash \"$REPO/loop/opencode-implementer.sh\"}" ;;
    cursor-implementer)
      # fallback: cursor-agent + composer-2.5 (its own harness wrapper). Serial tier.
      CURSOR_MODEL="${CURSOR_IMPL_MODEL:-composer-2.5}" \
        eval "${CURSOR_IMPLEMENTER_CMD:-bash \"$REPO/loop/cursor-implementer.sh\"}" ;;
    fallback-implementer)
      OPENCODE_MODEL="${OPENCODE_FALLBACK_MODEL:-openrouter/nvidia/nemotron-3-ultra-550b-a55b:free}" \
        eval "${OPENCODE_FALLBACK_CMD:-bash \"$REPO/loop/opencode-implementer.sh\"}" ;;
    frontier)
      # grok: reviewer + the single integrator (+ escalated tier:2 implementer).
      GROK_BRIEF="$brief" eval "${GROK_FRONTIER_CMD:-bash \"$REPO/loop/grok-frontier.sh\"}" ;;
    designer)
      # M19: design judgment runs on claude+opus. CLAUDE_ROLE is EXPLICIT: the wrapper used
      # to infer its mode from CLAUDE_BRIEF being set, which silently handed the standing
      # service's brief-less designer sweep the REVIEWER prompt (v7 M25 introduced that
      # sweep; the inference predated it). An empty brief now means "decompose whatever is
      # on the board", not "you are a reviewer".
      CLAUDE_ROLE=designer CLAUDE_MODEL="${CLAUDE_DESIGNER_MODEL:-opus}" CLAUDE_BRIEF="$brief" \
        eval "${CLAUDE_FRONTIER_CMD:-bash \"$REPO/loop/claude-frontier.sh\"}" ;;
    frontier-claude-reviewer)
      # M19: the claude reviewer peer (sonnet). Reviews only; holds no capability:integrate.
      CLAUDE_ROLE=reviewer CLAUDE_MODEL="${CLAUDE_REVIEWER_MODEL:-sonnet}" \
        eval "${CLAUDE_FRONTIER_CMD:-bash \"$REPO/loop/claude-frontier.sh\"}" ;;
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
