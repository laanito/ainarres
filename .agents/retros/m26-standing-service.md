# Retro — the standing service (v7's core: M25 + M26)

- Date: 2026-08-19
- PRs: design set #119 (ADR 0024 scope + ADR 0025 security posture + `design/service.md` +
  `plans/v7-plan.md`); **M25** — Slice A the supervisor #120 (+ the flake root-cause fix folded
  in), Slice B `skip_if_banned` (assisted) #121, Slice B the `service-status` formatter #123
  (**built hands-off by the swarm**); **M26** — the local intake channel #122; retro this PR.
- Plan: [v7-plan.md](../plans/v7-plan.md) · Design: [service.md](../design/service.md)
- Implements: [ADR 0024](../decisions/0024-v7-scope-the-standing-service.md) (the standing
  service) + [ADR 0025](../decisions/0025-v7-security-posture-local-service.md) (local, light
  security posture — the first external-ingress gate). Completes **v7's core**.

## What shipped

v6 named every role in the chain; the human still **started the machine** and still **hand-fed
every brief**. v7's core removes both — the last two things the orchestrator did with its hands:

- **M25 — the standing service.** `make loop-run` (owner-started, decompose-once, drain,
  **exit**) became `loop/service.sh`: an always-on supervisor that **idles** when the board is
  empty and **wakes** to run one *activation* (the v6 round loop, verbatim) when work appears —
  **never exiting between features**. The termination property **inverted** (drain-to-exit →
  idle-safe) without weakening the hands-off gate (delivery through a *running* process). It
  **consumes governance** (skips spawning a temp-banned family) and reports its own liveness
  (`service-status`). An **evolution of the dumb driver, not a rewrite**: the round body,
  spawn/reap primitives, and teardown were *lifted verbatim* into a shared `driver-lib.sh`; the
  service and the (kept) batch driver share one tested implementation.
- **M26 — the local intake channel.** The **first external ingress** this project has ever
  taken: `bin/intake-server.mjs`, a loopback-bound HTTP endpoint an external Customer POSTs a
  request to, PSK-authenticated, which opens a `proposed_brief` in the intake lane **as a
  distinct human identity** (`human+intaker`, holding *only* `lane:intake` + `role:intaker`).
  The inbound mirror of the integrator's guarded egress ([ADR 0015](../decisions/0015-egress-as-capability.md)).

With both, the substrate's claim reads, for the first time end to end: *no orchestrator, many
makers at once, the workflow removes capability from the unfit, hard cases reach a human — and
the machine now **runs itself**, waking on work and idling when there is none, with an
authenticated door a request comes in through.*

## The gate result (ADR 0024 success criterion — all four met)

1. **The service runs standing and idles safely** — empty board ⇒ holds no workers, spawns
   nothing; work inserted ⇒ it wakes, demand-scales, drains, returns to idle, no human running
   `make loop-run`. Proven deterministically by `service-selftest.sh` (idle → wake → drain →
   idle → **second activation, same pid, no restart** → clean stop).
2. **Hands-off delivery through the running service** — the swarm brief for M25 Slice B's own
   formatter was delivered to `main` by the service pattern, hands-off (#123), the supervisor
   making **no** routing decision (every claim `SKIP LOCKED`).
3. **The local channel is exercised** — a PSK'd POST becomes a `proposed_brief` (M24 gate
   unchanged); missing/wrong PSK → 401, no row; the identity is refused a dev create and holds no
   integrate (defence in depth). Live E2E smoke + `test/intake-channel.test.ts` both green.
4. **`main` coherent; the supervisor never routed; governance still only removes** — the
   termination inversion added no ability to assign work, price tokens, or auto-ban.

## The v7 arc (findings, load-bearing)

1. **A standing service decomposes *continuously* — the batch driver did not.** The mock service
   selftest caught it immediately: directly-inserted `proposed` tasks **poisoned to `blocked`**
   because the service's tier set had no decomposer. The batch driver runs the designer *once,
   upfront, on the brief*; a service keeps seeing new proposed work (from inserts, and — M26 — the
   channel) and must decompose each round. Fix: `LOOP_DESIGN_TIERS=(designer)` as a standing
   per-round poller — the **one activation-shape difference** between the batch driver (empty)
   and the service. A property that only surfaces once the loop never ends.
2. **The flake we chased was a real product bug, not a test artifact.** `heartbeat.test.ts` had
   been dismissed as "a timing flake on a loaded box." Chasing it (the owner's call — *a test we
   routinely ignore is worse than none*) found the truth: the CLI's long-lived `--watch` loops
   reused a keep-alive socket PostgREST had closed, and **undici stalled ~3s reconnecting** — so
   every beat after the first came ~3s late and a short lease lapsed. Measured cleanly: beat 1 =
   34ms, beats 2-6 = **exactly ~3019ms**. `Connection: close` per request fixed it; the suite is
   now 278→**green with no "ignore the 1" exception**. The lesson: a standing, long-lived process
   exposes latent bugs a short-lived CLI never did — and "flaky" is often a real defect wearing a
   disguise.
3. **The stall signal met the substrate and yielded — again.** `design/service.md` D3 said a
   no-progress activation "raises an M23 operational flag." At build time: `raise_operational_flag`
   is **family+capability-scoped**, but a *whole-board* stall has no single family to blame — and
   stranded *claims* (which do) are already surfaced by the M23 health watch. So the service's
   "flag" is a local **`stalled`** state (status file + loud log) that refuses to re-activate a
   stuck board until its signature changes; it raises no redundant, un-attributable substrate flag.
   The same substrate-meets-design yield as M21/M22/M24 — the correct-first core is the cheap place
   for it to surface.
4. **The human identity is a *registered family*, not a new feature.** M26 D7 planned "a
   role-feature grant"; the build found `role:intaker`/`lane:intake` already existed (M24), and
   `create_task`'s `ensure_agent` needs the caller's **family registered** (ADR 0007). So the
   channel's identity is the **roster pattern applied to a human** — `human+intaker`, holding only
   `[lane:intake, role:intaker]`. The M19 "add a worker" move, for a person.
5. **Concurrency is a test hazard too.** M26's first tests asserted on the *shared* intake-lane
   count; they passed in isolation and **failed in the full suite** (vitest runs files
   concurrently; other intake tests race the lane). Fixed by asserting on **unique per-request
   markers**. The [loop-board-pollution] lesson, one altitude up: a test that counts shared state
   is a flake waiting to happen.
6. **The demand-scaler-never-router invariant became load-bearing code.** v1–v6 had no standing
   scaler to violate it. M25 made the gate deliberately **coarse** — "is there active work?" — so
   it *structurally cannot* route; the tiers self-claim via `SKIP LOCKED` exactly as before.
   Getting this right on one local service is what makes the federated many-services future safe.

## Bootstrap honesty (ADR 0024 § recursive)

- **Assisted + mock-verified:** the **supervisor lifecycle** (idle/wake, graceful stop,
  `skip_if_banned`) and **all of M26** (auth + channel + the human identity — the perimeter, the
  first external ingress; correct-before-live per the M19-D4 / M22-A / M24-A rule). Both are
  trust-critical: a runtime that spawns unattended, and a door to the outside.
- **Built hands-off by the swarm:** the M25 Slice B **`service-status` formatter** (#123) — a
  pure formatter + a thin file-reading command, substrate-free to validate. Designer(`opus`) →
  implementer(`opencode+big-pickle`) → reviewer(`claude-code+sonnet`) →
  **integrator(`grok+grok-4.6`, autonomous merge)**, board draining clean. **The recursion
  landed:** the standing service's own liveness readout was built by the swarm the service runs.

## Decisions that held up

- **Service-flip first, channel second, UI/public deferred** (ADR 0024 breadth). Staging the
  *internal* termination flip apart from the *external* ingress kept the riskiest version from
  also being the widest. The flip added zero attack surface; the channel landed behind the posture
  gate, local and light.
- **Local + light, up front** (ADR 0025). A single-host, single-owner, loopback, PSK posture —
  with the *widening contract* written down (TLS, rotatable creds, per-caller authZ, rate-limit,
  egress re-review) so "light now" is not "trap later." The server enforces the posture **in
  code** (refuses a non-loopback bind or a missing PSK).
- **Evolution, not rewrite.** `driver.sh` already held every primitive; the service is the round
  loop with its exit inverted. `make loop-run` was **kept** as the one-shot batch/mock tool,
  retired only as the *entry point*.

## Honest limits (carried to v7.x / v8)

- **No web UI.** The read API is nearly free (PostgREST) but a rendered kanban is its own build —
  v7.x. v7 is a *service*, not a *site*.
- **Ingress is local + single-owner.** Public / multi-tenant / remote requires a **revision of
  ADR 0025** meeting the named widening contract. Not crossed yet, by decision.
- **Idle-poll, not push.** Wake is an interval poll; `LISTEN/NOTIFY` push-wake is the clean future
  optimization (lower latency, no idle polling), deferred to avoid substrate coupling now.
- **One local service.** The demand-scaler invariant is built *so that* many fungible services are
  safe, but v7 stands up one; federated pull-queues (intake/audit as claimable cross-maker work)
  are the v8 move.
- **The intaker's dialog is still one-shot.** The channel accepts a request and the human refines
  the brief; a real Customer↔Intaker back-and-forth is a later slice.

## What's next

**v7's core is complete** — the crank is retired and the intaker has a real (local) door. The
loop was always scaffolding; the service is the thing it was scaffolding for. Deferred to v7.x/v8
(above): the web UI, wider ingress behind a heavier ADR 0025, push-wake, and the federated,
many-services topology the invariant was built to make safe. Owner's call after the pause. Blog
installment 11 ("The crank is gone") accompanies this.
