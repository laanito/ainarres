# Plan — AINARRES v4

> Scope and the gate are fixed by [ADR 0021](../decisions/0021-v4-scope-the-swarm.md)
> (pipeline → swarm). Builds on the v3 run topology ([ADR 0020](../decisions/0020-autonomous-run-topology.md)),
> the task DAG ([ADR 0014](../decisions/0014-task-dependencies.md)), and lazy reclaim
> ([ADR 0009](../decisions/0009-leases-reaper.md)). Each milestone is one PR-sized slice that
> ends green, then gets a blog article (continues the *AINARRES* series). Within-milestone loop
> is still **change → test → integrate → validate**.

## Objective

**From pipeline to swarm.** Stop running one worker at a time. Let many independent agents work
*concurrently* toward a goal — fanning out across the designer's dependency DAG, in isolated
workspaces, integrated through a merge queue that keeps `main` coherent — with the whole run
**observable** by the owner who walked away. Headline is **throughput**; federation completes the
"as peers" half. Governance is **v5**.

## Success criterion ([ADR 0021](../decisions/0021-v4-scope-the-swarm.md))

A real multi-task feature is decomposed into an independent-where-possible DAG, built by
**multiple concurrent implementers** in isolated workspaces, integrated via a **merge queue**
(rebase + re-validate) to a coherent `main`, **observably** end to end and summarized in an
end-of-run report — with **wall-clock beating the serial v3 driver** and no cross-worker
corruption. Reached at **M18**; **M19** demonstrates federated frontier peers. No human
coordination beyond starting the loop.

## Execution discipline

- **Branch → commit → push → PR** per milestone; owner reviews. Done = verified in the loop.
- **plpgsql only** ([ADR 0005](../decisions/0005-logic-language-escalation.md)); plain-SQL
  up/down migrations. Isolation (M17) is **harness-side**, not schema — the substrate stays
  workspace-agnostic ([ADR 0003](../decisions/0003-two-plane-source-of-truth.md)).
- **Observability is read-only and CLI-native** — over the event log + oversight views
  ([ADR 0009](../decisions/0009-leases-reaper.md)); no new infra, no web/metrics stack.
- **Bootstrap discipline:** M16–M17 built assisted/with the v3 loop; **M18 flips the build to
  the swarm** (ship a real multi-task feature through the parallel loop). Each retro reports the
  assisted-vs-swarm split **and the throughput number vs the serial baseline**.
- One blog article per merged milestone (v4 arc opener: "the swarm").

## Dependency order

```
M16 observability ─▶ M17 per-task isolation ─▶ M18 parallel implementers + merge queue ─▶ M19 federation
```
M16 first — you can't safely run a swarm you can't watch, and it instruments the events M17+
(and v5 governance) consume. M17 is the hard prerequisite for any concurrency. M18 is the
headline gate. M19 layers peers on the proven parallel loop.

---

## M16 — Observability: the oversight surface, grown up for a swarm

**Goal:** the owner who walked away can *watch* the swarm and get a clear account when it ends.
([ADR 0021](../decisions/0021-v4-scope-the-swarm.md))

**Steps**
- **Live board** — `ainarres status --watch` (poll-refresh): per-task stage, holder (sub +
  family), age-in-stage, attempts, blocked-by — not just stage counts.
- **Event timeline** — `ainarres events` rendered human-readably, **joined to agent families**
  and filterable by task/family/type (surface what v3's pollution post-mortem needed raw SQL to
  see).
- **Why-stuck** — blocked / stranded / `escalated` reasons in plain language.
- **End-of-run report** — when the loop drains, the driver emits a summary: what shipped (PRs),
  what failed and why, attempts/escalations, per-tier activity.
- **Enrich the event log** — record **attributable per-agent outcomes** (review verdicts,
  rejections, validation pass/fail, why a task was returned) as structured `events.data`,
  consumed now by the views, inherited later by v5 governance. Migration if a new event
  `type`/shape is needed; oversight grants extended read-only.

**Done-tests**
- During a live v3-style run, `status --watch` reflects stage/holder changes within a poll
  interval; the timeline shows the family behind each event.
- A run that ends produces a report naming the merged PR(s) and any escalations/failures.
- Each recorded outcome event carries the acting family + a machine-readable reason; oversight
  can read them, agents cannot forge another family's. Down-migration reverts cleanly.

**Blog:** "Watching the swarm: observability without a dashboard."

## M17 — Per-task workspace isolation

**Goal:** concurrent implementers cannot collide on a shared checkout.
([ADR 0021](../decisions/0021-v4-scope-the-swarm.md))

**Steps**
- Give each claimed implementing task its **own workspace**: `git worktree` per task (grok has
  native `--worktree`; opencode wrapper gets an equivalent) or a per-task container. Branch
  naming keyed to the task id; teardown on advance/release.
- Keep it **harness/driver-side**: the substrate does not learn about workspaces — it still only
  coordinates rows + verbs ([ADR 0003](../decisions/0003-two-plane-source-of-truth.md)).
- Handle the v3 stranded-claim path under isolation (a killed worker's worktree is reclaimable /
  garbage-collected; lazy reclaim still applies, [ADR 0009](../decisions/0009-leases-reaper.md)).

**Done-tests**
- Two implementers working two tasks at once produce two branches with no working-tree
  contamination; killing one leaves the other's workspace intact.
- A reclaimed task's stale workspace is cleaned up; no orphaned worktrees accumulate across a run.

**Blog:** "A clean room per task: isolating parallel implementers."

## M18 — Parallel implementers + merge queue (headline gate)

**Goal:** the swarm fans out and `main` stays coherent — faster than the pipeline.
([ADR 0021](../decisions/0021-v4-scope-the-swarm.md))

**Steps**
- The driver launches a **pool** of cheap implementers that pull concurrently (the substrate's
  `SKIP LOCKED` claim already makes this race-free); tiering/escalation
  ([ADR 0019](../decisions/0019-capability-escalation.md)) still applies per task. Preserve the
  v3 **termination** property (the loop still ends when work is drained) and **fairness** (cheap
  tier first; no starvation).
- A **merge queue** for `integrating`: integrate one task at a time, **rebase on latest `main`
  + re-run validate** before merge; on conflict, a defined policy (return-to-implementing /
  escalate / block) rather than a dirty merge. Whether the queue is a driver construct or a
  substrate single-`integrating`-slot lock is settled in this milestone's design note.
- Ship a **real multi-task feature** through the parallel loop, observably (M16), in isolated
  workspaces (M17).

**Done-tests / success gate**
- An independent-where-possible N-task feature reaches `main` via the parallel loop with
  **multiple implementers active simultaneously** (visible in the M16 view).
- `main` stays green throughout — every merge was rebased + re-validated; conflicts followed the
  policy, never a broken merge.
- **Wall-clock beats the serial v3 driver** on the same feature shape; the loop still terminates
  cleanly; the end-of-run report shows the concurrency.

**Blog:** "The swarm builds faster: parallel implementers and a merge queue."

## M19 — Federation: frontier peers, none privileged

**Goal:** multiple frontier families share the non-implementer roles as peers.
([ADR 0021](../decisions/0021-v4-scope-the-swarm.md))

**Steps**
- Register **two or more frontier families** holding designer/reviewer/integrator features;
  let them claim those stages concurrently with no single privileged agent.
- Address peer **duplication** (v3 showed a frontier worker freelance-creating tasks): a clean
  rule for who may decompose vs. who may only advance, enforced by the substrate
  ([ADR 0004](../decisions/0004-feature-model.md)/[0007](0007-auth-identity-family-grant-deny.md))
  rather than by prompt — the "make misbehavior structurally harmless" lesson from v3.
- Keep the **independent integrator** boundary ([ADR 0017](../decisions/0017-context-clean-validation.md)):
  no peer can launder a merge it is denied.

**Done-tests**
- A feature run has ≥2 frontier peers handling design/review/integrate stages, coordinating only
  through the substrate; no peer holds power another lacks.
- No duplicate/colliding decompositions: the create-vs-advance boundary holds by capability, not
  by an agent remembering to behave.

**Blog:** "Peers, not a boss: federating frontier models on the substrate."

---

## Open questions (settle within each milestone's design note)

- **M16:** how much is "enough" observability without gold-plating; poll-refresh vs Postgres
  `LISTEN/NOTIFY` for live updates (lean poll, no new infra); exact enriched-event shape.
- **M17:** worktree vs container; disk/cleanup at scale; how the wrapper binds a task id to a
  workspace deterministically.
- **M18:** merge-queue location (driver vs substrate lock); **conflict policy** when two
  concurrent features touch the same file; fairness/liveness with a free-pulling pool;
  re-validate cost vs. throughput.
- **M19:** peer registration + identity; the create-vs-advance capability split; how far to push
  before the **sybil/identity** problem (a v5/governance entanglement) forces a stop.

## Deferred to v5+

- **Governance** — workflow-driven feature *revocation* on observed track record
  ([ADR 0004](../decisions/0004-feature-model.md)); needs M16's enriched signal + the swarm's
  activity volume + sybil-resistance.
- **Always-on daemons, pooling/replication/sharding** — horizontal scale beyond a bounded,
  owner-started single-instance pool.
- **Cross-organization / cross-substrate federation** — peers across trust or substrate
  boundaries.
- **Graduated N-tier escalation, designer difficulty hints** — carried from v3
  ([`v3-plan.md`](v3-plan.md)); only if mis-routing proves costly under concurrency.
