# Plan — AINARRES v1

> The autonomous build plan. Scope is fixed by [ADR 0011](../decisions/0011-v1-scope-boundary.md);
> the success gate by [ADR 0012](../decisions/0012-self-hosting-success-criterion.md). Each
> milestone is one PR-sized slice that ends green, then gets a blog article. Within a
> milestone the loop is **change → test → integrate → validate**, iterated until all tests
> pass *before* committing.

## Objective

Build the v1 substrate — schema + nine verbs + auth + data-driven state machine + lazy
reclaim + human-readable views — running in the dockerized teardown/rebuild loop, and
prove it by **self-hosting**: AINARRES carries a real AINARRES development task end to end.

## Success criterion ([ADR 0012](../decisions/0012-self-hosting-success-criterion.md))

A real dev task is `create`d, `claim`ed by a registered agent family, `advance`d through
a workflow that encodes our dev loop, with the work product in git and the result visible
on the board. Reached at **M6**.

## Execution discipline

- **Branch → commit → push → PR** per milestone ([workflow](../README.md)). Owner reviews.
- **Done = verified:** a milestone's checklist of done-tests all pass in the loop before
  the PR. No item committed red.
- **Repeatable loop** (built in M0) is the validate step for every later milestone:
  `down -v → up → dbmate up → seed → test`.
- **plpgsql only** ([ADR 0005](../decisions/0005-logic-language-escalation.md)); stock
  `postgres:18`, no extensions ([ADR 0010](../decisions/0010-environment-migrations-testing.md)).
- One blog article per merged milestone (publish guidelines TBD from owner).

## Dependency order

```
M0 harness ─▶ M1 schema ─▶ M2 auth ─▶ M3 create+claim ─▶ M4 rest of verbs ─▶ M5 recovery+views ─▶ M6 self-host
```
Each milestone depends only on the prior one.

---

## M0 — Harness & skeleton

**Goal:** prove the repeatable loop itself *before* any schema or logic.

**Steps**
- `docker-compose.yml`: `postgres:18`, `postgrest/postgrest`, one-shot `migrate` (dbmate).
- dbmate layout (`db/migrations/`), `schema_migrations` bootstrapping, one no-op migration.
- A `Makefile` (or `./loop`) target: `reset` = `down -v → up → dbmate up → seed → test`.
- vitest scaffold + a `pg`/HTTP client helper; env/secret wiring (HS256 secret, role names).
- Smoke test: PostgREST is up; a trivial authenticated request succeeds.

**Done-tests**
- `make reset` brings the stack from zero to green; repeating it is deterministic (no
  residual state). Smoke test passes. Tear-down leaves nothing behind.

**Blog:** "A teardown-and-rebuild loop you can trust."

## M1 — Core schema + roles

**Goal:** the full data model and the coarse Postgres roles, no logic yet.

**Steps**
- Migrations for: `features`, `agent_families`, `agents`, `family_features`,
  `feature_denials`, `projects`, `lanes`, `workflows`, `stages`, `transitions`, `tasks`,
  `events` — per [design/data-model.md](../design/data-model.md). UUIDv7 defaults, FKs,
  the claim-supporting indexes, `stages.is_initial/is_terminal/lease_duration/max_attempts`,
  `transitions.kind`, `tasks.blocked/attempts/lease`.
- Coarse roles (`anon`, `agent`, `oversight`, `reaper`) + table grants.
- Append-only `events`: revoke `UPDATE`/`DELETE`, add a guard trigger.
- A `seed` fixture: one project, lane, workflow, stages, transitions, a couple of families.

**Done-tests**
- Migrations apply on a fresh DB and **down-migrations revert** cleanly.
- Schema assertions: tables/roles/indexes exist; `events` rejects `UPDATE`/`DELETE`.
- Seed loads without error and is idempotent under `reset`.

**Blog:** "Encoding a workflow as data: the AINARRES schema."

## M2 — Auth & effective features

**Goal:** tokens carry the grant; the DB computes effective features (grant − veto).

**Steps**
- Token minting: a privileged path (`mint_token`) stamping `sub/family/role/features[]/exp`
  from `family_features` (HS256); a TS helper mirrors it for tests.
- `effective_features()` plpgsql: read `request.jwt.claims.features` minus
  `feature_denials(family)`.
- Wire PostgREST role-switching; confirm `request.jwt.claims` reaches functions.

**Done-tests**
- A minted token authenticates and `SET ROLE`s correctly.
- `effective_features` = granted − denied; a freshly inserted denial takes effect on the
  next call (instant revocation); features cannot be added via arguments.

**Blog:** "Grant in the token, veto in the database."

## M3 — Verbs I: `create_task` + `claim_next_task` (+ concurrency)

**Goal:** the queue works and the claim is race-free.

**Steps**
- The uniform envelope helper (`{ok, code, reason?, task?, event?}`).
- `create_task`: insert at the workflow `is_initial` stage; gated by lane-feature.
- `claim_next_task`: availability = `claimed_by IS NULL OR lease_expires_at < now()`;
  effective-feature superset; `FOR UPDATE SKIP LOCKED`; one-per-instance; stamp lease.

**Done-tests**
- create → claim happy path; envelope shapes; `not_eligible`, `already_holding`, `empty`.
- **Concurrency barrier test** ([ADR 0010](../decisions/0010-environment-migrations-testing.md)):
  *N* connections released together; no task claimed twice; successes = min(N, K). Runs
  every `reset`.

**Blog:** "SKIP LOCKED, honestly tested."

## M4 — Verbs II: advance / reject / release / block / progress / heartbeat

**Goal:** the full agent surface and its invariants.

**Steps**
- `advance_task`: validate a legal `advance` transition + eligibility + guard +
  optimistic from-stage check; apply `effects` (family grant/deny); write `transition`
  event; move stage; **release the hold**.
- `reject_task`: same over `reject` transitions; separately gated.
- `release_task`: `attempts++`, threshold → `blocked`.
- `block_task`/`unblock_task`; `report_progress` (event + artifact refs + renew lease);
  `heartbeat` (renew).
- Enforce `lease_lost` (`claimed_by = sub AND lease_expires_at > now()`) across all.

**Done-tests**
- Legal advance moves stage, releases hold, logs event; illegal transition →
  `illegal_transition`; reject gated independently of advance; `effects` mutate denials;
  `lease_lost` after expiry; blocked task excluded from claim; progress appends + renews.

**Blog:** "Nine verbs and the rules that hold them."

## M5 — Recovery & views

**Goal:** self-healing and the human surface.

**Steps**
- End-to-end lazy reclaim: expired lease → next claimer reclaims → `attempts++` → poison
  → auto-`blocked` at `max_attempts`.
- Views: `board` (lane × stage), `feed` (events), `abandoned` (expired-lease-still-claimed);
  grants to `oversight`.

**Done-tests**
- A held task whose lease expired is reclaimed by another agent; original holder gets
  `lease_lost`. Poison task auto-blocks. Views return expected rows under the right roles.

**Blog:** "Recovery with no moving parts."

## M6 — Self-hosting checkpoint (success gate)

**Goal:** prove [ADR 0012](../decisions/0012-self-hosting-success-criterion.md).

**Steps**
- Seed a real **AINARRES dev** project/lane/workflow whose stages encode change → test →
  integrate → validate, with `reject` rework transitions.
- Register real agent families with features; mint their tokens.
- A **thin TS client** (reusing test helpers) so an agent can `claim`/`advance` ergonomically.
- Drive one real, small dev task through the workflow; land its work product in the repo.

**Done-tests / success gate**
- A real dev task goes `create → claim → advance/reject → … → terminal` entirely through
  the verbs; work product is in git; the board shows the journey; the owner can intervene.

**Blog:** "AINARRES, building AINARRES."

---

## Open follow-ups (tracked, not blocking v1)

- Blog publish guidelines (owner to provide before M0's article ships).
- Plan structure: this single file vs. one file per milestone — revisit if it grows.
- Post-v1 backlog already has homes: governance *policy*, `pg_cron`, egress, pooling,
  scaling, oversight UI (see [ADR 0011](../decisions/0011-v1-scope-boundary.md)).
