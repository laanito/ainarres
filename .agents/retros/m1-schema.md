# Retro — M1: core schema + roles

- Date: 2026-06-15
- PR: build/m1-schema
- Plan: [v1-plan.md](../plans/v1-plan.md) milestone M1

## What we built

The full data model and the coarse roles, as data — no verb logic yet.

- `db/migrations/20260615090000_domain_schema.sql`: all twelve tables
  ([data-model.md](../design/data-model.md)) in a **private `app` schema** —
  `features`, `agent_families`, `agents`, `family_features`, `feature_denials`,
  `projects`, `workflows`, `lanes`, `stages`, `transitions`, `tasks`, `events`.
  uuidv7 defaults (native, no extension), FKs, the claim-supporting indexes,
  `stages.is_initial/is_terminal/lease_duration/max_attempts`, `transitions.kind`,
  `tasks.blocked/attempts/lease`. Two triggers: `tasks.updated_at` bump and the
  `events` append-only guard.
- `db/migrations/20260615090100_roles_grants.sql`: `agent`/`oversight`/`reaper`
  roles, granted to `authenticator` for SET ROLE; schema usage; oversight gets
  read-only SELECT; events UPDATE/DELETE revoked from everyone.
- `db/seed.sql`: an idempotent fixture — a project, an `api` lane, a reusable
  `dev-loop` workflow (backlog→in-progress→review→done with a reject back to
  in-progress), the trait vocabulary, and two agent families with grants.
- Tests (vitest, zero-dep): `schema`, `events`, `seed` suites plus a `db` helper
  that runs `psql` inside the `db` container.

## Key decisions made in passing

1. **Tables live in `app`, not `api`.** PostgREST only exposes `api`, so a private
   schema makes "agents never write tables directly" ([ADR 0001](../decisions/0001-data-driven-state-machine.md))
   true *by construction* — there's no REST surface to abuse. Verbs (in `api`,
   SECURITY DEFINER, M2+) are the only door.
2. **Features matched as canonical text names**, not uuids. `features.name` is a
   generated `kind:key` column; `transitions.required_features` and
   `tasks.required_features` are `text[]` of those names, the same form the token
   carries. Superset matching is then a plain `text[]` comparison with **no id
   translation in the hot claim path**. Cost: array elements can't be FK'd (true
   of any Postgres array) — soft integrity, covered by a seed test that checks
   every referenced name resolves to a real feature.
3. **Append-only events = belt *and* suspenders.** Belt: never grant
   UPDATE/DELETE. Suspenders: a trigger that raises `restrict_violation` even for
   the table owner. Tested both layers.
4. **`reaper` role created but unused in v1.** Recovery is lazy reclaim with no
   process ([ADR 0009](../decisions/0009-leases-reaper.md)); the role exists for
   forward-compat (a future optional `pg_cron`/sweeper) and carries no table rights.

## Done-tests (all green)

- `make reset` brings the stack zero→green **twice**, deterministically; teardown
  leaves no containers and no volumes.
- `make verify-down`: every migration rolls back and re-applies cleanly (new
  target — rolls all the way to zero, then `up`).
- Schema assertions (17 tests total): all twelve tables exist in `app` and none
  leak into `api`; the three roles exist (nologin) and are SET-ROLE-able by
  `authenticator`; the claim indexes + the one-initial-per-workflow partial unique
  exist; uuidv7() is native and wired as the pk default.
- `events` rejects UPDATE/DELETE (trigger) and no role holds those privileges
  (grants); oversight can read, agent cannot touch tables.
- Seed loads, is internally coherent (one initial + one terminal stage; all
  transition features resolve), and is **idempotent** (re-apply changes no counts).
- `tsc --noEmit` clean.

## What surprised us

1. **Adding the `pg` npm client was blocked** by the supply-chain policy gate.
   Rather than wait on an approval, we stayed **zero-dep** (consistent with M0's
   hand-rolled JWT minter): the `db` test helper shells out to `psql` inside the
   running container via `docker compose exec`, returning rows as `json_agg`-wrapped
   JSON. Works cleanly for schema/grant assertions. **Open question for M3:** the
   concurrency barrier test wants *N genuinely-parallel connections*; spawning N
   `psql` processes can do it, but a real driver would be ergonomic — revisit and
   ask the owner before M3 if a driver is worth the dependency.
2. **The append-only trigger blocks cascade deletes too.** `ON DELETE CASCADE` from
   `tasks` to `events` would be vetoed by the events delete-guard. That's fine —
   coordination history is permanent in v1 (tasks aren't deleted) — but worth
   noting so a future "purge" path knows it must disable the trigger deliberately.

## Ready for M2

The model is in place and trustworthy under the loop. M2 (auth & effective
features) builds on it: `mint_token` reads `family_features`, `effective_features()`
computes grant − `feature_denials`, and PostgREST role-switching gets wired so
`request.jwt.claims` reaches functions.

## Follow-up

- Blog article for M1 ("Encoding a workflow as data") pending the owner's publish
  guidelines (tracked in the plan, same as M0's).
- M3: decide pg-driver vs. N-psql-processes for the concurrency barrier test.
