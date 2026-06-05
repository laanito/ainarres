# Open questions

Everything except **Postgres + PostgREST** is open. This is the burn-down list that
drives the design phase. Each question, once resolved, becomes an ADR in `decisions/`
and is checked off here with a pointer.

Legend: `[ ]` open · `[~]` in discussion · `[x]` resolved (→ ADR)

## A. Data model & state machine
- [ ] **Q1** How is the pipeline represented — a data-driven `transitions` table the DB
  reads, or transitions encoded in functions? (Affects how humans reshape the workflow.)
- [ ] **Q2** What is the `task` schema? Minimum viable columns (id, stage, work-area,
  capability requirements, lease fields, payload, timestamps).
- [ ] **Q3** Task id type — README argues **UUID** for a global id space. Adopt now even
  though sharding is a non-goal, or defer?
- [ ] **Q4** Are stages a fixed enum, a lookup table, or free-form strings validated by
  the transition rules?
- [ ] **Q5** Event log shape — one `events` table for everything (progress, transitions,
  human notes), or separated? Append-only enforced how?
- [ ] **Q6** Artifacts — inline JSON on the event, a separate `artifacts` table, or both?

## B. Agent-facing surface (the verbs)
- [ ] **Q7** Confirm the verb set. README lists six: `claim_next_task`,
  `report_progress`, `advance_task`, `release_task`, `block_task`/`unblock_task`,
  `heartbeat`. Is that the v1 set? Anything missing (e.g. `fail_task`)?
- [ ] **Q8** Exact signature + return contract of each verb (inputs, success shape,
  error shape).
- [ ] **Q9** Can an agent hold more than one task at once? If so, how is that bounded?

## C. Identity, auth & capability matching
- [ ] **Q10** Token model: what claims does the JWT carry (role, capabilities,
  work-areas) and in what shape?
- [ ] **Q11** How does `claim_next_task` match a task to an agent from **verified claims
  only** (not arguments)? Set membership? Predicate? (Closes risk R3.)
- [ ] **Q12** Role model in Postgres — how do PostgREST roles map to agent roles, and
  what privileges does each role get on tables/functions/views?
- [ ] **Q13** Who signs tokens and how are they issued/rotated? (May be deferrable to a
  stub for v1.)

## D. Leases, heartbeat & recovery
- [ ] **Q14** Lease duration default + heartbeat cadence. (Closes risk R4.)
- [ ] **Q15** Reaper mechanism — `pg_cron` (README's choice) vs. lazy reclaim at
  claim-time vs. both. Is `pg_cron` acceptable as a dependency for v1?
- [ ] **Q16** What happens to a reaped task — straight back to open, or to a
  `released`/`abandoned` intermediate stage with a count?

## E. Logic language
- [ ] **Q17** PL language for the verbs — `plpgsql` (zero extra deps) vs `plv8`
  (README's recommended default; JSON-native, shareable dry-run with JS/TS clients) vs
  other. Trade-off: dependency/build weight vs. client-shared logic. (Risk R7.)
- [ ] **Q18** Do we need any untrusted language (`plpython3u`, etc.) in v1, or is that a
  deferred concern with everything in trusted languages for now?

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
