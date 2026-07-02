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
| **v6 candidate — the standing service** | "feed the brief · start & watch the machine · sit at the terminal" |

v5 is the safety prerequisite for v6: an always-on service is only *responsible* once the
substrate can self-correct without someone watching every run.

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
auditor audits against.** v5 names the auditor (quality facet); v6 names the intaker and grows
the auditor's operational facet. Both are **human-held first, federatable later** (the M19 move
applied to intake/audit — deferred).

## v6 candidate — "the standing service"

Turn AINARRES from an **owner-run batch tool** into a **standing service you talk to**:
self-fed (intaker), self-watched (auditor-ops), always-on (loop-as-service), reachable
(API/UI). Four coherent themes, not four separate features.

### Themes

1. **Intaker (Consultant) + intake channel.** The intaker is a *reasoning/translation* role
   (request → brief), distinct from the *channel* that carries the customer's words (API/web).
   It is **inherently interactive** (back-and-forth to pin the request down) — which is exactly
   why it pairs with the UI: the UI's write side *is* the Customer↔Intaker conversation.
   - *Decision to settle:* **two-tier creation vs the D4 gate.** D4 ([federation.md](../design/federation.md))
     gated `create_task` on the starter role (`role:designer`). Intake adds a second legitimate
     creator: **`role:intaker` creates the request-root (`proposed` brief); `role:designer`
     creates the decomposition.** Two creators, two levels.

2. **Auditor — operational facet.** Beyond v5's quality/governance duty, a *standing* service
   needs the auditor watching **pipeline health** (stalls, stranded claims, backpressure),
   **repo integrity** (coherent `main`, no orphaned worktrees / [loop-board-pollution]-style
   contamination), and **integration spot-checks**. Framing: the auditor is the *agent
   embodiment of the existing `oversight` role* — an automated overseer beside the human one,
   sharing its read surface + intervention RPCs (not a new privilege).

3. **`make loop` → service (always-on supervisor, 1..n children).** The topology flip v4/v5
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
   - *Synergy with v5:* the supervisor **consumes governance** — don't spawn a family that's
     temp-banned from the capability it's needed for.

4. **API → UI (API first).** **PostgREST already is the HTTP+JWT API** — verbs + M16 views are
   exposed, so the *read* API for a UI (board / timeline / report as JSON) is nearly free. The
   new work is: **intake endpoints** (the intaker's write channel), **human/external auth**
   (distinct from the `agent` role), and read shapes for a UI. UI last, cheap once the API is
   shaped. The intake write-side and the UI front are **one surface**.

### Suggested sequencing (within v6)

`API + intake  →  the service (always-on, consuming governance + auditor-ops)  →  UI`

Lowest-risk front door first (also forces the D4/ingress decisions early); the risky always-on
flip second, once governance + health make it safe; the UI last, on a shaped API.

### Cross-cutting — a security-posture ADR up front (gate for v6)

**External ingress + standing egress (integrator) + always-on** is qualitatively a new posture:
a system acting on outside input continuously. It deserves its own **threat-model ADR at the
start of v6**, not a retrofit. (The intaker is the inbound counterpart to the integrator's
guarded egress — auth / validate / sanitize *before* input becomes a row.)

## v7+ gestures (even rougher)

Pulled from the standing deferred lists ([0021](../decisions/0021-v4-scope-the-swarm.md) §
out-of-scope, [0022](../decisions/0022-v5-scope-governance.md) § deferred):

- **Federated intaker / auditor** — frontier families doing requirements elicitation and
  cross-maker delivery audit (the M19 move applied to the two bookends).
- **Cost-aware routing** — use v5's captured token/cost signal to *pick* a family per task
  ([idea-token-spend-metric]); v5 measures, this routes.
- **Automated qualitative judgment** — an agent-judge for design quality / catching
  rubber-stamp reviewers (a reviewer track record).
- **Cross-substrate / cross-org federation + sybil attestation** — peers and identity beyond
  one substrate / one owner.
- **Horizontal scale** — pooling / replication / sharding beyond a single instance.

## Next action

Land **v5 M20–M22** first. Return here to promote the v6 candidate into a scope ADR + plan
when v5 is done.
