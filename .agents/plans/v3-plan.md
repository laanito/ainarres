# Plan — AINARRES v3

> Scope and the gate are fixed by [ADR 0018](../decisions/0018-v3-scope-autonomous-loop.md);
> the net-new mechanism by [ADR 0019](../decisions/0019-capability-escalation.md) (dynamic
> escalation) and the run model by [ADR 0020](../decisions/0020-autonomous-run-topology.md)
> (independent pollers, dumb driver, isolated substrate). Each milestone is one PR-sized
> slice that ends green, then gets a blog article. Within-milestone loop is still
> **change → test → integrate → validate**.

## Objective

**Remove the conductor.** Make AINARRES's own development run *hands-off*: the owner starts
a loop and walks away; agents self-organize through the substrate, a stalled cheap worker is
escalated to a frontier one automatically, and a real feature reaches `main` with no human
sequencing, re-routing, or remediation. Federation (many frontier peers) is **v4**.

## Success criterion ([ADR 0018](../decisions/0018-v3-scope-autonomous-loop.md))

The owner starts the driver against a feature brief and does not intervene; a real feature is
decomposed, implemented (with at least one **automatic** cheap→frontier escalation exercised),
reviewed, **integrated to a real merged PR on `main`**, and validated — entirely by
independent pollers, with no human in the loop. Reached at **M15**.

## Execution discipline

- **Branch → commit → push → PR** per milestone; owner reviews. Done = verified in the loop.
- **plpgsql only** ([ADR 0005](../decisions/0005-logic-language-escalation.md)); plain-SQL
  up/down migrations; single-instance.
- **Bootstrap discipline ([ADR 0018](../decisions/0018-v3-scope-autonomous-loop.md)):**
  M12–M14 are built *on* AINARRES, **assisted** (the v2 loop), since the autonomous loop
  can't exist before its mechanism does. **M15 flips to fully autonomous.** Each retro states
  the assisted-vs-hands-off split.
- One blog article per merged milestone (continues the *AINARRES* series; the v3 arc opener
  is "removing the conductor").

## Dependency order

```
M12 escalation ─▶ M13 substrate isolation ─▶ M14 driver + headless pollers ─▶ M15 hands-off gate
```
M12 is the new substrate mechanism; M13 makes unattended runs safe; M14 builds the run
harness; M15 needs all three.

---

## M12 — Dynamic capability escalation

**Goal:** a task a cheap family keeps failing auto-routes to a frontier family.
([ADR 0019](../decisions/0019-capability-escalation.md))

**Steps**
- Migration: `stages.escalate_after int?` + `workflows.default_escalate_after int` (system
  default 1); `app.resolve_escalate_after(stage)` (stage → workflow → system, mirrors
  `resolve_max_attempts`).
- `app.maybe_escalate(task)`: when `attempts >= escalate_after` and the task doesn't already
  require `capability:frontier`, append it to `required_features` and write an `escalated`
  event. Idempotent. Call it from `release_task` and from the reclaim branch of
  `claim_next_task` (after `attempts++`, before the poison-block check;
  `escalate_after < max_attempts`).
- Seed: `capability:frontier` feature granted to frontier families (`grok+grok-build`,
  `claude-code+opus`), **not** to `opencode+qwen3.6`; set `escalate_after = 1` on the
  `ainarres-dev` `implementing` stage.

**Done-tests**
- A task released (or reclaimed) at the threshold gains `capability:frontier` in
  `required_features` and an `escalated` event; a second release does not duplicate it.
- After escalation, the cheap family's `claim` no longer returns it (`empty`); a
  frontier-feature token does. Below threshold, no escalation. At `max_attempts`, still
  auto-blocks (unchanged). Down-migration reverts cleanly.

**Blog:** "When a small model gives up: automatic escalation."

## M13 — Substrate isolation (pollution-proofing)

**Goal:** an unattended run can't corrupt shared state — no human remediation.
([ADR 0020](../decisions/0020-autonomous-run-topology.md) § pollution-proofing)

**Steps**
- A dedicated compose project/DB for the autonomous loop, separate from the test substrate
  (own project name + port; documented `make` target or env). Not scaling — isolation.
- Confirm/lock the **substrate-free validate** convention in the role skills (carried from
  v2); add a guard or doc so a per-task `validate` never invokes the full suite against the
  live dev substrate.
- A short operability doc: how to bring up the loop substrate vs. the test substrate.

**Done-tests**
- The loop substrate and the test substrate run simultaneously without cross-contamination
  (a `make reset`/full suite on one leaves the other's `dev` lane untouched).
- A simulated agent running its task `validate` does not create or block tasks in the loop's
  `dev` lane.

**Blog:** "Two substrates: keeping the swarm's world clean."

## M14 — The dumb driver + headless pollers

**Goal:** the run harness — independent role pollers and an owner-started driver that only
starts and detects done. ([ADR 0020](../decisions/0020-autonomous-run-topology.md))

**Steps**
- Wire the role pollers **headless**: grok (`--output-format json`, `always-approve`,
  Claude-compatible skills) for designer/reviewer/integrator/escalated-implementer;
  `opencode + qwen3.6` for the cheap implementer. Each loops claim→work→advance until `empty`.
- The **integrator as a standing poller** (continuous claim of `integrating` tasks), not a
  per-task invocation.
- A **dumb driver** script: takes a feature brief, hands it to a designer poller, runs the
  pollers until the `dev` board drains, then stops. **No routing/sequencing logic** — it only
  launches pollers and checks for an empty board.
- Run it **assisted** end-to-end on a throwaway feature (owner present, ready to intervene) to
  shake out wiring before M15's unattended run.

**Done-tests**
- The driver, started on a throwaway brief, drives a feature to `done` through the pollers
  with the owner only watching; the integrator poller merges without per-task invocation.
- Killing/restarting a poller mid-run is recovered by lazy reclaim ([ADR 0009](../decisions/0009-leases-reaper.md))
  — the loop is resilient, not brittle.

**Blog:** "A driver that doesn't drive: starting the loop without conducting it."

## M15 — Hands-off bootstrap (success gate)

**Goal:** prove [ADR 0018](../decisions/0018-v3-scope-autonomous-loop.md) — a feature ships
with no conductor.

**Steps**
- Pick a small, real AINARRES feature with a clean substrate-free validate (e.g. an `ainarres`
  CLI enhancement). Owner gives the brief to the driver and **leaves**.
- The loop decomposes, implements, **exercises at least one automatic escalation** (seed a
  task the cheap model will stall on, or let it happen naturally), reviews, integrates to a
  real merged PR on `main`, validates → `done`.
- Orchestrator (Claude) is **absent** during the run; the owner does not sequence, re-route,
  or remediate.

**Done-tests / success gate**
- A real feature reaches `main` via a merged PR, built by the hands-off loop, with the board
  showing the journey including an `escalated` event.
- The run log shows zero human coordination interventions; the only human act was starting the
  driver with a brief.
- Retro records the assisted-vs-hands-off split honestly (M15 = fully hands-off).

**Blog:** "AINARRES builds AINARRES, unattended."

---

## Open follow-ups (post-v3, → v4)

- **Federation** — several frontier models forming workgroups as peers (the v4 thesis), now
  on a proven autonomous single-director loop.
- **Parallel workers** — per-task `git worktree` isolation (grok has native `--worktree`) for
  concurrent implementers.
- **Always-on daemons** — role pollers as long-running services instead of a driver session.
- **Governance** — workflow-driven feature *revocation* (distinct from M12's additive
  escalation), [ADR 0004](../decisions/0004-feature-model.md).
- **Designer difficulty hints** — an upfront tier hint layered over M12's attempts-based
  escalation, if mis-routing proves costly.
