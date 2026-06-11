# Open questions

Everything except **Postgres + PostgREST** is open. This is the burn-down list that
drives the design phase. Each question, once resolved, becomes an ADR in `decisions/`
and is checked off here with a pointer.

Legend: `[ ]` open · `[~]` in discussion · `[x]` resolved (→ ADR)

## A. Data model & state machine
- [x] **Q1** Pipeline representation → **data-driven**; agents interact RPC-only.
  (→ [ADR 0001](../decisions/0001-data-driven-state-machine.md))
- [x] **Q2** Task schema → minimal structured core + `payload jsonb`.
  (→ [ADR 0006](../decisions/0006-task-identity-events-artifacts.md), [design](../design/data-model.md))
- [x] **Q3** Task id type → **UUIDv7**.
  (→ [ADR 0006](../decisions/0006-task-identity-events-artifacts.md))
- [x] **Q4** Stages → data-driven lookup scoped to a **workflow**; flow is **per lane**
  via reusable workflows. (→ [ADR 0002](../decisions/0002-project-lane-workflow-hierarchy.md))
- [x] **Q5** Event log → one append-only `events` table with a `type` discriminator.
  (→ [ADR 0006](../decisions/0006-task-identity-events-artifacts.md))
- [x] **Q6** Artifacts → **references** in event/payload `jsonb`, no table in v1.
  (→ [ADR 0006](../decisions/0006-task-identity-events-artifacts.md), [ADR 0003](../decisions/0003-two-plane-source-of-truth.md))

> **New (from design discussion):** the three agent axes — capability/role/work-area —
> are unified into one generic **feature** mechanism with superset matching, and the
> workflow can mutate features (reflexive governance). The source-of-truth boundary was
> split into coordination (DB) vs. work product (external).
> → [ADR 0004](../decisions/0004-feature-model.md), [ADR 0003](../decisions/0003-two-plane-source-of-truth.md)

## B. Agent-facing surface (the verbs)
- [x] **Q7** Verb set → **nine** verbs; rejection is its own verb (`reject_task`) for
  permission granularity; failure stays a forward transition. (→ [ADR 0008](../decisions/0008-verb-contracts.md))
- [x] **Q8** Contract → **uniform envelope** `{ok, code, reason?, task?, event?}`, always
  HTTP 200; outcomes are values not exceptions. (→ [ADR 0008](../decisions/0008-verb-contracts.md))
- [x] **Q9** Holding → **one active task per instance**; scale by spawning instances.
  (→ [ADR 0008](../decisions/0008-verb-contracts.md))

## C. Identity, auth & capability matching
- [x] **Q10** Token claims → `sub`, `family`, `role`, granted `features[]`, `exp`. Token
  is the grant; effective = grant − family denials. (→ [ADR 0007](../decisions/0007-auth-identity-family-grant-deny.md))
- [x] **Q11** Matching → **pure feature superset** over *effective* features (lane folded
  in as a feature kind). (→ [ADR 0004](../decisions/0004-feature-model.md) amended by [0007](../decisions/0007-auth-identity-family-grant-deny.md))
- [x] **Q12** Postgres roles → coarse fixed set (`agent`/`oversight`/`reaper`/`anon`);
  functional role is a feature, not a Postgres role. (→ [ADR 0007](../decisions/0007-auth-identity-family-grant-deny.md))
- [x] **Q13** Issuance → HS256 shared secret + privileged mint for v1; asymmetric/JWKS +
  rotation deferred. (→ [ADR 0007](../decisions/0007-auth-identity-family-grant-deny.md))

## D. Leases, heartbeat & recovery
- [x] **Q14** Lease → data-driven `stage.lease_duration` → `workflow.default_lease` →
  system (~5 min); heartbeat cadence advisory (~lease/5). (→ [ADR 0009](../decisions/0009-leases-reaper.md))
- [x] **Q15** Recovery → **lazy reclaim** (claim treats expired leases as available); no
  process; `pg_cron` deferred/optional. (→ [ADR 0009](../decisions/0009-leases-reaper.md))
- [x] **Q16** Reaped task → open at same stage, `attempts++`; `max_attempts` exceeded
  auto-`blocked` (reuse block flag, no `abandoned` state). (→ [ADR 0009](../decisions/0009-leases-reaper.md))

## E. Logic language
- [x] **Q17** PL language → **plpgsql-first escalation ladder** (plpgsql → plv8 → FDW),
  climb only when forced. (→ [ADR 0005](../decisions/0005-logic-language-escalation.md))
- [x] **Q18** Untrusted languages → deferred; everything trusted (plpgsql) in v1.
  (→ [ADR 0005](../decisions/0005-logic-language-escalation.md))

## F. Environment, migrations & testing
- [ ] **Q19** Migration tooling — raw ordered SQL files, sqitch, Flyway, dbmate, or
  similar? Must support deterministic teardown/rebuild (the dockerized loop).
- [ ] **Q20** `docker compose` topology for local: Postgres image (which extensions
  baked in — `pg_cron`, `plv8`?), PostgREST, and how the schema loads on boot.
- [ ] **Q21** DB test strategy — pgTAP in-DB, vs. an external test runner driving SQL/RPC
  over the PostgREST surface, vs. both. Must cover **concurrency** (the `SKIP LOCKED`
  race) and **illegal transitions**. (Risk R5.)
- [ ] **Q22** How do we exercise true concurrency in tests deterministically (multiple
  sessions claiming at once)?

## G. Scope boundaries (confirm deferrals)
- [ ] **Q23** Confirm scaling (single-writer/sharding/replication), external egress
  (outbox + `LISTEN/NOTIFY`), and pooling (PgBouncer) are **out of v1 scope** — kept as
  constraints we don't design *against*, but don't build *yet*.
- [ ] **Q24** Is a human oversight UI in scope for v1, or only human-readable
  tables/views with the UI deferred?
