# Retro — M16: observability, watching the swarm without a dashboard

- Date: 2026-06-30
- PRs: design #50 (`.agents/design/observability.md`), build #51
- Plan: [v4-plan.md](../plans/v4-plan.md) (M16)
- Implements: [ADR 0021](../decisions/0021-v4-scope-the-swarm.md) (§ observability)

## What shipped

The first v4 build milestone — the read-only oversight surface grown up for a
swarm. Three slices, all on the existing event log + M5 views (no new infra):

- **Read views** (`db/migrations/…_observability_views.sql`) — `api.board`
  enriched (additive) with `claimed_by_family`, `age_in_stage` (truncated to
  seconds), and `blocked_by` (the unsatisfied prerequisites, mirroring the exact
  `claim_next_task` predicate, [ADR 0014](../decisions/0014-task-dependencies.md));
  and a new `api.timeline` = `api.feed` joined to the acting agent's family.
- **CLI** — `ainarres events` over the timeline (family-attributed, filterable,
  plain-language reason gist); `status` enriched with an `active` holder section
  (family + age), stranded rows naming the family, and a why-stuck `escalated`
  section; `status --watch [--interval 2]` poll-refresh.
- **End-of-run report** — pure `formatReport()` + `ainarres report`; `driver.sh`
  emits it on drain (what shipped + PRs, failures, escalations, activity-by-family).

## The finding that shrank the milestone

The design note budgeted for "enrich the verb bodies to stamp attributable
outcomes." Implementing it surfaced that **the event log was already attributable
and already structured**:

- `advance`/`reject` funnel through one `app.do_transition`, which stamps a single
  `type='transition'` event carrying `{kind, from, to, note, reason, artifacts,
  effects}` — `kind` *is* the verdict, `reason` *is* the reject reason.
- M12 already stamps `released {reason, attempts}` and `escalated {from_tier,
  to_tier, attempts}`.
- `actor` is server-stamped from the JWT `sub` inside every SECURITY DEFINER verb,
  so a family can never attribute an outcome to another — the "agents cannot forge"
  done-test was *already* structurally true; M16 just asserts it.

So the genuine gap was purely the **read** side: `board`/`feed` exposed holders and
actors as bare instance uuids with no family, which is exactly what forced the v3
pollution post-mortems into hand-written `actor→agents→agent_families` SQL. M16
therefore **adds no columns and rewrites no verbs** — views only. The down-migration
restores the M5 board/abandoned verbatim and drops the timeline; `verify-down` clean.

This is the design-first workflow paying off in the *cheap* direction: the
"validate against the code" step turned a verb-rewrite slice into a no-op, and the
milestone got smaller and lower-risk rather than larger.

## The elegant bit

The three CLI renderers (`formatStatus`, `formatEvents`, `formatReport`) are all
**pure** — rows in, string out, no I/O, no clock. Every interesting behavior
(family attribution, why-stuck derivation, PR extraction, dedup) is unit-tested
with inline rows and zero substrate. The commands are thin fetch-then-format
shells; `--watch` is a poll loop around the same pure snapshot. The whole surface
is read-only over views granted to `oversight` — observability added no write path.

## Done-tests

- **Full suite 91/91** on a clean reset — 16 new pure-formatter cases
  (`status-format.test.ts`) + a live `observability.test.ts` proving the family
  surfaces on claim, `blocked_by` lists then clears prerequisites, the timeline
  joins family (null for actor-less human/system events), oversight-only.
- **`make verify-down` clean** — down/up of every migration including the new one.
- **`make loop-selftest` green, exit 0** — the driver's end-of-run report renders
  end to end in a real drain: the shipped task with its PR, and activity-by-family
  (`grok+grok-build: 11 events`, `opencode+big-pickle: 2 events`).

## Decisions locked (design note)

- **D1** poll-refresh, not `LISTEN/NOTIFY` (no new infra; lazy-reclaim ethos).
- **D2** enrichment = `events.data` conventions; turned out already-satisfied (above).
- **D3** the `actor→family` join lives in `api.timeline`, keeping the CLI pure.
- **D4** why-stuck is derived (blocked/stranded/escalated), not stored.
- **D5** the end-of-run report is a driver rendering, not substrate state.

## Follow-ups

- **`age_in_stage` is time-since-last-update**, not strictly time-in-current-stage
  (a claim bumps `updated_at`). Exact for an unclaimed task; for a held task it reads
  as time-since-claim — which is the "how long has this been sitting" signal oversight
  wants anyway. True stage-entry time (last transition-into-stage event) is a
  timeline query if M18 ever needs it.
- **PostgREST schema cache** must reload after the migration adds the view (a fresh
  `make reset` is fine — postgrest starts after migrate; only an already-running
  instance needs `NOTIFY pgrst, 'reload schema'`). Noted for live upgrades.
- **Governance runway (v5):** the enriched, family-attributed timeline is the signal
  v5 will score. M16 deliberately only *records/reads* it; revocation is later
  ([ADR 0021](../decisions/0021-v4-scope-the-swarm.md) § out-of-scope).

**Blog:** "Watching the swarm: observability without a dashboard."
