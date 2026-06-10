# Design — data model & state machine

> The worked-out model the ADRs decided. ADRs ([0001](../decisions/0001-data-driven-state-machine.md)–[0006](../decisions/0006-task-identity-events-artifacts.md))
> hold the *why* and rejected alternatives; this file is the *what*. Still a design
> sketch — column types firm up when we write migrations. **No code yet.**

## Shape

```
projects ──< lanes >── workflows ──< stages
                           └────────< transitions
            lanes ──< tasks >── (subject) ── agents/families
                        └──< events
agent_families ──< agents              (durable class ──< ephemeral instance)
agent_families ──< family_features      (provisioning grant; minted into the token)
agent_families ──< feature_denials      (governance veto, fresh)
features >── (kinds incl. `lane`; referenced by family_features, denials, requirements)
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
A column in a workflow's board. `id`, `workflow_id`, `key`, `ordering`, `is_initial`
(where `create_task` lands), `is_terminal`.

### `transitions`
A legal move. The single place flow rules are enforced. `id`, `workflow_id`,
`from_stage`, `to_stage`, `kind` (`advance` | `reject` — selects which verb may execute
it), `required_features[]`, `effects jsonb?` (grant/revoke on subject), `guard?`.

### `tasks`
The unit of work. Small structured core; the rest in `payload`.
`id (uuidv7)`, `lane_id`, `stage`, `required_features[]?` (extras on top of the flow),
`subject?` (when the task is *about* an agent/family — e.g. governance), `claimed_by?`,
`lease_expires_at?`, `blocked` + `blocked_reason?` (orthogonal park flag), `priority`,
`attempts`, `payload jsonb`, `created_by`, `created_at`, `updated_at`.

### `events`
Append-only oversight feed + audit trail. `id`, `task_id`, `actor`, `type`, `data jsonb`,
`created_at`. No `UPDATE`/`DELETE` granted; trigger enforces.

### `agent_families` — identity & competence unit ([ADR 0007](../decisions/0007-auth-identity-family-grant-deny.md))
The **durable** class = `(harness/tool + model)`, e.g. `opencode+qwen`,
`claude-code+opus`. Grants and denials attach here, because competence is a family
property that survives instance respawn. `id`, `key`, `description`.

### `agents` — instance
An **ephemeral** instance of a family. `id` (= token `sub`), `family_id`,
`first_seen_at`. Exists so `claimed_by`, `created_by`, event `actor`, and task `subject`
resolve to a row. Authorization never trusts this table — it derives from effective
features (below).

### `features`
The trait vocabulary. `id`, `kind` (`capability` | `role` | `work-area` | `lane` | …),
`key`. **`lane` is a feature kind** — lane membership is just a feature, not a separate
dimension.

### `family_features` — grant (provisioning)
What a family is provisioned with. `family_id`, `feature_id`. Human-assigned; the mint
path reads this to stamp the token's `features[]`.

### `feature_denials` — veto (governance)
Family-scoped revocations, written by governance; always fresh. `id`, `family_id`,
`feature_id`, `reason`, `created_at`.

## Identity & effective features ([ADR 0007](../decisions/0007-auth-identity-family-grant-deny.md))

- **Token (grant, signed):** `sub`, `family`, `role` (Postgres role), `features[]`
  (snapshot of `family_features`), `exp`. Upper bound; an agent can't add to it.
- **Effective features = token `features[]` − `feature_denials(family)`.** Revoking is
  instant; granting needs a reissued token.
- **Coarse Postgres roles** gate which functions you may call: `agent`, `oversight`,
  `reaper`/`admin`, `anon`. The functional role (analyst/reviewer/…) is a *feature*, not
  a Postgres role.

## Matching ([ADR 0004](../decisions/0004-feature-model.md), amended by [0007](../decisions/0007-auth-identity-family-grant-deny.md))

One uniform rule — **pure feature superset** over the **effective** feature set:

> An agent may claim a task **iff** its effective features ⊇ the `required_features` of
> at least one legal transition out of the task's current stage, **plus** any task-level
> `required_features`. A task in lane *X* implicitly requires feature `(lane, X)`.

- **Lane** = a `lane`-kind feature → *where* an agent works.
- **Feature superset** = eligibility across every dimension at once (capability, role,
  work-area, lane).
- **Work-area features on a side-effecting transition** gate external actions (e.g. the
  "publish weekly report to Asana" transition requires `work-area:asana`).

## Agent surface (RPC-only — [ADR 0001](../decisions/0001-data-driven-state-machine.md), contracts [ADR 0008](../decisions/0008-verb-contracts.md))

Agents never write tables directly. Nine verbs, each returning a **uniform envelope**
`{ok, code, reason?, task?, event?}` (always HTTP 200):

- `create_task` (agents may create work for other agents) — lands at `is_initial` stage.
- `claim_next_task` — `FOR UPDATE SKIP LOCKED`; one active task per instance.
- `report_progress` — append a `progress` event; renews lease.
- `advance_task` — execute an `advance` transition; apply `effects`; **release the hold**.
- `reject_task` — execute a `reject` transition; separately permission-gated.
- `release_task` — return a held task unchanged; `attempts++`.
- `block_task` / `unblock_task` — orthogonal `blocked` flag + reason.
- `heartbeat` — renew the lease.

Every verb on a held task asserts `claimed_by = sub AND lease_expires_at > now()`; a
reaped agent returning late gets `code:"lease_lost"` and must re-claim. Eligibility is
computed from **effective features**, never from arguments.

## Reflexive governance (plumbing now, policy later)

`transitions.effects` + `tasks.subject` make "the workflow grants/revokes a feature"
expressible from day one. A revoke writes a **family-scoped `feature_denials`** row
(instant effect); a grant updates `family_features` (takes effect on token reissue). An
actual governance flow (e.g. quality review → revoke a work-area for a family) is a
**later slice**.

## Language ([ADR 0005](../decisions/0005-logic-language-escalation.md))

`plpgsql` for all of the above. Climb to `plv8`/FDW only when a concrete need forces it.

## Still open (not decided here)

Lease/heartbeat tuning and reaper (Q14–Q16), env/migrations/testing (Q19–Q22), scope
confirmations (Q23/Q24). See [open-questions.md](../analysis/open-questions.md).
