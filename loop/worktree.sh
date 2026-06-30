#!/usr/bin/env bash
# loop/worktree.sh — per-sweep workspace isolation for the loop (M17, ADR 0021).
#
# Each implementer SWEEP gets its own git worktree — a second working tree over the
# repo's shared object store — so concurrent implementer processes (M18) can edit,
# commit and switch branches without colliding on one checkout. The substrate never
# learns worktrees exist (ADR 0003): the only contract is git, here.
#
# Granularity is PER SWEEP PROCESS, not per task — refined from the M17 design note
# (.agents/design/isolation.md D2) once the code made the constraint concrete: the
# real harnesses SELF-CLAIM inside an opaque `opencode run`/grok process, so the
# wrapper never sees the task id and cannot key a worktree on it. The collision M17
# prevents is between concurrent PROCESSES; a per-process worktree fully prevents it.
# Per-task BRANCHES (loop/<task_id>) — the reviewer/integrator hand-off contract —
# are created by the harness INSIDE its worktree and are independent of the worktree
# directory. This is also the grain grok's native `--worktree` uses (per invocation).
#
# Subcommands (run from anywhere; paths resolve against the repo root):
#   enter <id> [base]   create (idempotent) .loop-worktrees/<id> off <base> (default
#                       origin/main→main→HEAD) and print its absolute path; the caller
#                       cd's into it. Detached HEAD — the harness makes its own branches.
#   teardown <id>       remove that worktree (force) and prune.
#   gc [active-id ...]  remove every .loop-worktrees/* NOT in the active list, then
#                       prune. No args → remove all (end-of-run sweep).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WT_DIR="$REPO/.loop-worktrees"

# Sanitize an id to a safe path/branch segment (uuids are already safe; be defensive).
_safe() { printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '_'; }

_resolve_base() {
  local base="${1:-}"
  if [ -n "$base" ]; then printf '%s' "$base"; return; fi
  if git -C "$REPO" rev-parse --verify -q origin/main >/dev/null; then printf 'origin/main'
  elif git -C "$REPO" rev-parse --verify -q main >/dev/null; then printf 'main'
  else printf 'HEAD'
  fi
}

cmd_enter() {
  local id; id="$(_safe "${1:?worktree enter: id required}")"
  local path="$WT_DIR/$id"
  git -C "$REPO" worktree prune                # clear any missing-but-registered entries
  # Idempotent reuse only when the checkout genuinely exists and is registered.
  if [ -d "$path" ] && git -C "$REPO" worktree list --porcelain | grep -qxF "worktree $path"; then
    printf '%s\n' "$path"; return 0
  fi
  rm -rf "$path"                              # stale dir / orphaned registration
  local base; base="$(_resolve_base "${2:-}")"
  git -C "$REPO" worktree add --force --detach "$path" "$base" >/dev/null
  printf '%s\n' "$path"
}

cmd_teardown() {
  local id; id="$(_safe "${1:?worktree teardown: id required}")"
  git -C "$REPO" worktree remove --force "$WT_DIR/$id" 2>/dev/null || rm -rf "$WT_DIR/$id"
  git -C "$REPO" worktree prune
}

cmd_gc() {
  local keep=" $* "
  if [ -d "$WT_DIR" ]; then
    for d in "$WT_DIR"/*; do
      [ -e "$d" ] || continue
      local id; id="$(basename "$d")"
      case "$keep" in
        *" $id "*) : ;;                        # active — keep
        *) git -C "$REPO" worktree remove --force "$d" 2>/dev/null || rm -rf "$d" ;;
      esac
    done
  fi
  git -C "$REPO" worktree prune
}

case "${1:-}" in
  enter)    shift; cmd_enter "$@" ;;
  teardown) shift; cmd_teardown "$@" ;;
  gc)       shift; cmd_gc "$@" ;;
  *) echo "usage: worktree.sh {enter <id> [base]|teardown <id>|gc [active-id ...]}" >&2; exit 2 ;;
esac
