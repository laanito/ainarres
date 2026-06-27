# ADR 0020 — Autonomous run topology: independent pollers, a dumb driver, isolated substrate

- Status: Accepted
- Date: 2026-06-27
- Builds on: [0018](0018-v3-scope-autonomous-loop.md) (hands-off gate),
  [0017](0017-context-clean-validation.md) (independent integrator, skill-only agents),
  [0019](0019-capability-escalation.md) (auto-escalation), [0001](0001-data-driven-state-machine.md)
  (no orchestrator), [0009](0009-leases-reaper.md) (lazy recovery)
- Decides: how the loop actually runs with no conductor, and how it stays uncorrupted

## Context

[0018](0018-v3-scope-autonomous-loop.md) sets the gate (a feature ships with no human
conductor). This ADR fixes the *run model* — who runs the agents, how the loop is started
and detects "done," and how an unattended run avoids the two things the conductor did by
hand in v2: re-routing stalls (solved by [0019](0019-capability-escalation.md)) and
**remediating corrupted shared state** between steps.

## Decision

### Roles are independent, headless pollers — the orchestrator is not in the loop

Each role runs as a **headless agent process**, started by the owner's driver, **not spawned
by any orchestrator** (Claude Code can't launch the merge anyway — the auto-mode guard,
retro `m11-bootstrap` — and removing the conductor is the whole point). Each poller runs the
verb loop from its published skill ([0017](0017-context-clean-validation.md)): *claim →
work → advance, repeat until `claim` returns `empty`.*

Cast for v3 (two harnesses; Claude Code absent during the run):

| Role(s) | Harness / family | Tier |
|---|---|---|
| implementer (default) | `opencode + qwen3.6` | cheap |
| designer, reviewer, integrator, **escalated** implementer | `grok` (`grok-build`) family | frontier (`capability:frontier`) |

When [0019](0019-capability-escalation.md) escalates an implementing task, the cheap poller
is no longer eligible and the grok poller picks it up — automatically.

### A *dumb* driver starts the loop and detects completion — nothing more

The owner starts a small **driver** (a shell script in the repo) with a **feature brief** —
the single human input (the "what to solve", per the vision; not coordination). The driver:

1. hands the brief to a **designer** poller (which decomposes it into `dev`-lane tasks), then
2. keeps the role pollers running until the board **drains** (no non-terminal `dev` tasks
   left), then stops.

**The driver must stay dumb.** It launches pollers and detects done; it makes **no** routing,
sequencing, or escalation decisions — those live in the substrate
([0001](0001-data-driven-state-machine.md), [0019](0019-capability-escalation.md)). A driver
that started deciding *which* task goes *where* would be the orchestrator we are removing.
Its only knowledge is "which harness runs which role" and "is the board empty yet."

### The integrator is a standing poller, not a per-task invocation

In v2 the owner invoked grok once per integrate task. In v3 the grok integrator runs as a
**standing loop** claiming `integrating` tasks and merging until none remain — same as every
other role. (It still runs on grok, owner-started, outside the orchestrator — the
independent-integration boundary from [0017](0017-context-clean-validation.md) is unchanged;
only the cadence becomes continuous.)

### Pollution-proofing: the loop runs on its own substrate

The v2 incident — a per-task `validate` running the full suite against the *shared* `dev`
substrate, injecting test fixtures into the live lane and blocking real tasks (retro
`m11-bootstrap`) — must not recur unattended. Two layers:

1. **Validates are substrate-free** (already enforced in the role skills, v2): a per-task
   `validate` is a targeted unit check / `node --check`, never the whole suite.
2. **The autonomous loop runs against a dedicated AINARRES instance**, separate from the one
   the test suite uses (its own compose project + DB; not "scaling" — just isolation). Any
   full-suite regression at the `validating` stage runs on a clean throwaway, never the live
   dev substrate.

Together: an unattended run cannot corrupt itself, so no human remediation is needed.

### Serialized for v3

One worker at a time (a single cheap-implementer poller; the grok poller covers the frontier
roles). The substrate's one-task-per-instance rule ([0008](0008-verb-contracts.md)) plus a
single cheap poller naturally serialize. Parallel workers + `git worktree` isolation are a
later slice ([0018](0018-v3-scope-autonomous-loop.md)).

## Alternatives considered

- **Each role as a long-running daemon (systemd/cron) polling forever.** Cleaner "always-on"
  story, but more infra than a first hands-off proof needs; the owner-started driver is the
  smaller step. Daemonizing is a natural follow-up.
- **Orchestrator (Claude) drives the loop.** Impossible by construction (can't perform the
  merge; can't launder it) and contrary to the goal — the orchestrator's absence *is* the
  result we're proving.
- **One shared substrate for tests + the loop** (with careful parking). Rejected: that's the
  manual remediation we're removing; isolation is cheaper to reason about than discipline.

## Consequences

- New artifact: a dumb driver script (M14) + the grok role pollers wired headless
  (`--output-format json`, `always-approve`; Claude-compatible skills already work on grok).
- A second, dedicated compose project/DB for the autonomous loop (M13).
- The run model has **no component that coordinates** — coordination is entirely the
  substrate's; the driver only starts and stops. That keeps "no orchestrator" literally true
  even as the loop becomes hands-off.
- M15 runs it for real: owner starts the driver, leaves, a feature reaches `main`.
