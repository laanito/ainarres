# ADR 0019 — Dynamic capability escalation (cheap → frontier, on failure)

- Status: Accepted
- Date: 2026-06-27
- Builds on: [0009](0009-leases-reaper.md) (`attempts`, `max_attempts`, lazy reclaim,
  `release_task`), [0004](0004-feature-model.md)/[0007](0007-auth-identity-family-grant-deny.md)
  (features, `required_features`, superset matching), [0008](0008-verb-contracts.md) (verbs)
- Decides: how a task a cheap worker can't finish is automatically routed to a frontier one

## Context

v2's bootstrap showed capability routing works — but the *escalation* was manual: a human
noticed `opencode+qwen3.6` stall on a task, `release`d it, and re-routed it to a frontier
implementer by hand (retro `m11-bootstrap`, finding #1). A hands-off loop
([0018](0018-v3-scope-autonomous-loop.md)) cannot have a human watching for stalls. The
substrate itself must escalate.

The owner chose **dynamic, attempts-based** escalation over designer-tagged-upfront: react
to *real* failure rather than predict difficulty. One cheap attempt is "wasted" first — but
that attempt is cheap, and reacting to reality beats mis-prediction.

## Decision

### A task that keeps failing is raised to require a frontier tier

- **Tier as a feature.** `capability:frontier` is a feature in the existing model
  ([0004](0004-feature-model.md)) — no new feature *kind*. Frontier-capable families hold it
  (`grok+grok-build`, `claude-code+opus`); the cheap worker (`opencode+qwen3.6`) does not.
  Being "frontier" is just another capability a family has.
- **Escalation = adding `capability:frontier` to the task's `required_features`.** Once
  added, the existing eligibility check (`eff @> t.required_features`) excludes every family
  without it. The cheap worker can no longer claim the task; a frontier family can. **Zero
  new matching logic** — escalation rides the feature superset that already gates everything.
- **Trigger: `attempts` crossing a data-driven threshold.** A nullable
  `stages.escalate_after int` → `workflows.default_escalate_after` → system default (1).
  `attempts` is already bumped on every `release_task` and every lazy reclaim
  ([0009](0009-leases-reaper.md)). A shared helper `app.maybe_escalate(task)` runs at both
  those points: when `attempts >= escalate_after` and the task does **not** already require
  `capability:frontier`, it adds the feature and writes an `escalated` event (the audit
  trail). Idempotent (never added twice).
- **Ordering vs. poison-block.** `escalate_after < max_attempts`. So the lifecycle is:
  cheap attempt(s) → **escalate** at `escalate_after` → frontier attempt(s) → auto-`block`
  at `max_attempts` if even the frontier family can't finish ([0009](0009-leases-reaper.md)
  unchanged). Defaults: `escalate_after = 1`, `max_attempts = 3` — one cheap try, then
  frontier, then a human if frontier also fails twice.

### What escalation is *not*

It **adds a requirement to a task**; it does **not revoke a feature from a family**. The
latter is reflexive **governance** ([0004](0004-feature-model.md)), still dormant and a v4
concern. Escalation is per-task and additive; governance is per-family and subtractive. They
share the feature model but are different policies.

### Behaviour when no frontier agent is available

If escalation adds `capability:frontier` and no frontier family is currently polling, the
task simply waits — correctly. `claim_next_task` returns it to nobody until a capable agent
asks. No new state; the lazy model already expresses "waiting for a capable claimer."

## Alternatives considered

- **Designer-tags difficulty upfront** (route by tier at create). Rejected as the mechanism:
  mis-prediction sends easy work to the expensive model or hard work to one that'll stall;
  the owner chose reacting to real failure. (A designer *hint* could be layered later, but
  the attempts-based path is the load-bearing, self-correcting one.)
- **A dedicated `tier` column / new feature kind.** Rejected: `capability:frontier` reuses
  the feature vocabulary and the superset check with no schema churn in the matching path.
- **Escalate by mutating the transition's `required_features`.** Rejected: transitions are
  shared flow definition; per-task `required_features` (task extras) is exactly the
  per-task knob the model provides ([0006](0006-task-identity-events-artifacts.md)).

## Consequences

- Model additions: `stages.escalate_after int?`, `workflows.default_escalate_after int`; a
  `capability:frontier` feature granted to frontier families; `app.maybe_escalate()` called
  from `release_task` and the reclaim branch of `claim_next_task`; an `escalated` event type.
- A cheap worker stalling now self-heals into a frontier attempt with **no human in the
  loop** — the missing piece for [0018](0018-v3-scope-autonomous-loop.md)'s gate.
- Built in M12 ([`plans/v3-plan.md`](../plans/v3-plan.md)); the seed grants the tier feature
  and sets `escalate_after` on the dev workflow's `implementing` stage.

## Amendment (M12, as built — per roadmap #29)

Refined while building, to be forward-compatible with the graduated-tiers roadmap (#29):

- **Ordered tier feature, not a lone boolean.** Instead of `capability:frontier`, the tier
  is a new feature **kind `tier`** with an ordinal key — v3 ships `tier:2` (the frontier
  rung; base work needs no tier feature = implicit tier 1). `maybe_escalate` rewrites a
  task's `required_features` to require the **next** tier up. Adding `tier:3`, `tier:4`… is
  additive seed data; the helper escalates to whatever the next existing tier is.
- **Ordering rides the existing superset match — no new mechanism.** This resolves the
  concern in #29 ("set-superset can't express ≥ N"): with families holding the tier(s) they
  are capable of, *"requires tier:N"* is satisfied by the ordinary `eff @> required_features`
  check. No numeric `>=` dimension was added; the feature model is untouched.
- **Escalation is OPT-IN.** `escalate_after` (stage → workflow) defaults to **NULL = never
  escalate**, so existing workflows are unaffected. (An earlier draft used a system default
  of 1, which — with `tier:2` seeded globally — made *every* workflow escalate after one
  release and broke the m4/recovery tests. Opt-in is the fix.) Only the dev `implementing`
  stage sets it (`escalate_after = 1`).
- **The frontier implementer rung is `grok+grok-build`** (`role:implementer` + `tier:2`),
  reusing the independent integrator family. Free frontier-scale models (e.g.
  `nemotron-3-ultra`) can join the rung later with a one-line `tier:2` grant.
