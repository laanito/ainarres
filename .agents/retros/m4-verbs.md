# Retro — M4: verbs II (advance / reject / release / block / unblock / progress / heartbeat)

- Date: 2026-06-18
- PR: build/m4-verbs
- Plan: [v1-plan.md](../plans/v1-plan.md) milestone M4

## What we built

The full agent surface (ADR 0008), all enforcing the `lease_lost` invariant.
Migration `20260618090000_verbs_advance_reject_etc.sql`:

- Helpers (private `app`): `resolve_lease()` / `resolve_max_attempts()` (stage →
  workflow → system default, ADR 0009), `apply_effects()` (reflexive-governance
  plumbing), and `do_transition()` — the shared engine behind advance/reject.
- `advance_task` / `reject_task` — thin `api` wrappers over `do_transition` with
  `kind = advance|reject`. Validate a legal transition the caller is eligible for,
  run the optional guard, apply `effects`, write a `transition` event, move the
  stage, and **release the hold**. Reject is gated independently (different
  `required_features`).
- `release_task` — `attempts++`; auto-`blocked` at the cap (reused for poison in
  M5).
- `block_task` (requires the hold) / `unblock_task` (requires the lane feature,
  since a blocked task isn't held).
- `report_progress` (append a `progress` event + renew lease) / `heartbeat`
  (renew lease).
- 9 tests in `test/verbs-m4.test.ts`, one small lane per scenario for isolation.

## Key decisions made in passing

1. **Shared `do_transition` engine.** advance and reject differ only in `kind` and
   permission gating, so one engine + two one-line `api` wrappers. The wrappers are
   `SECURITY DEFINER` so their call into the private `do_transition` runs as the
   owner (agents aren't granted the internal helper).
2. **`lease_lost` everywhere a hold is required**, expressed identically:
   `claimed_by IS DISTINCT FROM sub OR coalesce(lease_expires_at,'-infinity') <= now()`.
   This is the safety net that makes lazy reclaim (M5) correct.
3. **Guard contract:** a transition's `guard` is a trusted boolean SQL expression
   evaluated with the task as `$1` (jsonb), e.g.
   `coalesce((($1)->'payload'->>'ready')::boolean, false)`. Authored by flow
   designers (not agents); a raised/false guard → `guard_failed`. (Hardening
   follow-up: guards run as the definer — fine for v1 trusted config.)
4. **`unblock` is not a held-task verb.** Blocking releases the hold, so unblock
   can't require one; it requires the caller to work the task's lane instead.
5. **`not_eligible` vs `illegal_transition`:** if a transition of the right kind
   exists from→to but the caller lacks its features → `not_eligible`; if no such
   transition exists at all → `illegal_transition`.

## What surprised us

1. **Host port 5432 was newly taken** by another of the owner's containers
   (`openterminalui-postgres`) that started mid-project — `make up` failed with
   "port is already allocated". Fixed by mapping the db to host **5433**
   (`DB_PORT` in `.env`); tests are unaffected because they reach the db via
   `docker compose exec` (container-internal 5432), so the host port only matters
   for external tooling. (Same class of conflict as the 3000/open-webui one from
   M0 — the env memory is updated.)
2. **A transient Docker DNS race** on startup (`lookup db ... no such host`) and a
   leftover container holding the port after a failed `up` — both cleared by a
   clean `down -v` + retry. Reinforces: on `up` failures, force-down before retry.

## Done-tests (all green — 41 total, 9 new)

- Advance moves the stage, releases the hold, logs a `transition` event;
  `illegal_transition` for a non-existent move; reject gated independently of
  advance; `not_eligible` when the caller lacks a transition's features.
- `release_task` increments attempts and auto-blocks at the cap.
- A blocked task is excluded from claim; unblock makes it claimable again.
- `report_progress` appends an event and renews the lease; `heartbeat` renews it.
- `lease_lost` after the lease expires (heartbeat + advance both rejected).
- Guard blocks when unsatisfied, allows when satisfied.
- A transition `effect` writes an instant `feature_denials` row for the subject's
  family.
- `make reset` zero→green twice; `make verify-down` clean; teardown leaves
  nothing; `tsc --noEmit` clean.

## Ready for M5

The verbs are complete. M5 wires end-to-end **lazy reclaim** (expired lease →
next claimer reclaims → `attempts++` → poison → auto-`blocked` at `max_attempts`)
and the human **views** (`board`, `feed`, `abandoned`) granted to `oversight`.
The `release_task` attempts/auto-block logic and the `lease_lost` invariant built
here are exactly what reclaim reuses.

## Follow-up

- Blog article for M4 ("Nine verbs and the rules that hold them") pending publish
  guidelines.
- Guard expressions run as the definer (trusted config); a sandboxed evaluator is
  a possible later hardening.
