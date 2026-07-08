# Plan — AINARRES v6

> Scope and the gate are fixed by [ADR 0023](../decisions/0023-v6-scope-seat-the-bookends.md)
> (seat the bookends — the two out-of-loop roles, human-held first). Builds on the feature
> model ([ADR 0004](../decisions/0004-feature-model.md): roles are features), the federation
> create-gate ([`design/federation.md`](../design/federation.md) D4 — creation requires the
> lane's starter role, data-driven), and v5's auditor + governance surface
> ([`design/auditor.md`](../design/auditor.md), [`design/track-record.md`](../design/track-record.md),
> [`design/reflexive-revocation.md`](../design/reflexive-revocation.md)). The two milestone
> design notes settle the open questions: [`design/auditor-operational.md`](../design/auditor-operational.md)
> (M23), [`design/intake.md`](../design/intake.md) (M24). Each milestone is one PR-sized slice
> that ends green, then a blog article (continues the *AINARRES* series).

## Objective

**Name the two out-of-loop roles the orchestrator still holds by hand** — the **intaker**
(front: raw request → well-formed brief) and the **auditor's operational facet** (back:
pipeline health, repo integrity, and the token **spend watch**) — as first-class roles.
**Additive grants, human-held first, no topology change, no new attack surface.** The headline
is **role completeness**: the full Customer → Intaker → Designer → … → Auditor chain is named
in the substrate, exercised by hand on the existing owner-fed loop. The channel and the
always-on runtime are **v7**; v6 seats the roles v7 will later run and expose.

## Success criterion ([ADR 0023](../decisions/0023-v6-scope-seat-the-bookends.md))

On the existing owner-fed loop, with no topology change and `main` coherent: (1) a
`role:auditor` holder raises an **operational flag** — a spinner (caught by the **health**
watch) or an overspender (caught by the **spend** watch) — writing **no** denial, human-decided;
and (2) a `role:intaker` holder **creates a proposed brief** that a `role:designer`
**decomposes** into the dev DAG and the loop delivers hands-off — **two-tier creation works**,
an agent lacking the starter role refused at the right level (D4 preserved). Governance still
only **removes** capability, never grants; the auditor still only **signals**, never auto-bans.

## Execution discipline

- **Branch → commit → push → PR** per milestone; owner reviews. Done = verified in the loop.
- **plpgsql only** ([ADR 0005](../decisions/0005-logic-language-escalation.md)); plain-SQL
  up/down migrations. v6 adds **no revocation mechanism** and **no `create_task` change** — the
  create-gate is reused unmodified (M24 verifies it, does not touch it).
- **Signal/observability stays read-only, CLI-native** — over the event log + oversight views;
  no new infra, no daemon, no external ingress (those are v7).
- **Bootstrap discipline (aim: as much of v6 by the swarm as the split allows).** The
  **auth/creation-gate cores** — M23's flag verb + ledger, M24's intake-workflow seed + the
  two-tier gate — are built **assisted and mock-verified** before running live (a rule about
  who may flag a family, or create the request-root, must be correct first), exactly as M19 D4
  / M22 Slice A were. The **watch views + surfaces + pure report-lines** are **swarm-built**:
  the SQL views validated **assisted** (no DB in a worktree — the board-wipe rule), the **pure
  report-lines substrate-free and hands-off** (the #87/#91 slice).
- One blog article per merged milestone (v6 arc opener: "seating the bookends").

## Dependency order

```
M23 auditor operational facet (health + spend watch) ─▶ M24 intaker (two-tier creation)
```
M23 first (ADR 0023): it is **pure additive read + watch** on v5's M22 auditor — no
create-gate change, so it is the smaller, lower-risk step and continues the governance season
directly. M24 carries the create-gate *verification* (a second lane, a second creator) and
closes M22 D8's open loop (the brief ↔ delivery link the auditor audits against).

---

## M23 — The auditor's operational facet: health + spend watch

**Goal:** grow v5's auditor from *delivery quality* to *operational health* — watch pipeline
health, repo integrity, and token spend; flag a **spinner** or an **overspender** as a
qualitative, human-decided signal that writes **no** denial. ([ADR 0023](../decisions/0023-v6-scope-seat-the-bookends.md);
design settled in [`design/auditor-operational.md`](../design/auditor-operational.md))

> **Build split:** **Slice A** (the family-scoped flag verb + append-only ledger + policy
> datum) is **assisted + mock-verified** — an auth-gated verb recording a judgment against a
> family must gate correctly first. **Slice B** (the watch views + report line) is
> **swarm-eligible**: views validated assisted, the pure report-line substrate-free.

**Steps**
- **The flag verb + ledger (D1)** — `api.raise_operational_flag(subject_family, capability,
  kind, detail, severity)`, `role:auditor`-gated, writing an append-only `app.operational_flags`
  row (`kind ∈ {spinning, overspending, health, integrity}`) and **no `feature_denials`**
  (mirrors the M22 `governance_actions` reconciliation — family-scoped conduct → a ledger, not
  a task-anchored event).
- **The spend watch (D3)** — `api.spend_anomalies`: `tokens_per_delivery` (from
  `api.family_track_record`) vs. the **per-capability peer median**, flagging families over
  `overspend_multiple` (new seeded `governance_policy` datum); also the `delivered=0 AND
  usage>0` (burned-but-shipped-nothing) case. Tokens only — no USD, no ranking.
- **The health watch (D4)** — a read over the **existing** `api.abandoned` + `api.board`
  (stalled/stranded claims, near-lease no-advance). No new liveness mechanism.
- **The surface (D2/D7)** — `api.operational_flags` (open flags, newest-first) + a report
  **operational block**: health anomalies · spend anomalies · open flags, with spinning shown
  as "review" and overspending as "cost" (the D5 presentation lives in the pure formatter).

**Done-tests**
- Only `role:auditor` may call `raise_operational_flag`; an agent token is refused. A flag
  lands in `app.operational_flags`, names the subject family + capability + kind, and writes
  **no** `feature_denials`; the ledger rejects update/delete.
- `api.spend_anomalies` flags a family whose `tokens_per_delivery` exceeds the peer-median
  multiple, and the `delivered=0 & usage>0` case; a single-family capability yields **no**
  anomaly (no peer baseline — reported honestly, not as a false positive).
- The health watch surfaces a stalled/stranded claim from `api.abandoned`.
- Operational flags do **not** feed M22's permanent-ban recommendation (spend ≠ competence,
  track-record D3); a human may still escalate a *spinning* flag via M22's oversight RPC.
- Down-migration drops the verb, ledger, views, and policy column.

**Blog:** "The auditor grows a second sense: watching health and spend."

## M24 — The intaker: the front bookend, and two-tier creation

**Goal:** name `role:intaker` (raw request → well-formed brief) and seat two-tier creation —
the intaker creates the request-root, the designer creates the decomposition — **reusing the
D4 create-gate unmodified**. ([ADR 0023](../decisions/0023-v6-scope-seat-the-bookends.md);
design settled in [`design/intake.md`](../design/intake.md))

> **Build split:** **Slice A** (seed `role:intaker` + the intake workflow/lane/stages/
> transitions; verify the two-tier gate) is **assisted + mock-verified** — it changes the
> creation-gate *surface* (a second lane, a second creator), auth-shaped, correct-first.
> **Slice B** (the open-briefs surface + report line) is **swarm-eligible**.

**Steps**
- **The intaker role (D5)** — a `role:intaker` feature (`kind=role, key=intaker`), human-held;
  granting stays an owner reprovision (ADR 0007 asymmetry).
- **The intake workflow (D1/D2)** — a new `ainarres-intake` workflow + `intake` lane; stages
  `proposed_brief` (initial) → `briefed` → `accepted` (terminal); transitions
  `proposed_brief→briefed [role:intaker]` (the starter — which is *what lets the intaker
  create*, D4) and `briefed→accepted [role:designer]` (the designer accepting for
  decomposition).
- **Two-tier creation, verified not modified (D4)** — **no `create_task` change**; the existing
  `create_requires_starter_role` gate already enforces intaker-creates-intake /
  designer-creates-dev, purely from the seed.
- **The brief ↔ task link (D3)** — dev tasks decomposed from a brief carry `payload.brief =
  <intake_task_id>` (a convention, no FK) — closing M22 D8's open loop (the auditor's
  request-side contract).
- **The surface (D7)** — `api.open_briefs` (intake board by stage) + a report **intake** line.

**Done-tests**
- The intake workflow exists with both transitions. A `role:intaker` token creates in `intake`
  and is **refused** in `dev`; a `role:designer` token creates in `dev` and is **refused** in
  `intake`; a family holding **both** can do both.
- A brief advances `proposed_brief → briefed` (intaker) → `accepted` (designer); dev tasks
  created from it carry `payload.brief`.
- `api.open_briefs` lists intake tasks by stage; the report shows the intake line.
- Down-migration drops the workflow, lane, and role feature.

**Blog:** "The intaker: naming the front bookend — and two-tier creation for free."

---

## Open questions (settled within each milestone's design note)

- **M23:** *settled in [`design/auditor-operational.md`](../design/auditor-operational.md)* —
  a family-scoped operational flag gets its **own verb + ledger** (not M22's task-anchored
  flag, D1); the **watch is computed, the flag is judgment** (D2); spend = `tokens_per_delivery`
  vs. peer median (D3); health reuses `api.abandoned` (D4); **spinning may be escalated to a
  ban, overspending never nudges one, neither auto-bans** (D5); same `role:auditor`, oversight
  separation held (D6); append-only, no new mutable capability state (D7).
- **M24:** *settled in [`design/intake.md`](../design/intake.md)* — the request-root is a
  **task in a new `intake` lane** (not a dev stage, not a new entity, D1); the intake workflow
  is three stages / two transitions (D2); the brief↔task link is `payload.brief` (D3, closing
  M22 D8); **no `create_task` change** — D4 delivers two-tier creation from the seed (D4);
  `role:intaker` human-held, federatable later (D5); **no channel in v6** — exercised by hand
  (D6); an open-briefs view + report line (D7).

## Deferred to v7+

- **The channel + the runtime (v7).** The intake **API/UI** (the intaker's write pipe),
  human/external auth distinct from `agent`, the always-on supervisor, retiring the `make`
  loop — all v7, gated by its own **security-posture ADR** (external ingress threat model).
- **Federating the bookends** — a frontier family doing requirements elicitation (intaker) or
  cross-maker delivery/health audit (auditor): the M19 move applied to the two bookends (v8+).
- **Cost-aware routing** — using the token signal to *pick* a family per task
  ([[idea-token-spend-metric]]). v6 **watches** spend; a **router** that assigns work is an
  ADR 0023 anti-goal (SKIP LOCKED stays the routing) and a v8+ candidate.
- **Automated qualitative judgment** — an agent-judge scoring delivery quality; a **reviewer
  track record** (catching rubber-stamp reviewers). Noted, not built.
- **A first-class delivery/brief entity + enforced brief↔task link** — v6 uses a payload
  convention (M24 D3); a real entity with an FK, and auditing a brief's whole task set, is
  deferred (symmetric with M22 D8).
- **A per-claim progress heartbeat** (a tighter spinner catch than lease/abandoned), and
  **per-transition token attribution** (M20's coarse per-sweep limit) — later refinements.
