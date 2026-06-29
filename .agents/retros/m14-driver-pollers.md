# Retro — M14: the dumb driver + headless pollers

- Date: 2026-06-29
- PR: build/m14-driver-pollers
- Plan: [v3-plan.md](../plans/v3-plan.md) (M14)
- Implements: [ADR 0020](../decisions/0020-autonomous-run-topology.md) (run topology)

## What shipped

The run harness for the hands-off loop — the last build before the M15 gate. A new
`loop/` directory:

- **`driver.sh`** — the *dumb* driver. Hands the brief to a designer (one
  decomposition pass), launches the standing pollers, watches the `board` view
  (oversight token) until no non-terminal, non-blocked dev task remains, then stops
  the pollers and reports. It makes **no** routing/sequencing/escalation decision —
  its only knowledge is "which harness runs which role" and "is the board empty."
- **`poller.sh`** — one standing role poller: mint the role token, relaunch its
  harness for a sweep, sleep, repeat until the driver drops a `STOP` sentinel. A
  poller holds ≤1 task (one-task-per-instance), so a single cheap poller serializes
  the cheap implementer (ADR 0020 § serialized).
- **`roles.sh`** — the *only* place that maps role → harness + token features. Cast:
  `cheap-implementer` = opencode+qwen3.6 (default implementer); `frontier` =
  grok+grok-build (designer/reviewer/integrator + escalated `tier:2` implementer).
  The **integrator is a standing poller**, not a per-task invocation (ADR 0020).
- **`mock-harness.sh`** — a deterministic stand-in (`LOOP_MODE=mock`) honouring the
  same claim→act-per-stage→repeat contract as a real harness.
- Runs against the **isolated loop substrate** (M13), never the test substrate.
  `make loop-run BRIEF=…` (real, owner-invoked) and `make loop-selftest` (mock).

## The elegant bit

The driver and pollers are genuinely dumb — every coordination decision is read off
the substrate. Drain detection is just "count board rows where `not is_terminal and
not blocked`"; routing is the feature-superset match; escalation is M12's. The
harness contract turned out identical for every role and both harnesses: *self-claim,
act on the stage you got, repeat until empty* — which is exactly what each role skill
already says. So the mock harness is a faithful stand-in, not a special path.

## Done-tests

- **`make loop-selftest` green (exit 0).** A fresh loop substrate + the mock harness
  drove a brief to `done`: the feed shows three distinct agents — a designer
  (`proposed→designing→implementing`), the cheap implementer
  (`implementing→reviewing`), and the frontier
  (`reviewing→integrating→validating→done`) — with the integrator role merging as a
  standing poller, no per-task invocation. Board drained to a single `done` task; the
  driver detected it and stopped the pollers. Deterministic, ~3s, no LLMs.
- **Resilience** rides on already-tested lazy reclaim (ADR 0009; M5 + the M12 reclaim
  test): a dead poller's held task expires and is reclaimed on the next claim, and
  `poller.sh` retries a non-zero sweep. A real mid-run kill/restart is part of the
  assisted shakeout (below).

## Bootstrap honesty (ADR 0018)

The split this milestone makes explicit:

- **Deterministic plumbing (proven here):** driver + pollers + substrate drive a
  board to drain with zero human coordination — the mock self-test.
- **Real harnesses (owner-assisted, not done by me):** the actual grok + opencode
  pollers driving a real feature. Claude Code **cannot** run this — spawning `grok
  --always-approve` to perform the company-denied merge is blocked by the auto-mode
  guard (retro `m11-bootstrap`), and the integrator boundary must stay independent
  (ADR 0017). So `GROK_FRONTIER_CMD`/`OPENCODE_IMPLEMENTER_CMD` are thin shims the
  owner fills in; the real end-to-end run + mid-run kill is the **assisted shakeout**,
  the immediate precursor to the M15 unattended gate.

This is the same honest boundary as M11/M13: I build and deterministically verify the
coordination machinery; the owner runs the stochastic, egress-capable harnesses.

## Follow-ups

- **Assisted shakeout** (pre-M15): owner wires the two real harness commands and runs
  `make loop-run` on a throwaway brief, present, to shake out the grok/opencode
  invocation details; exercise a mid-run poller kill.
- **Frontier/cheap implementing race** (noted, benign): the real frontier token holds
  `role:implementer` (needed so an escalated `tier:2` task is claimable), so it is
  *also* eligible for non-escalated implementing tasks and could occasionally grab one
  before the cheap poller. Harmless (grok can implement) and escalation still routes
  correctly; if it ever matters, give the frontier implementer-hat its own poller with
  a claim cadence behind the cheap one.

**Blog:** "A driver that doesn't drive: starting the loop without conducting it."
