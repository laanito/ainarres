# ADR 0021 — v4 scope: from pipeline to swarm (concurrency, observability, federation)

- Status: Accepted
- Date: 2026-06-30
- Builds on: [0018](0018-v3-scope-autonomous-loop.md) (v3 hands-off loop),
  [0020](0020-autonomous-run-topology.md) (run topology),
  [0014](0014-task-dependencies.md) (task DAG),
  [0009](0009-leases-reaper.md) (lazy reclaim), [0003](0003-two-plane-source-of-truth.md)
  (two planes), [0004](0004-feature-model.md) (feature model — governance plumbing)
- Decides: v4 north star, in/out scope, the v4 success gate; refines 0018's "v4 = federation"

## Context

v3 met its gate ([0018](0018-v3-scope-autonomous-loop.md)): a real feature (`ainarres ttl`)
shipped to `main` with **no conductor** — the owner started a driver and walked away. But v3
deliberately ran **one thing at a time**: a single serialized worker per tier, one instance,
and the [0020](0020-autonomous-run-topology.md) driver sweeping tiers in rounds. That isolated
the autonomy variable. It proved coordination is *correct* for a serial pipeline.

The substrate, however, was built for more from the start: race-free claims
(`SELECT … FOR UPDATE SKIP LOCKED`, [0008](0008-verb-contracts.md)) and a dependency DAG
([0014](0014-task-dependencies.md)) mean *many* agents pulling at once is already solved at
the data layer. The serialization lives entirely in the v3 *driver*, by choice. v4 lifts that
choice: stop being a pipeline, become a **swarm**.

ADR 0018 pencilled "v4 = federation." This ADR **refines** that. Federation (frontier models as
peers) remains in v4, but it is not the entry point: you cannot federate peers onto a loop that
still runs one worker at a time, and you cannot safely run *any* fan-out you cannot see. So v4
leads with **concurrency** and is funded by **observability**, with federation as the milestone
that completes the "as peers" half of the swarm. **Governance is deferred to v5** (see below).

## Decision

### The v4 north star

**From pipeline to a swarm.** Many independent agents — cheap and frontier — working
*concurrently* toward a goal, where all coordination, safety, and human *visibility* come from
the substrate rather than a human, an orchestrator, or any single privileged agent. The
**headline is throughput** (the swarm builds faster, coherently), not trust.

### The v4 success gate

**v4 is "done" when a real multi-task AINARRES feature ships to `main`, built by multiple
agents working concurrently, observably, with `main` kept coherent.** Concretely:

1. A designer decomposes a feature into an **independent-where-possible task DAG**
   ([0014](0014-task-dependencies.md)).
2. **Multiple implementers run at once**, each in an **isolated workspace** (no shared-checkout
   collisions), fanning out across the DAG; dependent tasks wait, independent ones proceed.
3. Integration is serialized through a **merge queue** that rebases + re-validates so `main`
   stays green even though implementation ran wide.
4. The whole run is **observable live** (board, per-agent activity, why-stuck) and produces an
   **end-of-run report** — the owner who walked away comes back to a clear account.
5. **Measured:** wall-clock for an N-independent-task feature **beats the serial v3 driver**,
   with no human coordination and no cross-worker corruption.
6. At least one non-implementer role is exercised by **federated frontier peers** (M19),
   demonstrating coordination with no single privileged agent.

If the swarm ships an N-task feature faster than the pipeline did, coherently and watchably,
v4 holds.

### In scope for v4

- **Observability** (M16) — the oversight surface grown up for a swarm: a live board view,
  an event timeline joined to agent families, human-readable why-stuck/escalation reasons, and
  an end-of-run report. **CLI- and substrate-native, read-only over the event log and oversight
  views** ([0009](0009-leases-reaper.md)) — `ainarres status` is the lineage. Includes
  **enriching the event log** with attributable per-agent outcomes (verdicts, rejections,
  validation results), consumed *now* by the view and inherited later by governance.
- **Per-task workspace isolation** (M17) — `git worktree` (grok has native `--worktree`) or a
  per-task container, so concurrent implementers cannot collide. A **harness/driver** concern,
  not a schema change: the substrate stays workspace-agnostic ([0003](0003-two-plane-source-of-truth.md)
  — work product lives in git, the substrate only coordinates).
- **Parallel implementers + merge queue** (M18, the headline) — a pool of implementers pulling
  concurrently; integration serialized with rebase + re-validate + a conflict policy.
- **Federation** (M19) — multiple frontier families sharing the designer/reviewer/integrator
  roles as peers, none privileged over the others.

### Out of scope for v4 — deferred (constraints, not built)

- **Governance** (workflow *revokes* a family's capability, [0004](0004-feature-model.md)) —
  **deferred to v5**. It is premature for a concrete reason: the substrate does not yet capture
  enough **rich, attributable outcome signal** to judge an agent *fairly* (today's events know
  "stranded/advanced," not *why*), and a fair track record needs the **volume** that concurrency
  produces — plus **sybil-resistance** (an agent must not shed a bad record by re-registering a
  family). M16's event enrichment is the deliberate runway; v5 consumes it. (Escalation,
  [0019](0019-capability-escalation.md), *adds* a feature to a task; governance *revokes* a
  family's — still the harder, later half.)
- **Always-on daemons / pooling / replication / sharding** — v4 still runs a bounded,
  owner-started pool on a single instance; long-running services and horizontal scale are later.
- **Cross-organization / cross-substrate federation** — M19 federates peers on one substrate;
  federating across trust or substrate boundaries is a v5+ concern (and entangled with
  governance/sybil).
- **Designer difficulty hints, graduated N-tier escalation** — carried from v3's follow-ups
  ([`plans/v3-plan.md`](../plans/v3-plan.md)); ride along only where they unblock the swarm.

## Bootstrap discipline (recursive, again)

As in v2/v3, v4's own milestones are built **on AINARRES**. M16 (observability) and M17
(isolation) are built assisted/with the v3 loop where feasible. **M18 flips the build itself
to the swarm:** the parallel loop is exercised by shipping a real multi-task feature through
it, observably. M19 layers federated peers on top. Each retro states the
assisted-vs-swarm split and reports the throughput number against the serial baseline.

## Alternatives considered

- **Lead v4 with federation (per 0018).** Rejected as the *entry point*: peers presuppose
  concurrency and visibility. Federation stays in v4, but as M19, on top of a proven parallel,
  observable loop — the same "don't build on sand" reasoning that scoped v2 and v3.
- **Include governance in v4.** Rejected: no fair signal yet, and concurrency is what *creates*
  the signal. Owner's call; M16 instruments for it so v5 is a small step, not a re-paint.
- **Skip observability ("a bit more," not a milestone).** Rejected: a fan-out swarm you cannot
  see is unsafe to run unattended, and v3's pollution post-mortems required hand-querying the
  event log. Visibility is a prerequisite for trusting the swarm, not a nicety — but it is held
  to **CLI-native, read-only** scope so it doesn't balloon into a metrics product.
- **Parallelism without isolation.** Rejected: shared-checkout collisions corrupt branches.
  Isolation (M17) gates everything concurrent.

## Consequences

- The plan ([`plans/v4-plan.md`](../plans/v4-plan.md)) is M16–M19, gate at M18 (concurrency,
  measured) with M19 completing the peer thesis; further ADRs fix the merge-queue policy and
  the isolation mechanism as those milestones are designed.
- The substrate's founding claim sharpens: no orchestrator, **and** many agents at once —
  coordination, safety, and visibility all in the substrate and its read-only surface.
- v5 (governance) builds on v4's enriched, attributable event log and the activity volume the
  swarm generates.
