# Retro — M5: recovery & views

- Date: 2026-06-19
- PR: build/m5-recovery-views
- Plan: [v1-plan.md](../plans/v1-plan.md) milestone M5

## What we built

Self-healing with no moving parts, and the human read surface. Migration
`20260619090000_recovery_views.sql`:

- **Reclaim accounting in `claim_next_task`** (ADR 0009). The M3 availability
  predicate already handed out expired-lease tasks; M5 adds the bookkeeping:
  reclaiming a still-claimed (lease-expired) task **`attempts++`**, and once a task
  hits `max_attempts` it is auto-**`blocked`** ("max attempts exceeded") and
  **skipped** — the claim loop moves on to the next viable task rather than handing
  out poison. All lazy, at claim time; **no background process**.
- **Views** in the exposed `api` schema, granted to `oversight` only:
  - `board` — one row per task with readable `project`/`lane`/`stage` keys and the
    orthogonal flags (`blocked`, computed `abandoned`).
  - `feed` — every event with its task's lane/stage, newest first.
  - `abandoned` — `board` filtered to lease-expired-still-claimed (stuck work).
- `test/recovery.test.ts` (5 tests) + a `restGet` HTTP helper.

## Key decisions made in passing

1. **Reclaim is a loop, not a single select.** A poison task is blocked and the
   loop `continue`s, so a claimer never receives a dead task — it gets the next
   eligible one (or `empty`). Bounded by the claimable set.
2. **Fresh vs reclaim, by `claimed_by`.** At selection, a non-null `claimed_by`
   can only mean an expired lease (the predicate excludes live ones), so that *is*
   the reclaim signal — attempts increment there; fresh claims leave the counter
   alone (release/reclaim own it). This avoids double-counting with M4's
   `release_task`.
3. **Owner-rights views.** The views are plain (non-`security_invoker`) views owned
   by the migration superuser, so they read the private `app.*` as owner and
   `oversight` only needs `SELECT` on the view — least privilege, and it doesn't
   lean on the M1 `app` grants.
4. **The original holder needs no new code.** "Gets `lease_lost`" already falls out
   of the M4 invariant (`claimed_by` is now someone else / lease expired). M5 just
   asserts it end to end.

## What surprised us

- **`information_schema.tables` counts views.** The M1 schema test "no domain
  tables leak into `api`" started failing once M5 added three `api` views (3 ≠ 0).
  The intent was *base tables*; tightened the assertion to
  `table_type = 'BASE TABLE'`. Views legitimately live in `api` now (that's how
  oversight reads over REST). Same lesson shape as M3's scoped-counts fix:
  assertions must track the schema as it actually evolves.

## Done-tests (all green — 46 total, 5 new + 1 amended)

- An expired-lease task is reclaimed by another agent (`attempts` 0→1); the
  original holder's next verb returns `lease_lost`; a second reclaim hits the cap
  and the task is auto-blocked (`attempts = 2`, reason "max attempts exceeded"),
  and the claimer gets `empty`.
- `board` shows readable keys + flags; `feed` shows a task's events; `abandoned`
  surfaces an expired-lease held task.
- Views are readable by `oversight`, denied to `anon` and `agent`.
- `make reset` zero→green twice; `make verify-down` clean (incl. the
  `claim_next_task` replace→restore); teardown leaves nothing; `tsc` clean.

## Ready for M6

The substrate is feature-complete for v1: schema, auth, all nine verbs, race-free
claim, lazy recovery, and the oversight surface. M6 is the **self-hosting
checkpoint** ([ADR 0012](../decisions/0012-self-hosting-success-criterion.md)):
seed a real AINARRES dev project/lane/workflow encoding change→test→integrate→
validate, register real agent families, build a thin TS client, and drive one real
dev task end to end through the verbs with the work product landing in git.

## Follow-up

- Blog article for M5 ("Recovery with no moving parts") pending publish guidelines.
- `board`/`feed` currently return all columns; if the oversight UI later wants
  pagination/projection defaults, PostgREST query params already cover it.
