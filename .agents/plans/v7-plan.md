# Plan — AINARRES v7

> Scope and the gate are fixed by [ADR 0024](../decisions/0024-v7-scope-the-standing-service.md)
> (the standing service — retire the crank; always-on, local, demand-scaled) and its posture
> companion [ADR 0025](../decisions/0025-v7-security-posture-local-service.md) (local, lightly
> authenticated — the gate up front). Builds on the v3 run topology
> ([ADR 0020](../decisions/0020-autonomous-run-topology.md): the dumb driver + independent
> pollers), the M18 pool + merge queue ([`design/parallel-loop.md`](../design/parallel-loop.md)),
> leases + lazy reclaim ([ADR 0009](../decisions/0009-leases-reaper.md)), governance
> ([ADR 0022](../decisions/0022-v5-scope-governance.md) / M21 `governance_status`), the M23
> operational auditor ([`design/auditor-operational.md`](../design/auditor-operational.md)) and
> the M24 intake two-tier gate ([`design/intake.md`](../design/intake.md)). The mechanism is
> settled in [`design/service.md`](../design/service.md). Each milestone is one PR-sized slice
> that ends green, then a blog article (continues the *AINARRES* series). Steers by the
> [`analysis/vision.md`](../analysis/vision.md) compass — a service is a **demand-scaler, never a
> router** — banking its cheap forward-compatible decisions while taking deliberate shortcuts
> (below).

## The vision, and the shortcuts v7 takes (banked vs. deferred)

Per [`vision.md`](../analysis/vision.md), the long-run picture is **many fungible services running
from many places** over a **federated** substrate, with the bookends as **pull-queues** and a
demand-scaling supervisor that is indifferent to how many services exist. v7 stands up the
**first, single, local** instance of that and banks the invariant that makes the plural case safe:

- **Banked (fits the vision, costs little):** the **demand-scaler-never-router** invariant as
  *load-bearing code* (the supervisor scales capacity for a role when work is pending, never
  assigns a task to a worker); **idempotent, concurrency-safe scaling** (two ticks / a restart
  converge on capacity, never corrupt — leaning on `SKIP LOCKED` + leases); the service holding
  **no truth the substrate doesn't** (fungible, restartable); the channel as **guarded ingress**,
  the inbound mirror of [ADR 0015](../decisions/0015-egress-as-capability.md).
- **Deferred (value is federation / public exposure — v8+):** many services / horizontal scale;
  the bookends as **federated pull-queues** across makers; **public / multi-tenant** ingress (v7
  is local + light per [ADR 0025](../decisions/0025-v7-security-posture-local-service.md)); the
  **web UI** (v7.x); `LISTEN/NOTIFY` push-wake (idle-poll is the baby step); dynamic epics + the
  goal tier. v7 runs **one local service** on the bootstrap project.

## Objective

**Retire the crank.** Turn the owner-started, drain-to-exit batch loop into an **always-on, local
demand-scaling service** — a standing supervisor that wakes on pending work, drains it, and
**idles safely** when there is none, with no human running `make loop-run` per feature — and give
the v6 intaker its **local, authenticated write channel**. The headline is **runtime**: AINARRES
stops being a script you run and becomes a process that runs, the two v6 bookends finally *running*
rather than merely named. **Local and light** ([ADR 0025](../decisions/0025-v7-security-posture-local-service.md)):
no public/multi-tenant ingress, no new privilege, no new trust in workers.

## Success criterion ([ADR 0024](../decisions/0024-v7-scope-the-standing-service.md))

With `main` coherent and no new external attack surface beyond the local, lightly-authenticated
channel: (1) the service **runs standing and idles safely** — empty board ⇒ holds no workers,
spawns nothing; work inserted ⇒ it wakes, demand-scales the right families, drains, returns to
idle — **without** a human running `make loop-run`, with its liveness observable; (2) a brief fed
to the **running** service reaches `main` implemented/reviewed/integrated **hands-off** (the v3
gate, met by a process that did not exit between features), the supervisor making **no** routing
decision and **skipping** a temp-banned family rather than spawning it uselessly; (3) the local
intake channel is exercised — an authenticated request becomes a `proposed_brief` (M24 gate
unchanged), an unauthenticated / non-starter-role submission refused **at the channel and at the
substrate** (defence in depth) — **or** the channel is explicitly deferred to v7.x and the flip
ships as the standing service alone; (4) the supervisor **never routed**, governance still only
**removes**, the always-on process is a demand-scaler reading the same substrate truth every agent
does.

## Execution discipline

- **Branch → commit → push → PR** per milestone; owner reviews. Done = verified in the loop.
- **Driver/harness-side; substrate change expected to be ~zero.** Like M14 / M17 / M18, v7 is a
  runtime change over an unchanged coordination core. **If a design pressure wants a migration,
  stop and rethink** ([ADR 0003](../decisions/0003-two-plane-source-of-truth.md)) — the one
  permitted seed touch is M26's **human/external identity feature** (a role-feature seed row +
  grant, **not** a schema change); `governance_status` / `raise_operational_flag` already exist and
  are **read/used**, never added to.
- **The demand-scaler-never-router invariant is the non-negotiable.** The supervisor's demand gate
  stays **coarse** ("is there claimable work?") and the tiers self-select via `SKIP LOCKED`; it
  **never** picks which task or which worker. Any pressure toward per-task/per-family assignment is
  a regrown orchestrator — reject it.
- **The cost-control property survives the termination inversion.** Idle spawns nothing and holds
  no leases; a no-progress activation **flags a human and idles** (M23), it does **not** spin and
  does **not** exit (design/service.md D3). "Always-on" always keeps a **clean, graceful stop**.
- **Bootstrap discipline (aim: as much of v7 by the swarm as the split allows).** The
  **supervisor lifecycle** (idle/wake, graceful stop, `skip_if_banned`) and **all of M26** (auth +
  channel + the human identity — the perimeter) are built **assisted and mock-verified** before
  running live (a runtime that spawns unattended, and the first external ingress, must be correct
  first — exactly as M19 D4 / M22 Slice A / M24 Slice A were). The **pure status/liveness
  formatter + any report-line** are **swarm-built** (substrate-free, `npx vitest`, hands-off — the
  #87/#91/#117 slice). The recursion to aim for: once M25 is up, **let the standing service deliver
  M26's report-line slice hands-off**.
- One blog article per merged milestone (v7 arc opener: "the crank is gone").

## Dependency order

```
M25 the standing supervisor (idle-safe, demand-scaled, stoppable) ─▶ M26 the local intake channel + human auth
```
M25 first ([ADR 0024](../decisions/0024-v7-scope-the-standing-service.md)): it is the topology
flip and adds **no new ingress** — the safe first move, provable on the mock, and the runtime the
channel feeds. M26 carries the **first external ingress** (behind
[ADR 0025](../decisions/0025-v7-security-posture-local-service.md)) and is only responsible once
the service it talks to is proven. If time forces a stop after M25, v7 ships as the standing
service alone and M26 becomes the first v7.x slice — the flip is independently a version.

---

## M25 — The standing supervisor: idle-safe, demand-scaled, stoppable

**Goal:** invert the driver's drain-to-exit into an always-on idle/wake envelope — a standing
supervisor that runs an **activation** (the v6 round loop, verbatim) when the board has claimable
work and **idles** when it doesn't, consumes governance (skips temp-banned families), flags a
stuck board to a human instead of spinning or exiting, exposes its liveness, and stops cleanly.
([ADR 0024](../decisions/0024-v7-scope-the-standing-service.md); mechanism in
[`design/service.md`](../design/service.md) D1–D6)

> **Build split (two slices, mirroring M23/M24):** **Slice A** — the supervisor **lifecycle**
> (idle/wake, no-progress→stalled, graceful stop) via a shared `driver-lib.sh` (`run_activation`
> extracted from `driver.sh`), `service.sh`, the Makefile targets, and the mock lifecycle test —
> **assisted + mock-verified** (a runtime that spawns workers unattended is trust-critical; a
> routing-drift or a stuck-non-idle is the exact failure class this guards). **Slice B** —
> **governance consumption** (`skip_if_banned`, D6) assisted, plus the **pure status/liveness
> formatter** (`ainarres service-status` pretty readout + any report-line) — **swarm-eligible**
> (substrate-free, hands-off — the recursion target: let the running Slice-A service deliver it).

**Steps**
- **The idle/wake envelope (D1/D2)** — wrap `driver.sh`'s round loop: `active==0` ⇒
  `sleep LOOP_IDLE_POLL_SECS` and re-poll; `active>0` ⇒ run one activation (the existing round
  body: `LOOP_PRE_TIERS` → `run_pool` → `LOOP_SERIAL_TIERS` → `run_concurrent` frontier peers),
  which drains and returns to idle. The demand gate stays **coarse** — the tiers self-claim; the
  supervisor never routes.
- **No-progress → flag, not exit (D3)** — an activation whose rounds stop moving the board
  **stops scaling that work**, raises an M23 **operational flag** (stalled board — no auto-penalty)
  and **returns to idle**. Reuses the `board_sig`-unchanged / `LOOP_MAX_ROUNDS` guard as a
  per-activation circuit breaker; preserves the cost bound (no infinite spawn) without terminating.
- **Liveness status file (D4)** — write `RUN_DIR/service.status` (`pid`, `state ∈ {running,idle,
  stopped}`, `last_tick`, current activation/round); surface via `make service-status` /
  `ainarres service-status`. **No substrate row** — a service is fungible, holds no truth the
  substrate doesn't (a heartbeat *table* is v8/multi-service).
- **Graceful stop (D5)** — a `draining` flag on `SIGTERM` / `make service-stop`: finish the
  in-flight activation's current sweeps (`run_pool`/`run_sweep`/`run_concurrent` already reap), do
  not start a new round/activation, run the existing `stop_active` (kill/gc/xdg), exit 0. A hard
  kill stays safe via leases + `release_stranded` + lazy reclaim (unchanged).
- **Consume governance (D6)** — `skip_if_banned`: before spawning a tier, read `governance_status`;
  skip the spawn if that tier's family is temp-banned for its role's capability. **Best-effort** —
  an unreadable `governance_status` degrades to "spawn anyway" (measured-not-enforced resilience);
  log the degrade. Reading a denial, **not** routing.
- **Entry points** — `make service` (start), `make service-stop`, `make service-status`;
  `make loop-run` **kept** as a one-shot dev convenience (bounded drain-to-exit; still the right
  tool for a quick local build / the mock selftest).

**Done-tests** (deterministic on `LOOP_MODE=mock`, then the real gate run)
- A service started against an **empty** mock board **idles**: it spawns no harness, holds no
  lease, and `service-status` reads `idle` — verified over multiple poll ticks.
- A brief inserted **mid-idle** wakes the service on the next tick; it drains the mock board green
  (a feature reaches a terminal stage) and **returns to idle** — no human re-ran anything.
- A **second** brief inserted after the first drains is a **second activation** with **no restart**
  — proving the process persists across features.
- A no-progress mock board (a task no tier can move) makes the supervisor **raise an operational
  flag and idle** — it neither spins (bounded rounds) nor exits; `service-status` distinguishes
  "idle-because-drained" from "idle-because-flagged-stuck".
- `service-stop` **mid-activation** drains the in-flight sweeps, halts without starting a new round,
  and leaves `main` coherent with no orphaned worker; a hard kill leaves the held task reclaimable.
- `skip_if_banned` skips spawning a temp-banned family (a `governance_status` fixture); an
  unreadable `governance_status` spawns anyway and logs the degrade.
- The pure status formatter is unit-tested substrate-free (`npx vitest`); the existing suite green.
- **Gate run (real):** a feature delivered to `main` hands-off by a service the owner did **not**
  start for that feature — the supervisor made **no** routing decision, every claim `SKIP LOCKED`.

**Blog:** "The crank is gone: AINARRES as a standing service."

## M26 — The local intake channel: the intaker's write path, lightly authenticated

**Goal:** give the v6 intaker a **local, authenticated write channel** — a loopback-bound endpoint
that authenticates a caller (pre-shared key), maps them to a **human/external identity distinct
from `agent`** carrying only request-creation, validates/sanitizes the input, and creates a
`proposed_brief` through the **unchanged M24 two-tier gate**. The **first external ingress**,
kept local + light. ([ADR 0025](../decisions/0025-v7-security-posture-local-service.md); mechanism
in [`design/service.md`](../design/service.md) D7)

> **Build split:** **all of M26 is assisted + mock-verified** — auth, the channel, and the human
> identity are the perimeter; the first external ingress must be correct before it runs live
> (the M19-D4 / M22-Slice-A / M24-Slice-A rule). The **report-line for intake-via-channel** (if
> any surface changes) is swarm-eligible and the recursion target: **let the running M25 service
> deliver it hands-off**.

**Steps**
- **The loopback endpoint (D7)** — a thin, `127.0.0.1`-bound handler in front of the existing
  intake create (an HTTP handler — UI-forward, since PostgREST already speaks HTTP — or a
  `service intake` subcommand; the slice picks). Binds locally only; nothing public.
- **PSK auth before a row exists (D7)** — authenticate the caller with a **pre-shared key** per
  request; refuse unauthenticated calls **at the channel** (local-user / socket-peer credentials
  are the noted alternative — same local perimeter, not ADR-level).
- **A distinct human identity (D7)** — the authenticated caller acts as a **human/external**
  identity (not `agent`; a seed **role-feature** for request-creation — `role:intaker`-equivalent,
  **no** `capability:integrate`, no decompose, no advance). The one permitted seed touch of v7.
- **Validate/sanitize + create via the unchanged gate (D7)** — sanitize input to the brief shape,
  then call the **existing** M24 intake create; the **substrate's D4 gate is the inner wall**
  (defence in depth). No new create path, no gate change.

**Done-tests** (assisted / mock-verified)
- An **authenticated** request through the channel becomes a `proposed_brief` in the `intake` lane
  (M24 gate unchanged); a running M25 service then delivers it hands-off end-to-end.
- An **unauthenticated** request is refused **at the channel** (no row written).
- A request whose identity **lacks the starter role** is refused **at the substrate** even if it
  reaches the create path — proving the channel is not the only wall (defence in depth).
- The channel binds loopback only (not reachable off-host); the human identity holds **no**
  `capability:integrate` and cannot advance/decompose.
- Down-migration (if a seed feature was added) drops only the human-identity feature; no schema
  change to remove.

**Blog:** "A door, not a crank: the intaker's local channel."

---

## Open questions (settled within [`design/service.md`](../design/service.md))

- **M25:** the supervisor is the **existing round loop with the exit inverted to idle**, wake =
  interval poll (D1); the demand gate is **coarse**, tiers self-select — no routing (D2);
  no-progress **flags a human and idles**, never spins or exits (D3); liveness is a **local status
  file**, not substrate truth (D4); graceful stop = **stop-new-activations + reuse `stop_active`**
  (D5); governance is **consumed** via best-effort `skip_if_banned` (D6).
- **M26:** the channel authenticates with a **pre-shared key over loopback**, maps to a **distinct
  human identity** carrying only request-creation, and the **M24 D4 gate is the inner wall** (D7);
  the endpoint is a thin front over the **unchanged** intake create (no new create path).

## Deferred to v7.x / v8+

- **The web UI (v7.x).** The read API is nearly free (PostgREST); a rendered kanban UI is its own
  build and buys nothing the flip needs. v7 is a *service*, not a *site*.
- **Public / multi-tenant external ingress.** v7's channel is **local + light**
  ([ADR 0025](../decisions/0025-v7-security-posture-local-service.md)); internet-facing,
  multi-tenant auth, TLS, rate-limiting-as-a-product require a **revision of ADR 0025** with the
  named widening contract (TLS, rotatable credentials, per-caller authZ, rate limiting, egress
  re-review).
- **`LISTEN/NOTIFY` push-wake.** Idle-poll (D1) is the baby step; push-wake lowers latency and
  removes idle polling — a clean future optimization, no substrate coupling now.
- **Federating the bookends as pull-queues, and many services / horizontal scale.** The
  three-altitude pull model and the fungible-multi-service topology are where the queues' value
  lives — that is federation, **v8+**. v7 runs **one** local service; the demand-scaler invariant
  is built so the plural case is safe later.
- **Cost-aware routing.** The supervisor **scales**, it never **assigns**; using the token signal
  to pick a family per task is a **router** ([[idea-token-spend-metric]]) — a v8+ layer, and the
  only place USD pricing ever lives (never the substrate).
- **Substrate-initiated egress (the outbox).** Still the clean future seam
  [ADR 0015](../decisions/0015-egress-as-capability.md) named; v7's egress stays agent-driven, the
  supervisor issues no outbound calls.
- **A rich Customer↔Intaker dialog.** v7's channel accepts a request and the human refines the
  brief; a real elicitation back-and-forth is a later slice (v6's recorded honest limit).
