# ADR 0003 — Two-plane source of truth: DB coordinates, work product lives external

- Status: Accepted
- Date: 2026-06-05
- Closes: the "is the DB the whole source of truth?" question raised in design discussion

## Context

The README states the DB is "the single source of truth." Pressed during design, we
distinguished two kinds of truth: the **coordination** of work (who does what, in what
state, with what history) versus the **work product** itself (code, documents, designs).
Agents naturally produce commits, files, and PRs that belong in a git repo, not as blobs
in Postgres. The work-area/Asana example reinforced it: external systems own their own
state; the substrate coordinates and points at it.

## Decision

Split the planes:

- **Coordination plane — the DB is authoritative.** Tasks, stages, transitions, leases,
  agents and their **features**, assignments, and the full **event history**. Agent
  permissions are coordination state, so they live here, mutable and audited.
- **Work plane — external systems are authoritative.** The deliverables live in their
  natural home (git repo, filesystem, Asana, …). The DB **never stores the deliverable
  itself.**
- **The seam carries typed references, not payloads.** A project/lane's `context jsonb`
  says where its work-truth lives; a task `payload` describes *what to do and where*;
  handoff outputs are **references** (repo + commit/branch, PR URL, path), not content.

## Alternatives considered

- **DB holds everything, including work product.** Rejected: bloats the store,
  complicates the race-free claim hot path and replication, and gives consuming agents
  nothing they couldn't get from `git clone`. Fights the grain of how agents work.
- **DB holds only assignments, with no event history.** Rejected: the event log *is* the
  human oversight feed and the audit trail for feature mutation — it must be in the
  coordination plane.

## Consequences

- The coordination store stays lean and fast where it matters (the claim).
- Getting work *out* (to GitHub, deploys, Asana) is the same seam — aligns with the
  README's outbox/egress model, promoted here to a first-class principle.
- "Artifacts" are references, not stored bytes — see
  [0006](0006-task-identity-events-artifacts.md).
