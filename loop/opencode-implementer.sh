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

OPENCODE="${OPENCODE_BIN:-opencode}"
MODEL="${OPENCODE_MODEL:-ollama/qwen3.6:35b-mlx}"
command -v "$OPENCODE" >/dev/null 2>&1 || { echo "opencode-implementer: '$OPENCODE' not on PATH (set OPENCODE_BIN)" >&2; exit 2; }

exec "$OPENCODE" run \
  "Run the AINARRES implementer loop until a claim returns code:empty, then stop. Everything you need is in each task." \
  --agent ainarres-implementer -m "$MODEL"
