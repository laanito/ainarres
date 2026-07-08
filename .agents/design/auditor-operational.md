# The auditor's operational facet: watching health and spend — and the line spend must not cross

> Design note for **M23** — the first v6 slice, growing the auditor from *delivery quality*
> to *operational health* ([ADR 0023](../decisions/0023-v6-scope-seat-the-bookends.md) ·
> [v6-plan](../plans/v6-plan.md)). Settles M23's open question (how a family-scoped
> operational flag coexists with M22's task-anchored one) before code. Builds on the M22
> auditor ([auditor.md](auditor.md): `role:auditor`, `raise_audit_flag`, the flag/reject line,
> oversight-only permanence), M21's reflexive core
> ([reflexive-revocation.md](reflexive-revocation.md): `governance_strikes`,
> `api.governance_status`, the D5 recommendation), M20's record
> ([track-record.md](track-record.md): `api.family_track_record`, `tokens_per_delivery`,
> **tokens ≠ USD, spend ≠ competence, unknown ≠ free**), and the recovery/observability views
> (`api.abandoned`, `api.board`).

## What M23 is for

M22 named the auditor for the failure a *rule* must not decide: a delivery that doesn't meet
the **request or design**, task-anchored, raised to a human. That is the auditor's **quality**
facet. M23 adds the auditor's **operational** facet — the out-of-loop watch the orchestrator
still runs by hand every time it comes back to a run and asks *"is the machine healthy, and is
anyone burning fuel for nothing?"*:

- **Pipeline health** — stalls, stranded claims, backpressure.
- **Repo / board integrity** — a coherent `main`, no orphaned worktrees, no
  [loop-board-pollution]-style contamination.
- **The spend watch** — the [fleet-and-token-capture](../retros/fleet-and-token-capture.md)
  stage made every family's token spend legible; M23 is what *watches* it. Flag a family that
  **spins** or **consistently overspends vs. peers** — a **qualitative** flag (the M22 shape),
  **human-decided, no auto-denial**.

M23 adds **no new revocation mechanism** and **no auto-penalty** (ADR 0023 invariant). It adds
a **watch** (computed, read-only), a **family-scoped flag verb** for the auditor's recorded
judgment, and the **surface** that routes a human's attention. The same auditor, watching more.

## The two failure modes, and the honest mechanics of catching them

The retro framed the spinning worker as the motivator for a spend watch. Designing it forces a
correction worth stating plainly, because it changes what we build:

| mode | example | does it deliver? | is its spend recorded? | what catches it |
|---|---|---|---|---|
| **spinning** | nano looping on a hallucinated `str_replace_editor`, ~10 min, 0 progress | **no** | **no** — `record_usage` anchors on a *transition*; a worker that never advances leaves **no `usage` event** | the **HEALTH watch** (a claim/lease held with no advance) |
| **overspending** | a "thinker" burning 50× peers' tokens for the same result | **yes** | **yes** — its delivery anchors usage, so `tokens_per_delivery` is populated | the **SPEND watch** (`tokens_per_delivery` vs. peers) |

So the spend signal, by itself, **does not catch a pure spinner** — the spinner's tokens are
never recorded because it never transitions. That is not a gap to paper over; it is the
**division of labor**: the **health** watch catches the worker that produces nothing (whatever
it spends), the **spend** watch catches the worker that produces at an abnormal cost. Together
they cover the operational failures no per-task reject can see (M21's blind spot). The blog's
"a spend signal catches the spinner" is *aspirationally* true (a spinner burns tokens) but
*mechanically* the health watch is its catch; the spend watch is the overspender's. M23 builds
both, and this note is where we say so.

## Decisions (the open questions, settled)

**D1 — An operational flag is FAMILY/CAPABILITY-scoped and CANNOT ride M22's task-anchored
`raise_audit_flag`; it gets a sibling verb + a small append-only ledger.** M22's flag is
**task-anchored** by construction (`events.task_id NOT NULL`, D8) — a delivery-quality gap
embodies in a shipped task. An operational flag has **no single task**: a spinner never
advanced (no task to point at), and an overspend is a *trend across many tasks*. Forcing it
onto `raise_audit_flag` would mean nulling `events.task_id` — the **exact invariant M22 D7
refused to weaken** (that is precisely why the human ban/lift trail became the separate
`app.governance_actions` ledger, not events). So M23 mirrors that reconciliation:
`api.raise_operational_flag(p_subject_family, p_capability, p_kind, p_detail, p_severity)`
(SECURITY DEFINER, gated on `role:auditor`) writes an append-only **`app.operational_flags`**
ledger row (`kind ∈ {spinning, overspending, health, integrity}`) and **no `feature_denials`**.
Task-anchored quality → an **event** (M22); family-scoped operational conduct → a **ledger row**
(M23). Same shape, same discipline, no weakened invariant.

**D2 — The WATCH is computed, dumb, read-only; the FLAG is the auditor's recorded judgment.**
Measure-not-enforce (the M19/v5 spine): the substrate **surfaces anomalies**, a human
**decides**, and only then is a flag written. Two dumb views feed the human's attention —
`api.spend_anomalies` (below) and health via the **existing** `api.abandoned` — and the
`role:auditor` holder, reading them, calls `raise_operational_flag` when the anomaly is real.
The view never writes; the flag never bans. This keeps the subjective judgment ("is this spin,
or a legitimately hard task?") where M22 put it — with a person — and out of a rule.

**D3 — The spend watch is `tokens_per_delivery` vs. the per-capability peer median, plus the
"burned-but-shipped-nothing" case.** `api.family_track_record` already computes
`tokens_per_delivery` per `(family, capability)` (M20). `api.spend_anomalies` compares each
family's ratio to the **median across families holding the same capability** (compare
implementers to implementers, not to integrators) and flags those exceeding a **policy
multiple** (`overspend_multiple`, seeded on `governance_policy`, the M21/M22 D5 tunable-data
pattern — not a constant). It **also** surfaces `delivered = 0 AND usage_events > 0` (spent
tokens, shipped nothing — a spinner that *did* record some usage before stalling). Tokens
only; **no USD, no ranking into "good/bad"** — an overspender is *expensive*, reported as such.

**D4 — The health watch reuses existing state; it is a lens, not a new mechanism.** Stalls and
stranded claims are already exposed: `api.abandoned` (`api.board where abandoned`) is the
stalled/expired-lease read; `api.board` carries claim age. The health watch is a **read** over
these (and, for the spinner specifically, "a claim held near its lease with no advance event") —
surfaced for the auditor, no new table, no new liveness mechanism (ADR 0009's leases + reaper
remain the source of truth). Repo/board integrity in v6 stays a **human read** of `main` + the
board (the board-wipe model: a human reading after catches what no rule does); a computed
integrity check is a later refinement, noted not built.

**D5 — The consequence line, sharpened: spinning MAY lead a human to ban; overspending NEVER
nudges toward a ban. Neither auto-bans.** track-record D3 says tokens never auto-ban — M23
holds it and draws the finer line the two modes demand:
- A **spinning** flag is a *functional* failure — the family produces nothing at the capability
  (nano was **disabled** for exactly this). A human may escalate it to a ban **through the
  existing M22 `oversight`-only RPC** (`set_permanent_ban`) — human-decided, audited, no new path.
- An **overspending** flag is a *cost* signal, **not** competence — an expensive model that
  passes is expensive, not unfit. It surfaces as **"review cost,"** and **never** feeds a ban
  recommendation. Pricing/routing on cost is a v8+ **router** (an ADR 0023 anti-goal).
- **Operational flags do NOT feed M22's permanent-ban RECOMMENDATION.** That recommendation
  stays **competence-driven** (`ban_count` / quality-flag count, M22 D5). Operational flags get
  their **own** surfacing ("open operational flags," and for spinning a softer "review — repeated
  spin"), kept off the capability-ban recommendation so spend can never quietly become a ban.

**D6 — Same `role:auditor`, grown reach; the oversight separation still holds.** M23 adds **no
new role**. The operational facet is the M22 auditor watching more, so `raise_operational_flag`
is gated on the same `role:auditor` (human-held now, federatable later — the M19 move, v8+).
The load-bearing M22 separation is preserved: the auditor only **signals** (flags, family-scoped
now too); only **`oversight`** may **act** on capability (the ban/lift RPCs). Federating the
auditor later still never hands an agent the ban trigger — now doubly important, since an
agent-auditor watching spend must not be able to ban for cost.

**D7 — Append-only, no new mutable capability state (mirrors M22 D7).** Operational flags are
**ledger rows** (`app.operational_flags`, block-trigger append-only like `governance_actions`);
the watch is **computed** from `family_track_record` + `board`/`abandoned` (no new table). The
only writers to `feature_denials` remain M21's `register_reject` (temporary) and M22's
oversight RPC (permanent/lift). M23 stays **signal + surface**: one verb, one ledger, computed
views, a report line — no new revocation, no auto-penalty (ADR 0023).

## What changes: no new role, one verb, one ledger, computed views

```
role:auditor                       ← UNCHANGED (M22); operational reach is new behavior, not a new grant

api.raise_operational_flag(subject_family, capability, kind, detail, severity)   ← NEW, role:auditor
    └─▶ app.operational_flags(family, capability, kind, detail, severity, actor_sub, created_at)
        NO feature_denials written.                        (D1/D2 — family-scoped signal only)

api.spend_anomalies       ← NEW view: tokens_per_delivery vs per-capability peer median
                            + delivered=0 & usage>0; flags > overspend_multiple      (D3)
api.operational_flags     ← NEW view: open operational flags, newest-first            (D7)
health watch              ← REUSE api.abandoned + api.board (claim age / no-advance)   (D4)
app.governance_policy += overspend_multiple    ← NEW policy data (D3)

report: an "operational" block — health anomalies · spend anomalies · open operational flags
        (spinning → "review", overspending → "cost")                                  (D5)
```

`effective_features`, the create/advance gates, M21/M22 — all unchanged. Nothing in M23 writes
a denial or blocks a claim; a flagged family keeps working until a **human** acts through M22's
oversight RPC.

## Slicing (build order within M23)

- **Slice A — the flag verb + ledger + policy datum (ASSISTED, mock-verified).** Seed
  `overspend_multiple`; create `app.operational_flags` (append-only trigger, mirroring
  `governance_actions`); `api.raise_operational_flag` with its `role:auditor` gate and the
  invariant that it writes **no** denial. This touches the **auth-gated flag-write path** — a
  verb that records a judgment against a family must gate correctly **before** it runs live
  (the M22 Slice A / M19 Slice A rule). Done-tests: only `role:auditor` may flag (an agent
  token is refused); a flag lands in the ledger, names the subject family + capability + kind,
  writes **no** `feature_denials`; the ledger rejects update/delete; down-migration drops the
  verb, ledger, and policy column.
- **Slice B — the watch views + report line (SWARM-ELIGIBLE → brief for the owner to run).**
  `api.spend_anomalies` + `api.operational_flags` (SQL views, **validated ASSISTED** — a
  worktree has no DB, the board-wipe rule), and the report's new **operational block** (a
  **pure formatter + graceful fetch**, **substrate-free** to validate — `npx vitest`, the
  hands-off #87/#91 slice). The recommendation/severity *presentation* (spinning→"review",
  overspending→"cost", per D5) lives in the **pure formatter**; the views stay dumb.

## Open risks (honest)

- **A spinner that neither advances NOR trips the lease/abandoned window is invisible.** The
  health watch keys on stalled/expired claims (`api.abandoned`) and near-lease no-advance; a
  worker that spins *and* releases cleanly inside its lease leaves little trace. Bounded by the
  lease (nano's ~10-min spin was caught by a human first, then by reclaim); a tighter
  per-claim progress heartbeat is a later refinement, not v6.
- **The spend watch needs a peer baseline.** `tokens_per_delivery` vs. peer median is
  meaningless when only **one** family holds a capability (the current reality — big-pickle does
  the implementing; qwen/cursor are idle insurance). Single-implementer runs yield **no** spend
  anomaly; the watch earns its keep only once the fleet is genuinely exercised (the retro's
  standing "the new tiers are barely exercised" limit, carried forward honestly).
- **`record_usage`'s coarse per-sweep attribution (M20 limit #5) skews the ratio for
  multi-role families.** grok-as-integrator reads `unknown`; its `tokens_per_delivery` is
  partial. The spend watch is honest about `unknown` (never treats it as 0) but cannot flag
  spend it never saw. Per-transition capture (deferred) is the fix.
- **Operational judgment is subjective and unscored in v1** (as M22's quality flag). The flag
  records a `detail` verbatim; "spin vs. hard task" is the human's call. A computed spin
  detector (progress heartbeat) that *proposes* flags is a v6+/v8 refinement.
- **Human bandwidth** — flags pile up if no human returns (the M22 risk). The surface makes the
  backlog **visible**, not silent; standing oversight is v7's always-on service.
