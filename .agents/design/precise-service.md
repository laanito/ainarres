# The precise service: wake exactly when work arrives, spawn exactly the roles it needs

> Design note for **v7.1** ([ADR 0026](../decisions/0026-v7-1-demand-shaped-scaling.md) — demand-
> shaped scaling · [ADR 0027](../decisions/0027-v7-1-push-wake.md) — push-wake ·
> [plans/v7.1-plan.md](../plans/v7.1-plan.md)). Settles the mechanism the two ADRs decide.
> Refines — does not replace — the v7 service ([`service.md`](service.md)): the same idle⇄running⇄
> stalled state machine, the same `run_activation` round body, the same demand-scaler-never-router
> invariant. v7 made the service *exist*; v7.1 makes it *precise*.

## What v7.1 is for

The v7 standing service is deliberately blunt in two places, and both are now worth sharpening:

- **It wakes by polling** ([`service.md`](service.md) D1): idle, `sleep 15s`, look again. A request
  that lands one second after a poll waits ~15s to be noticed. → **push-wake** (ADR 0027).
- **It spawns the whole fleet on any work** ([`service.md`](service.md) D2): one pending `reviewing`
  task still boots the entire implementer pool, which claim-misses and exits — wasted process
  churn and wasted model tokens. And a task no configured tier can claim is discovered only *after*
  a full fleet-spawn moves nothing. → **demand-shaping** (ADR 0026).

v7.1 fixes both without touching the invariant: the service wakes *exactly when* work arrives and
spawns *exactly the roles* the work needs — a precise demand-scaler, still never a router. Every
task→worker binding stays the tiers' own `SKIP LOCKED` self-claim, unchanged since v1.

**This is a refinement of the v7 service, not a new capability class.** The bigger v8 themes
(federated many-services, a web UI, wider ingress) sit ahead of it; v7.1 tightens the one local
service first — "prove sufficiency before distribution."

## Decisions (the mechanism, settled)

### D1 — The substrate reports demand in capability terms; a new read-only view, knowing nothing about tiers

"Which family can move a task at stage X" is already defined by the substrate: a family whose
effective features satisfy the task's `required_features` **and** the `required_features` of some
outgoing transition from its stage — the exact predicate `claim_next_task` and the `claimable`
recovery view apply ([ADR 0009](../decisions/0009-leases-reaper.md)). v7.1 exposes that as an
**aggregate**, in a new read-only view `api.demand`:

- One row per **distinct required-feature bundle** among the board's *pending, claimable-modulo-
  capability* tasks — unblocked, dependency-satisfied, no live lease (i.e. the tasks that a
  suitably-capable family *could* claim right now). Each row: the bundle (a sorted `text[]` of
  canonical feature names) + a **count** of pending tasks needing it.
- The bundle for a task = `task.required_features ∪ (an outgoing transition's required_features)`.
  A stage with multiple outgoing transitions (advance vs reject, or two roles) yields multiple
  bundles for that task — each a real way the task could be moved; the view lists them all.
- The view names **no task id, no worker, no tier** — it reports only "this many pending tasks need
  a family with ⊇ {these features}." It is the [ADR 0026](../decisions/0026-v7-1-demand-shaped-scaling.md)
  substrate half: demand in pure capability terms, blind to who (or which service) will serve it.

`api.demand` is the only substrate touch for the demand half — a read-only view, the
[ADR 0024](../decisions/0024-v7-scope-the-standing-service.md)-blessed kind (no schema change, no
new truth). Build **assisted** (DB code is never swarm-self-validated in a worktree — the wipe
lesson; [`service.md`](service.md) build split).

### D2 — The service maps its OWN *available* capacity onto demand: an in-memory capability map, probed at start and refreshed; the spawn gate lives in the driver

The tier→features mapping (`roles.sh::role_features`) is **runtime config, not substrate truth** —
the substrate must never learn what a "tier" is ([vision](../analysis/vision.md): "the substrate
has no concept of which service"). And *configured* is not *available*: the v7 service kept trying
to spawn a tier whose model had been retired overnight (a real incident), wasting a spawn on a dead
backend each round. So the service matches demand against **available** capacity, held in an
in-memory map, and the spawn decision is the service's, in `driver-lib.sh`:

```
build_capability_map()                  # AT START: probe each configured tier's backend
                                        # (reachable? model loaded? key valid?) — best-effort,
                                        # timeboxed, parallel. CAPMAP = { live tier → role_features }.
refresh_capability_map()               # periodically + lazily: re-probe down tiers on a slow
                                        # cadence; a tier that ERRORS on spawn is marked down until
                                        # re-probe. A backend returning is picked up with no restart.
refresh_demand()                        # once per round (like refresh_governance): read api.demand
                                        # → DEMAND = list of {bundle, count}; unreadable → empty
tier_has_demand(tier):                  # tier is IN CAPMAP (live) AND some demanded bundle ⊆ its features
    tier in CAPMAP || return false
    for bundle in DEMAND:
        if bundle ⊆ CAPMAP[tier]: return true
    return false
```

Then, in `run_activation`'s round body, each spawn is gated: `tier_has_demand(tier) || skip`. It
composes with the existing `skip_if_banned` — a tier is spawned iff it is **live**, has **demand**,
and is **not governance-banned**. With push-wake (D4), this is exactly the owner's "wake models as
soon as they match an available task": a notification arrives → match demand against `CAPMAP` →
spawn precisely the live tier(s) that can serve it, at once. Two shaping refinements:

- **The implementer pool sizes to demand.** `run_pool(POOL_TIER, min(implementer-demand-count,
  LOOP_POOL_SIZE))` — one pending dev task spawns one implementer, not three; three-or-more spawn
  the full pool. The cap is unchanged; the floor tracks demand.
- **Every optimization degrades to spawn-anyway.** `refresh_demand` empty (read error / view
  absent) ⇒ treat all live tiers as demanded; the probe unavailable/timed-out ⇒ treat the tier as
  **live** (never wrongly withhold). Either outage collapses to the v7 coarse gate. Resilience over
  optimization ([`service.md`](service.md) D6 rule): an outage changes cost, never correctness.

**Invariant guard (the bright line).** `refresh_demand` reads **counts by required-feature bundle** —
never a task's id, priority, subject, or content, and never to pick a winner. The capability map is
keyed by *capability*, not by task. `tier_has_demand` is a subset test over *capabilities* (live ∩
demanded), not a task→worker choice. The tiers still self-claim via `SKIP LOCKED`; the service only
decides *which kinds of live worker to launch*, exactly as
[ADR 0026](../decisions/0026-v7-1-demand-shaped-scaling.md) permits. The moment any of this reads
task content to prefer one capable family over another, it is routing — and that is out of scope.

Build **assisted + mock-verified**: this is trust-critical runtime that spawns unattended; a
routing-drift, a wrongly-skipped tier, or a probe that wrongly withholds a live tier is exactly the
failure class ([`service.md`](service.md) build split, same as M25's lifecycle). The probe itself
is per-harness (a lightweight "are you reachable" check, mockable in `LOOP_MODE=mock`).

### D3 — Unserviceable demand is a new, predictive signal — distinct from `stalled`

A demanded bundle that no tier *in the live-capability map* satisfies is **unserviceable demand**.
The service:

- does **not** spawn against it (there is nothing live to spawn) and does **not** waste an activation
  to discover it;
- surfaces it, **named by the missing capability *and why***, distinguishing the two causes:
  - `⚠ unserviceable: N task(s) need {features} — no configured family provides it; seat one`, vs.
  - `⚠ unserviceable: N task(s) need {features} — the family that provides it is unreachable; a
    backend is down` (the incident case the probe exists for);

  (status file `note` + a loud stderr log, the [`service.md`](service.md) D3 pattern);
- holds — it does not spin. If *other* work is serviceable this round, the service drains that
  normally and keeps reporting the unserviceable remainder; when a down backend returns, the
  refreshed capability map (D2) reclassifies it as serviceable with no restart.

This **narrows `stalled` to its true meaning.** After v7.1 there are two distinct diagnoses:

| Signal | Means | When detected |
|---|---|---|
| **unserviceable demand — unconfigured** (new, D3) | "no tier I run provides this capability" | *predictively*, from `api.demand` — no fleet-spawn |
| **unserviceable demand — backend down** (new, D3) | "the tier that provides it is unreachable" | *predictively*, from `api.demand` ∩ the capability map — no fleet-spawn |
| **stalled** (v7 D3, unchanged) | "I spawned every live tier the demand asked for and the board still didn't move" | *empirically*, after an activation makes no progress |

The first is "seat a capable family"; the second is "bring a backend back up"; the third is "a
capable, live family keeps failing this task." Each names what a human must do; none spins.

### D4 — Push-wake: a truth-free NOTIFY the supervisor waits on, alongside the poll

Per [ADR 0027](../decisions/0027-v7-1-push-wake.md):

- **A single `AFTER INSERT OR UPDATE` trigger on `app.tasks`** fires `pg_notify('ainarres_activity',
  <lane>)` when a row is inserted or its `stage`/`blocked` changes — every substrate event that can
  create claimable work (a new task, an advance, an unblock, an accepted intake brief). It persists
  nothing; it is a nudge to look now. Migration built **assisted** (substrate behavior,
  trust-critical).
- **The supervisor holds one direct-connection `LISTEN`** (`loop.env` creds, `psql` — *service-side
  infra, never a harness child*, on the correct side of the harness deny-list guard). Arrivals feed
  the idle wait.
- **The idle wait becomes "up to `LOOP_IDLE_POLL_SECS`, or until a notification arrives."** A
  notification interrupts the sleep → immediate re-poll. Many notifications coalesce to one wake
  (the service fully drains regardless of how many fired). If the `LISTEN` connection drops: log it,
  fall back to the pure poll, re-establish next tick.

Concretely, the idle sleep in `service.sh` (today `sleep "$LOOP_IDLE_POLL_SECS"`) becomes a bounded
wait on the notification stream — e.g. a background `psql … LISTEN` writing arrivals to a FIFO under
`$RUN_DIR`, and the idle branch doing `read -t "$LOOP_IDLE_POLL_SECS" … <fifo` (returns at once on a
notification, times out to the backstop poll otherwise). The exact plumbing is the plan's to fix;
the property is: **wake on the earlier of {a notification, the backstop interval}.**

### D5 — The poll stays as the backstop; correctness never depends on a notification

Non-negotiable, and the reason push-wake is an *optimization layer*, not a replacement
([ADR 0027](../decisions/0027-v7-1-push-wake.md)):

- **Lazy reclaim emits no NOTIFY.** A lease expiring makes a task claimable *without writing the row*
  ([ADR 0009](../decisions/0009-leases-reaper.md)) — so the trigger never fires for it. The poll
  is what picks such a task up. This case alone justifies the backstop permanently.
- A **dropped LISTEN**, a **missed notification**, or an **unreachable board** all degrade to the v7
  poll — visibly logged (the resilience-with-visibility rule), self-healing. A peer down never
  stalls; a signal lost never drops work.
- Because the poll remains authoritative, the poll interval may **lengthen** (it is no longer the
  primary wake) — idle cost drops *and* latency improves, together.

### D6 — Build split (recursive, per [ADR 0024](../decisions/0024-v7-scope-the-standing-service.md) §bootstrap)

- **Assisted (mock-verified before live):** `api.demand` (DB view — never swarm-self-validated in a
  worktree); the demand-gate + pool-sizing in `driver-lib.sh` (trust-critical spawn logic, the
  routing-drift failure class); the `pg_notify` trigger migration (substrate behavior); the
  LISTEN-or-poll idle wait in `service.sh` (the wake path).
- **Swarm-built (briefed, run hands-off):** the pure, substrate-free pieces — the **unserviceable-
  demand / demand-summary report-line + formatter** (the M20–M24 pure-formatter pattern: takes
  `demand=[]` + tier capabilities, renders the human-facing lines; `npx vitest`, no DB). The
  pleasing recursion, again: **let the standing service deliver its own precision-report slice
  hands-off** — and now it delivers it *faster* (push-wake) and *cheaper* (demand-shaping) than the
  service that built its v7 status readout did.

## The precise supervisor, concretely

The v7 idle/wake loop ([`service.md`](service.md)), with D1–D5 folded in (changes in **bold**):

```
start:  reach loop substrate; status(idle); trap stop → draining=1
        **build_capability_map() — probe live tiers → CAPMAP (D2); best-effort/timeboxed**
        **start background LISTEN → FIFO (D4); degrade-tolerant**
loop forever:
    if draining: break
    if board unreachable: status(idle,"unreachable"); backstop-wait; continue
    read active,blocked; sig=board_sig
    if active == 0:
        status(idle); **wait {notification | LOOP_IDLE_POLL_SECS}**; continue      # D4/D5
    if stalled(sig): status(stalled); **wait {notification | interval}**; continue  # v7 D3
    # ── one activation, demand-shaped ──
    status(running, N)
    run_activation:                                # driver-lib.sh
        each round:
            **refresh_capability_map()**           # D2: re-probe down tiers; mark spawn-errored down
            **refresh_demand()**                   # D1/D2: read api.demand (degrade→coarse)
            **surface any UNSERVICEABLE bundle**   # D3: named + why (unconfigured | backend-down)
            for tier in DESIGN/PRE/POOL/SERIAL/FRONTIER:
                **tier_has_demand(tier)** && !skip_if_banned(tier) && spawn   # D2 (live∩demand) + D6(gov)
            (**pool sizes to min(impl-demand, POOL_SIZE)**)                   # D2
            active==0 → return DRAINED; no board change → NO_PROGRESS; cap → MAX_ROUNDS
    act_rc → idle | stalled (v7 D3)                # unchanged
stop:   drain in-flight (already reaped), stop_active, **tear down LISTEN**, status(stopped), exit 0
```

Identical to v7: the state machine, `run_pool`/`run_sweep`/`run_concurrent`, `SKIP LOCKED`, the merge
queue (single grok integrator), the wipe-vs-drain guard, `stop_active`, `skip_if_banned`, the
`stalled` circuit breaker. **New:** `api.demand` + `refresh_demand`/`tier_has_demand` + pool sizing
(D1/D2), the unserviceable surface (D3), and the LISTEN-or-poll wait + trigger (D4/D5).

## Scope: driver/harness-side + two blessed substrate touches

Like v7, this is a **driver + harness** change. Two substrate touches, both the acceptable kind:

- **`api.demand`** — a read-only view (M16/M21/M22/M24 precedent; no schema change, no new truth).
- **The `ainarres_activity` NOTIFY trigger** — a truth-free signal, not coordination truth
  ([ADR 0027](../decisions/0027-v7-1-push-wake.md) owns the crossing of ADR 0024's ~zero-migration
  rule; a *truth* migration would still be the stop-and-rethink signal). No verb changes, no new
  mutable state.

`make loop-run` (batch) is byte-for-byte unaffected: demand-shaping and the LISTEN wait are
service-only (the batch driver leaves `LOOP_CONSUME_DEMAND`/the LISTEN off, exactly as it leaves
`LOOP_CONSUME_GOVERNANCE` off — its behaviour unchanged).

## Slicing (build order within v7.1)

1. **M27 — demand-shaping (+ the live-capability map).** `api.demand` (D1); the in-memory capability
   map with its startup probe + refresh (D2); `refresh_demand`/`tier_has_demand` + the per-tier spawn
   gate (live ∩ demand ∩ not-banned) + pool sizing in `driver-lib.sh` (D2); the two-cause
   unserviceable-demand surface (D3). The mock service selftest gains phases: a review-only board
   spawns no implementers; a single dev task spawns one implementer; a bundle no tier provides is
   surfaced as *unconfigured* without a wasted activation; a tier probed **down** is not spawned and
   its demand is surfaced as *backend-down*, then a re-probe brings it back with no restart; a
   demand-view or probe outage degrades to the v7 fleet-spawn. Gate:
   [ADR 0026](../decisions/0026-v7-1-demand-shaped-scaling.md) success criteria 1–4.
2. **M28 — push-wake.** The `ainarres_activity` trigger (D4); the supervisor's LISTEN-or-poll idle
   wait + degrade path (D4/D5). The selftest gains: an inserted task wakes an idle service in ≪ the
   poll interval; with LISTEN disabled it still drains via the poll; a lease-expiry-reclaimed task is
   still picked up. Gate: [ADR 0027](../decisions/0027-v7-1-push-wake.md) success criteria 1–4.

Each slice ends green (`service-selftest` + `loop-selftest` no-regression + the full suite). One
blog on merge (the series continues): *"The precise service: waking on demand, spawning to fit."*

## Open risks (honest)

- **Demand-view drift vs the claim predicate.** `api.demand` must compute *exactly* the claimable-
  modulo-capability predicate `claim_next_task` uses, or the service could skip a tier that actually
  had claimable work (a spawn deferred to the poll — a cost/latency bug, never a correctness one,
  since `SKIP LOCKED` still binds). Mitigation: derive the view from the *same* transition/feature
  logic, and a selftest phase that asserts "every tier the coarse gate would have usefully spawned,
  the demand gate also spawns."
- **The subset test is the routing tripwire.** `tier_has_demand` must stay a *capability* subset
  test over aggregate bundles. Any future temptation to break ties by task priority/subject/age is
  the router line — call it out in review, keep it out of v7.1.
- **`LISTEN` liveness is its own small daemon.** A background `psql LISTEN` can die quietly; if the
  degrade-to-poll path or its re-establish is buggy, the service could *look* responsive and
  silently be poll-only. Mitigation: log every LISTEN drop/reconnect; the selftest exercises the
  disabled-LISTEN path explicitly so poll-only is a tested mode, not an accident.
- **Notification storms.** A burst of inserts fires many NOTIFYs; the coalesce-to-one-wake property
  must hold or the service thrashes. Mitigation: the idle wait drains the FIFO fully and runs one
  activation per wake (the activation already drains *all* claimable work, so N notifications → 1
  activation regardless).
- **The availability probe is a staleness/cost trade-off of its own.** Probing every backend too
  eagerly adds start-up latency and its own cost; too lazily and the map lags reality (a tier down
  for a while still shows live, or vice versa). Mitigation: timebox and parallelize the startup
  probe; refresh down tiers on a *slow* cadence and mark a tier down *passively* on a spawn error
  (cheap, reactive) rather than polling every backend every round; and — the safety net — a stale
  map can only waste or defer a spawn, never drop work (`SKIP LOCKED` binds regardless), so
  correctness never rides on the probe being fresh.
- **Still one local service.** v7.1 makes the *one* service precise; the federated many-services
  topology the `api.demand` split was shaped for is still v8, not exercised here.
