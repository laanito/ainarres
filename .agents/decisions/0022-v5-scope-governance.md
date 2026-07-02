# ADR 0022 — v5 scope: governance (reflexive capability revocation)

- Status: Accepted
- Date: 2026-07-02
- Builds on: [0007](0007-auth-identity-family-grant-deny.md) (token-grant − DB-veto;
  `feature_denials`), [0004](0004-feature-model.md) (feature model, reflexive governance),
  [0009](0009-leases-reaper.md) (lazy, substrate-side reclaim — the pattern for a
  substrate-side reckoning), [0019](0019-capability-escalation.md) (escalation *adds* a
  feature; governance *revokes* one), [0021](0021-v4-scope-the-swarm.md) (v4 swarm; §
  deferred governance to v5 and named its prerequisites)
- Decides: v5 north star, in/out scope, the v5 success gate

## Context

v4 ([ADR 0021](0021-v4-scope-the-swarm.md)) delivered the swarm and federated frontier
peers — but it deliberately **trusts every family to behave**. ADR 0021 deferred
governance to v5 for a concrete reason: judging a family *fairly* needs **rich,
attributable outcome signal** (M16's enriched events) and the **volume** that concurrency
produces. Both now exist: M16 records *why* a task was returned, and M19's report already
attributes each stage to the acting family (`familyOfTransition`). The runway is built.

Two facts sharpen what v5 is — and is **not** — a build of:

- **The revocation mechanism already exists.** [ADR 0007](0007-auth-identity-family-grant-deny.md)
  shipped `app.feature_denials` (family-scoped, instant) and `effective = token features −
  denials`. `app.apply_effects(subject, effects)` already applies a transition's
  `{revoke:[…]}` to a family. Revoking a capability is a *solved primitive*. v5 does not
  build revocation; it builds the **signal**, the **policy**, and the **safety envelope**
  around pulling that trigger.
- **The spend signal is already emitted, unused.** Every headless harness result line
  carries per-model **token counts** (visible in `loop/run/*.log`). v5 captures the **tokens**
  into `events.data` rather than discarding them. (The harness also emits `total_cost_usd`; the
  substrate deliberately stores **tokens, not USD** — USD is meaningless for local/free models
  and is a UI-level translation. See [design/track-record.md](../design/track-record.md) D3.)

So v5 is small in *mechanism* and load-bearing in *judgment*: the substrate learns to
**remove a capability from a family that has proven bad at it**, safely, mostly on its own.

## Decision

### The v5 north star

**Reflexive governance: the workflow revokes capability on observed track record — the
substrate polices itself.** No orchestrator, no privileged agent, and now no *standing
human* for the common case: a family that repeatedly fails at a capability loses it,
automatically and temporarily, until it either reforms or a human decides the loss is
permanent. The headline is **self-correction**, not throughput (v4) or coordination (v1–v3).

### The safety envelope (the v5 invariant — from the owner's D1/D3)

Governance splits by **how attributable the failure is**, and the autonomous action is
made safe by being **bounded and reversible**, not by pre-approval:

- **Mechanical failure → automatic, temporary, substrate-applied.** An *objectively
  attributable* failure — a family's work crossing a reject threshold for a capability —
  triggers a **temporary** `feature_denial` with **exponential backoff** (repeat offense →
  longer ban; self-heals on expiry). Fail-safe direction: removing access never waits
  ([ADR 0007](0007-auth-identity-family-grant-deny.md)). Applies uniformly, including to
  `capability:integrate` (see below).
- **Permanent revocation → human.** The substrate never *permanently* revokes on its own.
  A permanent ban is a **signal raised to a human**, who decides.
- **Qualitative failure → the auditor, raised to a human.** A failure of *judgment* — "the
  delivery does not meet the request or the design," a reviewer waving through
  plausible-but-wrong work — is **not** auto-actioned. It is caught by the **auditor role**
  (see below) and escalated to a human at once (first-iteration policy). Automating this
  needs judgment we do not yet trust to a rule.

### The auditor — the missing role, and the source of the qualitative signal

Through v4 the loop had no role that validates the **whole delivery against the original
request and the design** — only the reviewer's *per-task* diff check. That whole-delivery
judgment has been performed **by the owner/orchestrator outside the swarm** (coming back to
a run and deciding whether the shipped feature met the ask). v5 **names it a role — the
auditor** — because it is the natural source of the qualitative governance signal, and it
maps onto exactly the two "senior" roles the mechanical reject-path cannot fairly judge:

- **Reviewer → judges the implementer**, per-task, mechanically → the **automatic** path (M21).
- **Auditor → judges the designer + integrator**, whole-delivery, qualitatively → the
  **human/escalation** path (M22). A bad design does not *bounce* (it is faithfully
  implemented, then fails the request later); a bad integration can be *green* yet not meet
  the ask. Only a delivery-vs-request-and-design audit surfaces those — which is why the
  designer and integrator sit on the *hard* path, not the automatic one.

First iteration: the auditor is **human** (the M22 escalation actor / flag-raiser).
Architecturally it is a role like any other — **federatable later** (a frontier family
auditing cross-maker, the M19 move applied to audit). Naming it now is the first step to
pulling the function the orchestrator has held into the substrate.

### The v5 success gate

**v5 is "done" when the swarm demotes one of its own families for cause — autonomously,
temporarily, correctly — while a qualitative failure is escalated (not auto-actioned), and
`main` stays coherent.** Concretely:

1. A family accumulates attributable rejects at a capability during a real run; on crossing
   the threshold the substrate applies a **temporary** denial that takes effect on the
   family's **next claim** (ADR 0007 instant-veto) and **expires** on schedule.
2. A **second** offense by the same family for the same capability yields a **longer**
   ban (exponential backoff) — the strike history survives the denial's expiry (no record
   shed by waiting it out).
3. A **qualitative** failure ("delivery does not meet the request/design") is caught by the
   **auditor** and **raised to a human**, with no automatic denial — visible in the
   oversight surface / report, and able to flag the **designer / integrator**.
4. `main` stays coherent throughout; the **`capability:integrate` boundary from M19
   holds** — governance may *remove* a capability, never *grant* `integrate` to a new
   family (grant stays an owner reprovision — ADR 0007's deliberate asymmetry).

### In scope for v5

- **Family track record** (M20) — aggregate M16's attributable outcomes (rejects,
  verdicts, validation results, cross-family review) **plus captured token counts** into a
  per-family, per-capability scored view. Read-only; the signal governance consumes.
- **Reflexive temporary revocation** (M21, the heart) — a substrate-side rule: crossing a
  family's reject threshold for a capability inserts a **temporary** `feature_denial` with
  **exponential backoff**; effective-features ignores expired denials; the strike ledger
  persists. Applied by the substrate (the [ADR 0009](0009-leases-reaper.md) reckoning
  pattern), not an agent.
- **The auditor role + the human boundary** (M22) — the auditor validates delivery against
  request + design and can **flag the designer / integrator**; its flags and permanent bans
  surface to a human (oversight view + report signal + an owner RPC to make permanent /
  lift). The hard-path escape hatch. Auditor is human-held this version, federatable later.

### Out of scope for v5 — deferred (constraints, not built)

- **Federating *who may merge*.** `capability:integrate` stays single, owner-invoked
  ([ADR 0017](0017-context-clean-validation.md), M19 D5). Governance may *demote* an
  integrator (halting integration → a natural human signal, since it is a singleton), but
  **granting `integrate` to a new family remains an owner act** — the ADR 0007 asymmetry.
- **Automated / federated auditing.** The auditor is **human-held** this version; an
  agent-judge scoring delivery-vs-request-and-design — and *federating* the auditor across
  makers (the M19 move applied to audit) — is v6+.
- **Cost-aware *routing*.** v5 *captures and scores* token spend (**tokens, not USD**); *using*
  it to pick which family gets a task (the [[idea-token-spend-metric]] router) is a follow-on —
  measure first, route later, same discipline as M19's measure-not-enforce. Any USD pricing
  lives at that routing/UI layer, never in the substrate.
- **Cross-substrate / cross-org sybil.** Family identity is `harness+model` on one
  substrate (see design note D2); attestation across substrates is later.
- **Always-on daemons / horizontal scale** — unchanged from v4; still owner-started.

## Bootstrap discipline (recursive — and the owner's trust-routing note)

As in v2–v4, v5 is built **on AINARRES**, aiming for **all of v5 built by the swarm**. The
split follows the safety envelope:

- **Assisted bootstrap:** the M21 substrate core (temporary-denial schema + backoff +
  effective-features change + the reject-threshold trigger) and the M22 permanent-ban RPC
  are the trust-critical primitives — a governance rule that can strip capabilities must be
  correct **before** it runs live. Verified deterministically on the mock, as M19 Slice A
  was.
- **Swarm-built:** the M20 track-record view, cost capture, the report extension, the
  escalation surface — SQL + display, swarm-shaped.
- **Trust-routing, stated honestly:** for the gate-touching tasks the owner may **route the
  implementer role to a frontier family** (grok/opus) instead of a cheap implementer. This
  is a *manual, one-off instance of the very cost-vs-trust routing v5 formalizes* — we
  hand-route trust for the milestone that teaches the system to route trust. Named, not
  hidden.

## Alternatives considered

- **Shadow-mode first (governance only recommends; a human applies every ban).** Rejected
  as the default per the owner's D1: the *bound* (temporary + backoff + reversible) is what
  makes autonomy safe, not a human in every loop. A permanent human gate stays for the
  *permanent* and *qualitative* cases — where it belongs — not the mechanical one.
- **Governance as an agent-advanced workflow for the easy path** (`apply_effects` via a
  governance lane). Rejected for the *mechanical* path: it reintroduces "who holds the
  governance role" and a poller that could stall. The mechanical ban is a **substrate
  rule** (ADR 0009 pattern) — no agent, no stall. `apply_effects` remains the vehicle for
  the *human-initiated* permanent revoke.
- **Instance-scoped or registration-scoped identity.** Rejected — ADR 0007's core insight,
  reaffirmed by the owner's D2: competence is a property of `(harness+model)`; a ban keyed
  anywhere else evaporates on respawn or re-registration.

## Consequences

- The plan ([`plans/v5-plan.md`](../plans/v5-plan.md)) is M20–M22, gate at M21 (the
  reflexive temporary revocation), with M22 completing the human boundary. Further ADRs fix
  the backoff schedule and threshold-resolution as those milestones are designed.
- `feature_denials` gains a temporal dimension (`expires_at`) + a persistent strike ledger;
  `effective_features` filters expired denials. The one real schema change of v5.
- The substrate's founding claim extends: no orchestrator, many agents at once, **and the
  workflow removes capability from those who prove unfit** — coordination, safety,
  visibility, **and self-correction** all in the substrate.
