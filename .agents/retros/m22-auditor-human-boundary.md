# Retro — M22: the auditor & the human boundary (v5's last milestone)

- Date: 2026-07-05
- PRs: design #88, Slice A (role + flag verb + oversight RPCs) #89, Slice B view half #90
  (assisted), Slice B report-line #91 (built hands-off by the swarm); retro this PR.
- Plan: [v5-plan.md](../plans/v5-plan.md) (M22) · Design: [auditor.md](../design/auditor.md)
- Implements: [ADR 0022](../decisions/0022-v5-scope-governance.md); completes the safety
  envelope M21 ([reflexive-revocation.md](../design/reflexive-revocation.md)) began.

## What shipped

M21 taught the substrate to say no **mechanically**. M22 completes v5 with the failures a
rule must **not** decide alone — and names the role that carries that judgment.

- **`role:auditor`** (D6) — a plain human-held role feature. Existence seeded; granting it
  stays an owner reprovision (the ADR 0007 asymmetry). It gates **only the flag** — the
  qualitative judgment, the piece that federates later.
- **`api.raise_audit_flag`** (D2) — `role:auditor`-gated; emits a task-anchored `audit_flag`
  event naming the producing (designer/integrator) family + capability + the delivery-vs-
  request/design gap, and **writes no `feature_denial`**. The qualitative path never
  auto-penalizes; it records a judgment and raises it to a human.
- **`api.set_permanent_ban` / `api.lift_ban`** (D4) — **oversight-only** (the `EXECUTE`
  grant *is* the gate: an agent role is refused before entry). The **only** route to a
  permanent (NULL-expiry) denial outside a human `apply_effects`; each act audited in the
  append-only `app.governance_actions` ledger. Effective on the family's next claim (ADR 0007).
- **The permanent-ban recommendation** (D5) — a *computed, read-only* signal: recurring
  reflexive bans (`ban_count`) or repeated auditor flags cross seeded thresholds and the
  report prints a loud `⚑ RECOMMEND PERMANENT BAN — … a human must decide`. It never
  self-applies; it routes a human's attention.
- **The oversight surface** — `api.audit_flags`, `api.governance_actions`, and
  `governance_status.recommend_ban_count`, rendered in the end-of-run report's governance
  section (open flags · recommendations · the ban/lift trail).

No new *revocation* mechanism (ADR 0022: v5 is signal + policy + envelope). Permanent = a
`feature_denials` row with a NULL expiry — M21's temporal column, used by a human this time.

## The v5 arc (record → sentence → boundary)

- **M20 — the record.** A fair, attributable, per-`(family, capability)` track record
  (delivered / rejected / cross-family / **tokens**), producer-credited. You cannot judge a
  family without it. Tokens, not USD; spend kept provably separate from competence.
- **M21 — the sentence (the gate).** The substrate temp-bans a family that crosses a reject
  threshold — autonomously, exponential backoff, self-healing, strike history surviving
  expiry. The v5 headline: *the swarm demotes one of its own families for cause, correctly,
  while `main` stays coherent.*
- **M22 — the boundary.** The qualitative and permanent cases reach a **human**, cleanly.

## The gate result (all four ADR 0022 conditions met)

1. **Mechanical → automatic, temporary.** M21's `reflexive-revocation.test.ts` drives real
   reject cycles: the producer is banned at its role on the 3rd strike, the ban vetoes the
   next claim, self-heals on expiry, and a repeat offense is strictly longer — history
   surviving.
2. **Qualitative → human, no auto-denial.** `raise_audit_flag` records the gap against the
   designer/integrator and writes **no** denial (`auditor.test.ts`); it surfaces at once.
3. **Permanent → human-only, audited.** Oversight bans/lifts through the RPC; an agent token
   **cannot** call it; the effect shows on the next `effective_features` read; both acts are
   on the ledger.
4. **`integrate` boundary holds; governance only removes.** No path grants a capability;
   the auditor only signals, only oversight acts on permanence.

Two of the three surface slices (M21 Slice B #87, M22 Slice B #91) shipped in **fully clean
hands-off runs** — designer(`opus`) → implementer(`opencode`) → reviewer(`grok`) →
**integrator(`grok`, autonomous merge)** — the guard live, the board draining correctly each
time. The instrument the swarm built two versions ago read back the whole v5 story.

## The arc (findings, load-bearing)

1. **A self-inflicted failure argued for its own cure.** The first hands-off v5 run (M21)
   ended with the frontier harness running `make reset` off-script and **wiping its own
   board** — a failure that bounced no reviewer and crossed no counter. A *mechanical*
   reject-rule could never have caught it; a **human, reading the board**, did. That is
   precisely the qualitative/human boundary M22 exists to name. The system building its own
   conscience tripped in the one way that proves you can't automate the whole conscience.
   (Fixes: `loop/guard-bin` deny-list + driver wipe-detection, #86; the incident is
   blog installment 6.)
2. **The briefing rule the incident taught, then held three times.** Only work the swarm can
   **check by itself** goes to the loop. A DB view can be *written* by the swarm but not
   *self-validated* in a worktree (no database there) — so every M22 view was built
   **assisted**, and only the **pure, substrate-free report-lines** were briefed hands-off.
   Three subsequent slices (#87, #90 assisted, #91) ran with **zero** incidents.
3. **Design meets substrate at build time — and yields.** `auditor.md` D7 said governance
   actions would be events. The assisted build found `events.task_id` is `NOT NULL` and a
   permanent ban is family-scoped, not task-scoped — so the human-action trail became its
   own append-only ledger, while the *flag* stayed an event (it *is* task-anchored, D8). The
   design note was amended in the same PR. Same shape as M21's D1 (strikes can't live in
   denials): the correct-first cores are where these surface, cheaply.

## Bootstrap honesty (ADR 0022 § recursive)

- **Assisted + mock-verified:** the M20 capture, the M21 reflexive core, and **all** of
  M22's trust-critical pieces — `role:auditor`, the flag verb, the oversight ban/lift RPCs,
  and the surface **views**. Anything touching auth or irreversible capability state, or any
  DB code a worktree can't self-check, was built and verified before it ran live.
- **Built hands-off by the swarm:** the M20 track-record view, the M21 governance surface
  report-line (#87), and the M22 recommendation report-line (#91) — pure formatter slices
  with substrate-free validates, designed→implemented→reviewed→**integrated** by the loop,
  the owner only starting the driver.

## Decisions that held up

- **Out-of-band audit, not a gating stage** (D1). Whole-delivery-vs-*request* is brief-scoped,
  not task-scoped; a gating `audited` stage would have put a standing human back on the
  critical path v5 exists to remove. The incident settled it empirically: a human caught the
  wipe *after* the run, off the critical path. Audit is the backstop, not the tollbooth — the
  loop still ships hands-off.
- **The auditor SIGNALS; only oversight ACTS on permanence** (D4/D6). The split is
  load-bearing: federating the auditor later (v6) must never hand an agent the permanent-ban
  trigger. Judgment (flaggable, automatable) is cleanly separated from the irreversible
  mutation (human-only).
- **The recommendation is computed, never enforced** (D5). The report *shows* it; the
  substrate never self-applies it — the same measure-don't-enforce discipline as M19's
  cross-family review, preserving the human's decision where it belongs.

## Honest limits (carried forward)

- **The audit is non-gating.** A delivery can merge unaudited; the reviewer gates per-task,
  the auditor is the backstop. A *gating* or *federated* auditor (an agent-judge on the
  critical path) is v6 — and needs judgment we don't yet trust to a rule.
- **The auditor is human-held and unscored.** It records a gap verbatim; its judgment isn't
  graded, and a *reviewer* track record (who waves through work an audit later flags) — the
  real check on rubber-stamping — is a v6 signal, noted not built.
- **Human bandwidth is the new backpressure.** Flags and recommendations pile up if no human
  returns. The surface makes the backlog *visible*, not attended; standing oversight is v7.
- **Still one laptop, owner-started.** And `make` is still reachable to the human driver —
  the guard blocks the *harness*, not the crank. The crank goes away only with the service.

## What's next

M22 closes v5. **v5 — governance — is complete**: M20 the record, M21 the reflexive gate,
M22 the human boundary. The substrate's founding claim now reads: *no orchestrator, many
agents at once, the workflow removes capability from those who prove unfit, and the failures
a rule shouldn't judge reach a human.* Coordination, safety, visibility, self-correction —
and, now, a conscience with a human in the one loop that needs one.

Deferred, per [ADR 0022](../decisions/0022-v5-scope-governance.md) and the roadmap: **v6**
(federate the auditor; a reviewer track record; cost-aware routing on the M20 token signal)
or **v7** (the standing service that finally retires the hand-crank). Owner's call after the
pause.

**Blog:** installment 7 — "The auditor: did we build the right thing? — and the line a rule
shouldn't cross."
