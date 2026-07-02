# Governance: the substrate polices itself

> Design note for **v5** ([v5-plan](../plans/v5-plan.md) ·
> [ADR 0022](../decisions/0022-v5-scope-governance.md)). Settles v5's open questions before
> code. Builds on the token-grant − DB-veto model ([ADR 0007](../decisions/0007-auth-identity-family-grant-deny.md)),
> the feature model + reflexive governance ([ADR 0004](../decisions/0004-feature-model.md)),
> lazy substrate-side reclaim ([ADR 0009](../decisions/0009-leases-reaper.md)), M16
> observability ([`observability.md`](observability.md)), and M19's per-transition family
> attribution ([`federation.md`](federation.md)).

## What v5 is for

Through v4 the substrate **trusts every family**. A family that reviews badly, ships
rejected work, or burns cost without delivering keeps its capabilities forever — the loop
has no way to learn from a track record. v5 closes that: **the workflow revokes a
capability from a family that has proven bad at it.** The reviewer that waves through junk
gets demoted; the implementer whose diffs keep bouncing loses `role:implementer` for a
while. Self-correction, in the substrate, no orchestrator.

The prize is **not** a new mechanism — revocation is already built ([ADR 0007](../decisions/0007-auth-identity-family-grant-deny.md):
`feature_denials`, instant, family-scoped; `apply_effects` applies `{revoke:[…]}`). The
prize is a **fair signal** and a **safe trigger**: judging a family on an attributable
record, and pulling the revoke trigger in a way that can't turn into a self-inflicted
outage or an unaccountable purge.

**The gate** ([ADR 0022](../decisions/0022-v5-scope-governance.md)): during a real run a
family crosses a reject threshold at a capability and the substrate **temporarily** denies
it (taking effect on its next claim, expiring on schedule, longer on repeat); a
*qualitative* failure is instead **raised to a human**; `main` stays coherent; the M19
`capability:integrate` boundary holds.

## What changes: a temporal dimension on a veto that already exists

Almost nothing in the mechanism. Today `feature_denials(family_id, feature_id, reason,
created_at)` is **permanent**, and `effective_features()` subtracts it. v5 adds:

```
M19:  feature_denials = permanent veto, written only by transition effects / human
v5:   feature_denials += expires_at (NULL = permanent)         ← temporary bans
      + a strike ledger per (family, capability) that OUTLIVES expiry  ← backoff, no shed
      effective_features() ignores denials where expires_at <= now()   ← self-heal
      reject_task, on crossing threshold, inserts a TEMPORARY denial    ← the reflexive rule
```

The reflexive rule lives in the substrate (the [ADR 0009](../decisions/0009-leases-reaper.md)
reckoning pattern — no agent advances a governance task for the common case). The real
work is the **signal** (attributing rejects + cost to a family fairly) and the **envelope**
(temporary/backoff vs. human).

## Decisions (the open questions, settled)

**D1 — Temporary is autonomous and substrate-applied; permanent is human.** The autonomous
action is safe because it is **bounded and reversible**, not because a human pre-approves
it. A mechanical failure yields a **temporary** `feature_denial` with **exponential
backoff** — the *n*-th ban for the same `(family, capability)` lasts `base · 2^(n−1)`
(capped) — applied by the substrate the instant the threshold is crossed, effective on the
family's next claim ([ADR 0007](../decisions/0007-auth-identity-family-grant-deny.md)
instant-veto), self-healing on expiry. A **permanent** ban is never automatic: the
substrate **raises a signal to a human**, who applies it via an owner RPC (`apply_effects`
with a NULL-expiry revoke). This rejects blanket shadow-mode: we do **not** gate every
mechanical ban behind a human — the bound does that job — but we **do** keep the human on
the permanent decision, where irreversibility demands it.

**D2 — Family is `harness+model`, and that is the whole sybil answer.** Competence is a
property of the *pairing*: the same model behaves differently in a different harness, and
vice versa, so a judgment must attach to `(harness+model)` — reaffirming
[ADR 0007](../decisions/0007-auth-identity-family-grant-deny.md). We build **no** new
identity mechanism. Sybil-resistance falls out of two facts already true: (a) family
identity is **intrinsic** — to escape a ban you must actually *become a different harness
or model*, which is legitimately a different family that has earned a clean slate; and (b)
grants are a **deliberate owner act** (ADR 0007), so a family cannot quietly re-mint itself
provisioned-and-clean. The one addition v5 needs is that the **strike ledger persists past
a temporary denial's expiry** — otherwise a family sheds its backoff by waiting out the
ban. Record persists; identity is the durable unit.

**D3 — The easy/hard split is the spine: mechanical → automatic, qualitative → human.**
- **Easy (substrate, automatic).** An *objectively attributable* failure — a family's work
  crossing a **reject threshold** for a capability — temp-bans that family from **that
  capability**. The signal is the reject itself (a reviewer/integrator returning work), and
  it is attributed to the **producing** family via M19's `familyOfTransition` (the family
  that last advanced *into* the rejected stage — e.g. the implementer who advanced
  `implementing→reviewing`). The mechanic is **uniform across capabilities**, including
  `capability:integrate`.
- **Hard (the auditor → a human, immediately).** A *qualitative* failure — "the delivery
  does not meet the request or the design," a reviewer approving plausible-but-wrong work —
  is **not** auto-actioned. It is caught by the **auditor** (D6) and escalated to a human at
  once (first-iteration policy). Detecting a bad design or a rubber-stamp needs a downstream
  judgment we do not yet trust to a rule; it lives here, not in the automatic path.

**D4 — A singleton capability's temp-ban is itself the human signal.** `capability:integrate`
is held by a single, owner-invoked family (M19 D5). The uniform rule (D3) *can* temp-ban it
on mechanical failure (an integrator producing repeatedly broken merges) — and because
integrate is a **singleton**, banning it **halts integration until a human intervenes**.
This is not a special case bolted on; it is the general rule producing the right behavior:
for a *federated* capability (implementer/reviewer, many families) a temp-ban **routes
around** the offender gracefully (M18 resilience); for a *singleton* it **surfaces to the
human**, exactly where D1 wants the permanent decision. One rule, two correct outcomes,
determined by how many families hold the capability.

**D5 — Governance may remove, never grant `integrate`.** v5 revokes; it does not federate
*who may merge*. Granting `capability:integrate` to a new family stays an **owner
reprovision** — [ADR 0007](../decisions/0007-auth-identity-family-grant-deny.md)'s
deliberate asymmetry (revoke instant & autonomous-capable; grant a deliberate human act).
The M19 integrator boundary ([ADR 0017](../decisions/0017-context-clean-validation.md)) is
untouched: governance can demote the integrator (D4), never anoint one.

**D6 — The auditor is a first-class role; it is the source of the qualitative signal and
the only role that can flag the designer + integrator.** The loop has a reviewer (per-task,
mechanical: *does this diff satisfy this task?*) but no role validating the **whole delivery
against the original request and the design** (*did we build the right thing?*). That
judgment has been done **by the orchestrator outside the swarm** — an audit in all but
name. v5 names it. The auditor is the counterpart to the reviewer, and the two divide the
governance signal along the exact line D3 draws:

| role | judges | question | signal | governance path |
|------|--------|----------|--------|-----------------|
| reviewer | implementer | does the *diff* meet the *task*? | reject (mechanical) | **automatic** temp-ban (M21) |
| **auditor** | **designer + integrator** | does the *delivery* meet the *request + design*? | flag (qualitative) | **human** escalation (M22) |

Why the auditor is the *only* path to the senior roles: a bad **design** does not bounce —
it is faithfully implemented, then fails the request later; a bad **integration** can be
*green* yet not meet the ask. Neither produces a reject the automatic path could count.
Only a delivery-vs-request-and-design audit surfaces them — which is *why* the designer and
integrator sit on the hard path.

**First iteration: the auditor is human** — the actor behind M22's escalation and the
owner RPC. But it is a role like any other (a set of `required_features`), so it is
**federatable later**: a frontier family auditing cross-maker is the M19 move applied to
audit, deferred to v6 (design-quality judgment is not something we automate this version).
Whether the audit is a **new stage** in the dev workflow (a `validating→audited→done` step,
or a lane-level audit of the shipped feature) vs. an **out-of-band** oversight action is
settled in M22's design; the *role* is fixed here, the *placement* is M22's call.

## Attribution, concretely (reusing what M19 built)

The reject signal must land on the *right* family. `reject_task` is called by the
reviewer/integrator, but the family being judged is the **producer** whose work bounced.
v5 reuses M19's `familyOfTransition(timeline, taskId, from, to)`: the implementer family is
"who advanced `implementing→reviewing` on this task." On a reject, the substrate credits the
strike to that producing family for `role:implementer` (and the analogous mapping wherever a
reject lands). The same helper that *measured* cross-family review now *feeds* governance —
the M16→M19→v5 signal chain, closed.

## Threshold & backoff resolution (a knob, seeded — not hardcoded)

Following the lease/max-attempts pattern ([ADR 0009](../decisions/0009-leases-reaper.md)):
the reject **threshold** and **backoff base/cap** resolve **capability → workflow → system
default**, seeded, tunable per deployment. The design fixes the *shape* (N attributable
rejects within a window → temporary ban; duration doubles per prior strike, capped;
permanent requires a human); it does **not** hardcode the numbers. Concrete seed values are
settled in M21's migration and stated in the retro.

## Judging the gate

Read from the M16 timeline + the family track-record view:
- A family crosses the reject threshold and is **temporarily denied** the capability;
  the denial **applies on its next claim** and is **absent after expiry**.
- A **repeat** offense produces a **longer** ban (backoff visible; strike count survived
  the prior expiry).
- A **qualitative** failure is **raised to a human** with **no** automatic denial.
- `main` coherent; the single grok integrator boundary intact; no capability *granted* by
  governance.

## Scope: one real schema change, plus signal + surface

- **Substrate (M21 core, assisted):** `feature_denials.expires_at` + a persistent strike
  ledger; `effective_features()` filters expired denials; `reject_task` inserts a temporary,
  backoff-scaled denial on threshold; threshold/backoff resolution. plpgsql / plain-SQL
  up+down ([ADR 0005](../decisions/0005-logic-language-escalation.md)/[0010](../decisions/0010-environment-migrations-testing.md)).
- **Signal (M20, swarm):** capture `total_cost_usd` + tokens from the harness result into
  `events.data`; the per-family, per-capability track-record view (rejects, verdicts,
  validation, cross-family review, cost-per-shipped-task).
- **Surface (M22):** the escalation view + report line (qualitative failures, pending
  permanent-ban signals); an owner RPC to make a ban permanent / lift one.

## Slicing (build order within v5)

- **M20 — the track record (swarm-built).** Cost capture + the scored view. Read-only,
  self-contained, builds on the parallel loop — the runway the reflexive rule consumes.
- **M21 — reflexive temporary revocation (assisted core + swarm periphery).** The temporal
  schema + backoff + `reject_task` trigger + effective-features change built assisted and
  mock-verified (a rule that strips capabilities must be trustworthy first); the observ-
  ability of it swarm-built. **The gate milestone.**
- **M22 — the human boundary (assisted RPC + swarm surface).** Qualitative escalation and
  permanent-ban signal/RPC. Completes the envelope.

## Open risks (honest)

- **Threshold calibration.** Too low → a family is temp-banned on noise (one flaky reject);
  too high → governance never bites. First seed values are a guess; the retro reports
  whether real runs banned fairly, and the knob is per-capability precisely so we can tune.
- **Attributing the *right* failure.** `familyOfTransition` credits the producer of the
  rejected stage — but a reject can be the *reviewer's* fault (a bad rejection), which would
  wrongly strike the producer. First iteration accepts this and leans on the human/hard path
  for disputes; a "reviewer track record" (who rejects work that later ships unchanged) is a
  richer signal for v6.
- **Self-DoS via the singleton (D4).** Auto-banning the sole integrator halts integration.
  This is *intended* (it surfaces to a human) but must be **loud** — the report and
  oversight view have to make "integration halted by governance" unmistakable, not a silent
  stall that reads like the M18 backpressure we already know.
- **Cost-aware routing is deferred.** v5 *measures* token spend; a family that is merely
  *expensive* (not failing) is **not** governed — expense feeds the future router
  ([[idea-token-spend-metric]]), not a ban. Guard against conflating cost with
  incompetence.
- **The qualitative path is a stub.** "Raise to a human" is honest but manual; until v6
  gives it structure, a swamped human is the bottleneck for design-quality failures. Named,
  accepted for the first iteration.
