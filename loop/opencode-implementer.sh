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

# Per-sweep isolation (M17 + M18): if the driver handed us a sweep id, isolate BOTH
# the git checkout AND opencode's own state, so concurrent implementers don't collide.
if [ -n "${LOOP_SWEEP_ID:-}" ]; then
  # 1. Git worktree (M17): our own checkout; the agent makes per-task `loop/<id>`
  #    branches inside; teardown on exit.
  WT="$(bash "$REPO/loop/worktree.sh" enter "$LOOP_SWEEP_ID")"
  trap 'bash "$REPO/loop/worktree.sh" teardown "$LOOP_SWEEP_ID" >/dev/null 2>&1 || true' EXIT
  cd "$WT"

  # 2. opencode session store (M18 gate finding): opencode keeps its session SQLite at
  #    $XDG_DATA_HOME/opencode/opencode.db. Concurrent opencode processes share it and
  #    collide ("database is locked"), which collapsed the M18 pool to one live worker.
  #    Give each sweep a PRIVATE XDG_DATA_HOME (its own fresh opencode.db) while
  #    symlinking the shared auth.json so the free-API credentials still resolve. Config
  #    (XDG_CONFIG_HOME, ~/.config/opencode — models/providers) stays shared, read-only.
  SRC_DATA="${XDG_DATA_HOME:-$HOME/.local/share}/opencode"
  export XDG_DATA_HOME="$WT/.xdg/data"
  mkdir -p "$XDG_DATA_HOME/opencode"
  [ -f "$SRC_DATA/auth.json" ] && ln -sf "$SRC_DATA/auth.json" "$XDG_DATA_HOME/opencode/auth.json"
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
