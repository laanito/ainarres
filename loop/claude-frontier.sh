#!/usr/bin/env bash
# loop/claude-frontier.sh — ONE claude sweep (M19 federation, ADR 0021 ·
# design/federation.md), a co-equal frontier PEER alongside grok. CLAUDE_ROLE picks the
# mode — EXPLICITLY (roles.sh::harness_sweep sets it):
#
#   CLAUDE_ROLE=designer + CLAUDE_BRIEF  → ONE-SHOT DECOMPOSE (opus): turn the brief into
#                        tasks, shepherd them to `implementing`, stop. The batch driver's
#                        upfront pass.
#   CLAUDE_ROLE=designer, no brief       → STANDING DESIGNER (opus): decompose whatever is
#                        on the board — dev `proposed` work, and `briefed` intake briefs it
#                        accepts on the intaker's behalf (M24 D2). The standing service's
#                        per-round design pass.
#   CLAUDE_ROLE=reviewer                 → REVIEWER (sonnet): reviewing / validating only.
#
# Either designer mode must NOT implement/review/integrate, or it would carry the whole
# feature itself and starve the cheap tier.
#
# WHY EXPLICIT: this wrapper used to infer its mode from CLAUDE_BRIEF being set. v7 (M25)
# then introduced a brief-LESS designer sweep in the standing service — which the
# inference silently served the REVIEWER prompt, while the token held only
# lane:dev,role:designer. The design pass therefore never decomposed anything. The mode is
# now a declared input; an absent brief means "work the board", never "you are a reviewer".
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
# Mode is a declared input, never inferred from which other variables happen to be set.
# A direct (non-loop) invocation may omit it; we then fall back to the pre-v8 inference and
# say so on stderr, so the legacy behaviour is visible rather than silent.
ROLE="${CLAUDE_ROLE:-}"
if [ -z "$ROLE" ]; then
  if [ -n "${CLAUDE_BRIEF:-}" ]; then ROLE=designer; else ROLE=reviewer; fi
  echo "claude-frontier: CLAUDE_ROLE unset — falling back to '$ROLE' inferred from CLAUDE_BRIEF (the loop sets it explicitly)." >&2
fi

case "$ROLE" in
  designer)
    if [ -n "${CLAUDE_BRIEF:-}" ]; then
      # ── One-shot decomposition (batch driver): the brief is the whole input. ──
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
      # ── Standing designer (the service's per-round design pass): the BOARD is the input. ──
      PROMPT="$(cat <<'EOF'
You are the AINARRES STANDING DESIGNER. Your API token is in AINARRES_TOKEN and the base
URL in AINARRES_BASE_URL (both set; do not print them). CLI:
`node bin/ainarres.mjs <verb>` — each call prints one JSON line (ok:true, or ok:false with
code+reason). Read skills/ainarres-designer.md and follow it exactly.

There is no brief this run: the BOARD is your input. You hold `role:designer` on two
lanes — `dev` and `intake` — and nothing else.

Run this loop until BOTH lanes return "empty", then STOP:
  1. node bin/ainarres.mjs claim --lane intake
  2. if a task came back, act per its stage (below), then go to 1.
  3. node bin/ainarres.mjs claim --lane dev
  4. if a task came back, act per its stage (below), then go to 1.
  5. both empty -> you are done.

INTAKE lane, stage `briefed` — a request a human intaker has refined. You accept it on
their behalf, and accepting is the LAST thing you do:
  a. Read the brief from task.payload (the request text, and `subject` if present).
  b. CREATE the dev-lane tasks it decomposes into, each fully self-contained:
     `node bin/ainarres.mjs create --lane dev --payload '{...}'` with goal, instructions,
     files, a SUBSTRATE-FREE validate (e.g. `npx vitest run test/x.test.ts` — never make,
     psql, docker, or dbmate), acceptance, and `brief_id` set to this brief's task id for
     traceability. Use --depends-on for ordering.
  c. ONLY THEN advance the brief: `advance <brief-id> --to accepted`. Creating first means
     a failure mid-way leaves the brief claimable and re-doable; accepting first would
     lose the request.
  If the brief is too vague to decompose, do NOT guess and do NOT accept it: `block` it
  with a reason saying what is missing. The human intaker refines it and unblocks.
  You will never see stage `proposed_brief` — refining a raw request is the intaker's
  step, and the substrate makes it invisible to you.

DEV lane, stage `proposed` — work that needs a spec:
  - If the payload is already a complete, implementable task spec, shepherd it:
    `advance --to designing`, then `advance --to implementing`.
  - If it is too coarse to implement as one task, CREATE the self-contained tasks it
    decomposes into first, then `block` the coarse one with a reason naming them (a human
    closes it). Never leave a coarse task sitting at `proposed` unexplained.

DEV lane, stage `designing` — finish the spec and `advance --to implementing`.

Do ONLY design. Do NOT implement, review, or integrate — separate worker tiers own
`implementing`, `reviewing`, and `integrating`. Leaving dev tasks AT `implementing` is the
correct, complete result of this run. Never invent stages. One task at a time.
EOF
)"
    fi ;;
  reviewer)
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
)" ;;
  *)
    echo "claude-frontier: unknown CLAUDE_ROLE '$ROLE' (want designer|reviewer)" >&2
    exit 2 ;;
esac

# Harness command guard (loop/guard-bin, 2026-07-04 board-wipe): deny make/docker/psql/
# dbmate to the harness so a sweep can't tear down the shared substrates. Prepended, so the
# absolutely-resolved "$CLAUDE" below is unaffected; only PATH-resolved child commands hit
# the shims. A temporary guard until the v7 service removes the make/docker substrate-cheat.
export PATH="$REPO/loop/guard-bin:$PATH"

exec "$CLAUDE" -p "$PROMPT" --model "$MODEL" $FLAGS --output-format json
