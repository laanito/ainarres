# Retro — M2: auth & effective features

- Date: 2026-06-16
- PR: build/m2-auth
- Plan: [v1-plan.md](../plans/v1-plan.md) milestone M2

## What we built

Tokens carry the grant; the DB computes the effective feature set and PostgREST
role-switching is proven end to end. One migration
(`20260616090000_auth_effective_features.sql`), four functions in the exposed
`api` schema:

- `api.jwt_claims()` — verified claims as jsonb (`{}` for anon). SECURITY INVOKER;
  reads only the `request.jwt.claims` GUC.
- `api.effective_features()` — **the hot path** (ADR 0004/0007): token `features[]`
  − `feature_denials(family)`. Zero arguments — eligibility derives only from
  verified claims, never from caller input (risk R3). SECURITY DEFINER so it reads
  `app.*` that `agent` can't touch directly.
- `api.whoami()` — introspection + the "SET ROLE works" test vehicle. SECURITY
  INVOKER on purpose, so `current_user` reflects the role PostgREST switched into;
  it delegates feature computation to the definer `effective_features`.
- `api.token_claims(family_key, assume_role, ttl_seconds)` — the privileged
  provisioning path: snapshots a family's `family_features` into token claims.
  reaper-only.

Plus `test/helpers/mint.ts` — the TS minter that mirrors `token_claims` (reads the
same `family_features`, then HS256-signs), and `test/auth.test.ts` (8 tests).

## Key decisions made in passing

1. **Signing lives outside the DB.** ADR 0007 wanted "a privileged mint path that
   reads a family's provisioned features and signs." In-DB HMAC would need the
   `pgcrypto` extension, which [ADR 0010](../decisions/0010-environment-migrations-testing.md)
   forbids (stock `postgres:18`, no extensions). So the DB *builds* authoritative
   claims (`token_claims`) and the privileged minter *signs* them (TS helper now, a
   service later). Consistent with ADR 0007 — it never said sign in the DB. A test
   asserts the DB snapshot and the TS mirror can't drift.
2. **Effective features as the only eligibility source.** `effective_features()`
   takes no parameters by design; a test asserts `pronargs = 0` (there is literally
   no argument path to inject features) plus a behavioral check that a bogus
   `features` body changes nothing.
3. **Instance registration is lazy.** `token_claims` mints a fresh `sub` (uuidv7)
   but does **not** insert an `app.agents` row — that happens at first claim (M3).
   Keeps minting side-effect-free.

## What surprised us

1. **Postgres grants `EXECUTE` to `PUBLIC` by default.** My explicit
   `grant ... to <role>` lines were no-ops on top of the implicit PUBLIC grant, so
   anon could call `whoami` and *any* role could call the privileged, SECURITY
   DEFINER `token_claims` — a real hole. Fix: `revoke execute ... from public` on
   every function before granting. Caught by the deny-path tests (anon→whoami,
   agent→token_claims both expected to be rejected and weren't). **Lesson for M3+:
   every new function needs `revoke execute from public` — especially definers.**

## Done-tests (all green — 25 total, 8 new)

- A minted token authenticates; `whoami` shows `role=agent`,
  `session_role=authenticator` (SET ROLE applied).
- anon cannot reach an agent-only function (401/403).
- `effective_features` = grant when no denials; a **freshly inserted denial is
  honored on the very next call with the same token** (instant revocation), and
  removing it restores the feature.
- Features cannot be injected via arguments (`pronargs = 0` + behavioral).
- `token_claims` is reaper-only (agent rejected), snapshots `family_features`,
  matches the TS mirror, and rejects an unknown family.
- `make reset` zero→green twice (deterministic); `make verify-down` clean; teardown
  leaves nothing; `tsc --noEmit` clean.

## Ready for M3

Auth and matching inputs are in place. M3 (`create_task` + `claim_next_task` +
concurrency) builds the first real verbs: the uniform envelope helper,
`create_task` at the initial stage gated by lane feature, and the race-free
`claim_next_task` using `effective_features()` for the superset check and
`FOR UPDATE SKIP LOCKED`.

## Follow-up

- Blog article for M2 ("Grant in the token, veto in the database") pending the
  owner's publish guidelines (tracked, same as M0/M1).
- **M3 open question (carried from M1):** the concurrency barrier wants N genuinely
  parallel connections. Per the owner's steer (containerize deps, no local npm
  installs), drive them from a containerized client — N `psql` processes against
  the `db` container, or a small client service in compose — not a local `pg`
  driver.
- SECURITY DEFINER functions are owned by the migration superuser (postgres). Fine
  for v1; a dedicated lower-privilege owner role is a possible later hardening.
