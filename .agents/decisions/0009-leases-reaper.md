# ADR 0009 — Leases, heartbeat, and recovery by lazy reclaim

- Status: Accepted
- Date: 2026-06-10
- Closes: Q14, Q15, Q16
- Builds on: [0008](0008-verb-contracts.md) (`lease_lost` invariant, `attempts`,
  `blocked`), [0005](0005-logic-language-escalation.md) (earn dependencies),
  [0001](0001-data-driven-state-machine.md) (`SKIP LOCKED`, no orchestrator)

## Context

A claim sets a lease so a crashed agent can't hold work forever (risk R4). The README
assumed a `pg_cron` job sweeps expired leases back to the queue. With everything but
Postgres+PostgREST open and ADR 0005's "earn the dependency" rule, we re-examined the
recovery mechanism, the lease/heartbeat timing, and what happens to a recovered task.

## Decision

### Recovery is lazy reclaim — no scheduled process (Q15)

A task is **available** to `claim_next_task` when:

```
claimed_by IS NULL  OR  lease_expires_at < now()
```

A dead agent's task becomes claimable the instant its lease expires, discovered by the
next claimer under the same `FOR UPDATE SKIP LOCKED`. **No external process, no cron** —
recovery is the claim path doing its job, which is the strongest possible statement of
"no orchestrator." The previous holder is already locked out by ADR 0008's
`claimed_by = sub AND lease_expires_at > now()` check (`code:"lease_lost"`).

- Observability without a sweeper: a **view** computes `abandoned` (`lease_expires_at <
  now()` while still `claimed_by IS NOT NULL`) so the human board sees stuck work.
- `pg_cron` is **deferred** to a later optional slice (proactive hygiene, time-based
  notifications). It is not a v1 dependency; the image stays lean.

### Lease duration is data-driven; heartbeat is advisory (Q14)

- `lease_duration` is an **optional column on `stages`**, falling back to a **workflow**
  default (`workflows.default_lease`), falling back to a **system** default (~5 min).
  Stages vary by orders of magnitude (a quick automated check vs. a hours-long human
  review), so the lease lives with the stage.
- `claim_next_task` stamps `lease_expires_at = now() + resolved_lease`.
- **Heartbeat cadence is advisory to clients** (~lease/5); the server only enforces
  expiry. `report_progress` and `advance_task`/`reject_task` also renew the lease, so an
  actively-working agent rarely needs an explicit `heartbeat`.

### A reaped task returns to open; poison tasks auto-block (Q16)

- On reclaim, the task returns to **open at the same stage** with **`attempts++`** — no
  separate `abandoned` lifecycle stage.
- A data-driven **`max_attempts`** (stage → workflow → system fallback) bounds retries.
  When `attempts` would exceed it, the task is auto-**`blocked`** with reason
  `"max attempts exceeded"` instead of being handed out again — reusing the `blocked`
  flag from [ADR 0008](0008-verb-contracts.md), so a human can investigate. No new state.
- The increment + threshold check happen at **reclaim time** (lazy). `release_task`
  applies the same `attempts++`/threshold logic for voluntary returns.

## Alternatives considered

- **`pg_cron` sweeper as the recovery mechanism (README's choice).** Rejected for v1:
  adds an extension dependency for something lazy reclaim already guarantees, and a
  scheduled process weakens the "no orchestrator" claim. Kept as a deferred, optional
  enhancement.
- **Single global lease duration.** Rejected: stages differ by orders of magnitude;
  a nullable per-stage column with fallbacks costs little and fits the data-driven ethos.
- **A distinct `abandoned` stage/state.** Rejected: abandonment is orthogonal to workflow
  position (like `blocked`); reusing `blocked` avoids a parallel lifecycle.

## Consequences

- Zero background processes in v1; the only moving parts are the verbs and Postgres.
- Model additions: `stages.lease_duration?`, `stages.max_attempts?`,
  `workflows.default_lease`, `workflows.default_max_attempts`; an `abandoned` view; the
  `claim_next_task` availability predicate includes expired leases.
- If a deployment later wants proactive tidying or wake-ups, `pg_cron` slots in without
  changing the contract — it would only do eagerly what lazy reclaim already does.
- This closes the last *mechanics* cluster; remaining design is environment/testing
  (Q19–Q22) and scope confirmations (Q23/Q24).
