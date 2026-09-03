# ADR 0028 — v8 scope: the agent operator seat (the operator becomes attributable and bounded, never root)

- Status: Accepted (2026-09-03 — steps 0–3 built and merged: #130 the read-only role, #131–#133 the preconditions, #138/#140 the seat identity + ledger, #144 the credential envelope; #145 the readiness pass, #147 the findings from the first external run. Two in-scope items remain unbuilt: the non-`make` service lifecycle, and success gate 5 — see the amendments below)
- Date: 2026-08-27
- Builds on: [0025](0025-v7-security-posture-local-service.md) (v7's posture — single-host,
  single-owner, **`human ≠ agent`**, "owner-started, owner-stoppable", and the explicit choice to
  reuse the human as the runaway backstop rather than add a new "who watches the watcher"; this ADR
  amends that last part and nothing else about the perimeter),
  [0024](0024-v7-scope-the-standing-service.md) (the standing service — the **demand-scaler-never-
  router** invariant, restated here at the operator layer),
  [0022](0022-v5-scope-governance.md) (v5 governance — the human boundary this ADR must not void:
  mechanical temp-ban autonomous, qualitative → human, permanent → human-only),
  [0007](0007-auth-identity-family-grant-deny.md) (families + effective features + the
  grant/deny asymmetry — the operator seat is modelled as a **family**, not a new mechanism),
  [0023](0023-v6-scope-seat-the-bookends.md) (the two out-of-loop bookends; the auditor's
  human-held role is the seat this ADR keeps human),
  [0015](0015-egress-as-capability.md) (the guarded-egress pattern the credential envelope mirrors
  inward, exactly as the intake channel did),
  and the four merged operator skills (`skills/ainarres-operator-{monitor,intake,intervene,config}.md`,
  #127) — the artefacts that made the gap visible.
- Decides: v8's north star, in/out scope, and success gate — **the operator seat becomes holdable
  by an agent**: attributable, credential-bounded, ledgered, and still governed by the substrate it
  operates. The design note settles the mechanics (`design/operator-seat.md`).
- Owner sign-off required: this ADR decides that **permanent ban/lift, capability grants, and
  custody of the signing key stay human**. That is the load-bearing choice; everything else follows
  from it. See *The one decision that can flip*.

## Context

Writing the four operator skills (#127) forced a question the project had never asked: **what is
the operator, exactly?**

Every other actor in AINARRES is modelled. Workers are families with signed features
([0007](0007-auth-identity-family-grant-deny.md)). The integrator is the family that holds
`capability:integrate` ([0015](0015-egress-as-capability.md)). The intaker and the auditor are
seated roles with their own features ([0023](0023-v6-scope-seat-the-bookends.md)). The service is a
demand-scaler with a fixed spawn set ([0024](0024-v7-scope-the-standing-service.md)). The
**operator** — the actor that seats families, opens requests, watches the board, intervenes on
stuck work, and starts and stops the service — is modelled **nowhere**, because it has always been
the owner, sitting at a terminal.

That was sound while it was true. It stops being sound the moment an agent takes the seat, because
of where v5–v7 deliberately put the human:

- **The auditor's qualitative flag** — human-held `role:auditor`, writing no denial
  ([0022](0022-v5-scope-governance.md) / M22).
- **Permanent ban and lift** — oversight-only RPCs, the only route to a NULL-expiry denial, an
  explicitly human decision (M22).
- **The intaker** — human-held `role:intaker`; the brief is worked by a person (M24).
- **The perimeter** — "owner-started, owner-stoppable"; the human is the runaway backstop
  ([0025](0025-v7-security-posture-local-service.md)).
- **The signing key** — the owner holds `JWT_SECRET`, and `ainarres token` signs **locally**, so
  the key-holder can mint any role, any features, any family, any `sub`.

An agent placed in the operator seat as the skills currently describe it occupies **all five at
once**. The consequence is not a bug in the skills; it is the honest shape of the system: every
boundary v5 built is enforced against **workers** and vacuous against **the operator**. A
key-holding agent operator can mint an oversight token, lift a ban the substrate placed on it, grant
itself `capability:integrate`, or act as any family — and none of it is attributable, because the
family named in the token is whatever it chose to claim.

Two smaller facts compound it. First, **attribution**: the merged intake skill instructs minting
`claude-code+opus` tokens to do intake work, so v5's track record (M20) and strikes (M21) would
score a *worker* family for the *operator's* actions. Second, **the record**: only ban/lift is
ledgered (`app.governance_actions`). Seating changes, forced releases, service restarts, and
accepted briefs leave no substrate trace at all — invisible in a way that is fine when a person
remembers doing them and useless when an agent does them all day.

Separately, two mechanical gaps make the seat's daily work impossible today, and they are cheap to
fix: **nothing works the `intake` lane** (no tier holds `lane:intake`; no intake→dev bridge; a
posted brief sits in `proposed_brief` forever), and **the standing service's design pass is
mis-wired** (`service.sh` spawns the `designer` tier with no brief, so `claude-frontier.sh` falls to
its reviewer prompt while holding only `lane:dev,role:designer`). Neither is design work; both block
"post a request and walk away".

## Decision

### The v8 north star

**Make the operator seat holdable by an agent — bounded, attributable, ledgered, and governed —
without moving a single one of the boundaries v5 drew.** The headline is **authority**: AINARRES
stops assuming a trusted human at the terminal and starts *modelling* the actor that sits there, so
that seat can be filled by an agent whose powers are enumerable and whose actions are reviewable
after the fact.

v7 made the machine run without a human turning the crank. v8 makes the machine *manageable*
without a human holding the keys — which is a strictly smaller claim, and deliberately so.

### The v8 invariant (the one that keeps the human boundary honest)

**The operator seat is bounded by a credential envelope it cannot widen, and it never holds the
signing key.** Concretely: the seat receives short-TTL credentials scoped to a declared envelope,
issued by something the seat cannot reconfigure. Whatever the seat can do, it can do *because the
envelope says so*, not because it can sign whatever it likes.

Three corollaries, none of them new mechanism:

- **Governance still only removes, and never by the operator.** The seat may *read* everything
  governance produces and *recommend* (the M22 recommendation signal already exists), but the two
  irreversible acts — permanent ban and lift — stay oversight-only RPCs called by the human. The
  operator's own bans, if it earns them, are the substrate's to place and to heal.
- **The operator is a demand-shaper, never a router** — the [0024](0024-v7-scope-the-standing-service.md)
  invariant restated one layer up. The seat may change *which families are seated* and *which service
  knobs are set*; it may never decide *which task goes to whom*. A capable agent operator is exactly
  the actor that would drift into routing, so the prohibition is written at its layer, not inferred.
- **The operator is subject to the governance it operates.** Its actions attribute to its own
  family, feed the same track record (M20) and the same strike ledger (M21), and can temp-ban it
  like anyone else. The seat is inside the system, not above it.

### The seat is a family, not a new kind of thing

The operator seat is modelled with what already exists: **a registered family** with declared
features ([0007](0007-auth-identity-family-grant-deny.md)), acting **out of band** — the same
placement the auditor got (M22: an out-of-band oversight actor, not a gating workflow stage). No new
capability state, no new role in a workflow, no new plane.

What the seat holds:

- **Read everything** — the oversight views, the raw `app` tables read-only.
- **The intake middle** — claim, refine, and advance briefs on the `intake` lane, and create the
  resulting `dev` work through the unchanged M24/D4 two-tier gate.
- **Unstick work** — forced release of a stranded claim (as `driver-lib.sh::release_stranded` does),
  and unblock. **Not** the audit or operational flags: both are `role:auditor`-gated (M22 D6,
  M23 D1), and the next section says the seat may not hold that role. Corrected during the
  step-2 build; the earlier draft of this bullet contradicted the section below it.
- **Service lifecycle and seating** — start, stop, and reconfigure the standing service; add or
  remove families from the seated roster, within the envelope.

What the seat must **never** hold:

- `capability:integrate` — the integrator stays the single push-trusted family
  ([0015](0015-egress-as-capability.md)). The operator introduces and unsticks work; it never merges.
- `role:auditor` — the auditor is the **human's** seat (below).
- The signing key, or any power to mint outside its envelope.
- `set_permanent_ban` / `lift_ban`.

### Amendment (found building step 2, 2026-08-28): what the seat identity does and does not buy

The seat is now built (`agent+operator` in `db/seed.sql`, `role:operator`, `app.operator_actions`,
`api.record_operator_action`, `api.operator_actions`). Two things the build settled that this ADR
should not leave a reader to over-read:

**1. Step 2 buys ATTRIBUTION, not CONTAINMENT.** `api.effective_features()` reads the *signed
token's* features and subtracts active denials — it does **not** re-intersect against
`app.family_features`. That is [0007](0007-auth-identity-family-grant-deny.md) working as designed:
the substrate trusts the token, and provisioning is enforced when the token is *minted*. So the
`role:operator` gate stops an unregistered family, a token that never claimed the feature, and a
seat whose feature governance has denied — and it stops nothing at all about a holder of
`JWT_SECRET`, because nothing inside the database can. **The seat's boundary is only as real as the
credential envelope**, which is the *next* step, not this one. Until then the seat is an honest
name for the operator's acts, not a wall around them.

**2. The seat is claim-eligible for `proposed → designing`, and that is a known widening.** The M24
D4 create-gate is data-driven — creating in a lane requires the starter role of that lane's initial
stage — and it reads the *same* features the claim path reads. So `lane:dev` + `role:designer`, the
minimum that can create dev work at all, also makes the seat eligible to claim dev design work.
Nothing pushes work to it (the seat is not a tier and runs no poller), and an actual claim would
carry its own name in `app.events`. Narrowing it means short-TTL, per-act credentials — again the
envelope step. Recorded here rather than hidden, because a reader comparing the seed to the
prohibition list will otherwise find it themselves and wonder what else was glossed.

Neither changes the decision. Both change what "step 2 is done" is allowed to mean: the seat is
*named and ledgered*, and it is *not yet bounded*.

### Amendment (step 3, 2026-08-28): the envelope, and the limit the owner accepted

Built as `api.issue_operator_credential` + `bin/credential-broker.mjs`. The mechanism it uses
had been sitting unused since M2: `api.token_claims` reads a family's *provisioned* features and
returns claims **for a separate minter to sign** — its own header says "the minter signs them".
That is an envelope. Three versions later this is the caller it was waiting for.

The seat no longer signs; it asks a loopback broker (PSK, owner-run, ADR 0025's posture), and
the **database** decides what may be in the token: role ∈ {`agent`, `monitor`} — never
`oversight`, which carries the human's ban/lift EXECUTE, and never `reaper`, which could issue
credentials; the family must hold `role:operator` (data-driven — the seat is whoever the owner
provisioned, not a name in code); features are the provisioned snapshot, whole and unedited,
because *asking is not part of the protocol*; TTL is capped. The issuance is recorded in the
same statement, so there is no path that mints without a trail.

**The limit, chosen deliberately by the owner.** On one host with one OS user, a shell-capable
seat can read `loop.env` and sign what it likes, and no code in the substrate can prevent it. The
owner chose an **audited boundary** over an enforced one: the envelope binds a cooperating seat
and *exposes* an uncooperative one, via `api.unbrokered_operator_acts` — every issued credential
records its subject, so an operator act whose actor was never issued one shows. Detection, not
prevention. Prevention is a deployment (the seat as a separate OS user with no read on the
secret), documented in `loop/README.md`, not a migration.

This is worth stating plainly rather than letting "the envelope" imply more than it does: **the
v8 invariant as written — "bounded by a credential envelope it cannot widen" — now holds against
a seat that goes through the broker, and holds only as an audit trail against one that does
not.** The success gate's clause 2 ("an attempt by the seat to mint outside its envelope is
refused, demonstrated as a done-test") is met for the brokered path and is *not* a claim about a
seat holding the key. Closing that gap is an OS-level deployment step or a later version.

### The auditor stays human, and the operator may not be the auditor

[ADR 0025](0025-v7-security-posture-local-service.md) answered "who watches the watcher" by pointing
at the human at the terminal. Once an agent holds the operator seat, that answer needs a name, and
this is it: **the operator seat and the auditor seat must be distinct identities, and `role:auditor`
stays human-held.** The agent runs the machine; the human judges whether it ran well and holds the
two irreversible levers. This is the same separation M22 already drew between the *auditor's*
qualitative flag and the *oversight-only* permanent ban — extended to say that the actor doing the
operating is not the actor doing the judging.

### The record: an operator action ledger

Every out-of-band operator action appends to an append-only ledger — seating changes, forced
releases, service start/stop/reconfigure, briefs accepted, recommendations acted on. This follows
the reconciliation M22 already made (D7): actions that are **not task-scoped** cannot live in
`app.events` (whose `task_id` is `NOT NULL`), so they get their own ledger, exactly as
`app.governance_actions` did for human ban/lift. Surfaced the established way — a read-only view
plus a report line.

The point is not audit theatre. It is that "reviewable after the fact" is what makes it safe to hand
an agent the seat at all: the wipe incident (2026-07-04) was caught by a human **reading the board
afterwards**, and that remains the model.

### The seat's preconditions (bug-shaped, in scope, land first)

Not design work, but the seat cannot do its job without them:

1. **Someone must be able to work the `intake` lane.** v8 makes the intake middle a first-class,
   idempotent operator path — claim, refine, advance, create — usable by the seat without
   impersonating a worker family. (A *federated* intake poller — an agent intaker as a claiming tier
   — stays deferred; see out of scope.)
2. **The standing design pass must actually decompose.** Fix the `LOOP_DESIGN_TIERS` /
   `CLAUDE_BRIEF` mis-wiring so a `proposed` dev task gets a designer, not a reviewer prompt.
3. **The silent failure mode needs a detector.** A stuck-but-alive worker (the unresolved
   lease-vs-liveness race, [0009](0009-leases-reaper.md)) is a curiosity when a human reads the
   report and the main hazard when nobody does. An operational flag (M23's mechanism, unchanged) for
   *claimed, leased, not progressing* replaces the eyes the seat no longer has.

### The v8 success gate

**v8 is "done" when an agent holds the operator seat through a full request-to-`main` cycle with no
human action, using only credentials it cannot widen — and the human's remaining powers are provably
still the human's.** Concretely:

1. **An agent-operated cycle.** A request arrives through the intake channel; the agent operator
   works the brief, creates the dev work, the standing service delivers it to `main` hands-off, and
   the operator reports it — with no human intervention anywhere in the chain.
2. **The envelope holds, provably.** An attempt by the seat to mint outside its envelope (an
   oversight token, `capability:integrate`, another family's identity) is **refused**, and the
   refusal is demonstrated as a done-test, not asserted.
3. **The human-gated powers were not exercised by the agent.** An attempted `set_permanent_ban` from
   the seat is refused at the grant boundary; a permanent ban that *should* happen is surfaced as the
   M22 recommendation and left for the human.
4. **Everything the operator did is attributable and ledgered.** Every action names the operator
   family — never a worker family — and appears in the operator ledger, readable in one report.
5. **The seat is governed.** A rejected or failed operator action credits the **operator's** track
   record (M20) and can strike it (M21) like any other family, demonstrated at least once.
6. **`main` stays coherent, and nothing became a router.** No task assignment, no cost-based
   picking, no capability granted by anything but a human reprovision.

### In scope for v8

- **The operator seat as a registered family** with declared features, out-of-band placement, and
  the explicit prohibition list above.
- **The credential envelope** — an issuing path the seat cannot reconfigure, short-TTL tokens, and
  the removal of `JWT_SECRET` from the seat's reach. First cut may be local and light, mirroring the
  intake channel's posture ([0025](0025-v7-security-posture-local-service.md)): loopback-bound,
  pre-shared-key-authenticated, owner-run. **Authenticated before a credential exists**, exactly as
  the channel is authenticated before a row exists.
- **The operator action ledger** + its view + report line.
- **The three preconditions** above (intake middle, design-pass fix, stuck-alive detector).
- **A non-`make` control path** for service lifecycle — `make` is deny-listed for harnesses
  (`loop/guard-bin/`) and `make service` is foreground-only; the seat needs start/stop/status/
  reconfigure it can drive, with the existing status file staying the liveness contract.
- **Refreshing the operator skills** to the new seat: its own family, envelope-scoped credentials,
  no impersonation, ledger-writing. The skills are the seat's interface and must not describe powers
  it no longer has.
- **An amendment to [ADR 0025](0025-v7-security-posture-local-service.md)** — the perimeter is
  unchanged (single-host, single-owner, local), but its actor model gains a third class: an **agent
  that is neither worker nor human**, and its "reuse the human as backstop" clause is narrowed to the
  auditor + the two irreversible levers.

### Out of scope for v8 — deferred (constraints, not built)

- **An off-host or remote operator.** The seat runs inside the same local, single-owner perimeter. An
  operator reaching the substrate across a network is a heavier revision of
  [0025](0025-v7-security-posture-local-service.md) (TLS, multi-tenant identity, rate limiting) and
  is its own version.
- **Giving the seat the human-gated powers.** Permanent ban/lift, capability grants, and key custody
  stay human. If that is ever revisited it is an ADR, not a config change.
- **An agent auditor / automated qualitative judgment.** Roadmap keeps this at v8+; this ADR moves it
  *further* out by making the auditor's human identity a structural requirement of the operator seat.
- **A federated intaker or auditor poller** — intake and audit as claimable pull-work across makers
  remains federation-shaped work, deferred as in [0024](0024-v7-scope-the-standing-service.md).
- **Cost-aware routing.** Still a router. The seat may seat cheaper families; it may not pick a
  family per task.
- **Multi-operator / operator federation.** One seat, one instance. The seat should be *modelled* so
  that a second one is not a rewrite, but v8 stands up one.
- **The web UI.** Unchanged deferral; v8 is an authority model, not a site.
- **v7.1 (demand-shaped scaling + push-wake, [0026](0026-v7-1-demand-shaped-scaling.md) /
  [0027](0027-v7-1-push-wake.md)).** Independent of this ADR and complementary: an agent operator
  reacting to the board all day is precisely the workload whose cost 0026 removes. Sequence it
  alongside, but it is neither a prerequisite for nor a part of the operator seat.

## Bootstrap discipline (recursive)

As in v2–v7, built **on AINARRES**, split by the substrate-free-checkability line the board wipe
taught, not by importance:

- **Assisted (mock-verified before live):** everything touching auth or the perimeter — the
  credential envelope and its refusals, the seat's family and feature grants, the ledger DDL and its
  append-only trigger, and the `make`-free control path. These are the trust-critical core; a worktree
  cannot self-validate them.
- **Swarm (substrate-free brief):** the surfaces — the ledger view's report line and the operator
  report block, following the view-assisted / report-line-to-the-swarm split that has held every
  time it was used (#87, #91, #117, #123).
- The precondition fixes are ordinary swarm work with substrate-free validates, except the
  design-pass wiring, which touches the harness layer and is owner-verified.

## The one decision that can flip

This ADR decides that **permanent ban/lift, capability grants, and key custody stay human**. The
alternative — hand the seat the key and treat the agent operator as the owner's full delegate — is
coherent, much less work, and voids v5: the governance boundary would exist only against workers,
and "hard cases reach a human" would become "hard cases reach whoever holds the key". If the owner
prefers that trade, this ADR is the wrong shape and should be replaced rather than amended, because
almost every section above derives from the choice.

A middle position exists and is worth naming: **monitoring-only delegation**, which needs none of
this — the merged skills already let an agent read the board, report health, and recommend, with the
human doing every write. If v8's cost is unattractive, that subset is available today and is the
honest fallback.

## Alternatives considered

- **Give the operator seat `JWT_SECRET` and trust it.** Rejected — the reason this ADR exists. It
  is not that an agent operator is untrustworthy; it is that an unbounded seat makes the v5 boundary
  unenforceable *and* unauditable, and the audit trail is what made the 2026-07-04 incident
  recoverable.
- **Model the operator as a workflow role on a lane.** Rejected for the reason M22 rejected a gating
  `audited` stage: the operator's scope is the whole instance, not a task, and a gating stage
  re-adds a standing actor to the critical path the service exists to remove. Out-of-band, like the
  auditor.
- **Let the operator hold `role:auditor` too** (one out-of-loop seat instead of two). Rejected: it
  collapses "who watches the watcher" into "the watcher watches itself", which is precisely the
  property [0025](0025-v7-security-posture-local-service.md) leaned on a human to provide.
- **Extend the harness deny-list to the operator instead of building a control path.** Rejected:
  the deny-list exists because a *worker* has no business touching shared substrates. The operator's
  job **is** substrate lifecycle. Guarding it by removing its tools would only push it to
  `bash loop/service.sh` — which it can already do, unledgered. Better to give it a real path and
  record what it does.
- **Put operator actions in `app.events`.** Rejected on the same mechanical ground M22 found:
  `events.task_id` is `NOT NULL` and operator actions are instance-scoped. Its own ledger.
- **Do 0026/0027 first and re-assess.** Rejected as an answer to *this* goal — cheaper activations
  do not make the seat definable — but adopted as parallel work, since the cost curve of an
  always-reacting operator is exactly what 0026 flattens.

## Consequences

- **The human's job shrinks to three things**: custody of the signing key, the two irreversible
  governance levers, and the qualitative audit. Everything else can be delegated. That is a clean,
  small, checkable residue — and a much better answer than "the owner watches the terminal".
- **The operator becomes visible.** For the first time, "what has been done to this instance, by
  whom, and why" is answerable from the substrate rather than from memory.
- **Attribution gets honest.** Worker track records stop absorbing operator actions — which also
  means M20's signal gets *better*, not just cleaner.
- **The seat can still do harm inside its envelope** — a forced release burns an attempt, a bad
  seating change wastes spend, a wrong brief ships wrong work. v8 does not claim to prevent that; it
  claims to bound and record it, and to leave the irreversible acts with a person.
- **More credential machinery to run.** A mint path is a new moving part inside the perimeter, with
  its own failure mode (the seat cannot get a token ⇒ the instance is unmanaged until the owner
  intervenes). The design note must decide the degraded behaviour.
- **The operator skills become versioned artefacts of a seat, not advice to a person.** They will
  need refreshing whenever the envelope changes — which is the right coupling, since they are the
  interface.
- **`ainarres token` stays as-is for the owner** and becomes something the seat does not call. The
  CLI is not weakened; the *seat's* access to it is.
