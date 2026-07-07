#!/usr/bin/env bash
# loop/mock-harness.sh <poller> [brief-file] — a DETERMINISTIC stand-in for the
# real grok/opencode harnesses, used when LOOP_MODE=mock.
#
# Why it exists: the dumb driver + pollers + substrate are deterministic plumbing
# and deserve a deterministic test. The real harnesses are stochastic LLMs AND
# (for grok) cannot be spawned by Claude Code (the auto-mode guard, retro
# m11-bootstrap) — so the real end-to-end is the owner-run assisted shakeout. This
# mock proves the COORDINATION wiring: a brief decomposes, walks every stage via
# the right role tokens, an integrator-role poller "merges" without per-task
# invocation, and the board drains to `done` — all driven only by the substrate.
#
# It honours the exact same contract as a real harness sweep: self-claim with the
# exported AINARRES_TOKEN and act per the claimed task's stage, until claim is
# empty. It does NOT do real git/gh — the loop substrate is a coordination board,
# not a checkout — so "implement"/"merge" are recorded as references only.
set -euo pipefail

POLLER="${1:?usage: mock-harness.sh <poller> [brief-file]}"
BRIEF_FILE="${2:-}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AINARRES=(node "$REPO/bin/ainarres.mjs")
: "${AINARRES_TOKEN:?mock-harness: AINARRES_TOKEN must be exported by the poller/driver}"

# Read one JSON line on stdin and extract a dotted path (e.g. "task.id").
jget() {
  node -e 'const p=process.argv[1].split(".");let v=JSON.parse(require("fs").readFileSync(0,"utf8"));for(const k of p){v=(v==null)?undefined:v[k];}process.stdout.write(v==null?"":String(v))' "$1"
}

ai() { "${AINARRES[@]}" "$@"; }

# Per-sweep worktree isolation (M17), exercised in loop-selftest exactly as the real
# cheap implementer does it: an implementer poller with a sweep id runs inside its own
# git worktree (teardown on exit). `ai` resolves the CLI via BASH_SOURCE, so working
# from the worktree is fine. Non-implementer pollers (designer/frontier) work in $REPO.
case "$POLLER" in
  nano-implementer|cheap-implementer|cursor-implementer|fallback-implementer)
    if [ -n "${LOOP_SWEEP_ID:-}" ]; then
      WT="$(bash "$REPO/loop/worktree.sh" enter "$LOOP_SWEEP_ID")"
      trap 'bash "$REPO/loop/worktree.sh" teardown "$LOOP_SWEEP_ID" >/dev/null 2>&1 || true' EXIT
      cd "$WT"
    fi ;;
esac

# One-shot decomposition: the driver calls `mock-harness.sh designer <brief>` once to
# hand the brief to the designer. The mock decomposes it into LOOP_MOCK_TASKS (default
# 3) INDEPENDENT, self-contained tasks (validate `true`) — independent so the M18
# concurrent pool can claim and implement them simultaneously (SKIP LOCKED), which is
# what the multi-task drain test exercises. Each is trivial so the plumbing test stays
# deterministic.
if [ "$POLLER" = "designer" ] && [ -n "$BRIEF_FILE" ]; then
  goal="$(head -n1 "$BRIEF_FILE" 2>/dev/null || echo "mock feature")"
  n="${LOOP_MOCK_TASKS:-3}"
  for i in $(seq 1 "$n"); do
    ai create --lane dev --payload "$(node -e 'process.stdout.write(JSON.stringify({goal:process.argv[1]+" #"+process.argv[2],instructions:"mock: no-op change",files:[],validate:"true",acceptance:"board drains to done"}))' "$goal" "$i")" >/dev/null
  done
  # M18 merge-queue conflict test: with LOOP_MOCK_CONFLICT=1 add one task that the
  # integrator will reject ONCE (simulating a rebase conflict, D3) before it merges —
  # proving conflict→reject→re-implement→merge still drains green.
  if [ "${LOOP_MOCK_CONFLICT:-0}" = "1" ]; then
    ai create --lane dev --payload "$(node -e 'process.stdout.write(JSON.stringify({goal:"mock CONFLICT task",instructions:"mock: rebase-conflicts once",files:[],validate:"true",mock_conflict:true,acceptance:"merges after one reject"}))')" >/dev/null
  fi
fi

# The claim→act→repeat sweep, identical in shape to every role skill's loop.
while true; do
  out="$(ai claim --lane "dev" || true)"
  code="$(printf '%s' "$out" | jget code)"
  [ "$code" = "ok" ] || break        # empty / already_holding / not_eligible → done sweeping
  id="$(printf '%s' "$out" | jget task.id)"
  stage="$(printf '%s' "$out" | jget task.stage_key)"
  conflict="$(printf '%s' "$out" | jget task.payload.mock_conflict)"

  # M18 merge-queue conflict policy (D3): a conflict-marked task is rejected back to
  # implementing on its FIRST integrate pass, then merges on the retry. The sentinel
  # makes it deterministic and one-shot (the agent token can't read event history).
  if [ "$POLLER" = "frontier" ] && [ "$stage" = "integrating" ] && [ "$conflict" = "true" ]; then
    sentinel="${RUN_DIR:-$REPO/loop/run}/mock-conflict-$id.handled"
    if [ ! -f "$sentinel" ]; then
      : > "$sentinel"
      ai reject "$id" --to implementing --reason "mock: rebase conflict against main (D3)" >/dev/null
      continue
    fi
  fi

  case "$POLLER:$stage" in
    designer:proposed)      ai advance "$id" --to designing   --note "mock: design start" >/dev/null ;;
    designer:designing)     ai advance "$id" --to implementing --note "mock: spec ready"  >/dev/null ;;
    nano-implementer:implementing|cheap-implementer:implementing|cursor-implementer:implementing|fallback-implementer:implementing)
                            ai advance "$id" --to reviewing    --note "mock: implemented" --branch "dev/$id" >/dev/null ;;
    # M19: reviewing/validating are FEDERATED — grok OR the claude reviewer peer may own
    # them (SKIP LOCKED gives each concurrent sweep a distinct task; cross-family review
    # is thus demonstrated deterministically). integrating stays grok-only (the single
    # integrator holds capability:integrate; the claude reviewer never gets such a task).
    frontier:reviewing|frontier-claude-reviewer:reviewing)
                            ai advance "$id" --to integrating  --note "mock: review ok ($POLLER)" >/dev/null ;;
    frontier:integrating)   ai advance "$id" --to validating   --note "mock: merged" \
                              --pr "https://example.invalid/pr/$id" --branch "dev/$id" --commit "mock$id" >/dev/null ;;
    frontier:validating|frontier-claude-reviewer:validating)
                            ai advance "$id" --to done         --note "mock: green on main ($POLLER)" >/dev/null ;;
    *)
      # Not this poller's stage (shouldn't happen given the eligibility gates);
      # release it so the right poller can take it, without forcing a transition.
      ai release "$id" --reason "mock: not my stage ($stage)" >/dev/null ;;
  esac
done
