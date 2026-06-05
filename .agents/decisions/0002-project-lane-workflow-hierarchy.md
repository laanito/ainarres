# ADR 0002 — Project → Lane → Workflow hierarchy; flow scoped per lane via reusable workflows

- Status: Accepted
- Date: 2026-06-05
- Closes: Q4 (and the lane/work-area distinction)

## Context

Work is organized along one axis on the *work* side: a **lane** is an initiative within
a project (build the business logic, the API, the frontend, the native apps). Lanes
share a project but can have different rules, requisites, and **— critically — their own
flow**. The word "maybe" in "maybe different flow" implies lanes sometimes share a flow.

Lanes are distinct from work-areas (the latter is an agent feature gating access to an
external system — see [0004](0004-feature-model.md)).

## Decision

Hierarchy:

```
Project ──< Lane >── Workflow ──< Stage
                         └──────< Transition
            Lane ──< Task
```

- **`projects`** are the top container.
- **`lanes`** are initiatives within a project. A task belongs to exactly one lane.
- A **`workflow`** is a named, reusable flow: a set of `stages` and `transitions`. A lane
  **points at** a workflow. Two lanes with the same process share one workflow; a lane
  with a unique process gets its own.
- **Stages and transitions are scoped to a workflow**, not to a project and not directly
  to a lane.

## Alternatives considered

- **Flow scoped per project.** Rejected: contradicts "not all lanes share stages."
- **Stages/transitions attached directly to a lane.** Simple, but duplicates the flow
  whenever two lanes run the same process. Rejected in favor of the reusable `workflow`
  indirection (one extra table) so shared flows are defined once.

## Consequences

- One extra entity (`workflow`) buys deduplication and a clean "shape vs. instance" split:
  a workflow is the shape, a lane is an instance that runs it.
- The board groups tasks by **lane × stage**; lane is the swimlane, stage is the column.
- Per-lane context (its repo, rules) lives on the lane (see
  [0003](0003-two-plane-source-of-truth.md)).
