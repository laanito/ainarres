# Retro — M10: role skills + context-clean rehearsal

- Date: 2026-06-26
- PRs: build/m10-role-skills (#19, skills) + build/m10-rehearsal (this one, fixes + rehearsal)
- Plan: [v2-plan.md](../plans/v2-plan.md) (M10)
- Implements: [ADR 0017](../decisions/0017-context-clean-validation.md) (+ ADR 0016 roles)

## What shipped

Four published role skills (designer/implementer/reviewer/integrator) + the opencode
implementer agent, then a **context-clean rehearsal**: a throwaway feature driven end to
end on the live `ainarres-dev` workflow by **fresh, skill-only agents**, to prove the
skills are self-sufficient and to find gaps. Per ADR 0017, every gap was closed by
**editing a skill, never by hand-holding**.

## The rehearsal (one feature, two dependent tasks)

A trivial "greeting utility" (`examples/rehearsal-2026-06-26/`), decomposed into Task A and
Task B (B depends on A). Cast, all fresh and given **only** their skill + the task:

| Role | Runner | Result |
|---|---|---|
| designer | Agent-tool subagent | Decomposed into 2 **correctly-ordered dependent** tasks with self-contained payloads; shepherded A `proposed→designing→implementing`. |
| implementer | `opencode + qwen3.6` | Claimed A, branched `dev/<id>`, wrote the code, **self-validated**, pushed, advanced to `reviewing` — entirely from its agent file. |
| reviewer | Agent-tool subagent | Independent diff review + **re-ran `validate`**; advanced A to `integrating`. |
| integrator | Agent-tool subagent | Opened real **PR #20** vs a scratch base, verified `MERGEABLE`/`CLEAN`, then advanced A to `validating` after the merge. |
| reviewer (validate) | role token | Confirmed the merged result green; advanced A to **`done`**. |

**Task A reached `done` with a real merged PR. Task B stayed unclaimable until A was
terminal, then became claimable immediately** — the M7 dependency gate, proven live.

## Gaps found → fixed (the real output)

- **Designer: a successful `advance` releases the hold.** The skill implied you hold a task
  across `proposed→designing→implementing`; the fresh designer hit `lease_lost`. **Fixed:**
  the skill now states each pass makes one move and re-claims between moves.
- **`board`/`feed` are oversight-only** (agent token → Postgres `42501`). The reviewer/
  integrator skills told agents to read `feed` to find the implementer's branch. **Fixed:**
  derive the branch from the **`dev/<task.id>` convention** (no feed, no permission change).
  Independently, both the reviewer and integrator subagents *converged on this same
  convention* on their own — strong evidence the fix is the right one.

## Operational findings (not skill flaws) — feed M11

- **A subagent integrator cannot run `gh pr merge`** — the harness permission layer blocks
  it (it behaved perfectly otherwise: verified clean, refused to fabricate a merge sha,
  reported honestly). Reinforces the ADR 0017 plan to evolve the integrator to a **fresh
  independent session** for M11.
- **`gh pr merge` is denied at the session level**, and the agent **cannot self-grant** it
  (the auto-mode guard correctly blocks widening one's own allow-list to gain standing
  merge-to-main power). For M11's hands-off auto-merge, the owner must deliberately add the
  permission. For this rehearsal the owner merged PR #20.
- **Minor:** the implementer runtime had no git `user.name`/`email` (commit still
  succeeded with a default); the `board` CLI verb doesn't accept `--task` (only `feed`
  does) though `--help` lists them together. Both noted, neither blocking.

## Done-tests (met)

- A fresh worker (implementer skill only) claimed and completed an implement task; a fresh
  reviewer reviewed it; a fresh integrator opened the PR — none using this conversation's
  context. ✅
- A fresh frontier designer decomposed a feature into correctly-ordered dependent tasks. ✅
- The rehearsal feature reached `done` (Task A, real merged PR) with zero design hand-
  holding; the only human action was the `gh pr merge` permission gate; the gap log shows
  what was added to the skills. ✅

## Bootstrap honesty (ADR 0013)

This is the **first work coordinated on AINARRES with context-clean agents** — the v1
subsidy (orchestrator-as-author) is gone: each role ran from its published skill alone, and
the two gaps that surfaced were exactly the context an orchestrator would silently have
supplied. M11 (the oversight tool) is the full bootstrap; before it, the owner decides on
the `gh pr merge` permission so the integrator can merge autonomously (or runs the
integrator as an independent session).

**Blog:** "No cheating: agents that work from a skill, not a memory."
