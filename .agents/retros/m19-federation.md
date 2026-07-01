# Retro — M19: federation — frontier peers, none privileged (v4's last milestone)

- Date: 2026-07-01
- PRs: design #68, Slice A (claude peer + D4 gate) #69, Slice B brief #70, Slice C
  gate brief #72; retro this PR. Built-by-the-federated-swarm: #71 (Slice B — the
  federation report), #73/#74/#75 (Slice C — the gate feature).
- Plan: [v4-plan.md](../plans/v4-plan.md) (M19) · Design: [federation.md](../design/federation.md)
- Implements: [ADR 0021](../decisions/0021-v4-scope-the-swarm.md); preserves the
  independent-integrator boundary ([ADR 0017](../decisions/0017-context-clean-validation.md)).

## What shipped

Federation: the frontier roles stopped belonging to a single family. A second
**maker** — `claude` (Anthropic) — joined `grok` (xAI) as a co-equal frontier peer,
sharing the non-privileged roles, with **no peer holding a power another lacks**.
Bare-minimum-safe scope ([federation.md](../design/federation.md) D1): federate
**designer + reviewer**; the single, owner-invoked `grok` integrator stays the only
family that can merge. Federating *who may merge* is differential trust with no fair
signal yet — that is v5 governance, deliberately not here.

- **Two claude families, split by role** (D2): `claude-code+opus` (design judgment),
  `claude-code+sonnet` (review) — distinct families, the same split we run with
  `opencode+zen` / `opencode+qwen`. A headless `claude -p` poller
  (`loop/claude-frontier.sh`), owner-run, holding **no** `capability:integrate`.
- **Concurrent frontier peers** (`driver.sh::run_concurrent`, `roles.sh::LOOP_FRONTIER_PEERS`):
  grok + the claude reviewer sweep at once each round, so a `reviewing` task is claimed by
  whoever is free (`SKIP LOCKED` distributes across families). Integration stays single
  because only grok holds `capability:integrate` — review fans out, merge does not.
- **D4 create gate** (create-vs-advance): `create_task` now requires the **starter role**
  — the features that move a task out of its initial stage, derived from the workflow
  (dev → `role:designer`), not hardcoded per lane. A cheap implementer can no longer
  freelance-create work. The v3 anomaly closed by capability, not by prompt.
- **Federation observability** (Slice B, #71): the end-of-run report attributes each
  shipped task's stages to the acting family (`by family: implemented=… reviewed=…
  integrated=…`) and prints `cross-family review: N/M`. The instrument that makes the
  gate judgeable — built BY the swarm.

No new capability *mechanism* and one small migration (D4): roles are per-transition
`required_features` matched by superset, so federating a role is pure grant. The
substrate was, once again, already ready.

## The gate result (passed — cleanly beyond the bar)

Owner ran `make loop-run BRIEF=federation-gate-brief.txt` (a 3-way independent fan-out).
Mid-run, the live board caught the headline — **two makers reviewing at the same instant**:

```
active (2):
  - 019f1ebc-d25d… [reviewing] grok+grok-build       age=00:00:22
  - 019f1ebc-bc64… [reviewing] claude-code+sonnet     age=00:00:28
```

And the end-of-run report — printed by the formatter the swarm built one slice earlier —
returned the verdict:

```
shipped (3):
  - …d25d  PR#73  by family: implemented=opencode+big-pickle reviewed=grok+grok-build       integrated=grok+grok-build
  - …bc64  PR#74  by family: implemented=opencode+big-pickle reviewed=claude-code+sonnet     integrated=grok+grok-build
  - …e943  PR#75  by family: implemented=opencode+big-pickle reviewed=claude-code+sonnet     integrated=grok+grok-build
      cross-family review: 3/3 shipped tasks reviewed by a different family than implemented
```

**3/3 tasks reviewed by a different family than implemented them; two of the three
reviewed by `claude+sonnet` — cross-*maker* review** (Anthropic verifying opencode's
work), concurrent with grok, coordinated only through the substrate. All three merged to
a coherent `main` via the single grok integrator (#73/#74/#75), 16/16 green. No human
routing. **AINARRES built a real multi-task feature of itself, reviewed across makers, by
peers none of which was privileged.** The "different machines, networks, or universes"
north star stopped being a metaphor: the reviewers were different *models from different
companies*, sharing nothing but the board.

## The arc (two findings, both load-bearing)

1. **The opus designer was the risky piece — and it cleared on first contact.** Slice A
   put `claude+opus` on the decomposition critical path with no fallback (unlike the
   reviewer, where grok co-covers). The first real loop run (the Slice B build, #71)
   proved `claude -p --dangerously-skip-permissions` behaves as a headless designer:
   opus created the DAG and shepherded it to `implementing`, hands-off. The harness risk
   the design note flagged (§ Open risks) was mostly retired by that single run.
2. **A single-task run cannot exercise a review peer — federation needs fan-out to be
   *seen*.** The Slice B build was one cohesive task, so `grok` won the sole review via
   `SKIP LOCKED` and `sonnet` did nothing (0 events). That was not a failure — it is a
   topology fact: with one review and two concurrent reviewers, the faster claims it. The
   remedy was structural, not a knob: the Slice C gate brief is a **3-way fan-out**, so
   three reviews coexist and the peers *must* split them. That is exactly what pulled
   sonnet in (it reviewed 2 of 3). Lesson: to demonstrate a shared role, give the swarm
   more work than one peer can sweep in a pass.

## Bootstrap honesty (ADR 0021 § recursive)

- **Slice A (the machinery): built assisted** (Claude Code) — the claude poller, the
  federated cast, the D4 migration — verified deterministically on the mock (4 families,
  cross-family review shown) before any real run, because the cast + a substrate gate must
  be trustworthy first.
- **Slices B and C: built BY THE FEDERATED SWARM.** The federation *observability* (#71)
  and the gate *feature* (#73/#74/#75) were designed, implemented, reviewed (across
  makers), and merged by grok + claude + opencode, owner only starting the driver. The
  milestone that adds a maker was, fittingly, largely built by the makers.

## Two decisions that held up

- **Cross-family review is measured, not enforced** (D3). The report *shows* it (3/3);
  the substrate never *blocks* on it. This is what let the Slice B single-task run still
  drain (grok reviewed everything) instead of stalling for want of a claude reviewer — the
  M18 resilience property preserved. Enforcing cross-family review would have reintroduced
  a single point of failure.
- **Separation of duties was never the point** (owner's correction during design): the
  loop already had it (distinct subs per sweep). Federation's prize is **uncorrelated
  failure across families** — a claude reviewer catching what grok's blind spots miss —
  and that is a quality property, measured by the report, not a safety mechanism.

## Honest limits (carried forward)

- **The sonnet reviewer is proven, but shallowly** — two reviews in one run. Its judgment
  *quality* vs grok's (does cross-maker review actually catch more?) is not yet measured;
  that needs volume, and it is what a token-spend / outcome signal (see below) would feed.
- **Single-frontier integrate backpressure** persists (unchanged from M18): review now
  fans across makers, but merge stays single by design.
- **Still one laptop, owner-started.** Federation makes "different makers" real; "different
  machines/networks" is still simulated (per-sweep isolation). And a human still picks the
  brief and starts the driver.
- **Token spend per worker/step** was flagged (owner) as the next observability metric —
  stamp counts into `events.data`, aggregate per family, and it becomes the cost signal
  for prioritizing models. Measurement fits a report extension; *using* it to route is v5
  governance (same shape as revoking an underperformer, with a cost signal).

## What's next

M19 closes v4. **v4 — pipeline → swarm → federation — is complete**: M16 observability,
M17 isolation, M18 the concurrent-swarm headline gate, M19 federated cross-maker peers.
**Governance is v5** (owner's call): the report now produces the cross-family outcome
signal — who reviewed whom, who returned what — that v5 will *consume* to revoke or
weight families. It does not consume it yet. No revocation, no differential trust, this
version.

**Blog:** installment 5 — "Peers, not a boss: two makers on one board."
