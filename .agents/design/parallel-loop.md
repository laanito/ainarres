# Parallel implementers + a merge queue: the swarm builds faster

> Design note for **M18** — the v4 **headline gate** ([v4-plan](../plans/v4-plan.md) ·
> [ADR 0021](../decisions/0021-v4-scope-the-swarm.md)). Settles M18's open questions
> before code. Builds on the M17 per-sweep worktrees ([`isolation.md`](isolation.md)),
> M16 observability ([`observability.md`](observability.md)), the task DAG
> ([ADR 0014](../decisions/0014-task-dependencies.md)), escalation
> ([ADR 0019](../decisions/0019-capability-escalation.md)) and the v3 run topology
> ([ADR 0020](../decisions/0020-autonomous-run-topology.md)).

## What M18 is for

v3 proved coordination is *correct* for a serial pipeline. M18 makes it *fast*: stop
running one implementer at a time, run a **pool** that fans out across the designer's
dependency DAG, and keep `main` coherent through a **merge queue**. This is the
milestone where the v4 thesis — *the swarm builds faster, coherently* — is measured.

**The gate** ([ADR 0021](../decisions/0021-v4-scope-the-swarm.md)): a real, multi-task
AINARRES feature, decomposed into an independent-where-possible DAG, is built by
**multiple implementers running at once** (visible in the M16 view), integrated via a
merge queue that rebases + re-validates so `main` stays green, **wall-clock beating
the serial v3 driver** on the same feature shape — no human coordination, no
cross-worker corruption.

## What changes: from serial rounds to a concurrent pool

The v3 driver (M14) sweeps tiers **sequentially** — `run_sweep` launches one harness,
`wait`s for it, then the next; tiers cycle in rounds until the board makes no
progress. The serialization lives entirely in the *driver*; the substrate has been
race-free from the start (`SELECT … FOR UPDATE SKIP LOCKED`,
[ADR 0008](../decisions/0008-verb-contracts.md)). M18 lifts the driver's
serialization for the **implementing** stage — exactly the choice
[ADR 0020](../decisions/0020-autonomous-run-topology.md) deferred and
[ADR 0021](../decisions/0021-v4-scope-the-swarm.md) authorizes.

```
v3 (serial):   designer → [cheap → frontier] round, repeat → integrator → drain
M18 (pool):    designer → ┌ cheap impl #1 ┐
                          ├ cheap impl #2 ├ concurrent ─→ reviewer → merge queue → drain
                          ├ cheap impl #3 ┤              (frontier)  (1 integrator)
                          └ frontier ceil ┘
```

Implementing fans out (where the time goes); review and integrate stay **single**
standing pollers (fast relative to implementing, and integration *must* serialize to
keep `main` coherent — that single integrator **is** the merge queue, see D2).

## Decisions (the open questions, settled)

**D1 — The pool is N concurrent standing cheap-implementer pollers; review/integrate
stay single.** The driver launches a configurable pool (`LOOP_POOL_SIZE`, default ~3)
of cheap implementers that pull concurrently — `SKIP LOCKED` already makes this
race-free, and one-active-task-per-instance ([ADR 0009](../decisions/0009-leases-reaper.md))
means N pollers hold ≤N distinct tasks. The frontier (reviewer + escalated-implementer
ceiling) and the **single** integrator remain one poller each. Each pool member runs in
its own M17 worktree (`LOOP_SWEEP_ID` per process) so the concurrent checkouts can't
collide.

**D2 — The merge queue is the single integrator poller, not a substrate lock.**
Integration serializes *by construction*: one integrator poller drains the
`integrating` stage one task at a time (FIFO by the existing `priority desc,
created_at` claim order). Each integration: **fetch latest `main` → rebase the task's
`loop/<task_id>` branch → re-run validate → merge** only if green. This keeps the
substrate **workspace- and merge-agnostic** ([ADR 0003](../decisions/0003-two-plane-source-of-truth.md)) —
no `integrating`-slot lock, no new verb. A substrate lock was considered and rejected:
it would teach Postgres about a git concern the topology already enforces for free.

**D3 — Conflict policy: reject to implementing, never a dirty merge.** If the rebase
hits a conflict the integrator can't cleanly apply, it **rejects** the task back to
`implementing` with the conflict context in the event `data` (reusing the existing
`reject` transition). That bumps `attempts` → feeds M12 escalation, so a task that
repeatedly conflicts climbs to the frontier and eventually blocks rather than
spinning. The implementer redoes it against fresh `main`. The substrate never sees a
half-merged tree.

**D4 — Termination generalizes the v3 drain check to the concurrent case.** The driver
stops when **the board has no non-terminal, non-blocked task AND no pool member is
still running**. The v3 "a full round moved nothing" no-progress guard becomes "a
full *quiescent* sweep moved nothing" (all pollers idle/exited + board signature
unchanged), preserving the v3 guarantee that the loop *ends* — the cost-control
property is non-negotiable. The `LOOP_MAX_ROUNDS`-style safety bound stays.

**D5 — Fairness/liveness is structural, not scheduled.** Cheap-tier-first is inherent:
the pool *is* cheap implementers; the frontier is a ceiling reached only via escalation
([ADR 0019](../decisions/0019-capability-escalation.md)). No starvation: the claim
order (`priority desc, created_at`) is FIFO-fair, and escalation guarantees every task
eventually finds a tier that can move it (or blocks as poison). Independent DAG tasks
proceed in parallel; dependent ones wait on the `depends_on` predicate
([ADR 0014](../decisions/0014-task-dependencies.md)) — the designer's decomposition is
what creates the parallelism, so a parallelizable brief matters (see risks).

**D6 — Re-validate stays targeted, so coherence is cheap.** The per-task `validate` is
substrate-free and discriminating (M13 / observability lessons) — a unit check, not the
full suite — so re-running it per merge on rebased `main` is fast. Rebase+revalidate
per integration is the accepted price of a green `main`; it is bounded because
integration is serial and validate is targeted.

## The merge queue, concretely

The integrator harness/skill (grok, owner-launched per [ADR 0017](../decisions/0017-context-clean-validation.md)),
for each `integrating` task:

1. `git fetch origin && git checkout loop/<task_id>`
2. `git rebase origin/main` — on conflict it can't resolve → `ainarres reject … --to
   implementing --reason "rebase conflict on <files>"` and move on (D3).
3. Re-run the task's `validate` on the rebased branch — on failure → reject (same path).
4. `gh pr create` + merge (squash) → `ainarres advance … --to validating/done` with the
   PR ref in artifacts (M16 picks it up for the end-of-run report).

Because there is one integrator, steps 1–4 are atomic with respect to `main`: no two
merges race. The "queue" is just the `integrating` column drained FIFO.

## Judging the gate — concurrency *correctness*, not wall-clock

> Reframed after the first real gate run ([ADR 0021](../decisions/0021-v4-scope-the-swarm.md)
> § Amendment 2026-06-30). The north star is the substrate coordinating **independent workers
> that could be on different machines, networks, or organizations** — so wall-clock on a single
> laptop is **not** the measure (a single host caps real parallelism via shared CPU, a free-API
> backend that serializes calls, and per-tool local state — none of which the substrate controls).

The gate is **qualitative — correct concurrent coordination**:

- **Genuine simultaneity.** During the run, `ainarres status --watch --lane dev` shows **≥2
  distinct workers holding distinct tasks at the same time** (the M16 `active` block); the
  end-of-run report's activity-by-family corroborates more than one implementer family/sub did
  real work. (This is exactly what the first run *lacked*: opencode's shared session DB collapsed
  the pool to one live worker — fixed by isolating each sweep's tool state, the harness analog of
  M17's worktree.)
- **Isolation is real and per-worker.** Each implementer ran in its own git checkout (M17) **and**
  its own tool state — the single-laptop stand-in for "each on its own machine." No shared-checkout
  or shared-state collision.
- **Coherence held.** Every merge rebased + re-validated; `main` green throughout; conflicts
  followed D3, never a broken merge; no double-claim (`SKIP LOCKED`); the loop terminated.
- **Pass = the substrate coordinated genuinely concurrent, isolated, independent workers to a
  coherent `main`** — i.e. the same run would hold with the workers on N machines. Wall-clock is
  **recorded, not gating**. The retro notes it (and the assisted-vs-swarm split,
  [ADR 0021](../decisions/0021-v4-scope-the-swarm.md) § bootstrap) for interest, flagging that a
  single host bounds it.

## Scope: harness/driver-side, no substrate change expected

Everything M18 needs already exists in the substrate — race-free claims, the DAG,
escalation, reject. So M18 is a **driver + harness** change (pool launch, concurrent
termination detection, the integrator's rebase/revalidate/merge loop), like M14 and
M17. **If a design pressure here wants a migration, that's a signal to stop and
rethink** ([ADR 0003](../decisions/0003-two-plane-source-of-truth.md)) — the substrate
is the coordination layer, not the build harness.

## Slicing (build order within M18)

1. **Concurrent pool in the driver** — launch `LOOP_POOL_SIZE` cheap-implementer
   sweeps in parallel (backgrounded, each with its own `LOOP_SWEEP_ID`/worktree),
   alongside the single frontier + integrator. Generalize drain/termination detection
   to "board empty AND pool idle" (D4). `mock-harness.sh` proves it deterministically:
   a multi-task mock brief drains green with overlapping implementer activity in the
   event timeline.
2. **The merge queue** — the integrator's rebase + re-validate + conflict→reject loop
   (D2/D3), in the grok integrator skill; mock integrator exercises the FIFO drain and
   a synthetic conflict→reject path.
3. **The gate run** — a real multi-task feature through the pool (owner-assisted; the
   integrator is owner-launched). Judged by **concurrency correctness** (≥2 distinct
   workers active at once, isolated, coherent `main`), not wall-clock — see *Judging the
   gate* above. Record the observability evidence; note wall-clock only for interest.

Each slice ends green (`loop-selftest` with a multi-task mock brief + the existing
suite). One blog on merge: *"The swarm builds faster: parallel implementers and a
merge queue."*

## Open risks (honest)

- **Decomposition quality gates throughput.** If the designer emits a mostly-serial DAG
  (everything `depends_on` the previous), the pool can't fan out and M18 won't beat the
  serial baseline — through no fault of the loop. The gate brief must be genuinely
  parallelizable; a designer that produces poor DAGs is a *separate* follow-up
  (difficulty hints, [v3-plan](../plans/v3-plan.md) carry-over), not an M18 blocker.
- **Single reviewer/integrator backpressure.** If many tasks finish implementing at
  once, they queue at the single frontier reviewer. Acceptable for the gate (review is
  fast); if it dominates, a small reviewer pool is a cheap follow-up — but integration
  stays single (coherence).
- **Milestone-scale self-build is unproven.** The loop has shipped single small
  features hands-off (`version`, `ttl`); a multi-task feature is a bigger ask and may
  thrash or need resets. M18's slices 1–2 are built/verified deterministically (mock)
  so the *machinery* is trustworthy before slice 3 risks a real, larger brief.
