# ADR 0004 — Unified feature model, superset matching, reflexive trait mutation

- Status: Accepted
- Date: 2026-06-05
- Closes: Q11 (matching from claims); partially informs Q10/Q12 (auth — still open)

## Context

Agents differ along several axes the owner enumerated:

- **capability** — what an agent can technically/safely do (e.g. `db-access`).
- **role** — the hat it wears (analyst, designer, QA, reviewer).
- **work-area** — access to a specific external system/resource (a repo, Asana).
- `…` — the list is open-ended.

The owner's framing: these are all the same kind of thing — a **feature** an agent
holds. The only standing human action is granting an agent its initial features; after
that, agents pull (or are handed) open tasks whose required features they fully satisfy.
The owner further wants the workflow itself to be able to *remove* a feature (a reviewer
flow that strips an underperforming agent of a work-area).

## Decision

1. **One generic mechanism.** A **feature** is `(kind, key)` — e.g.
   `("capability","db-access")`, `("role","reviewer")`, `("work-area","asana")`. New
   `kind`s never require a schema change. `kind` values stay the precise terms;
   **"feature" is the umbrella**.
2. **Agents hold a set of features** (`agent_features`).
3. **Requirements are sets of features.** Baseline requirements live on **transitions**
   (the flow), with **optional per-task extras** for one-off needs.
4. **Matching is superset containment from signed claims.** An agent is eligible for a
   task iff (a) it is bound to the task's lane and (b) its feature set ⊇ the required
   features of at least one legal transition out of the current stage, plus any
   task-level extras. The check reads **verified token claims**, never agent-supplied
   arguments (closes risk R3). This single predicate covers every dimension at once.
5. **Features are mutable by the workflow (reflexive).** A transition may carry
   `effects` (grant/revoke a feature on a *subject* agent); a task may name a
   `subject_agent`. Governance becomes just more tasks on the same queue, with every
   mutation written to the event log.

## Scope

- The **plumbing is built in v1**: `features`, `agent_features`, `required_features` on
  transitions/tasks, `effects` on transitions, `subject_agent` on tasks.
- An actual **governance flow** (quality review → feature revocation) is a **later
  slice**. v1 makes it expressible, not active.

## Alternatives considered

- **Three fixed columns (`capabilities`, `roles`, `work_areas`).** Rejected: adding a new
  trait dimension means a migration, and matching becomes three separate checks instead
  of one.
- **Matching on task arguments.** Rejected outright — lets an agent escape its remit by
  lying. Matching must derive from signed claims.

## Consequences

- `claim_next_task` is one set-containment query; the human view of "who can do what" is
  a read of `agent_features` vs `transitions.required_features`.
- Agent permissions are coordination state living in the DB (see
  [0003](0003-two-plane-source-of-truth.md)), audited via `events`.
- Token claims must be able to carry the agent's feature set — feeds the still-open auth
  ADR (Q10/Q12/Q13).
