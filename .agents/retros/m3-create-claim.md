# Retro — M3: verbs I (create_task + claim_next_task) + concurrency

- Date: 2026-06-17
- PR: build/m3-create-claim
- Plan: [v1-plan.md](../plans/v1-plan.md) milestone M3

## What we built

The first real agent verbs and the proof that the claim is race-free.

- Migration `20260617090000_verbs_create_claim.sql`:
  - Private `app` helpers: `envelope()` (the uniform `{ok,code,reason,task,event}`
    of ADR 0008), `task_json()` (a task row enriched with `stage_key`/`lane_key`),
    `ensure_agent()` (lazy instance registration, id = token `sub`).
  - `api.create_task(lane_key, payload?, priority?, required_features?, subject?)` —
    inserts at the lane's workflow initial stage, `created_by = sub`, gated by the
    implicit `lane:<key>` feature; writes a `created` event.
  - `api.claim_next_task(lane_key?)` — availability = unclaimed **or** lease expired
    (lazy reclaim, ADR 0009); eligibility = effective features cover the lane, the
    task's extras, and **≥1 legal outbound transition** out of a non-terminal stage;
    `FOR UPDATE SKIP LOCKED`; one active task per instance; stamps the lease (stage →
    workflow → 5 min); writes a `claimed` event.
- `test/verbs.test.ts` (5 tests) over the PostgREST surface — create→claim→
  already_holding, plus `empty`, `not_eligible`, `not_found` and the envelope shape.
- `test/helpers/barrier.ts` + `test/concurrency.test.ts` (2 tests) — the
  release-barrier concurrency harness.

## Key decisions made in passing

1. **Verbs in `api`, internals in `app`.** Only the two verbs are REST-reachable;
   `envelope`/`task_json`/`ensure_agent` stay private. Same belt-and-suspenders as
   the tables. Every function gets `revoke execute from public` (the M2 lesson).
2. **Eligibility = lane feature + task extras + a performable outbound transition.**
   A task is claimable only if the caller can actually *move* it (∃ transition out of
   its stage whose `required_features ⊆ effective`). Terminal stages have no
   outbound transitions, so they're naturally unclaimable.
3. **Lazy instance registration.** The `agents` row is created on first
   `create_task`/`claim_next_task` (so `claimed_by`/`created_by` FKs resolve), not
   at mint time — keeping `token_claims` side-effect-free (carried from M2).
4. **Reclaim attempts++/poison deferred to M5.** The availability predicate already
   makes expired-lease tasks claimable, but the `attempts++` / auto-block-at-
   `max_attempts` logic is M5's slice; M3's tests use fresh unclaimed tasks.

## Concurrency harness (ADR 0010)

Per the owner's containerize-everything steer (no local npm installs), the barrier
is built from `psql` processes against the `db` container — the exact mechanism
ADR 0010 names:

- A **coordinator** `psql` session holds an **exclusive** advisory lock.
- N **worker** sessions each `set_config('request.jwt.claims', …)` (simulating what
  PostgREST injects — the verb is SECURITY DEFINER so no SET ROLE is needed), then
  park on a **shared** advisory lock, then call `claim_next_task`.
- The harness polls `pg_locks` until all N are parked (not-granted), then releases
  the exclusive lock → all N fire in a tight window.
- Asserted invariants (hold under any interleaving): **no task claimed twice**, and
  **successes = min(N, K)**. Tested both N>K (10 vs 4 → 4 winners, 6 empty) and N<K
  (3 vs 8 → 3 distinct winners).

## What surprised us

1. **Global-count assertions don't survive new fixtures.** `seed.test` counted
   `app.agent_families`/`app.features` globally; M3's `race-fam` family and `m3`/
   `race` features (created by sibling test files **running in parallel**) pushed
   the counts up and the seed test flaked/failed. Fix: scope every seed assertion to
   the seed's own keys — a seed test should verify the *seed* loaded, not that the DB
   contains nothing else. Lesson: **assert scoped, never global**, once more than one
   test file writes data.
2. **`psql` output discipline for the barrier.** Workers run setup statements
   (`set_config`, the advisory park) whose output had to be sent to `\o /dev/null`
   so stdout carried only the final `claim_next_task` envelope line for parsing.

## Done-tests (all green — 32 total, 7 new)

- create at initial stage; claim returns the created task with `claimed_by`/lease;
  second claim by the same instance → `already_holding`.
- `empty` / `not_eligible` / `not_found`; envelope always has the five keys.
- Concurrency: no double-claim; successes = min(N, K), both N>K and N<K.
- `make reset` zero→green twice (deterministic); `make verify-down` clean; teardown
  leaves nothing; `tsc --noEmit` clean.

## Ready for M4

The queue works and the claim is honest. M4 adds the rest of the agent surface —
`advance`/`reject` (transition `kind`, guards, `effects`, release the hold),
`release`/`block`/`unblock`, `report_progress`, `heartbeat` — all enforcing the
`lease_lost` invariant (`claimed_by = sub AND lease_expires_at > now()`).

## Follow-up

- Blog article for M3 ("SKIP LOCKED, honestly tested") pending publish guidelines.
- M5 will add reclaim `attempts++`/poison→blocked and `release_task`'s `attempts++`.
