# Analysis — AINARRES

> AI-Native Asynchronous Role-Routed Execution Substrate.
> Source material: `README.md` (intent doc). This file distills it into a problem
> frame, separates what's settled from what's open, and names the risks. It makes
> **no design decisions** — those go to `design/` and `decisions/`.

## 1. The problem

Coordinate a swarm of autonomous agents on shared work **without an orchestrator** —
no dispatcher, no broker, no central process handing out tasks. Agents pull work they
are permitted to do off a shared queue and advance it through a pipeline. The
coordination logic lives in the substrate (one PostgreSQL database), and the agents
stay deliberately dumb.

The same property must serve humans: because everything is tables/views, oversight is
just a read of the same data, feeding work is an `INSERT`, and intervening is editing a
row. Agents and humans share exactly one source of truth.

## 2. Goals

- **No orchestrator, honestly.** "No central scheduler" must be a structural fact, not
  a claim that hides a coordinator somewhere. The race-free claim must hold under
  concurrent agents.
- **Rules live in the DB.** Legal transitions, capability matching, and lease recovery
  are enforced server-side, so a misbehaving or lying agent cannot grant itself work or
  make an illegal move.
- **Thin agent surface.** A small, stable set of verbs is the entire agent-facing API
  (the README proposes six: claim / report / advance / release / block-unblock /
  heartbeat — the exact set is open).
- **Self-healing.** A crashed agent cannot hold work forever; abandoned work returns to
  the queue automatically, by a mechanism inside the DB.
- **Shared backend for humans.** Oversight, feeding, and intervention use the same
  tables/views as the agents.

## 3. Non-goals (for the first working slice)

These appear in the README as future/scale concerns. Naming them here keeps the first
plan small. They are *deferred*, not rejected.

- Multi-cluster scaling: single-writer + read fanout, sharding by work-area, streaming/
  logical replication.
- External egress: outbox + `LISTEN/NOTIFY` shipping to GitHub/deploys/notifications.
- Connection pooling topology (PgBouncer) as anything more than a noted future need.
- A polished human oversight UI (the *data* must be human-readable; a UI is separate).

## 4. Settled constraints

Only two, per the project owner:

1. **PostgreSQL** is the substrate and source of truth.
2. **PostgREST** is the stateless HTTP layer in front of it.

Everything else is open (see `open-questions.md`). Notably, PostgREST's native auth is
JWT-based, so *some* JWT involvement is strongly implied — but the **claims model**
(what's in the token, how capabilities/work-areas are represented and matched) is open.

## 5. Actors

- **Agent** — authenticates with a token carrying role + capabilities + work-areas;
  calls the verbs; holds at most some number of tasks under lease.
- **Reaper** — in-DB mechanism that returns expired leases to the queue.
- **Human (oversight)** — reads task/event state; feeds work; intervenes by editing
  rows or posting events.
- **Feeder** — whatever inserts new tasks (human or upstream system).

## 6. Core concepts to pin down in design

- **Task** — a row; the unit of work. Has a stage, a work-area, capability
  requirements, a lease, and associated artifacts/events.
- **Stage / pipeline** — a state machine. Representation is open (data-driven
  transitions table vs. encoded in functions).
- **Transition** — a validated move from one stage to the next; server-side enforced.
- **Capability / work-area matching** — how a token's claims gate which tasks an agent
  may claim.
- **Lease / heartbeat** — claim sets a lease; heartbeat renews; expiry frees the task.
- **Event log** — append-only activity feed; doubles as the human oversight stream.
- **Artifact** — output attached to a task by `report_progress`.

## 7. Key risks / things that could make the thesis lie

- **R1 — Hidden orchestrator.** If correctness ends up needing an external coordinator,
  the core premise fails. The claim path must stay self-contained in Postgres.
- **R2 — `SKIP LOCKED` is single-instance only.** Race-freedom holds within one writer.
  Any multi-writer story is a separate, harder problem — correctly scoped as a non-goal
  for v1, but the v1 design must not casually assume multi-master.
- **R3 — Capability spoofing.** If matching trusts agent-supplied arguments instead of
  signed claims, an agent can escape its remit. Matching must read from verified token
  claims only.
- **R4 — Lease tuning.** Too short → live agents lose work mid-task; too long → crashed
  work stalls. Needs explicit defaults + heartbeat cadence.
- **R5 — Testability of in-DB logic.** The cleverness is in SQL/RPC, so the test harness
  must exercise concurrency and transitions at the DB level, not just app code. The
  dockerized teardown/rebuild loop exists largely to make this repeatable.
- **R6 — Connection exhaustion.** Postgres is process-per-connection; a herd of agents
  can exhaust it. Pooling is a non-goal for v1 *function* but a real constraint to keep
  in view so we don't design something that can't later sit behind PgBouncer
  (transaction mode).
- **R7 — Logic-language lock-in.** The choice of PL language (plpgsql / plv8 / other)
  shapes how shareable the transition logic is with JS/TS clients and how we test it.

## 8. What "done" looks like for the analysis phase

- This document agreed.
- `open-questions.md` reflects every decision the design phase must close.
- We then move to `design/`, resolving open questions into ADRs, before any plan or code.
