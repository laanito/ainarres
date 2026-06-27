# ADR 0018 — v3 scope: the hands-off autonomous loop (remove the conductor)

- Status: Accepted
- Date: 2026-06-27
- Builds on: [0013](0013-v2-scope-self-development.md) (v2 self-development),
  [0017](0017-context-clean-validation.md) (context-clean agents, independent integrator)
- Decides: v3 goal, in/out scope, the v3 success gate

## Context

v2 met its gate: a real feature (`ainarres status`) was built end-to-end as an AINARRES
project by fresh, context-clean agents, and shipped to `main`
([0013](0013-v2-scope-self-development.md), retro `m11-bootstrap`). But it was honestly
**orchestrator-*assisted***: a human/Claude conductor sequenced the stages, *noticed* when
the cheap worker stalled and re-routed by hand, triggered each merge, and remediated shared
state between steps. The agents were context-clean; the *coordination* was not yet
autonomous.

v3 closes that gap. The owner's framing: **remove the conductor.** You start the process and
walk away; the agents self-organize through the substrate, a stuck worker is escalated
*automatically*, and a real feature reaches `main` with **no human in the loop** and **no
orchestrating conversation** driving it.

This is the depth axis of the original vision (one expert directing cheap workers,
*asynchronously and lazily*) finally running without a babysitter. The breadth axis —
**federation** (several frontier models forming workgroups as peers) — is explicitly **v4**:
peer-coordination layered on autonomy we haven't yet proven hands-off would be building on
sand, the same reasoning that scoped v2.

## Decision

### The v3 success gate

**v3 is "done" when a real AINARRES feature ships to `main` with no human conductor.**
Concretely:

1. The owner **starts the loop** (a driver the orchestrator does not control) against a
   feature brief, and does not sequence, re-route, or remediate during the run.
2. Agents **claim, work, and advance** tasks as independent pollers
   ([0020](0020-autonomous-run-topology.md)) — designer decomposes, workers implement,
   reviewer gates, the independent integrator merges — entirely through the verbs.
3. When a cheap worker cannot finish a task, the substrate **escalates it automatically** to
   a frontier-capable family ([0019](0019-capability-escalation.md)) — no human noticing,
   no hand re-routing.
4. The run **does not corrupt shared state** unattended ([0020](0020-autonomous-run-topology.md)
   § pollution-proofing) — no human remediation between steps.
5. A real **merged PR** lands on `main` and the feature is verifiably live, with the journey
   visible on the board/feed.

If the owner can start it, leave, and come back to a shipped feature, the conductor is gone.

### In scope for v3

- **Dynamic capability escalation** ([0019](0019-capability-escalation.md)): the genuinely
  new mechanism — a task that a cheap family keeps failing is automatically raised to require
  a frontier tier, reusing the existing attempts counter + feature model.
- **Autonomous run topology** ([0020](0020-autonomous-run-topology.md)): roles as independent
  headless pollers (cheap worker on opencode/qwen; all frontier roles on grok), a
  owner-started driver, the integrator as a **standing** poller (not per-task owner
  invocation), and **pollution-proofing** so unattended runs don't corrupt shared state.
- **Single-instance, serialized** workers (one at a time) — isolate the autonomy variable.

### Out of scope for v3 — deferred (constraints, not built)

- **Federation** — several frontier models forming workgroups as peers. The v4 thesis; v3
  is one director, automated.
- **Parallel workers / `git worktree` isolation** — serialized first; parallelism is a later
  slice once hands-off is solid ([0020](0020-autonomous-run-topology.md)).
- **Governance policy** (workflow revokes a family's capability) — plumbing still dormant
  ([0004](0004-feature-model.md)); a v4-adjacent concern. (Note: escalation in
  [0019](0019-capability-escalation.md) *adds* a required feature to a task; it does not
  *revoke* a family's feature — governance is the latter.)
- **Scaling** (pooling, replication, sharding) — still single-instance.

## Bootstrap discipline (recursive, again)

v3's own milestones (M12–M14) are built **on AINARRES**, assisted, reusing the v2 loop where
feasible — we can't run the autonomous loop before its mechanism exists. **M15 is the
flip:** the remaining work (or a fresh feature) ships through the *fully autonomous* loop,
owner-started, orchestrator-absent. Each retro states how much ran assisted vs. hands-off.

## Alternatives considered

- **Include federation in v3.** Rejected: it depends on a proven hands-off single-director
  loop; doing both at once multiplies risk and muddies the gate.
- **A "usefulness" pass instead (governance + multi-project + ergonomics).** Rejected as the
  v3 *headline*: tangible but sidesteps the autonomy thesis the project is built around.
  Individual ergonomics ride along where they unblock the loop.
- **Parallel workers in v3.** Rejected for the first cut: autonomy + concurrency failure
  modes at once would make a failed gate hard to diagnose.

## Consequences

- The plan ([`plans/v3-plan.md`](../plans/v3-plan.md)) is M12–M15, ending in the hands-off
  gate; ADRs 0019–0020 fix the net-new mechanism and the run model.
- After v3, the substrate runs its own development with **no orchestrator** — the README's
  founding claim, finally literal, not assisted.
- v4 (federation) builds on a proven autonomous single-director loop.
