#!/usr/bin/env bash
# loop/grok-frontier.sh — ONE sweep of the grok frontier poller (ADR 0020).
#
# Covers designer / reviewer / integrator (+ the escalated tier:2 implementer).
# The role for a given task is decided by its stage; grok reads the matching role
# skill and acts. If GROK_BRIEF is set (the driver's one-shot decomposition pass),
# grok first acts as designer to turn that brief into dev-lane tasks.
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

# Static instructions — QUOTED heredoc so nothing here expands (the token never
# leaks into argv; grok reads it from its inherited env).
PROMPT="$(cat <<'EOF'
You are an AINARRES frontier agent on the `dev` lane. Your API token is in the
AINARRES_TOKEN env var and the substrate base URL is in AINARRES_BASE_URL (both
already set in your environment — do not print them). The CLI is
`node bin/ainarres.mjs <verb>`; every call prints one JSON line (ok:true, or
ok:false with code+reason). Do ONLY what the role skills say.

Read the role skills you may need this sweep:
  - skills/ainarres-designer.md    (stages: proposed, designing)
  - skills/ainarres-reviewer.md    (stages: reviewing, validating)
  - skills/ainarres-integrator.md  (stage:  integrating)

Then run this loop until done:
  1. node bin/ainarres.mjs claim --lane dev
  2. if code is "empty" -> stop; you are done.
  3. otherwise read task.stage_key and act as the role that owns that stage, per its
     skill, doing the REAL work:
       - integrating  -> real git push + gh PR create/merge, then advance to validating
       - reviewing/validating -> re-run the task's SUBSTRATE-FREE validate yourself
       - proposed/designing   -> shepherd one stage forward
     then make exactly the advance/reject the skill specifies.
  4. go to 1.
Never invent stages and never skip the task's validate. One task at a time.
EOF
)"

# The decomposition pass (driver hands the brief to a designer) only when set.
if [ -n "${GROK_BRIEF:-}" ]; then
  PROMPT="$PROMPT

BEFORE the loop, act as designer: read the feature brief at the path '$GROK_BRIEF'
and decompose it into the smallest set of self-contained dev-lane tasks per
skills/ainarres-designer.md. Create each with
\`node bin/ainarres.mjs create --lane dev --payload '{...}'\` (goal, instructions,
files, a SUBSTRATE-FREE validate command, acceptance; use --depends-on for ordering).
Then shepherd ready tasks proposed->designing->implementing until claim is empty."
fi

exec "$GROK" -p "$PROMPT" --model "$MODEL" --always-approve --output-format json
