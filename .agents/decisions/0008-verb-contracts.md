# ADR 0008 — Agent-facing verb contracts

- Status: Accepted
- Date: 2026-06-10
- Closes: Q7, Q8, Q9
- Builds on: [0001](0001-data-driven-state-machine.md) (RPC-only, data-driven),
  [0004](0004-feature-model.md)/[0007](0007-auth-identity-family-grant-deny.md)
  (effective-feature matching), [0003](0003-two-plane-source-of-truth.md) (references)

## Context

The agent-facing surface is the entire contract between dumb agents and the substrate
([ADR 0001](0001-data-driven-state-machine.md): RPC-only). With the data model, matching,
and auth settled, this ADR pins the verb set, each verb's behaviour, the return/error
shape, and how many tasks an agent may hold.

## Decision

### Verb set (Q7) — nine verbs

Failure-as-a-dead-end stays a **forward transition** into a terminal failure stage (no
dedicated verb). But **rejection is its own verb** for *permission granularity*: the
ability to reject (send work back) is gated separately from the ability to advance it, so
a worker family can advance while only a reviewer family can reject.

To keep moves data-driven, **transitions carry a `kind`** (`advance` | `reject`).
`advance_task` executes `advance` transitions; `reject_task` executes `reject`
transitions. Both still check `required_features`.

| Verb | Behaviour | Envelope payload |
|---|---|---|
| `create_task(lane, payload, priority?, required_features?, subject?)` | Insert a task at the lane's workflow **initial stage** (`stages.is_initial`); `created_by = sub`. Gated by lane membership feature. | `task` |
| `claim_next_task(lane?)` | Next open, unblocked, non-terminal task whose required features (≥1 legal outbound transition + task extras) ⊆ caller's **effective** features; `FOR UPDATE SKIP LOCKED`; set `claimed_by`, lease. | `task` (or `code:"empty"`) |
| `report_progress(task, note, artifacts?)` | Append a `progress` event (artifacts are **references**, ADR 0003); renew lease. | `event` |
| `advance_task(task, to_stage, note?, artifacts?)` | Validate a legal **advance** transition out of the current stage the caller is eligible for; run guard; apply `effects`; write `transition` event; move stage; **release the hold**. | `task` |
| `reject_task(task, to_stage, reason, artifacts?)` | As advance, but over a **reject** transition; separately gated. Sends the task back; releases the hold. | `task` |
| `release_task(task, reason?)` | Return a held task unchanged (same stage); clear claim/lease; `attempts++`; `released` event. | `task` |
| `block_task(task, reason)` | Park the task (orthogonal `blocked` flag + reason, not a stage); clear claim/lease; not claimable while blocked. | `task` |
| `unblock_task(task, note?)` | Clear `blocked`; task open again at its stage. | `task` |
| `heartbeat(task)` | Renew the lease during long work. | `lease_expires_at` |

### Return / error contract (Q8) — uniform envelope

Every verb returns the **same JSON envelope** (always HTTP 200; no SQLSTATE→HTTP
mapping), so a dumb client parses one shape and never infers meaning from status codes:

```json
{
  "ok":     true | false,
  "code":   "ok" | "empty" | "not_eligible" | "illegal_transition"
            | "lease_lost" | "blocked" | "already_holding" | "not_found" | ...,
  "reason": "human-readable explanation (present when ok=false)",
  "task":   { ... } | null,
  "event":  { ... } | null
}
```

- App-level outcomes are **values, not exceptions** — verbs validate and return the
  envelope. `claim_next_task` with nothing to do is `{ok:true, code:"empty", task:null}`,
  not an error.
- Only genuine infrastructure faults (deadlock, etc.) surface as a DB error.

### Holding rule (Q9) — one active task per instance

An agent **instance** holds **at most one** task. `claim_next_task` returns
`{ok:false, code:"already_holding"}` if the caller already holds one. **Concurrency comes
from spawning more instances of a family**, not from per-instance parallelism — matching
the ephemeral-instance model ([ADR 0007](0007-auth-identity-family-grant-deny.md)) and
keeping one lease per agent.

### Safety invariants

- Every verb acting on a held task asserts `claimed_by = sub AND lease_expires_at >
  now()`. A **reaped** agent returning late gets `code:"lease_lost"` and must re-claim —
  this is what makes the reaper (next cluster) safe.
- `advance_task`/`reject_task` also assert the task is still at the expected `from`
  stage (optimistic guard) before applying the transition.
- Eligibility is computed from **effective features** (token grant − family denials),
  read from verified claims — never from verb arguments (risk R3).

## Alternatives considered

- **No `reject_task` (rejection as a plain transition).** Rejected: the owner wants
  reject permission gated independently of advance permission; a separate verb expresses
  that cleanly.
- **Exceptions → HTTP status codes.** Idiomatic PostgREST, but pushes status-to-reason
  mapping into every client. Rejected in favour of the uniform envelope — less agent-side
  logic, more manageable for dumb clients.
- **Multiple concurrent tasks per instance.** Rejected for v1: complicates leases and
  heartbeat for no gain when scaling-by-instances is available.

## Consequences

- Small model additions: `stages.is_initial`, `transitions.kind` (`advance`|`reject`).
- Verbs are `SECURITY DEFINER`, granted `EXECUTE` to the `agent` role (intervention
  verbs also to `oversight`).
- The envelope is the stable contract; internal refactors don't change what clients parse.
- Lease/heartbeat *durations* and the reaper are the next cluster (Q14–Q16); this ADR
  fixes only the verb-visible behaviour.
