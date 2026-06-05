# ADR 0001 — Data-driven state machine, enforced in the DB, agent surface is RPC-only

- Status: Accepted
- Date: 2026-06-05
- Closes: Q1

## Context

AINARRES coordinates autonomous agents with no orchestrator. The README's central
promise is that humans share the backend: oversight is a read, feeding work is an
`INSERT`, intervening is editing a row. The pipeline (the legal moves work can make) can
be encoded two ways: as code inside functions, or as **data** the database reads.

The owner's intent: the underlying data renders as a kanban-like board humans understand
and act on (create tasks, reject/move stages), while a thin layer of functions hides the
logic complexity from agents.

## Decision

1. **The pipeline is data.** Stages and the legal moves between them
   (`transitions`) are rows, not code branches. `advance_task` is a generic validator
   that checks whether a requested move corresponds to a legal transition row.
2. **Rules are enforced server-side**, from this data, so an agent cannot make an
   illegal move or escape its remit by lying in arguments.
3. **Agents touch the system only through RPC verbs** — never direct table writes.
   Creating work (`create_task` — agents may create tasks for other agents),
   advancing, claiming, releasing, reporting all go through functions. This removes
   ambiguity and makes the function layer the single enforcement boundary.

## Alternatives considered

- **Transitions encoded in functions.** Simpler validator, some static safety, faster to
  write. Rejected: the workflow becomes code, so reshaping a pipeline is a redeploy, and
  humans can't render or edit the flow as data — directly contradicting the project's
  premise.
- **Direct table writes for agents (RLS-guarded).** Rejected: spreads enforcement across
  policies and triggers, making "one place the rules live" untrue and the contract
  ambiguous.

## Consequences

- A generic transition validator is more complex than hardcoded checks — acceptable, and
  exactly what the DB-level test harness exists to cover (concurrency + illegal moves).
- The human board is a *read* of the same `stages`/`transitions`/`tasks` the engine
  enforces; the two views can never drift.
- Reshaping a workflow is data manipulation, not a deploy.
- See [0005](0005-logic-language-escalation.md) for how validator complexity is handled
  language-wise.
