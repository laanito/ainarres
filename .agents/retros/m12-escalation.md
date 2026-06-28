# Retro — M12: dynamic capability escalation

- Date: 2026-06-28
- PR: build/m12-escalation
- Plan: [v3-plan.md](../plans/v3-plan.md) (M12)
- Implements: [ADR 0019](../decisions/0019-capability-escalation.md) (+ its M12 amendment, per roadmap #29)

## What shipped

The missing piece for the hands-off loop ([ADR 0018](../decisions/0018-v3-scope-autonomous-loop.md)):
a task a cheap family keeps failing is **automatically raised to require a higher
capability tier**, with no human noticing or re-routing — exactly the step I did by hand
in the v2 bootstrap.

- **Ordered tier feature** (`kind = 'tier'`): v3 ships `tier:2` (frontier rung; base work
  needs no tier feature). Per the #29 steer, ordered-from-the-start so adding rungs later
  is additive data, not a redesign.
- **`app.maybe_escalate(task, attempts, actor)`**: at `attempts >= escalate_after`, rewrites
  the task's `required_features` to require the next tier up and logs an `escalated` event.
  Idempotent at the top tier. Called from **both** failure paths — `release_task` and the
  lazy-reclaim branch of `claim_next_task`.
- **`stages.escalate_after` / `workflows.default_escalate_after`** (resolve stage → workflow);
  **opt-in** (NULL = never).
- **Seed:** `tier:2`; `grok+grok-build` becomes the frontier implementer rung
  (`role:implementer` + `tier:2`); the dev `implementing` stage sets `escalate_after = 1`.

## The elegant bit, and the bug

- **Ordering with zero new matching code.** The win flagged in #29 ("set-superset can't
  express ≥ N") turned out not to need a new mechanism: because a family holds the tier(s)
  it's capable of, *"requires tier:N"* is just the ordinary `eff @> required_features`
  superset check. The feature model is untouched; escalation only **mutates a task's
  required tier**. Ordered tiers, same one-query matching.
- **Opt-in, learned the hard way.** First draft defaulted `default_escalate_after = 1`.
  Combined with `tier:2` seeded globally, that made *every* workflow escalate after one
  release — the m4 and recovery suites went red immediately (a released task got `tier:2`,
  its cheap worker could no longer re-claim it → `lease_lost`). The fix: `escalate_after`
  defaults to **NULL = never**; only the dev `implementing` stage opts in. The existing
  tests caught it instantly — a good argument for keeping the full suite green per slice.

## Done-tests (met)

- `make reset` green: **70 tests** (3 new in `test/escalation.test.ts`): release at the
  threshold adds `tier:2` + an `escalated` event, then a cheap family gets `empty` and a
  frontier (`tier:2`) family claims; **below** the threshold there is no escalation; the
  **lazy-reclaim** path escalates too and skips the under-tier reclaimer. Idempotent at the
  top tier (no `tier:3` to climb to).
- `make verify-down`: M12 reverts (restores M4 `release_task` + M7 `claim_next_task`, drops
  columns/helpers, removes `tier` features + reverts the kind check) and re-applies cleanly.

## Bootstrap honesty (ADR 0018)

Built **by hand / assisted** (it's the mechanism the hands-off loop needs; it can't build
itself before it exists). The hands-off flip is M15. With M12 merged, a stalled cheap
worker now self-heals to a frontier attempt **automatically** — the loop no longer needs a
human watching for stalls.

## Follow-ups

- **Free frontier rung:** grant `tier:2` to `nemotron-3-ultra` (550B, free) once trusted —
  a one-line change, the point of the ordered model (roadmap / v3-plan).
- **Graduated rungs** (tier:3+) remain the post-v3 item; the mechanism already supports
  climbing to "the next existing tier."

**Blog:** "When a small model gives up: automatic escalation."
