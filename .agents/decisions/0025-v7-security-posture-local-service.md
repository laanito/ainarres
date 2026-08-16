# ADR 0025 — v7 security posture: a local service, lightly authenticated (the gate, up front)

- Status: Accepted
- Date: 2026-08-16
- Builds on: [0024](0024-v7-scope-the-standing-service.md) (v7 — the standing local service;
  this ADR is its companion posture gate), [0015](0015-egress-as-capability.md) (egress as a
  gated capability, the substrate makes no synchronous outbound call — ingress is its inbound
  mirror), [0007](0007-auth-identity-family-grant-deny.md) (identity, effective = grant − deny;
  the `agent` role the human identity is distinct from), [0020](0020-autonomous-run-topology.md)
  (the dumb driver becomes a standing process), and the roadmap
  ([analysis/roadmap.md](../analysis/roadmap.md): "a security-posture ADR up front — gate for v7,
  not a retrofit")
- Decides: the security posture for v7's standing runtime and its (local) intake channel — what
  changes, what we deliberately do **not** expose in this first stage, and the contract a future
  wider posture must satisfy. **Deliberately light** (owner's first-stage call).

## Context

v7 ([0024](0024-v7-scope-the-standing-service.md)) does two security-relevant things the project
has never done:

1. **Something runs continuously.** `make loop-run` was a crank the owner pulled and that exited;
   the v7 supervisor is an **always-on process** that wakes on its own and can **spawn worker
   agents** unattended. Even with zero external ingress, a standing process that spawns is a
   posture change: what starts it, what wakes it, what it may spawn, how it is stopped, and what
   happens if it misbehaves while no one is watching.
2. **The first external ingress** (Stage 2): an intake **write channel** so a Customer can talk to
   the intaker. Until now every input crossed the perimeter by the owner's own hand (`INSERT` /
   CLI / a hand-fed brief); the substrate's only outbound was the integrator's **gated** egress
   ([0015](0015-egress-as-capability.md)). An inbound write path from outside the owner's own shell
   is genuinely new surface.

The roadmap demanded this ADR be written **before** the code, not bolted on after. But the owner's
first-stage direction is explicit and shapes it: **start with a local service; relay security to
the host's local user management and/or a pre-shared key; do not overthink the first stage.** So
this ADR's job is not a full internet threat model — it is to **draw the perimeter honestly**: keep
v7 local and lightly authenticated, name precisely what is therefore *not* a threat yet, and record
the contract any later widening must meet so the light choice now is not a trap later.

## Decision

### The posture in one line

**v7 is a single-host, single-owner, locally-bound service. It authenticates a human with the
host's local user management and/or a pre-shared key, and it exposes nothing to a public or
multi-tenant network.** The trust boundary is *the owner's machine and the people already trusted
on it* — the same boundary every prior version implicitly had, now made explicit because a process
stands and a write path opens.

### What this rules out (so the threat model stays small)

Because the service is **local-bound**, the following are **not in the v7 threat model** — not
because they don't matter, but because the perimeter is drawn to exclude them, on purpose:

- **No public-internet exposure.** The service binds to loopback (or an owner-controlled local
  interface / a tunnel the owner runs); it is not reachable from the open network. Anonymous
  internet clients, DDoS, and untrusted-scale abuse are **out of scope by construction**.
- **No multi-tenant identity.** There is one class of human — the owner (and anyone the owner
  already trusts on the host). No tenant isolation, no per-user data partitioning, no account
  lifecycle. Cross-tenant leakage cannot occur because there are no tenants.
- **No new trust in the workers.** The supervisor spawns the **same** families v6 ran, with the
  **same** capabilities; v7 grants **no new `capability:integrate`** and no new egress
  ([0024](0024-v7-scope-the-standing-service.md) invariant). The outbound-mutation surface is
  unchanged: exactly the families holding `capability:integrate`, auditable as before
  ([0015](0015-egress-as-capability.md)).

Stating these keeps the ADR light *and* honest: the first stage is safe **because** it is small,
and the smallness is a decision, not an omission.

### The standing-runtime posture (Stage 1 — applies even with no ingress)

The always-on supervisor is trust-critical purely as a *process that acts unattended*. Its posture:

- **Owner-started, owner-stoppable.** The owner starts the service once (or installs it under the
  host's own service manager — `launchd`/`systemd`/a plain nohup, host's choice, out of scope
  here); it is **not** self-installing and **not** privilege-escalating. It runs as the owner's
  own user, with the owner's existing credentials (the git/`gh` provisioning egress already
  relies on) — **no new secret store, no new privileged identity.**
- **It spawns only what `roles.sh` already declares, and only to match pending work.** The
  demand-scaler invariant ([0024](0024-v7-scope-the-standing-service.md)) is also a security
  property: the supervisor cannot spawn an arbitrary command or an unknown family — its spawn set
  is the fixed, declared harness→role map, and it spawns **only** when the substrate reports
  claimable work for that role. A supervisor that could spawn anything on a timer would be a far
  larger surface than the one we are building.
- **Runaway containment leans on machinery that already exists.** A spinning or overspending
  spawned worker is caught by the **operational auditor's** health + spend watch (M23), surfaced to
  the human — the standing runtime does not add a new "who watches the watcher," it reuses the one
  v6 built. Leases + lazy reclaim ([0009](0009-leases-reaper.md)) already bound the damage a stuck
  worker does. The service's own liveness is observable ([0024](0024-v7-scope-the-standing-service.md)
  §termination) so a *stuck* (non-idle, non-progressing) supervisor is itself visible.
- **Graceful, complete stop.** Stopping the service must leave `main` coherent and no worker
  orphaned mid-mutation — drain-in-flight-then-halt, or halt-and-let-leases-reclaim (the design
  note settles which). "Always-on" never means "cannot be turned off."

### The ingress posture (Stage 2 — the local intake channel)

When the intake write channel lands (Stage 2 of [0024](0024-v7-scope-the-standing-service.md)), it
is the **inbound mirror of the guarded egress** ([0015](0015-egress-as-capability.md)): just as no
untrusted agent may push, no untrusted caller may write. Kept local and light:

- **Authenticated before a row exists.** The channel authenticates the caller **before** any input
  becomes a task/brief row — via the **host's local user management and/or a pre-shared key**
  (owner's choice of the two; the design note picks the concrete mechanism). No anonymous writes.
  An unauthenticated request is refused **at the channel**.
- **A human identity distinct from `agent`.** The caller is a **human/external** identity, not the
  `agent` role ([0007](0007-auth-identity-family-grant-deny.md)). It may do exactly one thing:
  submit a request that becomes a **`proposed_brief`** through the **unchanged M24 two-tier gate**
  (it holds, at most, `role:intaker`-equivalent creation of the request-root — **never**
  `capability:integrate`, never designer decomposition, never advance). The channel widens *who can
  start a request*, not *what can be done*.
- **Defence in depth: the substrate still gates.** Channel auth is the outer wall; the inner wall is
  the **same D4 create-gate the substrate already enforces** — a submission that reaches the
  substrate without the starter role is refused there too ([0024](0024-v7-scope-the-standing-service.md)
  success gate #3). A bug in the channel cannot grant a capability the substrate withholds. This is
  the M19/M24 property reused as a security control, not a new mechanism.
- **Validate / sanitize at the boundary.** Input is validated and sanitized to the brief's expected
  shape before it is persisted (the channel is the inbound counterpart to egress's "record a
  reference, make no synchronous outbound call"). The substrate remains the boundary at which
  outside intent becomes a coordinated row.

### The pre-shared-key / local-user choice (kept deliberately open here)

Whether v7 uses (a) the host's local user management (the request comes from an authenticated local
OS session / socket peer credentials), (b) a pre-shared key presented by the caller, or (c) both, is
a **mechanism** the design note (`design/service.md`) settles — not an ADR-level fork, because all
three land inside the same local, single-owner perimeter this ADR draws. The ADR fixes the
*posture* (local, single-owner, authenticated-before-write, human ≠ agent); the note fixes the
*mechanism* (which of PSK / local-user / both).

### The contract for widening later (so "light now" is not "trap later")

If a future version widens the perimeter (public exposure, multi-tenant, remote clients), it must
**revise this ADR** and, at minimum, satisfy — *before* going wide:

- **Transport security** (TLS) and a real, rotatable credential scheme (not a static PSK).
- **A per-caller identity model** distinct from the owner, with authorization scoped per caller —
  and the tenancy/isolation story the single-owner posture omits.
- **Rate limiting / abuse controls** at the ingress, and an input threat model for hostile,
  not-merely-untrusted, callers.
- **An egress re-review** — a public front changes what the integrator's standing egress is exposed
  to; the [0015](0015-egress-as-capability.md) boundary would want re-examining in that light.

Recording this now is the whole point of writing the posture ADR *up front*: the local, light first
stage is a deliberate, bounded step, and the price of widening is written down, not discovered.

## Alternatives considered

- **A full external-ingress threat model now** (auth-N/Z framework, TLS, rate limiting, tenant
  isolation). Rejected per the owner's first-stage call and the project's baby-step method: it is
  the threat model for the *wide* posture, and building it before there is a single remote caller is
  the retrofit-in-reverse — infrastructure for a perimeter we are deliberately not crossing yet. The
  contract-for-widening section captures it as a *future obligation* instead of premature work.
- **No auth at all for a purely-local channel** ("it's just localhost"). Rejected: local-bound
  reduces the threat, it does not erase it (other local processes, other users on the host), and
  "authenticate before a row exists" is cheap with local-user creds or a PSK. Defence in depth (the
  substrate's own D4 gate behind the channel) is kept regardless — a channel bug must not be the
  only wall.
- **Reuse the `agent` role / a family grant for the human caller.** Rejected: the Customer is not a
  worker; conflating them would either over-grant the human (toward `capability:integrate`) or
  contort the family model. A distinct human/external identity that can *only* start a request is
  both safer and truer to the role chain ([0024](0024-v7-scope-the-standing-service.md)).
- **Self-installing / privileged daemon.** Rejected: the service runs as the owner's own user with
  the owner's existing credentials and is installed by the owner under the host's own service
  manager. No new privileged identity, no new secret store — the smallest standing-runtime posture.

## Consequences

- v7 proceeds **local and light**: the standing service binds locally and runs as the owner; the
  Stage-2 channel authenticates via local user management and/or a PSK, admits only a human identity
  that can start a `proposed_brief`, and sits behind the unchanged substrate create-gate.
- **The threat model is small by decision**, and the decision is documented: public/multi-tenant/
  remote is explicitly excluded from v7 and gated behind a revision of this ADR with a named
  contract (TLS, real credentials, per-caller authZ, rate limiting, egress re-review).
- **No new privilege, no new secret store, no new trust in workers.** The outbound surface is
  unchanged ([0015](0015-egress-as-capability.md)); the supervisor spawns only the declared families
  to match pending work; the channel grants only request-creation. The perimeter moved outward by
  exactly one small, authenticated, local write path — and one standing, owner-run, stoppable
  process.
- The **inbound/outbound symmetry** is now explicit in the record: [0015](0015-egress-as-capability.md)
  gates who may push *out*; this ADR gates who may write *in*. The substrate stays the boundary at
  which outside intent — in either direction — becomes coordinated truth.
- `design/service.md` settles the mechanism (PSK vs local-user vs both; the concrete bind; the stop
  shape; the liveness signal) within this posture. The build split follows
  [0024](0024-v7-scope-the-standing-service.md): the auth + channel + spawn/stop lifecycle are
  **assisted, mock-verified before live**; the pure surfaces are swarm-built.
