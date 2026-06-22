# ADR 0013 — v2 scope: AINARRES is developed within AINARRES

- Status: Accepted
- Date: 2026-06-22
- Builds on: [0011](0011-v1-scope-boundary.md) (the v1 line), [0012](0012-self-hosting-success-criterion.md) (self-hosting gate), [0003](0003-two-plane-source-of-truth.md) (two planes)
- Decides: v2 goal, in/out scope, the v2 success gate, the bootstrap discipline

## Context

v1's gate ([ADR 0012](0012-self-hosting-success-criterion.md)) proved the *mechanism*: a
real agent carried a real coding task end to end through the verbs. But it did so at
desktop scale — one expert directing one worker, a single hand-kicked snippet task, the
work product copied into git by hand. The substrate can *host* a task; it cannot yet
*host its own development*.

The owner set the v2 goal directly: **AINARRES is 100% developed within AINARRES.** v2
exists to build exactly the plumbing that makes that true, and to prove it the only
honest way — by using AINARRES to ship a real piece of AINARRES.

This is the depth-first half of the vision (one expert orchestrating real work),
deliberately ahead of the breadth-first half (several frontier models federating), which
is v3+.

## Decision

### The v2 success gate

**v2 is "done" when a real AINARRES feature ships as an AINARRES project**, concretely:

1. A real feature is **decomposed into multiple dependent tasks** (design → implement →
   review → integrate → validate), modelled as data in AINARRES.
2. Agents **claim and work the tasks through the verbs** — no hand-editing rows, no
   out-of-band coordination. Ordering is enforced by task dependencies
   ([ADR 0014](0014-task-dependencies.md)).
3. The task reaching the **integrate** stage produces a **real merged PR**, performed by
   an agent holding the integrate capability ([ADR 0015](0015-egress-as-capability.md));
   the work product lands in git per the two-plane model
   ([ADR 0003](0003-two-plane-source-of-truth.md)).
4. The **owner supervises** the whole run through a human-readable surface.
5. The feature chosen to prove all of the above **is the bare-minimum oversight tool
   itself** — the thing that lets you watch the swarm is built by the swarm.

If a real change reaches `main` while AINARRES coordinated every step, v2 has proven
itself the same way v1 did: recursively and un-fakeably.

### In scope for v2 — the plumbing that makes self-development possible

- **Real development workflow as data** ([ADR 0016](0016-development-workflow.md)): stages
  and transitions encoding change → test → integrate → validate, with reject-for-rework;
  functional roles (designer/implementer/reviewer/integrator) as features.
- **Minimal task dependencies** ([ADR 0014](0014-task-dependencies.md)): a task declares
  prerequisite task(s) and is not claimable until they are satisfied — enough to order
  one real feature's work items.
- **Egress as a capability** ([ADR 0015](0015-egress-as-capability.md)): pushing to git
  and opening a PR is a gated *feature*, so a family can be allowed to code but not push;
  agent-driven, the PR reference recorded as an artifact. No new infrastructure.
- **Worker ergonomics for real tasks**: bounded auto-heartbeat and lease tuning (real
  tasks run minutes, not milliseconds — leases must not expire mid-work), and an
  `ainarres` PATH shim so agents stop typing `node bin/ainarres.mjs`.
- **Artifact richness**: branch / PR / commit / file references discoverable by the
  reviewer, over the existing event `data jsonb` ([ADR 0006](0006-task-identity-events-artifacts.md)).
- **Bare-minimum oversight tool**: a non-interactive read of task/dependency/board state
  (a `status` subcommand, a small TUI, or a static dashboard — form decided at its
  milestone). This is the v2 deliverable built *on* AINARRES.
- **Docs cleanup**: the README still describes intent that the implementation diverged
  from (`pg_cron` reaper, `plv8`, "Status: Early"). v2 is precisely the claim that
  AINARRES-on-AINARRES is real, so the README must stop contradicting the code.

### Out of scope for v2 — held as v3 constraints (not built)

- **Reflexive governance *policy*** ([ADR 0004](0004-feature-model.md)) — the plumbing
  (`effects`, `subject`, `feature_denials`) stays dormant; a quality-review→revoke flow
  is v3. Multi-worker failure is what makes it meaningful, and v2 is still one-expert.
- **Scaling** ([README](../../README.md)) — single-writer/sharding, streaming/logical
  replication, read fanout, connection pooling (PgBouncer). v2 stays **single-instance**:
  prove sufficiency for real development before distribution.
- **External egress as a substrate process** — the outbox + `LISTEN/NOTIFY` consumer.
  v2's egress is agent-driven ([ADR 0015](0015-egress-as-capability.md)); the outbox seam
  remains noted for when substrate-initiated egress is actually needed.
- **Federation** — several frontier models forming workgroups toward a common goal. The
  end vision, explicitly v3+.

## Bootstrap discipline

Early v2 milestones build the plumbing **by hand** (branch → PR per milestone, as v1
did), because you cannot develop dependencies-on-AINARRES before dependencies exist.
Dogfooding flips on **as early as it is feasible** — the moment the plumbing can carry a
task, we prefer to develop the remaining work *on* AINARRES. The final milestone (the
oversight tool) is the **fully-on-AINARRES** proof and the gate. We keep this honest: the
retro for each milestone states how much of it ran on AINARRES versus by hand.

## Alternatives considered

- **Breadth-first (federation) as v2.** Rejected: it depends on the ergonomics,
  dependencies, and egress that one-expert self-development forces us to build anyway.
  Federation on top of unproven single-expert orchestration would be building on sand.
- **Usefulness-first (egress + UI, no dependencies).** Rejected: without decomposition a
  "feature" is one monolithic task, which is not how real development works and would make
  the gate a toy again.
- **Pull scaling into v2.** Rejected per the v1 reasoning ([ADR 0011](0011-v1-scope-boundary.md)):
  distribution is not needed to prove self-development, and adds the most moving parts.

## Consequences

- The plan ([`plans/v2-plan.md`](../plans/v2-plan.md)) is four milestones (M7–M10) ending
  in the bootstrap gate; ADRs 0014–0016 fix the net-new mechanisms.
- Every deferred item already has an ADR or noted seam, so v3 is additive, not a redesign
  — the same property that made v2 additive over v1.
- After v2, AINARRES's own development is no longer a demonstration but the default way it
  is built.
