# ADR 0011 — v1 scope boundary

- Status: Accepted
- Date: 2026-06-10
- Closes: Q23, Q24
- Builds on: every prior ADR (this fixes what of them v1 actually builds)

## Context

The README describes intent well beyond a first slice (scaling, egress, pooling, a human
board). To produce an autonomous plan we must draw a hard line around v1: what we build
now versus what we keep as a constraint but defer. This ADR is that line.

## Decision

### In scope for v1 — the vertical slice

A single dockerized substrate that an agent (or a test) can pull work from:

- **Schema:** `projects`, `lanes`, `workflows`, `stages`, `transitions`, `tasks`,
  `events`, `agent_families`, `agents`, `features`, `family_features`, `feature_denials`.
- **The nine verbs** ([0008](0008-verb-contracts.md)) with the uniform envelope.
- **Auth** ([0007](0007-auth-identity-family-grant-deny.md)): HS256 token = grant; DB
  `feature_denials` = family-scoped veto; effective = grant − denials; coarse Postgres
  roles.
- **Data-driven state machine** ([0001](0001-data-driven-state-machine.md)) with
  per-lane workflows ([0002](0002-project-lane-workflow-hierarchy.md)).
- **Lazy reclaim** recovery ([0009](0009-leases-reaper.md)) — no background process.
- **Human-readable views** (Q24): the board (lane × stage), the event feed, the
  `abandoned` view — over the same PostgREST surface.
- **The dockerized loop + tests** ([0010](0010-environment-migrations-testing.md)).

### Out of scope for v1 — deferred (constraints, not built)

Confirmed deferred (Q23) — we don't design *against* them, but build none yet:

- **Scaling:** single-writer/sharding, streaming/logical replication, read fanout.
- **External egress:** the outbox + `LISTEN/NOTIFY` consumer.
- **Connection pooling:** PgBouncer (transaction mode).
- **`pg_cron` reaper** ([0009](0009-leases-reaper.md)) — lazy reclaim covers v1.
- **`plv8` / FDW / untrusted languages** ([0005](0005-logic-language-escalation.md)) —
  plpgsql until earned.
- **Reflexive governance *policy*** ([0004](0004-feature-model.md)) — the plumbing
  (`effects`, `subject`, `feature_denials`) exists; an actual quality-review→revoke flow
  is a later slice.
- **Human oversight UI** (Q24) — views ship; a dedicated UI is later.

## Alternatives considered

- **Pull egress or pooling into v1.** Rejected: neither is needed to demonstrate the
  core thesis (race-free, no-orchestrator coordination), and both add moving parts.
- **Ship a UI in v1.** Rejected: the data being human-readable is the requirement; a UI
  is independent and can come once the substrate is proven.

## Consequences

- The autonomous plan targets exactly the in-scope list and stops there.
- Each deferred item already has an ADR or a noted seam, so adding it later is additive,
  not a redesign.
- **Design phase complete** — all open questions (Q1–Q24) are closed. Next artifact is
  the plan in `plans/`.
