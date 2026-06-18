# `.agents/` — working memory for AINARRES

This directory is the **single source of truth** for how AINARRES is built. It is
written by and for agents (and the humans reading over their shoulder). If a decision,
plan, or rationale matters, it lives here — not only in commit messages or in someone's
head.

## Layout

| Dir            | What goes here                                                                 |
|----------------|--------------------------------------------------------------------------------|
| `analysis/`    | Problem framing, constraints, and the living list of open questions.            |
| `design/`      | Worked-out design: data model, state machine, the agent-facing verbs, auth.     |
| `decisions/`   | ADRs — one file per resolved decision, with the alternatives we rejected.       |
| `plans/`       | Autonomous work plans. A plan is only "ready" when each step has a done-test.    |
| `followups/`   | Deferred items, TODOs, and things parked mid-stream so they aren't lost.         |
| `retros/`      | Retrospective per completed plan slice: what we did, what surprised us.          |
| `blog/`        | Blog drafts documenting each completed slice (published per separate guidelines).|

## Phase gate

Design is **complete** (ADRs 0001–0012). We are now in **planning**: the autonomous build
plan lives in [`plans/v1-plan.md`](plans/v1-plan.md). Implementation begins once that plan
is approved — starting at milestone **M0**. The v1 success criterion is **self-hosting**
([ADR 0012](decisions/0012-self-hosting-success-criterion.md)).

## Conventions

- **ADRs** (`decisions/NNNN-title.md`): numbered, immutable once accepted. Changing a
  decision means a new ADR that supersedes the old one — we keep the history.
- **Settled vs open:** only **Postgres + PostgREST** are settled constraints. Everything
  else (logic language, auth model, state-machine representation, lease mechanics,
  scaling, egress) is an open question until an ADR closes it.
- **Done means verified:** an item is complete only when its tests and validation pass.
  No item is committed otherwise.
- **PR-based delivery:** every set of changes goes on its own branch → commit → push →
  open a PR. The owner reviews PRs (gatekeeping early, stepping back once the
  change→test→validate cycle is self-sustaining). Don't push straight to `main`.

## Status

| Date       | Phase     | Note                                          |
|------------|-----------|-----------------------------------------------|
| 2026-06-05 | Analysis  | `.agents/` created; analysis + open questions drafted. |
| 2026-06-05 | Design    | Data-model/state-machine cluster resolved → ADRs 0001–0006 + `design/data-model.md`. Open: auth, leases, env/test, scope. |
| 2026-06-07 | Design    | Auth/identity cluster resolved → ADR 0007 (family-scoped grant/veto), amends 0004. Open: verbs, leases, env/test, scope. |
| 2026-06-10 | Design    | Verb-contracts cluster resolved → ADR 0008 (9 verbs, uniform envelope, one-task-per-instance). Open: leases, env/test, scope. |
| 2026-06-10 | Design    | Leases/reaper cluster resolved → ADR 0009 (lazy reclaim, no cron; data-driven leases; poison→blocked). Open: env/test, scope. |
| 2026-06-10 | Design    | Env/testing + scope resolved → ADRs 0010–0011 (postgres:18 + dbmate + vitest; v1 boundary). **All Q1–Q24 closed; design complete.** Next: plan. |
| 2026-06-10 | Planning  | Success criterion = **self-hosting** (ADR 0012). Autonomous build plan written → `plans/v1-plan.md` (M0–M6). Next: implement M0. |
| 2026-06-10 | Build     | **M0 done** — dockerized loop (postgres:18 + PostgREST + dbmate) + vitest smoke, green from zero. Retro in `retros/m0-harness.md`. Next: M1 schema. |
| 2026-06-15 | Build     | **M1 done** — full data model in a private `app` schema + coarse roles + idempotent seed; append-only events; down-migrations reversible. 17 tests green. Retro in `retros/m1-schema.md`. Next: M2 auth. |
| 2026-06-16 | Build     | **M2 done** — auth functions: `effective_features` (grant−veto, instant revocation), `whoami`, privileged `token_claims`; HS256 signing in the TS minter (no in-DB crypto). 25 tests green. Retro in `retros/m2-auth.md`. Next: M3 create+claim. |
| 2026-06-17 | Build     | **M3 done** — first verbs `create_task` + `claim_next_task` (uniform envelope, effective-feature eligibility, `FOR UPDATE SKIP LOCKED`, one-per-instance). Race-free proven via a psql advisory-lock barrier (no double-claim; successes = min(N,K)). 32 tests green. Retro in `retros/m3-create-claim.md`. Next: M4 advance/reject/etc. |
| 2026-06-18 | Build     | **M4 done** — rest of the verbs: advance/reject (shared `do_transition`, guards, effects, release-the-hold), release (attempts→auto-block), block/unblock, report_progress, heartbeat; `lease_lost` enforced throughout. 41 tests green. Retro in `retros/m4-verbs.md`. Next: M5 recovery + views. |
| 2026-06-19 | Build     | **M5 done** — lazy reclaim accounting in `claim_next_task` (reclaim → attempts++, poison → auto-block & skip) + oversight views `board`/`feed`/`abandoned`. 46 tests green. Retro in `retros/m5-recovery-views.md`. Next: M6 self-hosting checkpoint. |
