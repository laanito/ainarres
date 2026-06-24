# Retro — M7: task dependencies

- Date: 2026-06-22
- PR: build/m7-dependencies
- Plan: [v2-plan.md](../plans/v2-plan.md) (M7)
- Implements: [ADR 0014](../decisions/0014-task-dependencies.md)

## What shipped

A task can declare prerequisite task(s); it is not claimable until every
prerequisite sits at a terminal stage. The smallest mechanism that lets a feature
decompose into ordered work items ([ADR 0013](../decisions/0013-v2-scope-self-development.md)).

- **Schema:** `tasks.depends_on uuid[] not null default '{}'` + a GIN index
  (`tasks_depends_on`) for the dependent-lookup the oversight read model will want.
- **`create_task(…, depends_on?)`:** validates every prerequisite id already exists
  (returns `not_found` otherwise) — **acyclic by construction**, since you can only
  point at tasks created before you. Records `depends_on` in the `created` event.
- **`claim_next_task`:** one added predicate in the candidate scan — a task with any
  prerequisite not yet at a terminal stage is skipped, alongside the existing
  blocked / terminal / lease checks. No new envelope code: a dependency-held task is
  simply not handed out, exactly like a blocked one (dumb clients branch on nothing new).
- **CLI:** `create --depends-on ID,ID`.

## Decisions that held up

- **Array column over an edge table.** The only access pattern the claim needs is
  per-candidate prerequisite satisfaction, which `unnest` + `NOT EXISTS` answers; a
  join table was structure no consumer asked for ([ADR 0014](../decisions/0014-task-dependencies.md)).
- **"Satisfied = terminal stage"** reused `stages.is_terminal` — no new stage state.
  Safe because the dev workflow ([ADR 0016](../decisions/0016-development-workflow.md))
  has a single terminal stage; `null`/`'{}'` depends_on unnests to zero rows, so v1
  tasks are untouched.
- **Faithful down-migration.** M7 restores the *M5* reclaim-loop `claim_next_task` and
  the *M3* `create_task` (5-arg), then drops the index + column — `make verify-down`
  rolls the whole stack to zero and back cleanly.

## Done-tests (met)

- `make reset` green: **53 tests pass**, including 5 new in `test/dependencies.test.ts`:
  unknown prereq → `not_found`; `depends_on` stored on the task; a dependent is held
  back while its prereq is in flight (a second worker gets `empty`) and becomes
  claimable once the prereq advances to terminal; a **blocked** prereq keeps its
  dependent unclaimable; tasks without prerequisites are unaffected.
- `make verify-down`: every migration including M7 reverts and re-applies cleanly.

## Bootstrap honesty (ADR 0013)

**Built 100% by hand**, as expected: you cannot develop dependencies-on-AINARRES
before dependencies exist. This is the floor of the bootstrap — the plumbing that
makes later milestones dogfoodable. Dogfooding begins to flip on from M9/M10 once the
dev workflow and role skills exist; M11 is the fully-on-AINARRES proof.

## Follow-ups (not blocking)

- `stages.satisfies_dependency` — only if a workflow ever needs a terminal *failure*
  stage; today "terminal = satisfied" is exact for our single-terminal dev workflow.
- The oversight tool (M11) will surface, per task, which prerequisites are still
  pending — a read over `depends_on` joined to prereq stages; no new write path.

**Blog:** "Ordering work without an orchestrator: task dependencies."
