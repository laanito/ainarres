# ADR 0006 — Task identity (UUIDv7), single append-only event log, artifacts as references

- Status: Accepted
- Date: 2026-06-05
- Closes: Q2 (id type), Q3, Q5, Q6

## Context

Three smaller data-model commitments that follow from the cluster above and the owner's
steer to favor `jsonb` over rigid structure that no agent will use ("bare minimum fields
that provide value to the consumer").

## Decision

1. **Task ids are `UUIDv7`.** Globally unique (the README's argument holds regardless of
   whether sharding ever happens) and time-ordered, so they keep index locality like a
   serial. Used for ids everywhere it's cheap to do so.
2. **One append-only `events` table** carries everything: progress notes, transitions,
   human interventions, feature mutations. Columns: `id`, `task_id`, `actor`, `type`,
   `data jsonb`, `created_at`. This table *is* the human oversight feed and the audit
   trail. Append-only is enforced by revoking `UPDATE`/`DELETE` from agent/human roles
   (belt) plus a trigger (suspenders).
3. **No artifacts table in v1.** Under [0003](0003-two-plane-source-of-truth.md) an
   artifact is a *reference* to external work product, not stored content. Those
   references live in the relevant event's `data jsonb` (and/or the task `payload`).
   A dedicated table is added only if a query actually demands the structure.

## Alternatives considered

- **`bigserial` task ids.** Rejected: not global, and the README explicitly wants a
  global id space; UUIDv7 costs little and removes a future migration.
- **`uuid v4`.** Rejected vs. v7 for index locality on insert-heavy workloads.
- **Separate tables per event kind.** Rejected: the oversight feed wants one ordered
  stream; a `type` discriminator + `jsonb` is enough.
- **Dedicated `artifacts` table now.** Rejected for v1 as structure no consumer has
  asked for yet (owner's steer). Revisit when a real query needs it.

## Consequences

- `tasks` keeps a small structured core (`id`, `lane_id`, `stage`, `required_features`,
  lease fields, `priority`, `attempts`, `subject_agent?`, `created_by`, timestamps) with
  everything else in `payload jsonb`.
- The event stream is uniform and easy to render as an activity feed.
- If artifacts grow structure later, it's an additive change, not a migration of stored
  bytes.
