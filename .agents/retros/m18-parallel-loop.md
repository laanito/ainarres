# Retro — M18: parallel implementers + merge queue (the headline gate)

- Date: 2026-07-01
- PRs: design #55, slices 1+2 #56, opencode-isolation fix #60, gate reframe #61,
  fresh gate brief #62; gate-run output below. Built-by-swarm: #57/#58/#59 (run 1),
  #63/#64/#65 (run 2 — the passing gate).
- Plan: [v4-plan.md](../plans/v4-plan.md) (M18) · Design: [parallel-loop.md](../design/parallel-loop.md)
- Implements: [ADR 0021](../decisions/0021-v4-scope-the-swarm.md) (+ its 2026-06-30 amendment)

## What shipped

The v4 headline: the loop stopped running one implementer at a time and became a
**swarm**. A concurrent pool of cheap implementers fans out across the designer's
independent-where-possible DAG; a single integrator serializes merges as a **merge
queue** (rebase on latest `main` + re-validate before each merge); the run stays
observable (M16) and isolated per worker (M17). Driver/harness-side only — **no
substrate migration** (the substrate has been race-free since `SKIP LOCKED` in M3).

- **Concurrent pool** (`driver.sh::run_pool`, `roles.sh::LOOP_POOL_TIER`): each round
  launches `LOOP_POOL_SIZE` (default 3) cheap-implementer sweeps at once, each in its
  own M17 worktree + (the fix below) its own opencode state. Serial tiers (fallback,
  frontier) run after; integration stays single. Termination generalized to "board
  empty AND pool idle" (D4).
- **Merge queue** = the single integrator, FIFO over `integrating`, rebase + re-validate
  before merge, conflict/post-rebase-fail → reject-to-implementing (D2/D3). The dev
  workflow already permitted `reject: integrating→implementing` — no migration.
- Deterministic proof: `make loop-selftest` (3 independent mock tasks drain green via 3
  concurrent pool processes) + `LOOP_MOCK_CONFLICT=1` (conflict→reject→re-merge drains).

## The gate result (passed — on the reframed terms)

The gate is **concurrency correctness, not wall-clock** ([ADR 0021](../decisions/0021-v4-scope-the-swarm.md)
§ Amendment). The owner ran `make loop-run BRIEF=parallel-gate-brief-2.txt` (real grok +
opencode, owner-invoked) and the live board showed the thing every prior run lacked:

```
active (3):
  - 019f1a83-e5e2… [implementing] opencode+big-pickle age=00:00:23
  - 019f1a84-089e… [implementing] opencode+big-pickle age=00:00:20
  - 019f1a83-f855… [implementing] opencode+big-pickle age=00:00:22
```

**Three distinct workers holding three distinct tasks simultaneously** (claims within
~3s), each in its own checkout + tool state, coordinating only through the substrate —
the single-laptop faithful mock of "three workers on three machines." All three reached
`main` via the merge queue (PRs #63/#64/#65), `main` green, board drained, exit 0. The
swarm built a real multi-task AINARRES feature, hands-off. **AINARRES built AINARRES,
concurrently.**

## The arc that made it real (two findings, both load-bearing)

1. **The first gate run collapsed on opencode's shared state.** It shipped 3 tasks and
   drained green, but the event trail showed **one** implementer sub doing all three
   *serially* and the pool logs showed `Error: … database is locked`. Root cause:
   opencode keeps its session SQLite at `~/.local/share/opencode/opencode.db`; three
   concurrent opencode processes collide on it, so two died and one survived. The
   substrate, the worktrees, and the merge queue were all correct — the harness wasn't
   isolated enough. Fix (#60): a private `XDG_DATA_HOME` per sweep (own `opencode.db`)
   with the shared `auth.json` symlinked in — **the harness analog of M17's git
   worktree**. Lesson restated: isolating each worker's checkout *and tool state* is
   how you simulate, on one box, what separate machines get for free.
2. **The gate is correctness, not a stopwatch** (owner steer, #61). On a single laptop,
   parallelism is capped by shared CPU, a free-API backend that serializes calls, and
   per-tool state — none of which the substrate controls. The north star is
   *location-independent* coordination, so wall-clock here measures the mock's overhead,
   not the swarm. The gate became: ≥2 genuinely concurrent isolated workers → coherent
   `main`. Sharper, not looser — and it's the property that generalizes to M19.

## The live resilience event (unplanned, the best evidence)

During a run, a cheap worker hung on a real provider failure — the free Nvidia API's
`ResourceExhausted: Worker local total request limit reached (82/32)`. The owner killed
the stuck process; the substrate **released the stranded claim** (`release_stranded`,
attempts→1) and a **co-eligible peer (grok, which also holds `role:implementer`) claimed
and finished the task** — no human re-routing. Note: this was the **reclaim** path
([ADR 0009](../decisions/0009-leases-reaper.md)), *not* M12 escalation (attempts stayed
below `escalate_after=2`); and in a fully unattended run the kill is unnecessary — the
~10-min `implementing` lease would expire and lazy reclaim would do the same. **A worker
can die mid-task and the work still lands.** Failure made structurally harmless, live,
captured legibly in the M16 timeline.

## Bootstrap honesty (ADR 0021 § recursive)

- **Slices 1–2 (the machinery): built assisted** (by Claude Code), verified
  deterministically via the mock — Claude Code can't spawn `grok --always-approve`, and
  the machinery must be trustworthy before a real run.
- **Slice 3 (the gate): executed BY THE SWARM** — a real 3-task feature designed,
  implemented (concurrently), reviewed, and merged by grok + opencode with the owner only
  starting the driver. This *is* the milestone-scale self-build the project has been
  climbing toward: not one small feature serially (v3's `ttl`), but a multi-task feature
  built by independent agents at once.

## Honest limits (carried forward)

- **Single frontier backpressure:** review + integrate + validate run serially through
  one grok with real git/gh; with trivial tasks that dominates the (un-gated) wall-clock.
  Fine for the gate; a **reviewer pool** is the clean follow-up if it ever bites
  (integration must stay single for coherence).
- **Free-API flakiness** is now a known operational fact (the Nvidia 502); the reclaim +
  co-eligible-peer path absorbs it, but it caps single-host throughput.
- **Gate briefs are single-use** (#62): each run ships to `main`, so a re-run needs a
  fresh brief — the owner caught the original being already-built.
- **The human kill** accelerated lease-expiry; a truly unattended run self-heals via the
  lease. Worth a dedicated unattended-resilience test later.

## What's next

M18 closes the v4 gate. **M19 — federation** (≥2 frontier peers sharing the
non-implementer roles, none privileged; create-vs-advance boundary by capability) is the
remaining v4 milestone, and the "different machines, networks, or universes" north star
points straight at it. Governance stays v5.

**Blog:** "The swarm builds faster" → reframed to *the swarm story*: concurrency proven,
and a worker dying mid-task while the work still lands.
