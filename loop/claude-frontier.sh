#!/usr/bin/env bash
# loop/claude-frontier.sh — ONE claude sweep (M19 federation, ADR 0021 ·
# design/federation.md), a co-equal frontier PEER alongside grok. Two modes:
#
#   CLAUDE_BRIEF set   → DESIGNER-ONLY (model: opus): decompose the brief into tasks and
#                        shepherd them to `implementing`, then stop. Same discipline as
#                        the grok designer — it must NOT implement/review/integrate, or it
#                        would carry the whole feature itself and starve the cheap tier.
#   CLAUDE_BRIEF unset → REVIEWER (model: sonnet): reviewing / validating only.
#
# Deliberately NEVER an integrator: claude holds no capability:integrate, so an
# `integrating` task is invisible to its claim (defense in depth — not prompt
# discipline). This is the federation safety line (design/federation.md D1/D5): whoever
# merges (grok, owner-invoked) can't be laundered by whoever else directs. The token is
# read from the environment, never placed in the prompt/argv.
#
# OWNER-RUN as a standing poller (design/federation.md D2): a co-equal peer that only
# self-claims and advances — it never sequences or routes another agent, so the "no
# orchestrator in the loop" property (M14) holds. A reviewer performs no egress.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"
: "${AINARRES_TOKEN:?claude-frontier: AINARRES_TOKEN must be set by the poller/driver}"
: "${AINARRES_BASE_URL:?claude-frontier: AINARRES_BASE_URL must be set (from loop.env)}"

# Model per role: opus for design judgment, sonnet for review (design/federation.md D2 —
# two distinct families, harness+model). The poller sets CLAUDE_MODEL.
MODEL="${CLAUDE_MODEL:-sonnet}"

# Resolve the claude binary robustly (pollers run in a non-interactive shell whose PATH
# may lack the install dir): explicit CLAUDE_BIN, else PATH, else known install paths.
CLAUDE="${CLAUDE_BIN:-}"
if [ -z "$CLAUDE" ]; then
  if command -v claude >/dev/null 2>&1; then CLAUDE="$(command -v claude)"
  elif [ -x "$HOME/.claude/local/claude" ]; then CLAUDE="$HOME/.claude/local/claude"
  elif [ -x "$HOME/.claude/bin/claude" ]; then CLAUDE="$HOME/.claude/bin/claude"
  else echo "claude-frontier: claude not found on PATH or at ~/.claude/{local,bin} (set CLAUDE_BIN)" >&2; exit 2
  fi
fi
[ -x "$CLAUDE" ] || command -v "$CLAUDE" >/dev/null 2>&1 || { echo "claude-frontier: '$CLAUDE' is not executable" >&2; exit 2; }

# Headless auto-approval flag (the claude analog of grok --always-approve). A reviewer
# does read-only substrate work + re-runs the task's substrate-free validate; no git/gh
# egress. Overridable via CLAUDE_FLAGS.
FLAGS="${CLAUDE_FLAGS:---dangerously-skip-permissions}"

# TWO mutually-exclusive modes (QUOTED heredocs so nothing expands — the token never
# leaks into argv; claude reads it from its inherited env).
if [ -n "${CLAUDE_BRIEF:-}" ]; then
  PROMPT="$(cat <<'EOF'
You are an AINARRES DESIGNER on the `dev` lane (decomposition only this run). Your API
token is in AINARRES_TOKEN and the base URL in AINARRES_BASE_URL (both set; do not print
them). CLI: `node bin/ainarres.mjs <verb>` — each call prints one JSON line (ok:true, or
ok:false with code+reason). Read skills/ainarres-designer.md and follow it exactly.

Decompose the feature brief (path below) into the SMALLEST set of self-contained
dev-lane tasks. Create each with
`node bin/ainarres.mjs create --lane dev --payload '{...}'` (goal, instructions, files,
a SUBSTRATE-FREE validate, acceptance; --depends-on for ordering). Then shepherd ready
tasks proposed -> designing -> implementing until `claim` returns "empty", then STOP.

Do ONLY design. Do NOT implement, review, or integrate — separate worker tiers own
`implementing`, `reviewing`, and `integrating`. Leaving tasks AT `implementing` is the
correct, complete result of this run. Never invent stages.

Feature brief is at this path:
EOF
)"
  PROMPT="$PROMPT $CLAUDE_BRIEF"
else
  PROMPT="$(cat <<'EOF'
You are an AINARRES REVIEWER on the `dev` lane, a frontier PEER (there are others; you
are not privileged over them). Your API token is in AINARRES_TOKEN and the base URL in
AINARRES_BASE_URL (both set; do not print them). CLI: `node bin/ainarres.mjs <verb>` —
each call prints one JSON line (ok:true, or ok:false with code+reason). Do ONLY what the
reviewer skill says.

Read skills/ainarres-reviewer.md (stages: reviewing, validating).

Then run this loop until done:
  1. node bin/ainarres.mjs claim --lane dev
  2. if code is "empty" -> stop; you are done.
  3. otherwise read task.stage_key and act as the reviewer for that stage, per the skill,
     doing the REAL work: re-run the task's SUBSTRATE-FREE validate yourself, then make
     exactly the advance (accept) or reject the skill specifies.
  4. go to 1.
You are NOT an integrator: you never push, open, or merge a PR — the integrator owns
`integrating` and you will never be handed such a task. Never invent stages, never skip
the task's validate. One task at a time.
EOF
)"
fi

exec "$CLAUDE" -p "$PROMPT" --model "$MODEL" $FLAGS --output-format json
