# Plan — AINARRES v5

> Scope and the gate are fixed by [ADR 0022](../decisions/0022-v5-scope-governance.md)
> (governance — reflexive capability revocation). Builds on the token-grant − DB-veto model
> ([ADR 0007](../decisions/0007-auth-identity-family-grant-deny.md)), reflexive governance
> ([ADR 0004](../decisions/0004-feature-model.md)), lazy substrate-side reclaim
> ([ADR 0009](../decisions/0009-leases-reaper.md)), and v4's enriched, family-attributed
> event log ([`design/governance.md`](../design/governance.md)). Each milestone is one
> PR-sized slice that ends green, then gets a blog article (continues the *AINARRES*
> series). Within-milestone loop is still **change → test → integrate → validate**.

## Objective

**The substrate polices itself.** Stop trusting every family forever. A family that proves
bad at a capability — an implementer whose diffs keep bouncing, an integrator producing
broken merges — loses that capability **temporarily and automatically**, with exponential
backoff, until it reforms or a human makes the loss permanent. A *qualitative* failure
("delivery doesn't meet the request/design") is caught by a newly-named **auditor** role
and **raised to a human**, not auto-actioned. Headline
is **self-correction**; the revocation *mechanism* already exists (ADR 0007), so v5 is
**signal + policy + safety envelope**.

## Success criterion ([ADR 0022](../decisions/0022-v5-scope-governance.md))

During a real run: a family crosses a reject threshold at a capability and the substrate
applies a **temporary** `feature_denial` that takes effect on its **next claim** and
**expires** on schedule; a **repeat** offense yields a **longer** ban (exponential backoff,
strike history surviving expiry); a **qualitative** failure is **escalated to a human** with
no automatic denial; `main` stays coherent and the M19 **`capability:integrate` boundary
holds** (governance may *remove* a capability, never *grant* `integrate`). Reached at
**M21**; **M22** completes the human boundary.

## Execution discipline

- **Branch → commit → push → PR** per milestone; owner reviews. Done = verified in the loop.
- **plpgsql only** ([ADR 0005](../decisions/0005-logic-language-escalation.md)); plain-SQL
  up/down migrations. The one real schema change is M21's temporal denial.
- **Signal/observability stays read-only, CLI-native** — over the event log + oversight
  views ([ADR 0009](../decisions/0009-leases-reaper.md)); no new infra.
- **Bootstrap discipline (aim: all of v5 built by the swarm).** The **trust-critical cores**
  — M21's revocation rule + backoff + effective-features change, M22's permanent-ban RPC —
  are built **assisted and mock-verified** before running live (a rule that strips
  capabilities must be correct first), exactly as M19 Slice A was. The **signal + surface**
  (M20 track record, cost capture, report/escalation views) are **swarm-built**. For
  gate-touching tasks the owner may **route the implementer role to a frontier family**
  (grok/opus) — a hand-run instance of the cost-vs-trust routing v5 formalizes; stated in
  each retro's assisted-vs-swarm split.
- One blog article per merged milestone (v5 arc opener: "the substrate learns to say no").

## Dependency order

```
M20 track record (signal + cost capture) ─▶ M21 reflexive temporary revocation ─▶ M22 the human boundary
```
M20 first — you cannot judge a family without a fair, attributable record, and the cost
signal is emitted-but-discarded today. M21 is the heart and the gate: the substrate applies
a bounded, reversible ban on its own. M22 completes the envelope: the hard/qualitative path
and permanent bans reach a human.

---

## M20 — Family track record: the signal governance consumes

**Goal:** a fair, attributable, per-family/per-capability record — the input a revocation
decision can stand on. ([ADR 0022](../decisions/0022-v5-scope-governance.md))

**Steps**
- **Capture cost** — stamp `total_cost_usd` + token counts from each harness result (already
  present in `loop/run/*.log`) into `events.data`; aggregate per family. The
  [[idea-token-spend-metric]] signal, finally recorded.
- **Track-record view** — a read-only view scoring each `(family, capability)`: reject rate,
  vacuous/empty-diff rate, validation pass/fail, cross-family review outcomes (reusing M19's
  `familyOfTransition`), cost-per-shipped-task. Attribution credits the **producing** family
  (who advanced *into* the stage that later bounced).
- **Report line** — the end-of-run report surfaces the track record (who's trending toward a
  ban, who's expensive-but-fine — kept distinct: cost ≠ incompetence).

**Done-tests**
- After a run, `events.data` carries per-step cost/tokens attributed to the acting family.
- The view reports reject/validation/cross-family/cost per `(family, capability)`, matching a
  hand-audit of the timeline; a family that never worked a capability shows no phantom score.
- Cost and failure are reported as **separate** signals (an expensive-but-passing family is
  not flagged for governance).

**Blog:** "A track record per family: the signal before the sentence."

## M21 — Reflexive temporary revocation (the heart, the gate)

**Goal:** the substrate temp-bans a family that crosses a reject threshold at a capability —
autonomously, with exponential backoff, self-healing — while permanent stays human.
([ADR 0022](../decisions/0022-v5-scope-governance.md))

**Steps**
- **Temporal denial** — add `feature_denials.expires_at` (NULL = permanent); a persistent
  **strike ledger** per `(family, capability)` that **survives** a denial's expiry (no shed
  by waiting out).
- **Self-heal** — `effective_features()` ignores denials where `expires_at <= now()`
  (instant-veto semantics preserved — ADR 0007).
- **The reflexive rule (substrate-side, no agent)** — on `reject_task`, attribute the reject
  to the producing family (`familyOfTransition`); if it crosses the threshold, insert a
  **temporary** denial for that capability with duration `base · 2^(strikes−1)` (capped).
- **Resolution knobs** — threshold + backoff base/cap resolve **capability → workflow →
  system default**, seeded (the lease/max-attempts pattern), not hardcoded.
- **Singleton behaves right (D4)** — the uniform rule applied to `capability:integrate`
  (a singleton) *halts* integration until a human acts; make that **loud** in the report /
  oversight view (not a silent stall).

**Done-tests / success gate**
- A family crossing the threshold in a real run is **temporarily denied** the capability; the
  denial **applies on its next claim** and is **gone after expiry** (verified via effective
  features + a re-claim).
- A **repeat** offense produces a **strictly longer** ban; the strike count reflects history
  that outlived the earlier expiry.
- For a **federated** capability the ban **routes around** the offender (M18 resilience
  preserved); for the **singleton** integrator it **surfaces to the human**, unmistakably.
- Governance **never grants** a capability; the M19 integrator boundary holds; `main`
  coherent. Down-migration restores the permanent-only `feature_denials`.

**Blog:** "The substrate learns to say no: temporary bans with backoff."

## M22 — The auditor role & the human boundary

**Goal:** name the auditor (validate delivery vs request + design; flag designer +
integrator), and route the failures a rule shouldn't decide to a human, cleanly.
([ADR 0022](../decisions/0022-v5-scope-governance.md), design D6)

**Steps**
- **The auditor role** — a `role:auditor` feature; the auditor validates the **whole
  delivery against the original request + the design** (distinct from the reviewer's
  per-task diff check) and may **flag the designer / integrator**. Human-held this version;
  federatable later (v6). Settle its **placement**: a new dev-workflow stage
  (`validating→audited→done`) vs. an out-of-band oversight audit of the shipped feature.
- **Qualitative escalation** — an auditor flag ("delivery does not meet request/design") is
  recorded as an escalation event surfaced immediately in the oversight view + report, with
  **no** automatic denial (first-iteration policy), attributed to the flagged designer /
  integrator family.
- **Permanent-ban signal** — a family whose temporary bans keep recurring (M21) or that an
  auditor repeatedly flags raises a **permanent-ban recommendation** to the human (does not
  self-apply).
- **Owner RPC** — an `oversight`-role RPC to **make a ban permanent** (`apply_effects` with
  NULL expiry) or **lift** a ban; audited as an event.

**Done-tests**
- An auditor flag against a designer/integrator appears in the oversight surface with **no**
  `feature_denial` written; it names the flagged family + the request/design gap.
- A recurring offender produces a permanent-ban recommendation the human can act on; the RPC
  applies/lifts and the effect shows on the next claim; the action is audited.
- Only the `oversight` role may call the RPC; an agent token cannot. `role:auditor` gates the
  flag action; a non-auditor cannot flag.

**Blog:** "The auditor: did we build the right thing? — and the line a rule shouldn't cross."

---

## Open questions (settle within each milestone's design note)

- **M20:** exact score shape and window (rolling N runs vs. time window); keeping cost and
  competence provably separate; where the cost stamp is written (driver vs. verb).
- **M21:** seed values for threshold + backoff base/cap; window semantics (consecutive vs.
  within-window rejects); whether a lifted/expired ban's strike decays over time; making the
  singleton-halt loud without false alarms.
- **M22:** the auditor's **placement** (new `audited` stage vs. out-of-band oversight audit);
  what precisely constitutes an auditor flag vs. a reviewer reject; the permanent-ban
  recommendation trigger; audit shape for human governance actions.

## Deferred to v6+

- **Automated / federated auditing** — an agent-judge scoring delivery-vs-request-and-design,
  and *federating* the auditor across makers (the M19 move applied to audit); catching
  rubber-stamp reviewers (a reviewer track record: who approves work that later bounces).
- **Cost-aware routing** — using the M20 cost signal to *pick* a family per task
  ([[idea-token-spend-metric]]); v5 measures, v6 routes.
- **Cross-substrate / cross-org sybil & attestation** — family identity beyond one
  substrate.
- **Always-on daemons / horizontal scale** — unchanged; still owner-started, single instance.
