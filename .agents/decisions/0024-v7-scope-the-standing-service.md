# ADR 0024 — v7 scope: the standing service (retire the crank; always-on, local, demand-scaled)

- Status: Accepted
- Date: 2026-08-16
- Builds on: [0023](0023-v6-scope-seat-the-bookends.md) (v6 — seated the two out-of-loop
  bookends, intaker + auditor-operational, human-held on the *existing* owner-fed batch loop;
  v7 gives them a *runtime*), [0020](0020-autonomous-run-topology.md) (the dumb driver +
  independent pollers; this ADR turns "owner-started, drain-to-exit" into "always-on,
  idle-safe" — the daemonizing that ADR named "a natural follow-up"),
  [0018](0018-v3-scope-autonomous-loop.md) (the hands-off gate v7 keeps),
  [0009](0009-leases-reaper.md) (leases + lazy reclaim — the liveness the supervisor leans on),
  [0022](0022-v5-scope-governance.md) (governance the supervisor *consumes* — never spawn a
  temp-banned family), the roadmap ([analysis/roadmap.md](../analysis/roadmap.md): v7 = "the
  standing service, the risky flip, done last") and the vision
  ([analysis/vision.md](../analysis/vision.md): a service is a **demand-scaler, never a router**)
- Decides: v7 north star, in/out scope, the v7 success gate. Its companion
  [0025](0025-v7-security-posture-local-service.md) fixes the (deliberately light) security
  posture for the standing runtime.

## Context

Every version so far removed one human touch-point (roadmap throughline): v2 "write the code by
hand," v3 "babysit the running pipeline," v4 "one worker / one maker," v5 "judge each family by
hand," v6 "hand-craft the brief / hand-check delivery + health." One touch-point remains, and it
is the most physical of them all: **the owner still sits at the terminal and pulls the crank.**
Every run of the loop begins with a human typing `make loop-run` and ends when the board drains
and the process exits. The loop is scaffolding started by hand; it is not yet a thing that runs.

v6 deliberately stopped short of this. It **seated** the two out-of-loop roles — the intaker
(front) and the auditor's operational facet (back) — as first-class grants, and **proved them by
hand** on the existing batch loop, precisely so v7 could give roles that already work a runtime,
not invent roles and a runtime at once. ADR 0023 §out-of-scope parked exactly this: "the channel
and the runtime (all of v7) ... an always-on supervisor, retirement of the `make` loop ... and
the security-posture ADR for external ingress."

Two facts shape how big v7 should be:

- **The topology flip and the external channel are separable, and separable by *risk*.** Turning
  `make loop-run` into an always-on supervisor changes the **termination property** (a v3/v4 gate:
  "the loop terminates when drained") into an **idle property** ("the loop idles safely when there
  is no work") — a real but *internal* change, adding **no new attack surface**: the service is
  still fed the way it is fed today (the owner's `INSERT`/CLI). The **channel** — an external write
  path so a Customer can talk to the intaker — is a *different* kind of change: the project's
  **first external ingress**, the genuinely new security posture. Bundling them would make the
  riskiest version also the widest. They can be staged.
- **The read API already exists.** PostgREST *is* the HTTP+JWT API; the M16 views + the report are
  already exposed. So a future UI's *read* side is nearly free; the new work when the channel
  arrives is the *write* side (intake endpoints) + **human/external auth distinct from `agent`** —
  which is exactly what the security ADR must gate. None of that is needed to retire the crank.

So v7, kept honest to the project's baby-step discipline, is **the standing service in the
smallest responsible first stage: the topology flip, local, no new ingress.** The channel + human
auth + UI are real v7 work but land *after* the flip is proven, behind [0025](0025-v7-security-posture-local-service.md)'s
posture gate — sequenced, not skipped.

## Decision

### The v7 north star

**Retire the crank. Turn the owner-started, drain-to-exit batch loop into an always-on, local
demand-scaling service** — a standing supervisor that watches the board and ensures capacity for
pending work, and **idles safely** when there is none, with no human pulling `make loop-run`. The
headline is **runtime**: AINARRES stops being a script the owner runs and becomes a process that
runs. The two v6 roles get their *always-on runtime*; their *channel* (external ingress) is
sequenced behind it (below).

### The v7 invariant (the one that keeps "no orchestrator" honest)

**The supervisor is a demand-scaler, never a router.** It asks the substrate one question —
*"is there pending work my roster's capabilities can satisfy?"* — and launches families from its
pool to match, draining until nothing claimable remains, then idling. It **never** decides *which*
task goes to *whom*, *which* family is best, or *what order* work is done: that is `SKIP LOCKED`
self-claim + the data-driven state machine ([0001](0001-data-driven-state-machine.md),
[0019](0019-capability-escalation.md)), unchanged. **If the supervisor ever picks which task goes
to which worker, we have regrown the orchestrator AINARRES exists to abolish.** This is the
[0020](0020-autonomous-run-topology.md) "dumb driver" rule, carried verbatim into a process that
no longer exits. Concretely, the supervisor's only knowledge stays: *which harness runs which
role* (`roles.sh`) and *is there claimable work for that role right now*.

Corollaries the supervisor must honour, all **consumed, not invented**:

- **It consumes governance, never creates it.** It must not spawn a family that is temp-banned
  ([0022](0022-v5-scope-governance.md) / M21 `effective_features`) for the capability the pending
  work needs — reading the same denial the substrate already enforces, so a spawned-anyway worker
  would simply fail to claim. Governance still only *removes* capability; the supervisor only
  *reads* the removal to avoid wasted spawns.
- **It leans on the operational auditor (v6/M23) for the health it cannot babysit.** A spinner or
  an overspender is the auditor's flag to raise to a human, not the supervisor's to act on. The
  supervisor scales capacity; it does not judge workers.
- **Idempotent, concurrency-safe scaling.** Two supervisor ticks (or, later, two services) that
  both see the same pending work must **converge on capacity, never double-spawn into corruption**
  — leaning on the existing lease/`SKIP LOCKED`/one-task-per-instance guarantees
  ([0008](0008-verb-contracts.md), [0009](0009-leases-reaper.md)), which already make a
  redundantly-spawned worker harmless (it finds nothing to claim and idles). The service holds no
  truth the substrate doesn't; it is a fungible, restartable coordinator (vision: "indifferent to
  how many services there are or where they run").

### The termination property inverts (the ADR-level change)

v3/v4 proved "hands-off" partly *by termination*: the driver stopped when the board drained, and a
clean exit was evidence the run self-completed ([0020](0020-autonomous-run-topology.md): "keeps the
role pollers running until the board drains, then stops"). v7 **inverts** this: the service **does
not exit on an empty board** — it **idles** (sleeps, holding no workers) and **wakes** when work
appears. "Drained" is no longer "done"; it is "quiescent."

This is deliberately load-bearing, so it must not weaken the hands-off gate:

- **Idle is observable and cheap.** An idle service spawns nothing, holds no leases, and is plainly
  distinguishable from a stuck one (it is sleeping between polls, not blocked mid-task). The
  operational auditor's health watch (M23) already distinguishes *quiescent* from *stalled*; the
  service exposes its own liveness the same way (a heartbeat / status readable from the substrate
  or a local status file — settled in the design note).
- **Stop stays a first-class, clean act.** Retiring `make loop-run` must not lose the ability to
  *stop* the machine. The service has an explicit, graceful stop (drain-in-flight then halt, or
  halt-and-let-leases-lazy-reclaim) — the design note settles which. "Always-on" means "no human
  needed to *start* each round," not "impossible to turn off."
- **The hands-off proof survives.** A feature fed to a *running* service still reaches `main` with
  no human in the loop — the v3 gate — the only change being the owner did not start the run. If
  anything the property strengthens: hands-off across an *arbitrary* number of features over time,
  not one drain.

### Sequencing within v7 (service-flip first; channel behind the posture gate)

**Stage 1 — the standing service (this ADR's committed core).** Evolve `driver.sh` +
[0020](0020-autonomous-run-topology.md)'s pollers into an always-on **local** supervisor:
demand-driven wake, idle-safe quiescence, governance-consuming, auditor-leaning, cleanly
stoppable. **Fed exactly as today** (the owner's `INSERT`/CLI) — **no new external ingress**, so
[0025](0025-v7-security-posture-local-service.md) is, for Stage 1, a *documented posture* (local
bind, the standing-process change, the perimeter we are deliberately not yet crossing) rather than
a live external threat model.

**Stage 2 — the intake channel + human auth (committed to v7, gated).** The write path an external
Customer uses to talk to the intaker: intake endpoints (validate/sanitize/auth *before* input
becomes a row — the inbound mirror of [0015](0015-egress-as-capability.md)'s guarded egress) and a
**human/external identity distinct from the `agent` role**. This is the **first external ingress**
and **only proceeds under [0025](0025-v7-security-posture-local-service.md)** — which, per the
owner's first-stage call, keeps that ingress **local and light**: bound locally, authenticated via
the host's local user management and/or a pre-shared key, **not** public multi-tenant auth.

**Deferred past v7 — the UI, and public/multi-tenant exposure.** The read API is nearly free
(PostgREST), but a web UI is its own build and buys nothing the flip needs; it graduates to v7.x /
v8. Public-internet, multi-tenant human auth is explicitly **out of v7** (see out-of-scope) — v7's
ingress is local by decision.

### The v7 success gate

**v7 is "done" when the crank is gone: a feature is delivered to `main`, hands-off, by a service
the owner did not start for that feature — and the service idles safely before and after, on a
coherent `main`, adding no external attack surface beyond the local, lightly-authenticated intake
channel.** Concretely:

1. **The service runs standing and idles safely.** With an empty board it holds no workers and
   spawns nothing; when work is inserted it wakes, scales the right families to match, drains, and
   returns to idle — **without** a human running `make loop-run`. Its liveness (running / idle /
   the last tick) is observable.
2. **Hands-off delivery through the standing service.** A brief fed to the *running* service
   reaches `main` implemented/reviewed/integrated with no human in the loop — the v3 gate met by a
   process that did not exit between features. The supervisor made **no routing decision**; every
   claim was `SKIP LOCKED` self-claim, and it **skipped a temp-banned family** rather than spawning
   it uselessly.
3. **The intake channel is exercised locally (Stage 2), or explicitly deferred with the flip
   standing alone (Stage 1 gate).** If the channel ships: a request submitted through the local,
   authenticated intake endpoint becomes a `proposed_brief` (the M24 two-tier gate unchanged), and
   a non-authenticated / non-`role:intaker` submission is refused **at the channel and at the
   substrate** (defence in depth, [0025](0025-v7-security-posture-local-service.md)). If it does
   not: v7 ships as the standing service alone and the channel is the first v7.x slice — the flip
   is independently a version.
4. **`main` stays coherent; the supervisor never routed; governance still only removes.** The
   termination-inverts change introduced **no** ability to assign work, price tokens, or auto-ban;
   the always-on process is a demand-scaler that reads the same substrate truth every agent does.

### In scope for v7

- **The standing local supervisor** (Stage 1) — always-on, demand-driven, idle-safe, governance-
  consuming, auditor-leaning, cleanly stoppable; an **evolution of `driver.sh`**, not a rewrite
  (reuses `run_pool` / `run_concurrent` / `roles.sh::harness_sweep`).
- **The termination inversion** — drain-to-exit → idle-safe, with observable liveness and a clean
  stop, without weakening the hands-off gate.
- **The local intake channel + human/external auth** (Stage 2) — write endpoints for the intaker's
  Customer dialog, validate/sanitize/auth before a row exists, a human identity distinct from
  `agent`; **local and light** per [0025](0025-v7-security-posture-local-service.md).
- **The security-posture ADR up front** — [0025](0025-v7-security-posture-local-service.md), the
  gate on both the standing-runtime posture change and the (local) ingress.
- **The surfaces** — the service's own status/liveness readout, following the existing view +
  report-line pattern where it applies.

### Out of scope for v7 — deferred (constraints, not built)

- **Public / multi-tenant external ingress.** v7's channel is **local**, authenticated by the
  host's local user management and/or a pre-shared key. Internet-facing, multi-tenant human auth,
  TLS termination, rate-limiting-as-a-product — a later version, behind a heavier revision of
  [0025](0025-v7-security-posture-local-service.md). ("Do not overthink the first stage.")
- **The web UI.** The read API exists (PostgREST); a rendered UI is v7.x / v8. v7 is a *service*,
  not a *site*.
- **Cost-aware routing / any router.** The supervisor **scales**, it never **assigns**. Using v5's
  token signal to pick a family per task is a router (v8+, [idea-token-spend-metric]); any USD
  pricing lives at that later layer, never in the substrate or the supervisor.
- **Federating the bookends / the pull-queues as federation.** Intake and audit as *claimable
  pull-work across makers* (the vision's three-altitude model) is where the queues' value lives,
  and that is federation — v8+. v7 runs the roles on one local service.
- **The goal tier / dynamic bounded epics.** Unchanged from the vision's deferral; v7 runs the
  bootstrap project's standing lanes.
- **Horizontal scale / multi-service topology.** The invariant is designed *so that* multiple
  fungible services are safe later, but v7 stands up **one** local service. Pooling / replication /
  many-services-many-places is v8+.
- **Substrate-initiated egress (the outbox).** Still the clean future seam
  [0015](0015-egress-as-capability.md) named; v7's egress stays agent-driven, the supervisor issues
  no outbound calls.

## Bootstrap discipline (recursive)

As in v2–v6, v7 is built **on AINARRES**, aiming for as much as possible **built by the swarm**,
split by the **substrate-free-checkability** line the board-wipe taught, not by importance:

- **Assisted (mock-verified before live):** anything that touches **auth or the perimeter** — the
  human/external identity distinct from `agent`, the intake channel's validate/sanitize/auth, and
  the supervisor's **spawn/stop lifecycle** (a runtime that runs unattended and can spawn workers
  is trust-critical; a routing bug or a stuck non-idle is the exact class the operational auditor
  and this ADR guard against). Correct **before** it runs live.
- **Swarm-built (briefed, run hands-off):** the pure, substrate-free pieces — status/liveness
  formatters and report-lines (the M20–M24 report-line pattern, `npx vitest`, no DB), and
  self-contained supervisor helpers with deterministic unit checks. The dumb-formatter + guarded-
  fetch split, unchanged.

A pleasing recursion to aim for, as with M24's report-line: **let the standing service, once up,
deliver a later v7 slice hands-off** — the machine that no longer needs starting, building its own
next piece.

## Alternatives considered

- **Bundle the channel + UI into v7 (the full "standing service you talk to, with a web UI").**
  Rejected as against the throughline's baby-step discipline and this project's whole method:
  it makes the riskiest version also the widest, and couples the *internal* termination flip to the
  *external* ingress posture — two different risks that deserve to be proven apart. Staged instead
  (Stage 1 flip, Stage 2 local channel, UI later).
- **Channel first, then the runtime.** Rejected: the channel is the new *attack surface*; standing
  it up before the runtime it feeds is proven inverts the risk order. The flip adds **no** ingress
  and is the safe first move; the channel lands behind the posture gate once the service it talks
  to exists.
- **Public / multi-tenant auth from the start** (a "real" internet service). Rejected per the
  owner's first-stage call and the safe-foundations ethos: local user management and/or a
  pre-shared key is the smallest thing that makes "a service you talk to" true without a
  multi-tenant threat model. Public exposure is a deliberate later step, not v7's first stage.
- **A full daemon rewrite (systemd units per role, a message bus, etc.).** Rejected:
  [0020](0020-autonomous-run-topology.md) already chose "evolve the dumb driver" over per-role
  daemons for the first hands-off proof, and the same logic holds — the supervisor is a small
  evolution of `driver.sh` (the spawning machinery exists), not new infrastructure. A message bus
  regrows a coordinator we do not want.
- **Let the supervisor use spend/health to route** (spawn the cheap family first, skip the slow
  one). Rejected as the headline anti-goal: that is a router. The supervisor scales capacity for a
  *role*; the substrate still routes *tasks* by self-claim. Consuming governance (don't spawn a
  *banned* family) is reading an existing denial, not routing.

## Consequences

- The plan (`plans/v7-plan.md`) is **staged**: M25 (the standing local supervisor + termination
  inversion) first, then M26 (the local intake channel + human auth) behind
  [0025](0025-v7-security-posture-local-service.md); each fronted by / folded into
  `design/service.md`, which settles the decisions this ADR parks (idle/wake mechanics, the
  liveness signal, the graceful-stop shape, the channel's auth mechanism). Further ADRs fix any
  that prove ADR-level.
- **The termination property changes** for the first time since v3 — from a *gate* (exit ⇒ done) to
  an *invariant* (idle ⇒ quiescent, wake ⇒ work). The hands-off gate is **preserved** (delivery
  through a running service), not the exit that used to witness it.
- **`make loop-run` is retired** as the entry point (kept, perhaps, as a one-shot dev convenience);
  the owner's act becomes *start the service once* (or install it), not *pull the crank each run*.
- **First external ingress** enters the project — locally, lightly — under a posture ADR written
  **up front** ([0025](0025-v7-security-posture-local-service.md)), not retrofitted. The
  inbound/outbound symmetry with [0015](0015-egress-as-capability.md) (guarded egress ↔ guarded
  ingress) is made explicit.
- **No change to the capability core, the state machine, or governance.** The supervisor reads the
  same effective-features every agent reads; the channel writes through the same M24 two-tier gate;
  the auditor still only flags. v7 is a **runtime** around an unchanged substrate — which is
  precisely why v6 seated the roles first.
- The vision's **demand-scaler-never-router** invariant becomes *load-bearing code* for the first
  time (v1–v6 had no standing scaler to violate it). Getting it right here is what makes the
  federated, many-services future (v8+) safe.
