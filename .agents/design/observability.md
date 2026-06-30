# Observability: watching the swarm without a dashboard

> Design note for **M16** ([v4-plan](../plans/v4-plan.md) · [ADR 0021](../decisions/0021-v4-scope-the-swarm.md)).
> Settles M16's open questions before code. Builds directly on the M5 oversight
> views ([ADR 0009](../decisions/0009-leases-reaper.md)) and the M11 `status` tool.

## What M16 is for

The owner who started the v3 driver and walked away ([ADR 0020](../decisions/0020-autonomous-run-topology.md))
can today only `ainarres status` for stage *counts* and tail a raw feed. When the
two failed shakeout runs went sideways, diagnosing them needed **hand-written SQL**
joining `app.events ↔ app.agents ↔ app.agent_families` to see *which family* did
what (see [[loop-board-pollution]]). A swarm (v4) fans wider; you cannot safely run
unattended what you cannot see. M16 turns that ad-hoc forensics into first-class,
read-only, CLI-native surface — and **enriches the event log** so the account is
attributable, owner-consumed now and inherited by v5 governance.

It is held to **CLI- and substrate-native, read-only over the event log + oversight
views**. No web UI, no metrics stack, no new infra (ADR 0021 § out-of-scope guard).

## Decisions (the open questions, settled)

**D1 — Poll-refresh, not `LISTEN/NOTIFY`.** `status --watch` re-fetches the views on
a fixed interval (default 2s, `--interval`). Rationale: the loop is low-frequency
(rounds, not millisecond ticks), the views are cheap, and a poll loop adds **zero
new infra or long-lived connection** — consistent with lazy-reclaim's "no background
process" ethos (ADR 0009). `LISTEN/NOTIFY` is deferred to v5+ and only if a
high-frequency swarm proves polling too coarse.

**D2 — Enrichment is `events.data` conventions + verb stamping, with one additive
migration.** The `app.events` table already carries `actor` (unforgeable: derived
from the JWT `sub` server-side, never client input) + `type` + `data jsonb`. M16
does **not** add columns. It (a) standardizes the structured `data` keys for outcome
events, and (b) teaches the existing verbs to *stamp* them. The migration is additive
(new views + enriched verb bodies); its down-migration restores the prior verb bodies
verbatim, exactly like the M5/M12 pattern.

**D3 — The family join lives in a view, not the CLI.** The CLI stays a thin formatter
(`formatStatus` is already pure, no I/O — keep it so). A new `api.timeline` view does
the `actor → family` join once, in SQL, granted to `oversight`. The CLI renders rows.

**D4 — Why-stuck is derived, not stored.** "Blocked / stranded / escalated" is
computed from existing signal (board flags + recent escalation events), surfaced as
plain-language lines. No new state, no new column — just a read.

**D5 — The end-of-run report is a driver artifact, not substrate state.** When the
loop drains, `driver.sh` queries the same oversight views/CLI and prints a summary.
The substrate stores facts (events); the report is a *rendering* of them, owned by
`loop/` (ADR 0003 — the substrate coordinates, it does not narrate).

## The surface

### 1. Live board — `ainarres status --watch [--interval N] [--lane L]`

Poll-refresh (D1) over an **enriched** board. Today `api.board` exposes `claimed_by`
as a bare uuid; M16 extends it (additive, drop+recreate view) with the **holder's
family** and **age-in-stage**, so a glance answers "who holds this and for how long":

| existing | added by M16 |
|---|---|
| project, lane, stage, is_terminal, task_id, priority, attempts, blocked, blocked_reason, claimed_by, lease_expires_at, abandoned, subject, created_at, updated_at | `claimed_by_family` (text, via join), `age_in_stage` (now − updated_at), `blocked_by` (unmet `depends_on`, from [ADR 0014](../decisions/0014-task-dependencies.md)) |

`formatStatus` gains a per-task holder/age line under the stage summary; the watch
loop just re-renders. Existing `status` (no `--watch`) keeps its one-shot behavior.

### 2. Event timeline — `ainarres events [--task T] [--family F] [--type X] [--limit N]`

A new command over a new view **`api.timeline`** = `api.feed` + the family join
(D3): `event_id, created_at, type, actor, family, task_id, lane, stage, data`,
newest-first, filterable. This is the surface that the pollution post-mortem needed
raw SQL to get — out-of-roster families now show at a glance. Rendered human-readably
(one line per event: `time  type  task#  family  ⟨reason from data⟩`).

### 3. Why-stuck — folded into `status` (and `status --watch`)

A "needs attention" block derived (D4) from the board + timeline:
- **blocked** → task id + `blocked_reason` (e.g. "max attempts exceeded").
- **stranded** → `abandoned` rows (lease expired while claimed) — name the family that
  held it, in plain language.
- **escalated** → tasks whose `required_features` gained a `tier:N` rung
  ([ADR 0019](../decisions/0019-capability-escalation.md)) and now wait on a higher
  tier — "waiting for tier:2 (frontier)".

### 4. End-of-run report — emitted by `driver.sh` (D5)

On drain, the driver prints: **what shipped** (tasks reaching `done` + their PRs, read
from `events.data`), **what failed and why** (blocked/poison + reason),
**attempts/escalations per task**, and **per-tier activity** (how much the cheap tier
carried vs. the frontier ceiling). Pure rendering of the views above; lives in `loop/`.

## The enriched event shape (D2)

Outcome events get a small, **machine-readable, attributable** `data` contract. The
acting family is always resolvable (actor → family), and the reason is structured —
so the owner reads it now and v5 governance scores it later without a re-paint.

| event `type` | emitted by | `data` keys (added/standardized) |
|---|---|---|
| `advanced` | `advance` verb | `from_stage`, `to_stage`, `verdict: "accept"` |
| `rejected` | `reject` verb | `from_stage`, `to_stage`, `verdict: "reject"`, `reason` (text) |
| `released` | `release` verb | `reason` (text), `attempts` (already stamped in M12 — formalize as the contract) |
| `escalated` | `maybe_escalate` | `from_tier`, `to_tier`, `attempts` (already stamped in M12 — formalize) |
| `validated` | implementer self-validate | `result: "pass"|"fail"`, `check` (what ran) |
| `shipped` | integrator on merge | `pr`, `merge_sha` (references only — ADR 0003) |

Forgery is already structurally prevented: a verb stamps `actor = sub` from the token,
so no agent can attribute an outcome to another family. M16's done-test **asserts**
this rather than adding a guard.

## Deliberately out of scope (M16)

- **No web/TUI/metrics** — terminal text only (ADR 0021 guard).
- **No `LISTEN/NOTIFY`** (D1), no historical aggregation/charts, no SLA timers.
- **No governance action** — M16 *records* attributable outcomes; *acting* on a track
  record (revoking a family's feature) is v5. M16 is the runway, not the engine.
- **No new schema columns** — views + verb-body stamping only (D2).

## Slicing (build order within M16)

1. **Migration** `…_observability_views.sql`: enrich `api.board`
   (`claimed_by_family`, `age_in_stage`, `blocked_by`); add `api.timeline`; enrich the
   verb bodies to stamp the D2 `data` contract; extend `oversight` grants; clean down.
2. **CLI** `events` command + `formatEvents` (pure, like `formatStatus`); `status`
   gains the holder/age line + why-stuck block; `--watch`/`--interval` poll loop.
3. **Driver** end-of-run report in `loop/driver.sh`, rendering the views on drain.

Each slice ends green (vitest for the pure formatters + a migration up/down test);
done = verified in a live loop run (the timeline shows families, the report names the
PR). One blog article on merge: *"Watching the swarm: observability without a dashboard."*
