# ADR 0027 — v7.1: push-wake (LISTEN/NOTIFY replaces the idle poll — as an optimization over it, never instead of it)

- Status: Accepted
- Date: 2026-08-20
- Builds on: [0024](0024-v7-scope-the-standing-service.md) (v7 — the standing service; ADR 0024 D1
  chose an **interval poll** as "the dumbest robust mechanism" and named `LISTEN/NOTIFY` push-wake
  "a clean future optimization … noted, not built" — this ADR builds it),
  [0026](0026-v7-1-demand-shaped-scaling.md) (its v7.1 companion — *what* the woken service spawns;
  this decides *when* it wakes), [0003](0003-two-plane-source-of-truth.md) (the substrate is the
  coordination layer, the driver is the runtime — a migration here is a signal to justify, which
  this ADR does), [0009](0009-leases-reaper.md) (lazy reclaim — the case NOTIFY *cannot* signal,
  which is why the poll stays), and the README roadmap's already-blessed `LISTEN/NOTIFY` outbox
  pattern for substrate-initiated egress (the same primitive, applied inward).
- Decides: the standing service wakes on a database notification the instant claimable work appears,
  instead of only on the next poll tick — while keeping the interval poll as a resilience backstop.
  Latency drops from ~poll-interval to ~instant on the happy path; correctness never depends on a
  notification arriving.

## Context

v7's service wakes by **polling**: idle, `sleep $LOOP_IDLE_POLL_SECS` (default 15s), re-read the
board, activate if `active > 0`. ADR 0024 D1 chose this deliberately — the dumbest thing that
robustly works, adding zero substrate coupling — and flagged its own cost in the "open risks": a
short poll wakes fast but polls often; a long one is cheap but laggy. A request that arrives one
second after a poll waits nearly a full interval before the service even *looks*. For an
"always-on" service meant to feel responsive (and, via M26, fed by an external channel where a human
is waiting on the other end of a `curl`), up-to-15s-to-notice is the crudest thing left.

The clean fix is the standard Postgres one: `LISTEN/NOTIFY`. The board's writer fires a notification
when something that could create claimable work happens; the service `LISTEN`s and wakes at once.
The README roadmap **already blesses** this exact primitive for the *outbound* direction
(substrate-initiated egress via a `LISTEN/NOTIFY` outbox consumer); this ADR applies it *inward*, to
wake the supervisor.

There is one real tension to own, and one real limit to be honest about.

## The tension: LISTEN needs a direct connection; the agent surface is HTTP-only

The entire **agent-facing** surface is PostgREST-over-HTTP, driven by a deliberately **zero-dependency**
CLI (`bin/ainarres.mjs` — `fetch` + a hand-rolled HS256 minter, no `pg` driver). PostgREST does not
speak `LISTEN/NOTIFY` — it is request/response HTTP. So push-wake **requires a direct database
connection**, which the agent surface deliberately does not have and must not grow (adding a `pg`
driver to the zero-dep CLI would break [the agent-surface contract]).

**Resolution: push-wake is *service-side infrastructure*, not the agent surface.** The standing
service is the runtime, co-located with the database, owner-run; it already holds direct-connection
credentials (`loop.env`) and already uses `psql` for infrastructure tasks (the selftest seeds
governance via a direct `loop_psql`). So the **supervisor** — and only the supervisor — opens a
direct connection to `LISTEN`. Harness children never do; the zero-dep HTTP agent contract is
untouched. This mirrors M26's framing exactly: the *service* may hold infrastructure capabilities
(a direct connection, a bound socket) that the *agents* it runs never receive.

> Guard interplay (the 2026-07-04 board-wipe lesson): the harness-PATH deny-list forbids
> `psql`/`make`/`dbmate` to **harness** children. Push-wake's `LISTEN` is the *service's own*
> connection, using `loop.env`, never exported to or reachable by a harness — so it sits on the
> correct side of that guard. The design keeps it there.

## The limit: not everything that becomes claimable emits a notification

**Lazy reclaim produces no NOTIFY.** A task whose lease expires becomes claimable again *without any
row being written* — that is the whole point of lazy reclaim ([ADR 0009](0009-leases-reaper.md)):
recovery is the next `claim_next_task`, not a background write. So a task that becomes claimable
purely because a dead worker's lease lapsed fires **no** notification. If push-wake were the *only*
wake path, such a task could wait indefinitely for an unrelated NOTIFY.

This is decisive for the design: **push-wake is an optimization layer over the poll, never a
replacement for it.** The interval poll stays as the backstop that covers (a) lease-expiry reclaim,
(b) a dropped/re-established `LISTEN` connection, (c) any missed notification, and (d) the existing
reachability check. With the notification path healthy, the poll interval can be *lengthened* (it is
no longer the primary wake), so idle cost drops even as latency improves.

## Decision

**Add a truth-free notification the board writer fires on anything that could create claimable work;
have the supervisor wake on it OR on the (now-backstop) poll, whichever comes first.** Concretely:

1. **A single `AFTER INSERT OR UPDATE` trigger on `app.tasks`** calls `pg_notify` on one channel
   when a row is inserted, or its `stage`/`blocked` changes (an unblock, an advance into a
   claimable stage, a new task, an accepted intake brief). Payload is minimal (the lane key). This
   is the **first service-driven substrate *behavior* change** — a migration, which
   [ADR 0024](0024-v7-scope-the-standing-service.md) said should be ~zero and "a design pressure
   wanting a migration is a signal to stop and rethink." We stop, and justify it (below): it is
   acceptable because it adds a **transient signal, not truth.**
2. **The supervisor's idle wait becomes "wait up to `LOOP_IDLE_POLL_SECS` OR until a notification
   arrives."** A background direct-connection `LISTEN` feeds arrivals to the idle wait; a
   notification interrupts the sleep and triggers an immediate re-poll. Many notifications coalesce
   into one wake (the service always fully drains regardless of how many fired). If the `LISTEN`
   connection drops, the service logs it and continues on the pure poll — degraded latency, intact
   correctness — and re-establishes on the next tick.
3. **The poll stays as the backstop**, its interval free to lengthen since it is no longer primary.

## Why the trigger is acceptable (crossing the ~zero-substrate-change rule, deliberately)

ADR 0024 kept the substrate untouched because the substrate holds **coordination truth** and the
driver holds **runtime** — a migration risks leaking runtime concerns into truth. This trigger does
**not**: `pg_notify` persists nothing, coordinates nothing, and decides nothing. The board remains
the sole source of truth; the notification is a *nudge to look now*, and **correctness survives it
being lost entirely** (the poll backstop, by construction). It is the same category the roadmap
already blessed for egress, and the same "transient signal, not truth" reasoning that let M21's
strikes and M22's actions find their honest homes. So the rule is not bent — a *truth* migration
would still be the stop-and-rethink signal; a *truth-free signal* trigger is the acceptable
exception, owned here explicitly.

## Consequences

- **Wake latency drops from ~poll-interval to ~instant** on the happy path — the externally-fed M26
  request a human is waiting on gets picked up in ~a heartbeat, not up to 15s later.
- **Idle cost drops**: the poll interval can lengthen (backstop, not primary), so the idle service
  reads the board far less often while *feeling* more responsive.
- **One migration** (a truth-free trigger) + a **direct-connection LISTEN in the supervisor only**.
  The agent surface (HTTP, zero-dep CLI) and the harness guard boundary are untouched.
- **A notification outage is invisible to correctness** — the service degrades to exactly v7's
  polling behaviour, logs the degrade (visible, per the `skip_if_banned` resilience-with-visibility
  rule), and self-heals. A peer down never stalls; a signal lost never drops work.
- **Lease-expiry reclaim is covered by the poll, by design** — the one claimable-transition that
  emits no NOTIFY, and the standing reason the poll is a backstop and not a relic.

## The v7.1 success gate (push-wake half)

1. **A task inserted into an idle service's board wakes it in well under the poll interval** (not on
   the next tick) — proven by the mock service selftest (a push-wake phase: insert, assert wake
   latency ≪ `LOOP_IDLE_POLL_SECS`).
2. **With the `LISTEN` path disabled/broken, the service still drains via the poll** — identical to
   v7 behaviour; correctness independent of the notification.
3. **A lease-expiry-reclaimed task is still picked up** (by the poll backstop), confirming push-wake
   did not create a class of silently-stranded work.
4. **The agent surface and harness guard are unchanged** — no `pg` dependency on the CLI, no `psql`
   reachable by a harness child; only the supervisor holds the direct `LISTEN` connection.
