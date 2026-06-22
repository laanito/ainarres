# ADR 0014 — Minimal task dependencies (prerequisites)

- Status: Accepted
- Date: 2026-06-22
- Builds on: [0008](0008-verb-contracts.md) (`claim_next_task`, envelope, `blocked`),
  [0006](0006-task-identity-events-artifacts.md) (UUIDv7 ids, small structured core),
  [0009](0009-leases-reaper.md) (availability predicate)
- Decides: how a feature decomposes into ordered work items in v2

## Context

Real development is not one task. "Build the oversight tool" is *design it*, *implement
the query*, *implement the render*, *write tests*, *write docs* — work items with an
ordering: you cannot implement before the design is settled, cannot review before
implementation exists. v1 tasks are all independent; nothing expresses "this task waits
for that one."

[ADR 0013](0013-v2-scope-self-development.md) needs exactly enough dependency mechanism to
order one real feature's work items, and no more. The owner's steer ("bare minimum fields
that provide value", [ADR 0006](0006-task-identity-events-artifacts.md)) applies.

## Decision

### A task declares prerequisites; it is not claimable until they are satisfied

- **Model:** `tasks.depends_on uuid[]` — a list of prerequisite task ids. Empty/NULL means
  no prerequisites (every v1 task). An array column, not an edge table: the only query we
  need is "are all of this task's prerequisites satisfied?", which a single
  `unnest`/`NOT EXISTS` answers; a join table is structure no consumer has asked for yet.
- **Satisfied = the prerequisite is at a terminal stage** (`stages.is_terminal`). This
  reuses the existing terminal flag; no new stage state.
- **`claim_next_task` skips a task with any unsatisfied prerequisite**, alongside the
  existing `blocked` and lease checks ([ADR 0009](0009-leases-reaper.md)). A task waiting
  on prerequisites is simply not handed out — the same shape as a blocked task, so no new
  envelope `code` is required; `claim` still returns `{ok:true, code:"empty"}` when
  nothing eligible remains.

### Acyclic by construction

`create_task` accepts an optional `depends_on` argument, and **every id in it must
reference an already-existing task**. Because a task can only depend on tasks created
*before* it, the dependency graph cannot contain a cycle — there is no way to point at a
not-yet-created task. `create_task` returns `{ok:false, code:"not_found"}` if any
prerequisite id does not exist. No runtime cycle detection is needed.

### Failure and blocking semantics

- A **blocked** prerequisite is not terminal, so its dependents stay unclaimable until a
  human unblocks or resolves it — the correct behaviour (downstream work should not start
  on top of parked work).
- The AINARRES development workflow ([ADR 0016](0016-development-workflow.md)) is designed
  with a **single terminal success stage** (`done`); failures route to rework via `reject`
  transitions or to the orthogonal `blocked` flag, never to a terminal stage. So "terminal
  = satisfied" carries no false positive in our own workflow. A workflow that *does* want a
  terminal failure stage would need to distinguish success-terminal from failure-terminal;
  that refinement (`stages.satisfies_dependency`) is deferred until a workflow needs it.

### Oversight

The bare-minimum oversight tool ([ADR 0013](0013-v2-scope-self-development.md)) surfaces,
per task, whether it is waiting on prerequisites and which ones — a read over `depends_on`
joined to prerequisite stages. No new write path; dependencies are visible in the same
read model as the board.

## Alternatives considered

- **Edge table (`task_dependencies`).** Rejected for v2: more normalized, but the only
  access pattern is per-task prerequisite-satisfaction; the array column answers it with
  less surface. Promote to a table if a query ever needs the reverse edge at scale.
- **Full DAG with epic rollup / parent-child.** Rejected: richer supervision, but more
  schema, verb, and rollup logic than ordering one feature's tasks requires. The array +
  "satisfied = terminal" expresses the ordering we need; epics are a v3 nicety.
- **Runtime cycle detection.** Rejected as unnecessary: the "prerequisites must already
  exist" rule makes cycles unconstructible, which is cheaper and stronger than detecting
  them.
- **A new `waiting` envelope code.** Rejected: a dependency-blocked task is operationally
  identical to a `blocked` one from the claimer's view (not handed out); adding a code
  would make dumb clients branch on a distinction they cannot act on.

## Consequences

- Model addition: `tasks.depends_on uuid[]` (+ an index supporting the satisfaction check).
- Verb changes: `create_task(… , depends_on?)` validates existence; `claim_next_task`
  gains one predicate. The envelope contract ([ADR 0008](0008-verb-contracts.md)) is
  unchanged.
- A feature becomes "create the work-item tasks with `depends_on` edges, then let agents
  pull them in dependency order" — decomposition is data, matching the data-driven ethos
  ([ADR 0001](0001-data-driven-state-machine.md)).
- This is the smallest change that lets [ADR 0013](0013-v2-scope-self-development.md)'s
  gate decompose a real feature.
