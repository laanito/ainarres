# Per-task workspace isolation: a clean room per task

> Design note for **M17** ([v4-plan](../plans/v4-plan.md) · [ADR 0021](../decisions/0021-v4-scope-the-swarm.md)).
> Settles M17's open questions before code. Harness/driver-side only — the
> substrate stays workspace-agnostic ([ADR 0003](../decisions/0003-two-plane-source-of-truth.md)).

## What M17 is for

M18 wants a *pool* of implementers working at once. Today every loop harness
(`loop/grok-frontier.sh`, `loop/opencode-implementer.sh`, and the designer/reviewer
sweeps the driver launches) does `cd "$REPO"` — **one shared checkout**. The v3
driver gets away with it only because it is *serialized*: one sweep at a time
([ADR 0020](../decisions/0020-autonomous-run-topology.md)). The moment two
implementers edit, commit, and switch branches in the same working tree
concurrently, they corrupt each other's branches. Isolation (M17) is therefore the
hard prerequisite for *any* concurrency — it gates everything in M18.

This is a **harness/driver concern, not a schema change.** The substrate already
coordinates the only thing it needs to: a task row with a stable id. Work product
lives in git ([ADR 0003](../decisions/0003-two-plane-source-of-truth.md)); *where*
in git a worker materializes its checkout is invisible to Postgres.

## The pivotal constraint: workers self-claim

The driver cannot create a workspace *before* launching a sweep, because it does not
know which task the sweep will get — workers **self-claim** off the queue
(`SELECT … FOR UPDATE SKIP LOCKED`, [ADR 0008](../decisions/0008-verb-contracts.md)),
and `SKIP LOCKED` is exactly what makes concurrent pulls race-free. So isolation
must happen **after the claim, inside the harness wrapper**: claim → enter a
workspace keyed to the task you got → work → advance → tear down. This preserves the
self-claim model instead of fighting it.

## Decisions (the open questions, settled)

**D1 — `git worktree`, not a container.** A worktree is a second working tree over
the *same* object store: `git worktree add` is fast (no clone, no re-fetch), cheap on
disk (shared objects), and native to the branch-per-task flow the shakeout already
uses. grok has first-class `--worktree`; the opencode wrapper gets the equivalent
with two `git` calls. Containers (a sealed per-task toolchain) are **deferred** —
they solve dependency isolation, which the loop does not yet need, at much higher
cost. Revisit only if a task's build pollutes a shared toolchain.

**D2 — Binding: task id → `.loop-worktrees/<task_id>` on branch `loop/<task_id>`.**
The task id is the one stable key both planes share, and `SKIP LOCKED` guarantees a
single holder per task — so keying the workspace on the task id alone is
collision-free *even across concurrent processes*, with no coordination and no new
substrate state. The wrapper derives both paths deterministically from the claimed
id; creation is **idempotent** (reuse an existing worktree for a reclaimed task, or
recreate it from base). `.loop-worktrees/` is gitignored.

**D3 — Lifecycle: create on claim, tear down on advance/release, GC the orphans.**
- *Create* when a worker claims a task at the **implementing** stage (the only stage
  that mutates a checkout — see scope below).
- *Tear down* when the worker advances or releases the task: the work is now captured
  on the pushed branch / PR, so the local worktree is disposable.
- *GC* defensively: a sweep (and the driver, between rounds) runs
  `git worktree prune` and removes any `.loop-worktrees/<id>` whose task is **terminal
  or absent** from the board. GC must be **concurrency-safe** — it removes only
  non-active worktrees, never one a live holder is using (the board's `claimed_by` +
  non-terminal stage is the liveness check, readable via M16's view).

**D4 — The substrate stays agnostic.** No migration, no `workspace` column, no new
verb. The task id (already returned by `claim`) is the entire contract. If the loop
vanished tomorrow the substrate would not know worktrees ever existed
([ADR 0003](../decisions/0003-two-plane-source-of-truth.md)).

**D5 — Stranded claims reclaim cleanly under isolation.** A killed worker leaves
(a) a claimed task and (b) a stale worktree. (a) is already handled: lazy reclaim
([ADR 0009](../decisions/0009-leases-reaper.md)) hands the task to the next claimer on
lease expiry, and the serialized driver's `release_stranded` releases it immediately
(bumping attempts → feeds M12 escalation). (b) is new and small: the next claimer of
that task id finds the stale worktree and **recreates it from base** (idempotent
create, D2); orphan GC (D3) sweeps any worktree whose task never comes back. No
lease logic changes.

## Scope: which stages get a worktree

Only **implementing** needs an isolated *mutating* checkout, so that is where M17
puts the worktree. The other roles don't collide on the working tree the same way:

- **designer** creates task rows (no code edit) — no worktree.
- **reviewer** reads a diff / the task's `loop/<task_id>` branch — a read, not a
  parallel mutation; it operates against that branch, no private worktree needed.
- **integrator** merges the task's branch to `main` — already serialized through one
  integrator (ADR 0020), and M18's merge queue keeps it serialized; it works against
  `loop/<task_id>`, not a shared dirty tree.

So M17's surface is: the implementer wrapper isolates per task; the branch name
`loop/<task_id>` becomes the hand-off contract that reviewer and integrator already
key on. (If M18 later finds a non-implementing stage mutating a shared tree, it gets
the same treatment — the mechanism is uniform.)

## Done-tests (from the plan)

- **Two implementers, two tasks, at once → two branches, no cross-contamination.**
  Each `loop/<id>` branch contains only its task's diff; neither working tree sees the
  other's uncommitted changes. (Exercised concurrently — this is the M18 precondition,
  but provable in M17 by launching two implementer wrappers against two ready tasks.)
- **Kill one mid-work → the other's workspace is intact**, and the killed task's
  worktree is recreatable by its next claimer; its task reclaims via the unchanged
  lazy/stranded path (D5).
- **No orphan accumulation across a run** — GC (D3) leaves `.loop-worktrees/` holding
  only worktrees for live, non-terminal claimed tasks; a drained board → empty dir.

## Slicing (build order within M17)

1. **A worktree helper** in `loop/` (e.g. `worktree.sh`): `enter <task_id>` (idempotent
   `git worktree add .loop-worktrees/<id> -b loop/<id> <base>` then `cd`), `teardown
   <task_id>`, `gc <board-json>` (prune + remove non-active). Pure-ish shell, unit-
   testable with a throwaway git repo + a fake board JSON.
2. **Wire the implementer wrappers** — `opencode-implementer.sh` (and grok's
   `--worktree` for its implementer hat) enter the worktree after claim, work there,
   tear down on advance/release. `mock-harness.sh` honors the same contract so
   `make loop-selftest` covers the isolated path deterministically.
3. **Driver GC hook** — `driver.sh` runs `worktree gc` between rounds and on exit
   (alongside the existing `stop_active` teardown), so a crashed run leaves no orphans.

Each slice ends green (a worktree-helper unit test on a scratch repo + `loop-selftest`
through the isolated path). Done = two real implementers build two tasks in parallel
with no contamination — the standing precondition M18 then turns into throughput.
One blog on merge: *"A clean room per task: isolating parallel implementers."*

## Deliberately out of scope (M17)

- **The implementer *pool* and the merge queue** — that is M18. M17 makes one isolated
  workspace correct; M18 runs many at once and serializes integration.
- **Containers / sealed toolchains** (D1), cross-machine workspaces, remote runners.
- **Any substrate change** — if a design pressure here wants a schema column, that is
  a signal to rethink, not to migrate (ADR 0003).
