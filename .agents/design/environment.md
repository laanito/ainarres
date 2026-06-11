# Design — environment, migrations & testing

> The operational shape decided by [ADR 0010](../decisions/0010-environment-migrations-testing.md)
> and bounded by [ADR 0011](../decisions/0011-v1-scope-boundary.md). The *what*; the ADRs
> hold the *why*. **No code yet** — this describes what the plan will build.

## Compose topology

```
┌─────────────┐     JWT (HS256)      ┌──────────────────┐
│  test / agent│ ───────────────────▶│ postgrest         │
└─────────────┘   POST /rpc/<verb>   │ (stock image)     │
                                      └────────┬─────────┘
                                               │ SQL
                                      ┌────────▼─────────┐   one-shot
                                      │ postgres:18       │◀── migrate (dbmate)
                                      │ stock, no exts    │
                                      └──────────────────┘
```

- **`postgres:18`** — unmodified. Native `uuidv7()` + `gen_random_uuid()`; no `pg_cron`,
  no `plv8`, no extensions to build.
- **`postgrest/postgrest`** — configured with the HS256 secret and the `anon` role.
- **`migrate`** — one-shot dbmate container; applies `db/migrations/` then exits.
- No PgBouncer (deferred, ADR 0011).

## Migrations (dbmate)

- Plain SQL `up`/`down` under `db/migrations/`, tracked in `schema_migrations`.
- Create everything: tables, views, verb functions, the coarse roles
  (`agent`/`oversight`/`reaper`/`anon`) + grants.

## The repeatable loop

The substrate for every plan item's *validate* step (one command / Make target):

```
down -v      # drop the volume — known-zero state
up           # fresh postgres + postgrest
dbmate up    # apply schema
seed         # fixtures: a project, lane, workflow, stages, transitions, families
test         # the TS suite
```

## Tests (TypeScript / Node, vitest)

| Layer | Drives | Covers |
|-------|--------|--------|
| Contract | PostgREST HTTP + minted JWTs | the uniform envelope, auth, effective-feature matching, illegal-transition rejection, lease renewal |
| Recovery | `pg` client + clock control | lease expiry → lazy reclaim → `attempts++` → poison→`blocked` |
| Concurrency | *N* `pg` connections + barrier | `SKIP LOCKED`: no double-claim, successes = min(N, K) |

**Concurrency barrier:** open *N* connections, hold at a shared advisory lock / `NOTIFY`
gate, release together so all fire `claim_next_task` in a tight window; assert invariants
(hold under any interleaving). Run every rebuild.

## v1 scope (ADR 0011)

**In:** schema + nine verbs + auth + data-driven state machine + lazy reclaim +
human-readable views + the dockerized loop & tests.
**Out (deferred):** scaling, egress (outbox/`LISTEN/NOTIFY`), pooling, `pg_cron`, `plv8`/
FDW, governance *policy*, oversight UI.
