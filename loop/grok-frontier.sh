#!/usr/bin/env bash
# loop/grok-frontier.sh — ONE grok sweep (ADR 0020), in one of two modes:
#
#   GROK_BRIEF set   → DESIGNER-ONLY: decompose the brief into tasks and shepherd them
#                      to `implementing`, then stop. It deliberately does NOT implement/
#                      review/integrate — otherwise it carries the whole feature to
#                      `done` in the decompose pass and starves the cheap implementer
#                      tier (the bug behind qwen never getting an implementing task).
#   GROK_BRIEF unset → frontier worker: reviewer / integrator / validating, plus the
#                      ESCALATED implementer (tier:2) for tasks the cheap tier left.
#
# OWNER-RUN by design: this spawns `grok --always-approve`, which performs real
# git/gh egress at the integrate stage. Claude Code CANNOT run it — the auto-mode
# guard blocks spawning grok --always-approve to do the company-denied merge
# (retro m11-bootstrap). The token is read from the environment, never placed in
# the prompt/argv.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"
: "${AINARRES_TOKEN:?grok-frontier: AINARRES_TOKEN must be set by the poller/driver}"
: "${AINARRES_BASE_URL:?grok-frontier: AINARRES_BASE_URL must be set (from loop.env)}"

MODEL="${GROK_MODEL:-grok-build}"

# Resolve the grok binary robustly (pollers run in a non-interactive shell whose PATH
# may lack ~/.grok/bin): explicit GROK_BIN, else PATH, else the known install path.
GROK="${GROK_BIN:-}"
if [ -z "$GROK" ]; then
  if command -v grok >/dev/null 2>&1; then GROK="$(command -v grok)"
  elif [ -x "$HOME/.grok/bin/grok" ]; then GROK="$HOME/.grok/bin/grok"
  else echo "grok-frontier: grok not found on PATH or at ~/.grok/bin (set GROK_BIN)" >&2; exit 2
  fi
fi
[ -x "$GROK" ] || command -v "$GROK" >/dev/null 2>&1 || { echo "grok-frontier: '$GROK' is not executable" >&2; exit 2; }

# TWO mutually-exclusive modes (QUOTED heredocs so nothing expands — the token
# never leaks into argv; grok reads it from its inherited env):
#
#   GROK_BRIEF set  → DESIGNER-ONLY decomposition. Create tasks + shepherd them to
#                     `implementing`, then STOP. It must NOT implement/review/integrate
#                     — if it did, it would carry the whole feature to `done` itself,
#                     starving the cheap implementer tier (the bug this fixes).
#   GROK_BRIEF unset → the frontier worker loop: reviewer/integrator/validating, plus
#                     the ESCALATED implementer (tier:2) for tasks the cheap tier left.
if [ -n "${GROK_BRIEF:-}" ]; then
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
  PROMPT="$PROMPT $GROK_BRIEF"
else
  PROMPT="$(cat <<'EOF'
You are an AINARRES frontier worker on the `dev` lane. Your API token is in
AINARRES_TOKEN and the base URL in AINARRES_BASE_URL (both set; do not print them). CLI:
`node bin/ainarres.mjs <verb>` — each call prints one JSON line (ok:true, or ok:false
with code+reason). Do ONLY what the role skills say.

Read the role skills you may need this sweep:
  - skills/ainarres-reviewer.md    (stages: reviewing, validating)
  - skills/ainarres-integrator.md  (stage:  integrating)
  - skills/ainarres-implementer.md (stage:  implementing — only ESCALATED tier:2 tasks
                                    reach you; the cheap tier does normal implementing)

Then run this loop until done:
  1. node bin/ainarres.mjs claim --lane dev
  2. if code is "empty" -> stop; you are done.
  3. otherwise read task.stage_key and act as the role that owns that stage, per its
     skill, doing the REAL work:
       - integrating          -> real git push + gh PR create/merge, then advance
       - reviewing/validating -> re-run the task's SUBSTRATE-FREE validate yourself
       - implementing         -> implement it (an escalated task the cheap tier couldn't)
     then make exactly the advance/reject the skill specifies.
  4. go to 1.
Never invent stages, never skip the task's validate. One task at a time.
EOF
)"
fi

exec "$GROK" -p "$PROMPT" --model "$MODEL" --always-approve --output-format json
