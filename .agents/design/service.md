# The standing service: from a crank you pull to a process that runs

> Design note for **v7** ([ADR 0024](../decisions/0024-v7-scope-the-standing-service.md) ·
> [ADR 0025](../decisions/0025-v7-security-posture-local-service.md) ·
> [plans/v7-plan.md](../plans/v7-plan.md)). Settles the mechanism the two scope ADRs parked.
> Builds directly on the v3 run topology ([ADR 0020](../decisions/0020-autonomous-run-topology.md):
> the dumb driver + independent pollers), the M18 pool + merge queue
> ([`parallel-loop.md`](parallel-loop.md)), leases + lazy reclaim
> ([ADR 0009](../decisions/0009-leases-reaper.md)), governance
> ([ADR 0022](../decisions/0022-v5-scope-governance.md) / M21 `governance_status`), the M23
> operational auditor ([`auditor-operational.md`](auditor-operational.md)) and the M24 intake
> two-tier gate ([`intake.md`](intake.md)).

## What v7 is for

v6 named every role in the chain; the human still **starts the machine**. Each feature begins
with someone typing `make loop-run BRIEF=…` and ends when `loop/driver.sh` drains the board and
`exit`s. v7 removes that last touch-point: the driver's **round loop becomes a standing
supervisor** — always-on, waking on pending work, **idling safely** when there is none, never
started by hand per feature. AINARRES stops being a script you run and becomes a process that
runs. The two v6 bookends get their *runtime*; their *channel* (a local, authenticated intake
write path) follows in the same version, behind the posture gate.

**This is an evolution of the dumb driver, not a rewrite** ([ADR 0024](../decisions/0024-v7-scope-the-standing-service.md)).
`driver.sh` already holds every primitive: the round body (`LOOP_PRE_TIERS` → `run_pool` →
`LOOP_SERIAL_TIERS` → `run_concurrent` frontier peers), `stop_active` (subtree kill + worktree
gc + `release_stranded`), and the wipe-vs-drain guard. v7 changes **one thing structurally**:
the loop's `break`-then-`exit` on drain becomes **sleep-then-re-poll**, plus a liveness signal, a
graceful stop, and a governance-aware spawn. Everything else is reused verbatim.

## What changes: from drain-to-exit to idle-safe

```
v3–v6 (batch):   owner runs `make loop-run BRIEF` → decompose → rounds → board drains → EXIT 0
                 (termination IS the hands-off evidence — the process ends)

v7 (service):    owner starts the service ONCE → ┌──────────────────────────────────┐
                                                 │ poll board                         │
                                                 │  ├─ work pending? → one activation │  ← reuse the
                                                 │  │    (a round-loop, drains it)     │    ENTIRE v6
                                                 │  └─ empty?        → IDLE (sleep)    │    round body
                                                 │ wake on next tick ─────────────────┘
                                                 └── stop signal → drain in-flight, halt cleanly
                 (quiescence, not exit — the process stays; hands-off is proved by DELIVERY)
```

The batch driver's "one run = decompose once, drain, exit" becomes "**one activation** =
drain whatever is currently claimable, then return to idle." A feature fed to the *running*
service is one activation; the next feature is the next activation; the process never exits
between them.

## Decisions (the parked questions, settled)

**D1 — The supervisor is the existing round loop with the exit inverted to idle; wake is an
interval poll.** The `while true` round body in `driver.sh` (pre-tiers → pool → serial → frontier
peers) is kept **as-is** — it already drains the board demand-scaled. What changes is the loop's
*envelope*: instead of `break` on `active==0` and then `exit`, an empty board triggers
**`sleep $LOOP_IDLE_POLL_SECS`** and a re-poll. When a poll finds claimable work, the supervisor
runs an activation (the round loop, exactly as v6 runs it), which drains and returns to the idle
poll. **Wake = the next poll tick** — the dumbest robust mechanism, matching the "dumb driver"
rule. (A `LISTEN/NOTIFY` push-wake is a clean future optimization — lower latency, no idle polling
— but polling is the baby step and adds no substrate coupling; noted, not built.)

**D2 — The demand gate stays coarse: an activation runs when there is *any* claimable work, and
the tiers self-select — no per-task, no per-family routing.** The supervisor's only question is
the substrate's board signature it already reads (`counts()` → active/blocked). `active > 0` →
run an activation; `active == 0` → idle. Within an activation the tiers self-claim via
`SKIP LOCKED` exactly as today — the supervisor never decides *which* task or *which worker*.
This is the [ADR 0024](../decisions/0024-v7-scope-the-standing-service.md) **demand-scaler-never-
router** invariant made literal: the coarsest possible gate ("is there work?") is also the one
that structurally *cannot* route. (A later efficiency — waking only the tiers whose role has
claimable work, to avoid spawning a reviewer when only `implementing` work exists — stays
**role-level, never task-level**, and is explicitly deferred so the first cut cannot drift toward
routing.)

**D3 — No-progress no longer terminates; it stops scaling that work, flags a human, and idles.**
In batch mode a full round that moved nothing meant "stop, we're done/stuck" → `exit`. A standing
service must not exit, but also must not **spin** (the cost-control property is non-negotiable —
[`parallel-loop.md`](parallel-loop.md) D4). So the `LOOP_MAX_ROUNDS` / board-signature-unchanged
guard becomes a **per-activation circuit breaker**: if an activation's rounds stop progressing the
board, the supervisor **stops scaling that stuck work**, raises it to the human via the M23
**operational auditor's health path** (a stalled/stranded flag — no auto-penalty, the M22/M23
shape), and **returns to idle**. It does not burn tokens re-spawning against a stuck board, and it
does not die — the stuck feature waits for a human exactly as a batch no-progress run does today,
only the process survives to serve the next feature. Cost bound preserved; termination replaced by
quiescence-plus-a-flag.

**D4 — Liveness is a local status file, not substrate truth.** A service is a **fungible,
stateless coordinator** ([vision](../analysis/vision.md): "the substrate has no concept of which
service"); it must hold **no** truth the substrate doesn't. So its own liveness — `pid`, `state`
(`running` | `idle`), `last_tick`, and the current activation's round — lives in a **local status
file** under `RUN_DIR` (beside the sweep logs), read by a `make service-status` / an `ainarres
service-status` readout. Work-in-flight is *already* substrate-visible (the board / M16 `active`);
the status file only answers "is the process alive and what is it doing right now," which is a
property of the process, not the coordinated work. A **heartbeat *table*** (so multiple services
or a remote reader can see liveness) is a **v8/multi-service** concern — deferred, because v7 is
one local service and a file is the honest minimum.

**D5 — Graceful stop = stop accepting new activations, drain the in-flight one, then the existing
teardown.** Retiring `make loop-run` must not cost the ability to *stop* the machine
([ADR 0024](../decisions/0024-v7-scope-the-standing-service.md) §termination). A stop signal
(`SIGTERM` to the supervisor, or a `make service-stop`) sets a **draining** flag: the supervisor
finishes the in-flight activation's current sweeps — `run_pool` / `run_sweep` / `run_concurrent`
**already reap before returning**, so no worker is abandoned mid-git — declines to start a new
round or activation, then runs the **existing `stop_active`** (subtree kill of anything still
live, worktree `gc`, XDG cleanup) and exits. A **hard** kill remains safe with zero new work:
leases + `release_stranded` + lazy reclaim ([ADR 0009](../decisions/0009-leases-reaper.md)) already
guarantee a killed worker's task is reclaimed and `main` stays coherent. "Always-on" means "no
human needed to *start* each feature," never "cannot be turned off."

**D6 — Consume governance: skip spawning a temp-banned family; never enforce, never route.**
Before an activation spawns a tier, the supervisor reads M21's **`governance_status`** (the same
denial the substrate already enforces via `effective_features`); if that tier's family is
**temp-banned for the capability its role needs**, the supervisor **skips that spawn** for the
activation. This is pure waste-avoidance — a spawned-anyway banned family would simply fail to
claim (harmless) — so the skip is **best-effort and non-blocking**: a `governance_status` read
that errors degrades to "spawn anyway," preserving the M18/M19 **measured-not-enforced**
resilience (a governance read being down never stalls the loop). Reading a denial to avoid a
useless spawn is **consuming** governance ([ADR 0024](../decisions/0024-v7-scope-the-standing-service.md)),
not routing — the supervisor still never picks *who* does *what*; it only declines to launch a
worker the substrate would reject anyway.

**D7 — The Stage-2 channel authenticates with a pre-shared key over loopback, maps to a distinct
human identity, and the substrate's D4 gate is the inner wall.** Per
[ADR 0025](../decisions/0025-v7-security-posture-local-service.md) (local, light):

- The intake channel is a **thin, loopback-bound endpoint** (an HTTP handler in front of the
  create path, or a `service intake` subcommand — the plan picks; HTTP is the UI-forward choice
  since PostgREST already speaks it). It authenticates the caller with a **pre-shared key**
  presented per request (the smallest portable mechanism; **local-user / socket-peer credentials**
  are the noted alternative, and *both* land in the same single-owner local perimeter, so the
  choice is not ADR-level). No anonymous write reaches a row.
- An authenticated caller acts as a **human/external identity distinct from the `agent` role**
  ([ADR 0007](../decisions/0007-auth-identity-family-grant-deny.md)). It carries **only**
  request-creation (a `role:intaker`-equivalent grant to open a `proposed_brief`) — **never**
  `capability:integrate`, never designer decomposition, never advance. The channel widens *who may
  start a request*, not *what may be done*.
- **Defence in depth:** the channel is the outer wall; the **unchanged M24 two-tier create-gate**
  is the inner one. A submission that somehow reaches the substrate without the starter role is
  refused **there** too ([ADR 0024](../decisions/0024-v7-scope-the-standing-service.md) gate #3) —
  a channel bug cannot grant a capability the substrate withholds. The channel validates/sanitizes
  input to the brief's shape before persisting (the inbound mirror of
  [ADR 0015](../decisions/0015-egress-as-capability.md)'s guarded egress).

## The supervisor, concretely

The evolution of `driver.sh`'s tail, in pseudocode (the round body is unchanged from v6):

```
start:  ensure loop substrate reachable; write status(state=idle, pid); trap stop → draining=1
loop forever:
    if draining: break
    read active,blocked from board
    if active == 0:
        status(state=idle); sleep LOOP_IDLE_POLL_SECS; continue
    status(state=running, activation=N)
    # ── one activation: the v6 round loop, verbatim, with D3/D6 folded in ──
    rounds=0
    while active>0 and not draining:
        rounds++; before=board_sig
        for tier in PRE_TIERS:        skip_if_banned(tier) || run_sweep(tier)
        run_pool(POOL_TIER, POOL_SIZE, skip_if_banned)
        for tier in SERIAL_TIERS:     skip_if_banned(tier) || run_sweep(tier)
        run_concurrent(FRONTIER_PEERS, skip_if_banned)
        read active,blocked; after=board_sig
        if active==0: break
        if after==before or rounds>=MAX_ROUNDS:
            raise_operational_flag(stalled board)   # D3: flag a human, DON'T exit
            break
    # ── activation done: back to idle ──
stop:   drain in-flight (already reaped), stop_active (kill/gc/xdg), status(state=stopped), exit 0
```

Note what is **identical** to v6: `run_pool` / `run_sweep` / `run_concurrent`, the tier order
(`roles.sh`), `SKIP LOCKED` self-claim, the merge queue (the single grok integrator), the
wipe-vs-drain guard, `stop_active`. The **only** new lines are the outer `idle/sleep/wake`
envelope (D1/D2), the no-progress→flag-not-exit swap (D3), the status-file writes (D4), the
`draining` flag (D5), and `skip_if_banned` (D6).

## The intake channel, concretely (Stage 2 / M26)

```
Customer → [ loopback endpoint ]            ← PSK auth (D7); reject unauth here
              │  validate/sanitize → brief shape
              ▼
           mint/hold a HUMAN identity token (request-creation only, ≠ agent, no integrate)
              │
              ▼
           create_task in the `intake` lane  ← M24 two-tier gate UNCHANGED (inner wall)
              │                                   refuses if the starter role is absent
              ▼
           proposed_brief row  → the loop (a running activation) picks it up hands-off
```

The channel adds **no new create path** — it is a thin authenticated front over the *existing*
M24 intake create. The intaker's dialog (the back-and-forth to shape the request) is, in v7,
still minimal: the endpoint accepts a request and the human refines the brief; a rich Customer↔
Intaker conversation is a later slice (the honest limit v6 already recorded).

## Scope: driver/harness-side; substrate change expected to be ~zero

Like M14 / M17 / M18, the standing service (M25) is a **driver + harness** change — the substrate
already coordinates, leases, and governs everything the supervisor reads. **If a design pressure
here wants a migration, that is a signal to stop and rethink** ([ADR 0003](../decisions/0003-two-plane-source-of-truth.md)):
the substrate is the coordination layer, not the runtime. The one place M26 *might* touch seed is
a **human/external identity feature** for the channel caller — and even that should ride the
existing role-feature model (a seed row + grant), **not** a schema change. `governance_status` and
`raise_operational_flag` (M21/M23) already exist; the supervisor **reads/uses**, it does not add.

`make loop-run` is **retired as the entry point** but **kept as a one-shot dev convenience** (a
bounded drain-to-exit run is still the right tool for a quick local build / the mock selftest).
The new surface is `make service` (start), `make service-stop`, `make service-status`.

## Slicing (build order within v7)

1. **M25 — the standing supervisor.** Invert the driver's exit into the idle/sleep/wake envelope
   (D1/D2), the no-progress→flag (D3), the status file (D4), the graceful stop (D5), and
   `skip_if_banned` (D6). `mock-harness.sh` proves it deterministically: a service started against
   an **empty** mock board idles (spawns nothing, holds no leases); a brief inserted mid-idle wakes
   it, drains green, and it returns to idle; a second brief is a second activation with no restart;
   `service-stop` mid-activation drains-then-halts leaving `main` coherent. The gate run: a real
   feature delivered to `main` by a service the owner did **not** start for that feature.
2. **M26 — the local intake channel + human auth.** The loopback endpoint + PSK auth (D7), the
   distinct human identity, validate/sanitize, riding the unchanged M24 gate. Verified: an
   authenticated request becomes a `proposed_brief`; an unauthenticated one is refused at the
   channel; a request lacking the starter role is refused at the substrate (defence in depth). The
   running service (M25) then delivers it hands-off.

Each slice ends green (`loop-selftest` extended for idle/wake + the existing suite). One blog on
merge per slice (the series continues): *"The crank is gone: AINARRES as a standing service."*

## Build split (recursive, per [ADR 0024](../decisions/0024-v7-scope-the-standing-service.md) §bootstrap)

- **Assisted (mock-verified before live):** the **supervisor lifecycle** (idle/wake, graceful
  stop, `skip_if_banned`) — a runtime that runs unattended and spawns workers is trust-critical,
  and a routing-drift or a stuck-non-idle is exactly the failure class this note guards; and **all
  of M26** (auth + channel + the human identity — the perimeter, correct before live per the
  M19-D4 / M22-Slice-A / M24-Slice-A rule).
- **Swarm-built (briefed, run hands-off):** the pure, substrate-free pieces — the **status/liveness
  formatter** and any **report-line** for the service state (the M20–M24 pure-formatter pattern,
  `npx vitest`, no DB), and self-contained helpers with deterministic unit checks. The pleasing
  recursion to aim for: once M25 is up, **let the standing service deliver M26's report-line slice
  hands-off** — the machine that no longer needs starting, building its own next piece.

## Open risks (honest)

- **Idle cost / poll latency trade-off.** A short `LOOP_IDLE_POLL_SECS` wakes fast but polls more;
  a long one is cheap but laggy. Polling spawns nothing and holds no leases, so idle cost is a
  cheap board read — but this is the obvious first thing `LISTEN/NOTIFY` push-wake removes (future).
- **The circuit breaker must not mask a real stall as "idle."** D3 returns to idle *after flagging*
  — the flag (M23) is what a human sees; if the flag path itself is silent, a stuck feature could
  look like a quiet service. The status file (D4) plus the operational auditor's surface must make
  "idle-because-drained" and "idle-because-a-feature-is-stuck-and-flagged" clearly distinguishable.
- **`skip_if_banned` degrade path.** If `governance_status` is unreadable, the supervisor spawns
  anyway (resilience over optimization) — correct, but it means a governance outage silently
  reverts to "waste a spawn," which is fine for cost but should be visible (log it).
- **The channel is the first external ingress.** Even local + PSK, it is new surface; M26 is
  assisted + mock-verified precisely for this, and the substrate's D4 gate is deliberately kept as
  the inner wall so the channel is never the *only* thing standing between a caller and a row.
- **Single laptop, one service still.** v7 stands up *one* local service; the demand-scaler
  invariant is designed so many fungible services are safe later, but that (and the pull-queues'
  federation value) is v8 — not exercised here.
