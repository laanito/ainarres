# ADR 0010 — Environment, migrations & testing

- Status: Accepted
- Date: 2026-06-10
- Closes: Q19, Q20, Q21, Q22
- Builds on: [0005](0005-logic-language-escalation.md) (earn dependencies),
  [0006](0006-task-identity-events-artifacts.md) (UUIDv7), [0008](0008-verb-contracts.md)
  (envelope contract), [0009](0009-leases-reaper.md) (no `pg_cron`)

## Context

The development loop is change → test → integrate → validate, on a **dockerized
environment that can be torn down and rebuilt deterministically** as often as needed. The
cleverness lives in the DB (SQL/RPC), so the harness must exercise the real surface
including concurrency (`SKIP LOCKED`, risk R5) and illegal transitions. This ADR fixes the
tooling.

## Decision

### Image & topology (Q20) — stock Postgres, two services + a migrate step

- **`postgres:18`**, unmodified. It provides native `uuidv7()` and `gen_random_uuid()`,
  and we deferred `pg_cron` (0009) and `plv8` (0005) — so **no extensions, no custom
  image build**.
- **`postgrest/postgrest`** in front, configured with the HS256 JWT secret (0007) and the
  `anon` role.
- A **one-shot `migrate` service** (dbmate) applies the schema on boot.
- No PgBouncer (deferred, see [0011](0011-v1-scope-boundary.md)).

### Migrations (Q19) — dbmate, plain SQL

- **dbmate**: a single static binary, plain-SQL `up`/`down` migrations under
  `db/migrations/`, tracked in a `schema_migrations` table.
- Migrations create everything: tables, views, the verb functions, the coarse Postgres
  roles (`agent`/`oversight`/`reaper`/`anon`) and their grants.
- Deterministic loop: `down -v` (drop volume) → `up` (fresh DB) → `dbmate up` (schema) →
  seed → test. Supports both fresh rebuild (dev) and incremental apply (later/prod).

### Test strategy (Q21) — TypeScript runner over the real surface

- **TypeScript / Node** (vitest): the primary suite drives the **PostgREST HTTP
  surface** — minting HS256 JWTs, calling the verbs, asserting the uniform envelope
  (0008), auth, effective-feature matching, and illegal-transition rejection. This tests
  what agents actually see, and shares helpers with future JS/TS agents.
- A `pg` client is used for **concurrency** tests (below) and seeding.
- `pgTAP` is **optional, later**, for pure in-DB units — not the backbone (can't drive
  real concurrency; adds an extension).

### Deterministic concurrency (Q22) — release barrier + invariant assertions

True simultaneity can't be perfectly forced, so we assert **invariants** that hold under
any interleaving:

- Open *N* real connections; hold them at a **barrier** (a shared advisory lock the test
  releases, or a `NOTIFY` gate) so all *N* fire `claim_next_task` in a tight window.
- Seed *K* claimable tasks; assert: **no task is claimed twice**, and **successes =
  min(N, K)**, the rest get `code:"empty"`.
- Run every rebuild. `SKIP LOCKED` correctness either holds or the invariant fails — the
  assertion is deterministic even though timing isn't.

## Alternatives considered

- **sqitch / Flyway / Atlas** for migrations. Rejected: heavier (Perl/JVM) or a
  declarative model we don't need yet; dbmate is the lightest tool that still gives
  versioning + up/down.
- **Raw init-files, no migration tool.** Zero-dep, but no version tracking / down /
  apply-to-existing; dbmate's cost is negligible and buys a real migration story.
- **pgTAP as the primary harness.** Rejected: single-session, so it can't honestly test
  the claim race, and it adds an extension.

## Consequences

- The repo grows a `docker-compose.yml`, `db/migrations/`, and a `test/` suite (TS).
- A single command/Make target runs the full teardown→rebuild→seed→test loop — the
  substrate for every plan item's "validate" step.
- Stock image + dbmate + TS tests are all dependency-light and CI-friendly.
- This and [0011](0011-v1-scope-boundary.md) complete the design phase; next is the
  autonomous plan in `plans/`.
