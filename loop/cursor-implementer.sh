#!/usr/bin/env bash
# loop/cursor-implementer.sh — ONE sweep of the cursor-agent implementer poller
# (ADR 0020). A FALLBACK implementer: higher quality than the cheap opencode tiers,
# below the grok frontier. Runs cursor-agent (Cursor's headless coding agent) with an
# inline prompt that points it at skills/ainarres-implementer.md and runs the
# claim->implement->validate->advance loop until a claim returns code:empty, then stops.
#
# It is a SERIAL tier (loop/roles.sh::LOOP_SERIAL_TIERS), run once per round after the
# pool — never fanned out — so it never runs concurrently with itself or the pool. That
# means (unlike opencode-implementer.sh's per-sweep opencode.db isolation) there is no
# session-store collision to guard: cursor-agent keeps its state under $HOME/.cursor,
# outside the worktree, and only one cursor sweep is ever live.
#
# Auth: cursor-agent uses CURSOR_API_KEY (or a prior `cursor-agent login` session under
# ~/.cursor). The owner provides it in the environment; this wrapper never puts the
# AINARRES token or any key into the prompt/argv — the agent reads AINARRES_TOKEN from
# its inherited env.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"
: "${AINARRES_TOKEN:?cursor-implementer: AINARRES_TOKEN must be set by the poller}"
: "${AINARRES_BASE_URL:?cursor-implementer: AINARRES_BASE_URL must be set (from loop.env)}"

# Per-sweep git worktree isolation (M17): if the driver handed us a sweep id, work in our
# own checkout so the agent's per-task `dev/<id>-<sweep>` branches and edits don't touch the main
# tree; teardown on exit. Serial tier ⇒ no concurrent-state isolation needed (see header).
if [ -n "${LOOP_SWEEP_ID:-}" ]; then
  WT="$(bash "$REPO/loop/worktree.sh" enter "$LOOP_SWEEP_ID")"
  trap 'bash "$REPO/loop/worktree.sh" teardown "$LOOP_SWEEP_ID" >/dev/null 2>&1 || true' EXIT
  cd "$WT"
fi

MODEL="${CURSOR_MODEL:-composer-2.5}"

# Resolve the cursor-agent binary robustly. Pollers run in a non-interactive shell that
# may lack the install dir on PATH — find it explicitly (mirrors the other wrappers).
CURSOR="${CURSOR_BIN:-}"
if [ -z "$CURSOR" ]; then
  if command -v cursor-agent >/dev/null 2>&1; then CURSOR="$(command -v cursor-agent)"
  elif [ -x "$HOME/.local/bin/cursor-agent" ]; then CURSOR="$HOME/.local/bin/cursor-agent"
  else echo "cursor-implementer: cursor-agent not found on PATH or at ~/.local/bin (set CURSOR_BIN)" >&2; exit 2
  fi
fi
[ -x "$CURSOR" ] || command -v "$CURSOR" >/dev/null 2>&1 || { echo "cursor-implementer: '$CURSOR' is not executable" >&2; exit 2; }

# The implementer prompt (QUOTED heredoc so nothing expands — the token never leaks into
# argv; cursor-agent reads it from its inherited env). Mirrors the opencode implementer
# agent + the claude-frontier prompt shape: read the skill, run the loop, one task at a
# time, stop on empty.
# NB: assigned via `read -r -d ''` (not `"$(cat <<EOF)"`) — bash 3.2's command-
# substitution parser mishandles some here-doc bodies; this pattern is immune. `read`
# returns non-zero at EOF, hence `|| true` under set -e.
IFS='' read -r -d '' PROMPT <<'EOF' || true
You are an AINARRES IMPLEMENTER on the `dev` lane, a FALLBACK implementer tier. Your API
token is in AINARRES_TOKEN and the base URL in AINARRES_BASE_URL (both set; do not print
them). CLI: `node bin/ainarres.mjs <verb>` — each call prints one JSON line (ok:true, or
ok:false with code+reason). Read skills/ainarres-implementer.md and follow it exactly.

Then run this loop until done:
  1. node bin/ainarres.mjs claim --lane dev
  2. if code is "empty" -> stop; you are done.
  3. otherwise implement the claimed task per the skill and its payload, doing the REAL
     work: make the code change on the task's own branch (per the skill:
     `dev/<task.id>-$LOOP_SWEEP_ID`, unique to this attempt), run the task's
     SUBSTRATE-FREE validate yourself, then advance the task per the skill (or reject with
     a reason if you cannot complete it). Heartbeat long work.
  4. go to 1.
Do ONLY implementer work: you never review, integrate, or merge — separate worker tiers
own `reviewing` and `integrating`. Never invent stages, never skip the task's validate.
One task at a time.
EOF

# Headless approval. `-p` is non-interactive print mode. We use `--trust` (trust this
# worktree), NOT `--force`/`--yolo` ("Run Everything") — the org admin has DISABLED Run
# Everything, so --force errors out. With --trust and cursor's `approvalMode: "allowlist"`
# (~/.cursor/cli-config.json): file edits (Write/Edit) run headless automatically, but
# SHELL commands run only if pre-allowed in `permissions.allow`. The implementer needs at
# least these entries (one-time owner setup; git covers all subcommands):
#     "Shell(git)", "Shell(npx)", "Shell(node)"
# Without them the sweep claims a task, then its git/npx calls get blocked and it can't
# advance (falls to the next tier). `--output-format json` makes the log machine-readable
# (and carries cursor's usage.{inputTokens,…} for future token capture). Override via CURSOR_FLAGS.
FLAGS="${CURSOR_FLAGS:---trust --output-format json}"

# Harness command guard (loop/guard-bin, 2026-07-04 board-wipe): deny make/docker/psql/
# dbmate to the harness so a sweep can't tear down the shared substrates. Prepended, so
# the absolutely-resolved "$CURSOR" below is unaffected; only PATH-resolved child commands
# hit the shims. A temporary guard until the v7 service removes the make/docker cheat.
export PATH="$REPO/loop/guard-bin:$PATH"

exec "$CURSOR" -p "$PROMPT" --model "$MODEL" $FLAGS
