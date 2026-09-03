# Roadmap — candidate next versions (forward framing, not committed scope)

> **Status: candidates, not decisions.** Scope is only *committed* in a version ADR
> (v1 [0011](../decisions/0011-v1-scope-boundary.md), v2 [0013](../decisions/0013-v2-scope-self-development.md),
> v3 [0018](../decisions/0018-v3-scope-autonomous-loop.md), v4 [0021](../decisions/0021-v4-scope-the-swarm.md),
> v5 [0022](../decisions/0022-v5-scope-governance.md)). This file is where the *next* candidates
> are parked so the thinking isn't lost. Each item graduates to its own scope ADR when we
> commit to it. Nothing here is a promise.
>
> **Compass:** the long-run destination these candidates steer toward — AINARRES as
> general-purpose, human+agent work coordination over a kanban hierarchy — lives in
> [`vision.md`](vision.md). This file is the *route*; that one is the *destination*.

## The throughline

Each version has removed one human touch-point:

| version | removed |
|---------|---------|
| v1 self-hosting | — (bootstrap) |
| v2 self-development | "write the code by hand" |
| v3 hands-off loop | "babysit the running pipeline" |
| v4 swarm + federation | "run one worker at a time / one maker" |
| **v5 governance** (done) | "judge each family by hand" |
| **v6 seat the bookends** (done) | "hand-craft the brief (intaker) · hand-check delivery & health (auditor)" |
| **v7 the standing service** (done) | "start & watch the machine · sit at the terminal" |
| **v7.1 the precise service** (designed: [0026](../decisions/0026-v7-1-demand-shaped-scaling.md) / [0027](../decisions/0027-v7-1-push-wake.md)) | "pay for the whole fleet on every wake" |
| **v8 candidate — the agent operator seat** ([0028](../decisions/0028-v8-scope-the-agent-operator-seat.md), Proposed) | "hold the keys and the terminal yourself" |

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

## v8 candidate — "the agent operator seat" (delegate the terminal, not the keys)

Promoted from a gesture to a **Proposed scope ADR**: [0028](../decisions/0028-v8-scope-the-agent-operator-seat.md).
The four operator skills (`skills/ainarres-operator-*.md`, #127) made the gap visible — the
operator is the only actor in AINARRES that was never *modelled*, because it has always been the
owner at a terminal. An agent in that seat occupies all five places v5–v7 deliberately left to a
human at once, and holds the signing key besides. The ADR decides the seat becomes **bounded,
attributable, ledgered, and governed** without moving any boundary v5 drew.

**The sequence — ordered, and each step is useful alone.** Step 0 needs no ADR; steps 1–3 are the
ADR's build; v7.1 runs beside them.

- **Step 0 — delegated monitoring (available now).** An agent reads the board, reports health, and
  recommends; the human does every write. Needs none of the ADR: the merged monitor skill plus a
  read token. *One dependency, found while scoping it:* the `oversight` PG role carries `EXECUTE`
  on `api.set_permanent_ban` / `api.lift_ban`, so an oversight token is **not** a read-only
  credential — bounded delegation needs a narrower read-only role (view `SELECT`s, no governance
  RPCs, no `record_usage`). That role is also the first brick of the ADR's envelope, so it is not
  throwaway work. Without it, step 0 is *trusted* delegation, which is a choice, not a boundary.
- **Step 1 — the seat's preconditions (bug-shaped, not design-shaped).** Nothing works the
  `intake` lane; the standing design pass is mis-wired (`LOOP_DESIGN_TIERS` spawns `designer` with
  no brief, so `claude-frontier.sh` falls to its reviewer prompt); no detector for a
  stuck-but-alive worker — the eyes a delegated seat no longer has. Until these land, "post a
  request and walk away" does not hold, whoever is operating.
- **Step 2 — the seat identity + the operator action ledger.** Its own family (so operator actions
  stop scoring worker track records) and an append-only ledger for the instance-scoped acts that
  cannot be events (`events.task_id` is `NOT NULL` — the M22 D7 reconciliation, reused).
- **Step 3 — the credential envelope.** The ADR's core, and the piece that needs owner sign-off:
  short-TTL credentials the seat cannot widen, issued by something it cannot reconfigure, with the
  signing key out of its reach. Permanent ban/lift, capability grants, and key custody stay human.
- **Beside it — v7.1** ([0026](../decisions/0026-v7-1-demand-shaped-scaling.md) then
  [0027](../decisions/0027-v7-1-push-wake.md)): cost first, latency second. Prerequisite to none of
  the above, but an always-reacting operator is exactly the workload whose fleet-spawn cost 0026
  removes.

**What v8 does not do:** run the operator off-host (a heavier revision of
[0025](../decisions/0025-v7-security-posture-local-service.md)), hand the seat the human-gated
powers, or replace the human auditor. ADR 0028 makes the auditor's human identity a *structural*
requirement of the operator seat — which pushes "automated qualitative judgment" (below) further
out, not nearer.

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

**Updated 2026-09-03.** `main` @ #153. v5, v6, v7 and **v7.1** have all landed; **v8** (the agent
operator seat, [0028](../decisions/0028-v8-scope-the-agent-operator-seat.md)) has shipped steps 0–3
and its ADR is Accepted. The crank is retired, both bookends are seated, the intake channel is
open, the service wakes on a notification, and an external agent has operated the seat through two
full deliveries — the second decomposing a *problem* brief into a four-node DAG and merging four PRs
in seventy-one minutes with no human between the request and the merges.

### Open, specified, and small

- **Per-transition usage attribution.** `api.record_usage` is reported once per *sweep*, and a
  sweep is not a task — one measured run had a single agent make eleven transitions across two
  tasks and five capabilities under one token report. The whole sweep is anchored to one
  `(task, capability)` and every other capability it exercised reads `unknown`, which
  [track-record.md](../design/track-record.md) D3 promises means *not measured*. **This is a hard
  prerequisite for cost-aware routing below** — that layer cannot pick a family on numbers at this
  granularity. Highest-value open item.
- **The v7.1 precision report-line** — the one part of [v7.1](../plans/v7.1-plan.md) designated
  swarm-built that never ran. Spec'd; substrate-free; the next obvious hands-off brief.
- **A non-`make` service lifecycle** — in [0028](../decisions/0028-v8-scope-the-agent-operator-seat.md)'s
  scope, unbuilt. The seat can read the service's state and stop it, and cannot start it, so every
  delivery that changes the running process ends in a human hand-off. Measured, not theoretical:
  push-wake merged and the live supervisor kept running the version it predates.
- **[0028](../decisions/0028-v8-scope-the-agent-operator-seat.md) success gate 5 is undecided.** The
  ADR claims a rejected or failed operator action credits the operator's track record and can strike
  it; strikes fire only on `transition`/reject events, so a ledger row of `outcome: refused` does
  neither. Amending the ADR (the ledger outcome was deliberately a record, not a penalty — the M22
  "qualitative never auto-penalizes" line) is the recommended resolution. Owner's call, unmade.

### The next version — the human seat, not the next repo

The candidate ahead of everything in *v8+ gestures* below: **equip the seat this project has spent
five versions defining by prohibition.** v5 drew a human boundary, v6 named the bookend roles, v8
handed an agent everything on the other side of it — and every capability that stays human by
design is the capability with the worst instrument. Permanently banning a family, lifting that ban,
and raising a qualitative audit flag are all hand-minted `oversight` tokens against raw PostgREST.
The one place where a human decision is *structurally required* is the one place with no interface.
Related: four daemons the human starts by hand, all foreground; a report that is now ten text blocks
and grows with every milestone; and no view of anything but *now*, even though the track record has
accumulated across restarts since #148.

**"Web" is the obvious shape and it forks on the perimeter, so decide that first** — the
[0025](../decisions/0025-v7-security-posture-local-service.md) lesson, applied to itself. A
loopback-only UI stays inside the perimeter that ADR already draws and needs no revision. Anything
reachable off-host triggers 0025's written widening contract in full (TLS, a rotatable credential
scheme, per-caller identity and authZ, rate limiting, an egress re-review). That is a scope ADR up
front, not a retrofit.

**Deliberately after it:** pointing a lane at a repository this system did not write. Every
delivery AINARRES has ever made has been to itself, which means every worker has always had ambient
context nobody decided to give it — the designs, the ADRs, the conventions, all in the same
repository as the task. That is a habit, not a design, and it is therefore holding up assumptions
that are currently invisible. It is the most informative next experiment and it wants a human
console to watch it through, which is why it comes second.

