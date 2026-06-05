# Design — data model & state machine

> The worked-out model the ADRs decided. ADRs ([0001](../decisions/0001-data-driven-state-machine.md)–[0006](../decisions/0006-task-identity-events-artifacts.md))
> hold the *why* and rejected alternatives; this file is the *what*. Still a design
> sketch — column types firm up when we write migrations. **No code yet.**

## Shape

```
projects ──< lanes >── workflows ──< stages
                           └────────< transitions
            lanes ──< tasks >── (subject) ── agents
                        └──< events
features >── agent_features ──< agents
features >── (required_features on transitions and tasks)
```

Two planes ([ADR 0003](../decisions/0003-two-plane-source-of-truth.md)): the **DB owns
coordination** (everything below), **external systems own work product**; the DB stores
typed references across the seam (`*.context`, task `payload`, references in event
`data`), never the deliverable itself.

## Entities

### `projects`
Top container. `id (uuidv7)`, `slug`, `context jsonb` (where the project's work-truth
lives), `created_at`.

### `lanes`
An initiative within a project (business logic / API / frontend / native apps). A lane
points at the workflow it runs. `id`, `project_id`, `key`, `context jsonb` (its repo,
rules, requisites), `workflow_id`, `ordering`.

### `workflows`
A named, **reusable** flow. Two lanes running the same process share one. `id`, `key`,
`description`.

### `stages`
A column in a workflow's board. `id`, `workflow_id`, `key`, `ordering`, `is_terminal`.

### `transitions`
A legal move. The single place flow rules are enforced. `id`, `workflow_id`,
`from_stage`, `to_stage`, `required_features[]`, `effects jsonb?` (grant/revoke on
subject), `guard?`.

### `tasks`
The unit of work. Small structured core; the rest in `payload`.
`id (uuidv7)`, `lane_id`, `stage`, `required_features[]?` (extras on top of the flow),
`subject_agent?` (when the task is *about* an agent), `claimed_by?`, `lease_expires_at?`,
`priority`, `attempts`, `payload jsonb`, `created_by`, `created_at`, `updated_at`.

### `events`
Append-only oversight feed + audit trail. `id`, `task_id`, `actor`, `type`, `data jsonb`,
`created_at`. No `UPDATE`/`DELETE` granted; trigger enforces.

### `agents`
Identity + the features it holds. `id`, `display_name`, … Authorization reads from
**verified token claims**, not this table; the table exists so `claimed_by`,
`created_by`, event `actor`, and `subject_agent` resolve to a row, and as the basis for
token issuance.

### `features` / `agent_features`
`features`: `id`, `kind` (`capability` | `role` | `work-area` | …), `key`.
`agent_features`: `agent_id`, `feature_id`. Mutable; every change lands in `events`.

## Matching ([ADR 0004](../decisions/0004-feature-model.md))

One uniform rule, evaluated from signed claims:

> An agent may claim a task **iff** it is bound to the task's lane **and** its feature set
> ⊇ the `required_features` of at least one legal transition out of the task's current
> stage, **plus** any task-level `required_features`.

- **Lane binding** = *where* an agent works.
- **Feature superset** = eligibility across every dimension at once (capability, role,
  work-area, …).
- **Work-area features on a side-effecting transition** gate external actions (e.g. the
  "publish weekly report to Asana" transition requires `work-area:asana`).

## Agent surface (RPC-only — [ADR 0001](../decisions/0001-data-driven-state-machine.md))

Agents never write tables directly. Verbs (exact contracts = open Q7–Q9):
`create_task` (agents may create work for other agents), `claim_next_task`,
`report_progress`, `advance_task` (validates the transition; applies its `effects`),
`release_task`, `block_task`/`unblock_task`, `heartbeat`.

## Reflexive governance (plumbing now, policy later)

`transitions.effects` + `tasks.subject_agent` make "the workflow grants/revokes an
agent's feature" expressible from day one. An actual governance flow (e.g. quality review
→ revoke a work-area) is a **later slice**.

## Language ([ADR 0005](../decisions/0005-logic-language-escalation.md))

`plpgsql` for all of the above. Climb to `plv8`/FDW only when a concrete need forces it.

## Still open (not decided here)

Auth/JWT claims shape and role mapping (Q10/Q12/Q13), lease/heartbeat tuning and reaper
(Q14–Q16), env/migrations/testing (Q19–Q22), scope confirmations (Q23/Q24). See
[open-questions.md](../analysis/open-questions.md).
