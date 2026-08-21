# ADR 0026 — v7.1: demand-shaped scaling (spawn the roles the work needs, never the whole fleet)

- Status: Accepted
- Date: 2026-08-20
- Builds on: [0024](0024-v7-scope-the-standing-service.md) (v7 — the standing service, the
  **demand-scaler-never-router** invariant this ADR sharpens; ADR 0024 D2 explicitly *deferred*
  "waking only the tiers whose role has claimable work … so the first cut cannot drift toward
  routing" — this ADR builds exactly that, now that the coarse cut has shipped and held),
  [0020](0020-autonomous-run-topology.md) (the dumb driver + independent pollers; the tier order
  is runtime config, not substrate truth), [0007](0007-auth-identity-family-grant-deny.md)
  (families + effective features — the *capability* terms demand is reported in),
  [0009](0009-leases-reaper.md) (`claim_next_task`'s claimable predicate, reused verbatim as the
  demand predicate), the vision ([analysis/vision.md](../analysis/vision.md): a service is a
  **demand-scaler, never a router**; "the substrate has no concept of which service").
- Decides: v7.1's first north star — the standing service scales capacity to the **shape** of
  pending demand (which capabilities the work needs), not merely its **existence**. Its companion
  [0027](0027-v7-1-push-wake.md) decides *when* the service wakes; this one decides *what* it
  spawns. Together they make the v7 service precise instead of coarse.

## Context

v7 shipped the standing service with a deliberately **coarse** demand gate ([ADR 0024](0024-v7-scope-the-standing-service.md)
D2): its only question was "is `active > 0`?" — any claimable work at all triggers a **full
activation**, spawning every configured tier (the cheap-implementer pool, the serial implementer
tiers, the frontier reviewer/integrator peers), each of which self-claims via `SKIP LOCKED`. That
was the right first cut: the coarsest possible gate is the one that *structurally cannot route*,
and shipping it proved the demand-scaler invariant held under a real standing runtime.

But coarse is expensive, and the cost is now visible. If the only pending task sits at `reviewing`,
the activation still boots the whole implementer pool — every one of them a process startup **and**
a model invocation that reads the board, finds nothing it can claim, and exits. The fleet is scaled
to the *existence* of work, not its *shape*. Two concrete costs:

1. **Wasted spawns.** Every activation pays for every tier, regardless of whether the board holds
   work that tier can do. On a board with only review work, the entire implementer fleet is pure
   waste — process churn and (worse) paid/limited model tokens spent claim-missing.
2. **Stall discovery is empirical, not predictive.** A task at a stage **no configured tier can
   claim** (its `required_features` are satisfied by no seated family) is discovered only *after* a
   full activation moves nothing → the D3 `stalled` state. The service spends a whole fleet-spawn to
   learn what it could have known from a read: "no tier I run can touch this." And the `stalled`
   signal is un-attributed — it says "the board is stuck," not "the board needs a `role:X` I don't
   have seated."

The owner's framing, which this ADR adopts: *being smarter about which models to spawn is not
routing.* Reading **how much work needs each capability** and spawning accordingly is demand-scaling
done at proper resolution. Reading a **task's content to prefer one competent worker over another**
would be routing. The line is bright, and this ADR draws it explicitly.

## Decision

**The service scales per-role to live demand: it reads which capabilities the pending work requires
(in substrate terms), and spawns only the tiers whose role satisfies some demanded capability. The
task→worker binding stays entirely in `SKIP LOCKED`.** Three parts:

1. **The substrate reports demand in capability terms, knowing nothing about tiers or services.** A
   new read-only view exposes, per *pending, claimable-modulo-capability* task (unblocked,
   dependency-satisfied, no live lease), the **feature bundle(s)** that could advance it — the
   task's own `required_features` unioned with the `required_features` of an outgoing transition
   from its stage. This is precisely the predicate `claim_next_task` already applies
   ([ADR 0009](0009-leases-reaper.md)); the view exposes it as an *aggregate*, not per-claim. It
   names no task-to-worker assignment and no tier — it says only "this much pending work needs a
   family whose effective features ⊇ {these}." A read-only view is the [ADR 0024](0024-v7-scope-the-standing-service.md)-blessed
   kind of substrate touch (M16/M21/M22/M24 all added views; no schema change, no new truth).

2. **The service maps its OWN *available* capacity onto that demand — via an in-memory capability
   map, built at start and refreshed.** The tier→features mapping (`roles.sh::role_features`) is
   **runtime config, not substrate truth** — the substrate must never learn what a "tier" is. So the
   spawn decision lives in the service, and it is made against *available* capacity, not merely
   configured capacity:

   - **At start, the service probes which configured tiers are actually reachable** (their model
     backend is up — ollama loaded, the API key valid, the harness resolvable) and builds an
     **in-memory capability map**: `{ live tier → its role features }`. This is what closes the gap
     a real incident exposed — a configured tier whose model was retired overnight, which the v7
     service kept trying to spawn and which merely claim-failed. A tier probed *down* is not in the
     map and is not considered for spawning until it is re-probed live.
   - **The map is refreshed** — periodically and lazily (a tier that errors on spawn is marked down
     until re-probe; a down tier is re-probed on a slow cadence) — so a backend coming back is picked
     up without a restart, and one going down stops being spawned. Probing is **best-effort and
     timeboxed**: it never blocks the wake path, and it never holds truth the substrate owns.
   - **The spawn gate:** for each tier *in the live-capability map*, spawn it iff its features satisfy
     **at least one** demanded bundle. No demand for a live tier's capability ⇒ not spawned this
     round; a tier not in the map (down) ⇒ not spawned regardless of demand. The primary implementer
     pool additionally sizes to demand — `min(pending-implementable, LOOP_POOL_SIZE)` — so a single
     pending dev task spawns one implementer, not three. With push-wake ([ADR 0027](0027-v7-1-push-wake.md)),
     the effect the owner asked for falls out directly: a task appears → the service matches it
     against the in-memory map → it wakes exactly the live tier(s) that can do it, at once.

3. **Unserviceable demand is surfaced predictively, not discovered by spawning — and it names *why*
   it is unserviceable.** If a demanded bundle is satisfied by no tier *in the live-capability map*,
   the service does not spawn against it (there is nothing live to spawn) and surfaces it as
   **unserviceable demand**, distinguishing two causes:
   - **no configured tier provides it** — "pending work needs `{features}`; no configured family
     provides it — seat one"; versus
   - **the only tier(s) that provide it are currently down** — "pending work needs `{features}`; the
     family that provides it is unreachable — a backend is down."

   Both are strictly better than today's post-hoc `stalled`: they fire without a wasted activation
   and say *what is missing and why*. The second is the incident-driven case the availability probe
   exists for — a retired/unreachable backend, surfaced as *that*, not as a generic stall.

**The invariant, restated and guarded.** The service reads demand **by required-capability, in
aggregate** — never a task's identity, priority, or content, and never to pick a winner among
capable families. Every task→worker binding remains the tiers' own `SKIP LOCKED` self-claim, exactly
as in v1–v7. The bright line this ADR must not cross: *the moment the service reads a task's content
to prefer one competent family over another, it has become a cost-aware router.* That is a separate,
invariant-adjacent question (the deferred "cost-aware routing" candidate) and is explicitly **out of
scope here.** Demand-*shaping* answers "what kinds of worker does the pending work need?"; routing
answers "which worker should this task go to?" — this ADR does only the first.

## Why this is *more* faithful to the invariant, not less

The coarse gate was safe by being blind. This gate is safe by being **precise in capability terms
and silent about identity.** It is the demand-scaler doing the job its name promises — scaling
capacity to the *demand curve*, per capability — rather than a binary "any / none." Crucially, the
split (substrate reports demand in feature terms; each fungible service maps its own capacity) is
exactly the shape the **federated many-services future** needs: a second service with a different
tier roster reads the *same* view and makes its *own* spawn decisions, no service knowing about any
other. Getting demand-shaping right on one local service is the groundwork for that — the invariant
was always "so that many fungible services are safe."

## Consequences

- **Cost drops with board shape.** A review-only board spawns no implementers; a single dev task
  spawns one implementer, not a pool of three; a truly-unclaimable task costs a read, not a
  fleet-spawn. Idle and near-idle boards get materially cheaper.
- **`stalled` narrows to its true meaning.** D3's `stalled` becomes "I spawned everything the demand
  asked for and the board still didn't move" — a genuine stuck (e.g. a task every capable tier keeps
  failing). "No tier can even claim this" is now the *separate, predictive* unserviceable-demand
  signal. Two distinct diagnoses, each named.
- **One new read-only view.** The only substrate touch. No schema change, no new mutable state, no
  verb change — the same "add a view, the service reads/uses it" rule v7 followed.
- **Both the demand read and the availability probe degrade safely.** Resilience over optimization
  (the M18/M19 measured-not-enforced rule, matching `skip_if_banned`'s degrade-to-spawn): if the
  demand view is unreadable, the service falls back to the v7 coarse gate (spawn the fleet on
  `active > 0`); if the availability probe is unavailable or times out, a tier is treated as **live**
  (spawn-anyway, back to v7 behaviour) rather than wrongly withheld. A wrong probe can only waste a
  spawn (probed-up-but-down: claim-miss, as today) or defer one to the poll (probed-down-but-up: the
  task waits a tick) — never mis-assign or drop work, because `SKIP LOCKED` still binds. An
  optimization outage never stalls the loop and never changes correctness, only cost.
- **Correctness is unchanged; only cost and latency-to-diagnosis change.** Because `SKIP LOCKED`
  still binds every task, a demand mis-read (spawning a tier with nothing to do, or skipping one
  that had work) can only waste or delay a spawn — never mis-assign, double-assign, or drop a task.
  The board remains the sole truth.

## The v7.1 success gate (demand-shaping half)

1. **A review-only board spawns no implementers**, a single dev task spawns one implementer (not the
   full pool), and a full board still drains exactly as v7 did — proven deterministically by the
   mock service selftest (new demand-shaping phases).
2. **A task requiring a capability no *live* tier provides is surfaced as unserviceable *without* a
   wasted activation**, naming *why* (no configured family, vs. the providing family unreachable),
   and the service holds (does not spin) — distinct from the post-activation `stalled` state. A tier
   whose backend is down is not spawned; when the backend returns, the refreshed capability map picks
   it up with no restart.
3. **The service still never routes** — every claim is `SKIP LOCKED`; the demand read is aggregate,
   by capability, never per-task-identity; matching live capability to demand is a capability-subset
   test, never a task→worker choice; and a demand-view outage or a probe outage each degrade to the
   v7 spawn-anyway behaviour.
4. **`main` stays coherent** and the batch driver (`make loop-run`) is byte-for-byte unaffected
   (demand-shaping is service-only; the batch driver decomposes once and drains, as before).
