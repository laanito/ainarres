# Roadmap — candidate next versions (forward framing, not committed scope)

> **Status: candidates, not decisions.** Scope is only *committed* in a version ADR
> (v1 [0011](../decisions/0011-v1-scope-boundary.md), v2 [0013](../decisions/0013-v2-scope-self-development.md),
> v3 [0018](../decisions/0018-v3-scope-autonomous-loop.md), v4 [0021](../decisions/0021-v4-scope-the-swarm.md),
> v5 [0022](../decisions/0022-v5-scope-governance.md)). This file is where the *next* candidates
> are parked so the thinking isn't lost. Each item graduates to its own scope ADR when we
> commit to it. Nothing here is a promise.

## The throughline

Each version has removed one human touch-point:

| version | removed |
|---------|---------|
| v1 self-hosting | — (bootstrap) |
| v2 self-development | "write the code by hand" |
| v3 hands-off loop | "babysit the running pipeline" |
| v4 swarm + federation | "run one worker at a time / one maker" |
| **v5 governance** (in progress) | "judge each family by hand" |
| **v6 candidate — seat the bookends** | "hand-craft the brief (intaker) · hand-check delivery & health (auditor)" |
| **v7 candidate — the standing service** | "start & watch the machine · sit at the terminal" |

**Roles before runtime.** v6 seats the two out-of-loop roles *by hand first* — additive
grants, no topology change, no new attack surface: safe foundations. **v7's always-on
service is only *responsible* once v5 lets the substrate self-correct AND v6 has named +
proven the roles** it will then run unattended and expose to the outside.

## The role model, and the two seats the orchestrator still holds

The pipeline of roles, as a **Customer → Consultant → Analyst → … → Auditor** chain:

| role | in the loop? | analogy | does |
|------|--------------|---------|------|
| Customer | no (external) | customer | states a request, in their own terms |
| **Intaker** | **no (out-of-loop)** | **consultant** | translates the request into a well-formed **brief** (elicit, scope, clarify) |
| Designer | yes | analyst | decomposes the brief into the task DAG |
| Implementer / Reviewer / Integrator | yes | — | build → review → merge (v1–v4) |
| **Auditor** | **no (out-of-loop)** | — | validates **delivery vs request + design**; flags designer/integrator; watches health/integrity |

**Intaker and auditor are the two out-of-loop bookends the orchestrator (human) still occupies
by hand** — every hand-written brief is an intaker act; every "did this run actually meet the
ask?" is an auditor act. They pair: **the intaker's crystallized request is the contract the
auditor audits against.** v5 names the auditor (quality facet); **v6 names the intaker and
grows the auditor's operational facet** (health/integrity); **v7 gives both roles their
*channel* (API) and *standing runtime* (service).** All **human-held first, federatable
later** (the M19 move applied to intake/audit — deferred).

## v6 candidate — "seat the bookends" (the roles, out-of-loop, human-held-first)

Make the two out-of-loop functions the orchestrator holds by hand into **first-class roles**.
**Additive grants, no topology change, no new attack surface** — baby steps, safe foundations.
Briefs still arrive the *existing* way (the owner feeds the loop); v6 is about the *roles*, not
the *channel* or the *runtime* (those are v7). Both roles are **human/orchestrator-held first**,
federatable later.

1. **Intaker (Consultant).** A *reasoning/translation* role: raw request → well-formed **brief**
   for the designer (Analyst). Distinct from any *channel* — this is the cognition, not a pipe.
   Inherently **interactive** (back-and-forth to pin the request down). It's what the orchestrator
   does every time it hand-writes a brief.
   - *Decision to settle:* **two-tier creation vs the D4 gate.** D4 ([federation.md](../design/federation.md))
     gated `create_task` on the starter role (`role:designer`). Intake adds a second legitimate
     creator: **`role:intaker` creates the request-root (`proposed` brief); `role:designer`
     creates the decomposition.** Two creators, two levels.

2. **Auditor — operational facet** (grows v5's quality naming). v5's M22 names the auditor for
   *delivery-vs-request-and-design*; v6 adds the **out-of-loop operational watch**: **pipeline
   health** (stalls, stranded claims, backpressure), **repo integrity** (coherent `main`, no
   orphaned worktrees / [loop-board-pollution]-style contamination), and **integration
   spot-checks**. Framing: the auditor is the *agent embodiment of the existing `oversight`
   role* — an automated overseer beside the human one, sharing its read surface + intervention
   RPCs (not a new privilege).

**Why v6 is the safe-foundations step:** both are additive role grants exercised on the
*existing* owner-fed, batch loop — no always-on daemon, no external ingress, nothing that
changes the termination property or the attack surface. It simply seats (and lets us *prove*,
by hand) the two roles that v7 will later run unattended and expose.

## v7 candidate — "the standing service" (API + always-on; the risky flip, done last)

Give the v6 roles a **channel** (API) and a **standing runtime** (always-on service): AINARRES
from an **owner-run batch tool** to a **standing service you talk to**. **Prerequisites: v5
governance** (self-correction so it's safe unattended) **and v6** (the intaker/auditor roles
named and proven by hand). This is where the real risk lives — hence last.

1. **API → UI (API first).** **PostgREST already is the HTTP+JWT API** — verbs + M16 views are
   exposed, so the *read* API for a UI (board / timeline / report as JSON) is nearly free. The
   new work is: **intake endpoints** (the intaker's write *channel* — the UI's write side *is*
   the Customer↔Intaker conversation), **human/external auth** (distinct from the `agent` role),
   and read shapes for a UI. UI last, cheap once the API is shaped.

2. **`make loop` → service (always-on supervisor, 1..n children).** The topology flip v4/v5
   deferred ("always-on daemons — later"). **Evolution of `driver.sh` + [ADR 0020](../decisions/0020-autonomous-run-topology.md),
   not a rewrite** — the spawning machinery exists (`run_pool`, `run_concurrent`,
   `roles.sh::harness_sweep`). A supervisor watches the board and spawns the right family when
   work is pending, demand-driven instead of round-driven.
   - *Decision to settle (ADR-level):* **termination inverts** — "the loop terminates when
     drained" (a v3/v4 gate property) becomes "the loop **idles safely** when there's no work."
   - *Invariant to keep:* the supervisor stays a **dumb demand-scaler** ("pending work in group
     X → ensure capacity for group X"), **never a router** that decides what work or who does
     it — the substrate still routes via `SKIP LOCKED`. If it ever picks which task goes to
     whom, we've regrown an orchestrator.
   - *Synergy with v5/v6:* the supervisor **consumes governance** (don't spawn a temp-banned
     family) and leans on the **operational auditor** (v6) for the health it can't babysit.

**Suggested sequencing (within v7):**
`API + intake channel  →  the service (always-on)  →  UI`

**Cross-cutting — a security-posture ADR up front (gate for v7).** **External ingress + standing
egress (integrator) + always-on** is qualitatively a new posture: a system acting on outside
input continuously. It deserves its own **threat-model ADR at the start of v7**, not a retrofit.
(The intaker's *channel* is the inbound counterpart to the integrator's guarded egress — auth /
validate / sanitize *before* input becomes a row.)

## v8+ gestures (even rougher)

Pulled from the standing deferred lists ([0021](../decisions/0021-v4-scope-the-swarm.md) §
out-of-scope, [0022](../decisions/0022-v5-scope-governance.md) § deferred):

- **Federated intaker / auditor** — frontier families doing requirements elicitation and
  cross-maker delivery audit (the M19 move applied to the two bookends).
- **Cost-aware routing** — use v5's captured **token** signal to *pick* a family per task
  ([idea-token-spend-metric]); v5 measures tokens, this routes (and is the layer that prices
  tokens in USD, if ever — the substrate never does).
- **Automated qualitative judgment** — an agent-judge for design quality / catching
  rubber-stamp reviewers (a reviewer track record).
- **Cross-substrate / cross-org federation + sybil attestation** — peers and identity beyond
  one substrate / one owner.
- **Horizontal scale** — pooling / replication / sharding beyond a single instance.

## Next action

v5 (M20–M22) landed. The **v6** candidate has graduated to a committed scope
([ADR 0023](../decisions/0023-v6-scope-seat-the-bookends.md): seat both bookends — auditor
operational facet first, then the intaker). Next: the two design notes + `plans/v6-plan.md`.
**v7** (API + service) remains a candidate here, to promote on top of v6.
