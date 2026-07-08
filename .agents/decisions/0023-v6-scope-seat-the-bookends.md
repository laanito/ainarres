# ADR 0023 — v6 scope: seat the bookends (the two out-of-loop roles, human-held first)

- Status: Accepted
- Date: 2026-07-08
- Builds on: [0022](0022-v5-scope-governance.md) (v5 governance — named the auditor's
  *quality* facet, M22; this ADR grows its *operational* facet and adds the intaker),
  [0007](0007-auth-identity-family-grant-deny.md) (token-grant − DB-veto; `feature_denials`,
  `role:*` features), [0004](0004-feature-model.md) (feature model; roles as features),
  the M22 design note ([design/auditor.md](../design/auditor.md): `role:auditor`,
  `raise_audit_flag`, the flag/reject line, oversight-only permanence), the federation D4
  create-gate ([design/federation.md](../design/federation.md): `create_task` gated on the
  workflow's starter role), and the roadmap ([analysis/roadmap.md](../analysis/roadmap.md):
  the Customer → Intaker → … → Auditor role chain, v6 = "seat the bookends")
- Decides: v6 north star, in/out scope, the v6 success gate

## Context

Every version so far removed one human touch-point (roadmap throughline): v2 removed
"write the code by hand," v3 "babysit the pipeline," v4 "one worker / one maker," v5 "judge
each family by hand." What the human **still** does by hand sits at the two ends of the
pipeline, **outside the loop**:

- **the intaker** — turns a raw request into a well-formed **brief** for the designer. Every
  hand-written brief the owner feeds the loop is an intaker act.
- **the auditor's operational watch** — comes back to a run and asks "did this actually meet
  the ask, and is the machine healthy?" v5 named the auditor's **quality** facet (M22:
  delivery-vs-request-and-design, a task-anchored flag raised to a human). It did **not** name
  the auditor's **operational** facet — pipeline health, repo integrity, and the **spend
  watch** the measurable-fleet stage just made possible.

Two facts sharpen what v6 is — and is **not**:

- **The mechanisms already exist.** Roles are features ([ADR 0004](0004-feature-model.md));
  seating a role is a **seed + grant**, not a new primitive. M22 already shipped the
  auditor's **flag verb** (`api.raise_audit_flag`), the **oversight-only** permanence RPCs
  (`set_permanent_ban` / `lift_ban`), the **recommendation signal**, and the read-only
  surface. The federation D4 gate already makes `create_task` **role-gated and data-driven**
  (the workflow's starter role). v6 does not build revocation, flagging, or a create-gate; it
  **seats two roles on top of machinery that is already there**, and grows the auditor's
  *reach* from delivery-quality to operational health.
- **The motivating failure is already on record.** The measurable-fleet interlude
  (retro [fleet-and-token-capture](../retros/fleet-and-token-capture.md)) produced both halves
  of the auditor-operational facet: the **token signal** (now populated for all five families)
  and the **incident that justifies watching it** — nano **spun ~10 minutes** on a
  hallucinated tool, burning effort, producing nothing, tripping **no reject and no counter**.
  That failure is invisible to every mechanical signal M21 watches, and **visible to a spend
  watch**. The spinning worker is the argument for this feature.

So v6 is small in *mechanism* and load-bearing in *placement*: it makes the two functions the
orchestrator performs by hand into **first-class, named roles** — additive grants exercised on
the **existing** owner-fed batch loop, so v7 can later run and expose roles that were **proven
by hand first**.

## Decision

### The v6 north star

**Seat the bookends: name the two out-of-loop roles the orchestrator still holds by hand —
the intaker (front) and the auditor's operational facet (back) — as first-class roles,
additive and human-held first.** The headline is **role completeness**: the full
Customer → Intaker → Designer → … → Auditor chain is named in the substrate, even though the
two ends are still played by a human. No throughput (v4), no self-correction mechanism (v5),
no channel or runtime (v7) — just the roles.

### The v6 invariant (safe foundations)

**Additive grants only — no topology change, no new attack surface, termination property
unchanged.** Every v6 addition is a role feature + verbs/views exercised on the same
owner-started, drain-to-empty batch loop v3–v5 run. Specifically:

- **No always-on daemon, no external ingress.** Briefs still arrive the *existing* way (the
  owner feeds the loop). v6 seats the *roles*; v7 gives them a *channel* and a *runtime*.
- **The auditor still never auto-penalizes.** The operational facet raises **flags** and
  **recommendations** (the M22 pattern), human-decided; it writes **no `feature_denials`**.
  A spinner or an overspender is *surfaced*, never auto-banned (respects the
  [track-record](../design/track-record.md) D3 line — spend ≠ competence, tokens never
  auto-ban).
- **The substrate is never a router.** v6 does not use the spend signal to *pick* who does a
  task. `SKIP LOCKED` self-claim stays the only routing. Cost-aware routing is a v8+ candidate
  and an explicit anti-goal here (roadmap; [idea-token-spend-metric]).
- **The integrate boundary from M19/M22 holds.** No new family gains `capability:integrate`;
  the intaker grants only creation of a *proposed brief*, never merge.

### Slice 1 — the auditor's operational facet (build first)

Grow v5's auditor from **delivery quality** to **operational health**, reusing M22's
flag/recommend/surface machinery. The auditor becomes the *agent-embodiment-ready overseer*
beside the human `oversight` role — **sharing its read surface, not gaining a new privilege**.

- **Health watch** — stalls / stranded claims / backpressure (the pipeline liveness
  [ADR 0009](0009-leases-reaper.md)'s leases + reaper already expose as substrate state).
- **Repo integrity** — a coherent `main`, no orphaned worktrees, no
  [loop-board-pollution]-style contamination.
- **The spend watch (the nano-spin motivator)** — flag a family that **spins** (abnormal
  token burn with no delivery) or **consistently overspends vs. peers** at a capability. A
  **qualitative flag** (M22 shape), **human-decided**, **no auto-denial**. Uses v5's captured
  per-family token record; it *watches* spend, it does not *price* (no USD) and does not
  *route*.
- **Decision to settle in the design note (not here):** M22's `raise_audit_flag` is
  **task-anchored** (delivery-vs-request, `events.task_id NOT NULL`); an operational/spend flag
  is naturally **family/capability-scoped** and may have no single task. Whether the
  operational facet reuses the task-anchored flag, emits a family-scoped signal alongside the
  `governance_actions` ledger (M22 D7's reconciliation pattern), or both — is the load-bearing
  design decision Slice 1's note settles.

### Slice 2 — the intaker (Consultant)

Name the **reasoning/translation** role that turns a raw request into a well-formed brief for
the designer. This is the *cognition* (elicit, scope, clarify), **not** a channel — the pipe
is v7.

- **`role:intaker`** — a plain role feature (`kind='role', key='intaker'`), human-held first,
  federatable later (the M19 move applied to intake — deferred).
- **Two-tier creation (revisits federation D4).** D4 gated `create_task` on the workflow's
  single **starter** role. Intake adds a *second legitimate creator at a different level*:
  **`role:intaker` creates the request-root** (a `proposed` brief), **`role:designer` creates
  the decomposition** (the task DAG under it). Two creators, two levels — kept **data-driven**
  (per-workflow starter role), not hardcoded, preserving D4's shape.
- **Decision to settle in the design note (not here):** the shape of the "request-root /
  proposed brief" — is it a new workflow whose starter is `role:intaker` (mirroring the
  `dev→role:designer` gate), a task in a `proposed` state ahead of the dev workflow, or a
  first-class brief entity? M22 D8 deliberately deferred a first-class *delivery* entity;
  Slice 2's note decides whether intake needs a first-class *brief* entity or can ride the
  existing task/workflow machinery.

### The v6 success gate

**v6 is "done" when both bookends are exercised, by hand, on the existing owner-fed loop —
the intaker creates a proposed brief that the designer decomposes and the loop delivers, and
the auditor's operational watch surfaces a real health/spend anomaly as a flag raised to a
human — with no topology change and `main` coherent.** Concretely:

1. A holder of `role:auditor` raises an **operational flag** (a spinner / overspender caught
   by the spend watch, or a health/integrity anomaly) — visible in the oversight surface +
   report, writing **no denial**, human-decided. The nano-spin failure class is now *catchable*.
2. A holder of `role:intaker` **creates a proposed brief** (the request-root); a
   `role:designer` **decomposes** it into the dev DAG; the loop implements/reviews/integrates
   it hands-off. **Two-tier creation works** — an agent lacking the starter role is refused at
   the right level (D4 preserved).
3. **No always-on daemon, no external ingress, no new `capability:integrate` grant.** The
   termination/attack-surface properties are exactly v5's; the additions are purely role
   grants + read/flag surface.
4. `main` stays coherent throughout; governance still only **removes** capability, never
   grants; the auditor still only **signals**, never auto-penalizes.

### In scope for v6

- **Auditor operational facet** (Slice 1) — health/integrity watch + the **spend watch**,
  surfaced as M22-style flags + recommendations, human-decided, no auto-denial. Reuses the
  M22 flag/recommend/surface machinery and v5's captured token record.
- **Intaker role** (Slice 2) — `role:intaker` + **two-tier creation** (request-root brief by
  the intaker, decomposition by the designer), data-driven per D4.
- **The surfaces** for both — the oversight view + end-of-run report grow to show operational
  flags and the intake state, following the M20–M22 view+report-line pattern.

### Out of scope for v6 — deferred (constraints, not built)

- **The channel and the runtime (all of v7).** No intake *API/UI* (the intaker's write pipe),
  no external/human auth distinct from `agent`, no always-on supervisor, no retirement of the
  `make` loop. v6 is roles on the *existing* batch loop; v7 gives them a channel + standing
  runtime and owns the **security-posture ADR** for external ingress.
- **Federating the bookends.** Both roles are **human-held** this version. A frontier family
  doing requirements elicitation (intaker) or cross-maker delivery/health audit (auditor) is
  the M19 move applied to the bookends — v8+.
- **Cost-aware routing.** v5 *captured* tokens, v6 *watches* them (flags anomalies); *using*
  spend to **pick** a family per task is a **router** — which AINARRES does not have by design
  ([idea-token-spend-metric]; roadmap v8+). Any USD pricing lives at that later routing/UI
  layer, never in the substrate.
- **Automated qualitative judgment.** The auditor stays **human-held**; an agent-judge scoring
  delivery quality, and a **reviewer track record** (catching rubber-stamp reviewers), remain
  v6+/v8 candidates — noted, not built.
- **A first-class delivery/brief entity.** M22 D8 anchored flags to a shipped task and
  deferred a delivery object; v6's intake **may** need a brief entity (Slice 2's open
  decision) but a general delivery/brief model beyond what intake requires is out of scope.
- **Always-on daemons / horizontal scale** — unchanged from v4/v5; still owner-started.

## Bootstrap discipline (recursive)

As in v2–v5, v6 is built **on AINARRES**, aiming for as much as possible **built by the
swarm**. The split follows the same **substrate-free-checkability** line the board-wipe
taught, not importance:

- **Assisted (mock-verified before live):** the **auth-and-creation-gate** core — seeding
  `role:auditor`'s operational reach and `role:intaker`, and the **two-tier create-gate**
  change (D4 revisited). A rule about *who may create* the request-root touches the same
  gating surface M19 D4 did; it must be correct **before** it runs live, verified on the mock.
- **Swarm-built (briefed, run hands-off):** the operational-watch views, the spend-anomaly
  computation, the report extensions, and the pure formatters — SQL + display, the exact
  M20–M22 view (assisted-validate) + report-line (substrate-free, hands-off) split. The pure
  report-line halves validate with `npx vitest`, no DB — the clean hands-off slices.

## Alternatives considered

- **Split the bookends across v6 / v6.x** (auditor-op only in v6; intaker later). Rejected:
  the roadmap pairs them deliberately — **the intaker's crystallized request is the contract
  the auditor audits against.** Seating both names the *whole* chain, and each is a small
  additive grant; there is no topology risk that argues for staging them apart. (Build order
  still sequences them — auditor-op first, since it is pure additive read+watch on M22 with no
  create-gate change; intaker second, carrying the D4 revisit.)
- **Make the auditor a gating stage** (a `validating → audited → done` toll). Rejected in M22
  (design/auditor.md D1) and again here: a gating audit puts a standing human on the critical
  path of every delivery — the exact freeze v5 removed. The operational auditor is likewise a
  **backstop, not a tollbooth**; it annotates and flags off the critical path.
- **Use the spend signal to route** (cheap-first assignment). Rejected as an **anti-goal**: a
  router that picks who does what regrows the orchestrator AINARRES exists to abolish. v6
  *watches* spend and *flags* anomalies to a human; it never assigns.
- **Auto-ban spinners / overspenders.** Rejected per track-record D3: spend ≠ competence, and
  a spin is a *qualitative* failure (M22 hard path) — it is flagged and human-decided, never
  auto-penalized. (An expensive model that always passes is *expensive*, not *bad*.)

## Consequences

- The plan (`plans/v6-plan.md`, to be written) is **two slices**: M23 (auditor operational
  facet) then M24 (intaker + two-tier creation), each fronted by a design note that settles
  the decision this ADR parks (the operational-flag anchoring for Slice 1; the request-root /
  brief-entity shape for Slice 2). Further ADRs fix those if they prove ADR-level.
- The substrate's role chain is **named end to end** for the first time: Customer (external) →
  **Intaker** → Designer → Implementer/Reviewer/Integrator → **Auditor** (quality + operational).
  Two ends are still human-played — v6 seats them; v7 runs them.
- **No schema change to the capability core.** Roles are features (seed + grant); the
  create-gate is the existing D4 mechanism extended data-driven; the auditor's operational
  flags reuse M22's event/ledger/surface. The one genuinely new *structural* question — how an
  operational (family-scoped) flag coexists with M22's task-anchored one — is a design-note
  decision, expected to reuse the `governance_actions` ledger pattern rather than add mutable
  state.
- v6 is the **safe-foundations** step the roadmap promised: the two roles v7 will run
  unattended and expose are, by the end of v6, **named and proven by hand** on the existing
  loop — so v7's always-on flip inherits proven roles, not new ones.
