#!/usr/bin/env bash
# loop/opencode-implementer.sh — ONE sweep of the cheap implementer poller (ADR 0020).
#
# Runs the opencode qwen implementer agent (.opencode/agent/ainarres-implementer.md,
# which embeds the claim->implement->validate->advance loop and reads AINARRES_TOKEN
# from the environment). The default implementer; M12 escalation routes a stuck task
# past it to the grok frontier automatically.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"
: "${AINARRES_TOKEN:?opencode-implementer: AINARRES_TOKEN must be set by the poller}"
: "${AINARRES_BASE_URL:?opencode-implementer: AINARRES_BASE_URL must be set (from loop.env)}"

# Per-sweep workspace isolation (M17): if the driver handed us a sweep id, run in our
# own git worktree so concurrent implementers (M18) never collide on one checkout. The
# agent makes its per-task `loop/<id>` branches INSIDE here; teardown on exit. No id
# (standalone invocation) → run in the repo as before.
if [ -n "${LOOP_SWEEP_ID:-}" ]; then
  WT="$(bash "$REPO/loop/worktree.sh" enter "$LOOP_SWEEP_ID")"
  trap 'bash "$REPO/loop/worktree.sh" teardown "$LOOP_SWEEP_ID" >/dev/null 2>&1 || true' EXIT
  cd "$WT"
fi

MODEL="${OPENCODE_MODEL:-ollama/qwen3.6:35b-mlx}"

# Resolve the opencode binary robustly. Pollers run in a non-interactive shell that
# usually does NOT have ~/.opencode/bin on PATH (the harness lives outside the system
# PATH, added only by an interactive profile). So we can't assume a bare `opencode`
# resolves — find it explicitly, mirroring grok-frontier.sh's absolute grok path.
OPENCODE="${OPENCODE_BIN:-}"
if [ -z "$OPENCODE" ]; then
  if command -v opencode >/dev/null 2>&1; then OPENCODE="$(command -v opencode)"
  elif [ -x "$HOME/.opencode/bin/opencode" ]; then OPENCODE="$HOME/.opencode/bin/opencode"
  else echo "opencode-implementer: opencode not found on PATH or at ~/.opencode/bin (set OPENCODE_BIN to its path)" >&2; exit 2
  fi
fi
[ -x "$OPENCODE" ] || command -v "$OPENCODE" >/dev/null 2>&1 || { echo "opencode-implementer: '$OPENCODE' is not executable" >&2; exit 2; }

exec "$OPENCODE" run \
  "Run the AINARRES implementer loop until a claim returns code:empty, then stop. Everything you need is in each task." \
  --agent ainarres-implementer -m "$MODEL"
