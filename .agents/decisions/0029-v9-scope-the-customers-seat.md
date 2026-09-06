# ADR 0029 — v9 scope: the customer's seat (project-scoped staffing, the epic as deliverable, and the human's two interfaces)

- Status: Proposed
- Date: 2026-09-03
- Builds on: [0028](0028-v8-scope-the-agent-operator-seat.md) (the agent operator seat — this ADR
  is its complement: v8 equipped the *agent* side of the boundary, v9 equips the *human* side),
  [0007](0007-auth-identity-family-grant-deny.md) (families + effective features + the grant/deny
  asymmetry — **this ADR amends its lane-scoped matching**, the first change to that model since
  M2), [0025](0025-v7-security-posture-local-service.md) (the perimeter — kept, not revised; and
  its actor model gets its third class named properly),
  [0023](0023-v6-scope-seat-the-bookends.md) (the intaker and auditor bookends — the customer's
  seat sits outside both), [0022](0022-v5-scope-governance.md) (the human boundary: qualitative →
  human, permanent → human-only; the veto obeys the same rule and adds no penalty),
  [0004](0004-feature-model.md) (the feature model whose `lane` kind this reshapes),
  [`analysis/vision.md`](../analysis/vision.md) (the kanban hierarchy — this ADR builds its middle
  tier), and [`design/auditor.md`](../design/auditor.md) D1/D8 (the out-of-band placement, reused
  verbatim; and the deferred "delivery entity", which is the debt this ADR pays).
- Decides: v9's north star, in/out scope, and success gate — **the human stops being an
  under-equipped operator and becomes a modelled customer**: capabilities are staffed per
  *project*, deliverables are first-class *epics*, a delivered epic can be *rejected*, and the
  human gets the two interfaces they actually use (a direct console, and a mediated agent) over one
  boundary the database already enforces.
- Owner sign-off required: **capabilities move from lane-scoped to project-scoped.** That is the
  load-bearing change and it touches the oldest decision in the substrate. Everything else in this
  ADR is either enabled by it or independent of it.

## Context

### Five versions defined the human by prohibition and never equipped them

v5 drew a human boundary. v6 named the bookend roles. v7 made the machine stand up on its own. v8
handed an agent everything on the far side of that boundary — its own identity, a ledger, a
credential envelope it cannot widen — and verified that the human-only levers refuse it: five out
of five, checked at the grant boundary on 2026-08-29, before the function body is ever entered.

The boundary works. Nothing makes it *usable*. Every capability that stays human by design is the
capability with the worst instrument:

| Capability | Why it is human | Its interface today |
| --- | --- | --- |
| `api.set_permanent_ban` | irreversible ([auditor.md](../design/auditor.md) D4) | a hand-minted `oversight` token against raw PostgREST |
| `api.lift_ban` | irreversible | the same |
| `api.raise_audit_flag` | qualitative judgment (D6) | the same |
| `api.raise_operational_flag` | qualitative judgment | the same |
| key custody / provisioning | trust root | `loop.env` + `db/seed.sql`, by hand |

The end-of-run report even renders `⚑ RECOMMEND PERMANENT BAN … a human must decide`, and the
human's next step is to go and mint a token in a shell. **The one place where a human decision is
structurally required is the one place with no interface.**

### The frame that makes this coherent: company and customer

The project has used a consultancy analogy since v6 to reason about the bookends. Taken seriously
it settles a run of questions that were open:

**AINARRES is the company. The human is the customer.**

The company is staffed with families holding disciplines. It takes a request, refines it, decomposes
it, builds it, reviews it, integrates it, and *delivers*. The customer states what they want,
answers questions, and — the act with no representation anywhere in the substrate today — **accepts
or rejects the delivery**.

That reframing does real work. It explains why the human's levers feel like an afterthought: they
were modelled as *operations* (ban a worker, flag a gap) when the human's primary act is
*commercial* (this delivery is or is not what I asked for). And it renames the actor:
[0025](0025-v7-security-posture-local-service.md)'s amendment named the agent operator as a third
class; the human class is better named **customer** than **owner**, because what defines it is
accepting and rejecting work, not holding the terminal.

### Three holes, verified

1. **`done` is the company's word, not the customer's.** The dev workflow ends at `done`, which
   means *we shipped it*. There is no verdict channel out. M24 opened a request channel **in**; the
   customer has never had a way to say "received, and no."
2. **There is no deliverable to reject.** `app.tasks` has no `title`, no `parent`, no origin
   pointer; `subject` is `uuid references app.agents(id)` (a governance pointer, not a name), and
   `payload` is opaque `jsonb` that nothing in the substrate or the CLI reads a key from except the
   intake channel's `request`. The four M28 slices have **no recorded link** to the brief that
   produced them; the only trace is that they were created eighteen seconds after it was accepted.
   [design/auditor.md](../design/auditor.md) D8 already conceded this — *"a 'delivery' is really the
   brief and all its tasks; anchoring to one task is the v1 shortcut. A first-class delivery/brief
   entity … is deferred."* This ADR pays that debt.
3. **Every output is machine-centric, and it is not a styling problem.** A console over today's
   substrate renders rows of `01a062f3…` with nothing to tell them apart, because work has never
   needed a name while only machines read the board. Nobody decided that; it simply never cost
   anything — the same shape as every finding in the last two deliveries.

## Decision

### The v9 north star

**The customer becomes a modelled actor with instruments.** Work gains the tier that can be
delivered and rejected; capabilities are staffed at the tier where staffing belongs; and the two
interfaces the human actually uses are built over the boundary the database already draws.

### D1 — Capabilities are granted per PROJECT, not per lane

Today authorization is an exact-match containment check on the lane key, in **six** places across
the verbs:

```sql
if not (eff @> array['lane:' || v_lane.key]) then
  return app.envelope(false, 'not_eligible', format('missing feature lane:%s', v_lane.key));
```

`lane:dev` is doing two jobs: *"you are staffed here"* and, through `lanes.workflow_id`, *"this is
the workflow."* Splitting them gives three axes that map onto the frame exactly:

| axis | means | in the analogy |
| --- | --- | --- |
| `project:<slug>` | staffing scope | who is on the engagement |
| lane / epic | the bounded deliverable + its workflow | the deliverable |
| `role:<x>` | what you may do | your discipline |

**The company starts a project and staffs it.** A family staffed on a project works whatever
deliverable inside it matches its role. This is what makes D2 possible at all: with lane-scoped
features, every dynamically-created epic would need its key granted to every worker, so tokens grow
with the board — workable at five epics, broken well before fifty. Project scoping removes the
problem rather than papering it with a wildcard.

**What it costs** — mechanical, bounded, and wider than it sounds: six authorization sites; the
`app.features.kind` constraint (`check (kind in ('capability','role','work-area','lane'))`) gains
`project`; ~38 config references (27 in `db/seed.sql`, 11 in `loop/roles.sh`); 32 test files that
grant a lane feature; and the skills (below).

**What it does NOT cost:** the verb signature. `api.claim_next_task(lane_key text default null)`
already defaults to null — *claim anything I am eligible for*. Project-scoped claiming needs no new
argument; what pins the loop to lanes is configuration (`LOOP_LANES`, and `claim --lane dev`
hardcoded in the harness wrappers), not the substrate.

**The expressiveness we give up, on purpose:** two lanes in one project can currently have different
staffing. After this they cannot — only the role gate separates them. Checked against the live
model: the lane gate never does work the role gate does not, because every worker family holds
`lane:dev` and the only lane split that exists (`intake`) is already gated by `role:intaker`. If a
deliverable ever genuinely needs separate staffing, it is a different project — which is also the
consultancy answer.

**Two things fall out free.** *Cross-project isolation becomes real*: another repository is another
project, staffed separately, and a family staffed only on `project:ainarres` structurally cannot
touch it — the perimeter the second-repo experiment needs, which a `lane:otherrepo` feature would
only have named. And *governance gains "roll off the engagement"*: M21 denials are per
`(family, feature)`, so with `project:<slug>` a feature, a denial can unstaff a family from a
project — the move that sits between a temp capability ban and a permanent one.

### D2 — The epic is the deliverable, and `epic = lane`

[`analysis/vision.md`](../analysis/vision.md) already settles this and is more elegant than adding a
parent pointer: the hierarchy is `goal (future) → project → epic (= lane) → task`, the data-model
note already calls a lane *"an initiative within a project"*, and the vision states plainly that
**M22's deferred delivery entity *is* the epic**.

So lineage needs **no new column**. `tasks.lane_id` already exists, is already indexed, and is
already in every view; it carries no information today only because `dev` is one standing lane
holding every task ever written. Make lanes **bounded per request** and the delivery pointer is
there retroactively.

The epic's definition also has a home: `app.lanes.context` is `jsonb not null default '{}'` and its
comment already reads *"repo, rules, requisites"*. The brief becomes the epic's `context`; the
designer's decomposition fills the epic with tasks. `app.projects.context` (*"where the project's
work-truth lives"*) is where a repo pointer belongs — which is also how a second project gets its
own repository without a new mechanism.

**What is still missing after epics: a name.** Epics give grouping; nothing gives a task a
human-readable title. `app.tasks` needs one field, or one blessed `payload` key that views actually
read. Without it the console has lineage and still nothing to display, so this is in scope, small,
and not optional.

### D3 — Opening a deliverable is an authorized act, and needs its own gate

M24's D4 gate covers creating a **task**: you need the STARTER role of the target workflow. Creating
a **lane** has no gate at all today, because lanes are seeded by hand. The moment epics are dynamic,
opening a deliverable becomes an authorized act that nothing describes.

**Decision:** opening an epic requires the STARTER role of the workflow the epic will run —
the same data-driven rule as D4, one tier up, so no new mechanism. In practice the intaker opens the
epic when a brief is accepted (the brief becomes its `context`) and the designer fills it. Creation
is **idempotent on a natural key** — one open epic per request — per the vision's federated-truth
rule, so two services racing the same request cannot produce two deliverables.

### D4 — The customer's verdict is OUT-OF-BAND, never a workflow stage

The tempting shape is `done → accepted`. It is wrong, and [design/auditor.md](../design/auditor.md)
D1 already argued why, for the same reason:

> The auditor judges the *whole delivery against the original request*. A delivery is a **brief →
> one or more tasks**; the dev workflow is **per-task**. A per-task `audited` stage structurally
> cannot see whole-delivery/request scope.

Two more from the frame. A gating stage re-adds a standing human to the critical path that v5–v8
spent four versions removing. And **acceptance happens on the customer's clock** — sometimes weeks
after delivery — so a gating stage would stall the board waiting for a client to look.

`done` therefore stays exactly where it is and keeps meaning *we shipped it*. The verdict is a
separate, out-of-band record against a **completed epic**. Audit is a backstop, not a tollbooth; so
is acceptance.

### D5 — Feature rejection: the customer's veto

**A completed epic can be rejected by the customer.** Human-only.

**It says nothing about any family's competence.** The reason a delivery is rejected is usually not
that it was built badly:

| reason | what it is actually about |
| --- | --- |
| does not meet the bar | quality of the work |
| contractual change | scope moved underneath it |
| does not capture the requirements | the **request** was wrong, or intake mis-read it |
| no longer meaningful | well-built and obsolete — we were too slow, or the customer's world moved |

Only the first is about execution. So the veto **writes no denial, no strike, and no track-record
row against any family** — the [0022](0022-v5-scope-governance.md) rule that qualitative judgment
never auto-penalizes, applied to a judgment about *work* rather than about a worker.

This is also the first signal in the project that is **not keyed `(family, capability)`**. Strikes,
bans, track record, audit flags and spend all are. A rejection is keyed to the *delivery*, and its
aggregate is a statement about the **pipeline**: a run of *does not capture the requirements* means
intake is broken; a run of *no longer meaningful* means the company delivers too slowly. Neither is
any family's fault, and neither is expressible today. It is also the first honest answer to the
question installment 7 asked and v5 could not measure — *did we build the right thing?*

**Rejection triggers the revert.** You cannot unmerge; you can revert, which is what git is for. A
rejection cancels the epic's unfinished tasks and **opens revert work** for the merged part, executed
by the swarm through the normal integrator path — the company does the rework, the customer does not
touch git. (Considered and rejected: merely *proposing* a revert. It makes the customer say no
twice.) Because a revert task enters at the workflow's initial stage, the designer still decides
*how* to unwind — revert, or supersede — which is the right place for that judgment.

### D6 — Two interfaces, one boundary the database already enforces

The human has exactly two interfaces, and they are not alternatives:

- **human → interface.** A console. Direct, precise, recorded.
- **human → agent.** State intent in language; the operator seat translates it into substrate acts
  under its own identity, and the ledger says who did what.

**The line between them is not a design choice — it is already the EXECUTE grants.** The console
must cover exactly the acts **no agent can perform on the human's behalf**: `set_permanent_ban`,
`lift_ban`, `raise_audit_flag`, `raise_operational_flag`, the D5 veto, and key custody. All five
existing ones were verified to refuse a seat credential at the grant boundary. Everything else can
be mediated and therefore needs no console surface at all.

So **the console is not an admin panel or a board manipulator. It is the decisions only the customer
can make, plus the evidence for them** — six actions and the views that justify them. Its scope
cannot drift, because widening it would mean widening a grant.

**Perimeter: loopback, and [0025](0025-v7-security-posture-local-service.md) is NOT revised.** The
console binds to 127.0.0.1 with the same posture as the broker and the intake channel — authenticated
before anything is written. Anything reachable off-host triggers 0025's written widening contract in
full (TLS, a rotatable credential scheme, per-caller identity and authZ, rate limiting, an egress
re-review) and is a separate ADR, not a later commit.

### D7 — The instruction trail: record what was asked, not only what was done

`app.operator_actions` records `action · target · task_id · outcome · reason · detail · actor_sub`
and has **no `requested_by`** — while `app.operator_credentials` has one. The project recorded why a
*token* was issued and never why an *act* happened. "The seat refined a brief at 17:54:10" is in the
ledger; "the customer asked for it" is nowhere but a chat log on the human's laptop.

This is load-bearing for D5, not housekeeping: one of the four rejection reasons is *does not capture
the requirements*, and that cannot be adjudicated against a delivery unless something recorded what
was actually requested. So the mediated interface gains an instruction record, and an epic carries
the conversation that produced it — not only the tasks that came out.

The two interfaces are therefore coupled: **human → interface** gives the veto somewhere to be
exercised; **human → agent** gives it something to be exercised *against*.

### D8 — Per-transition usage attribution (the fix that keeps slipping)

`api.record_usage` is reported once per **sweep**, and a sweep is not a task. One measured sweep
(2026-09-02) had a single actor make **eleven transitions across two tasks and five capabilities**
under **one** token report; the designer filed 5,053,327 tokens for a sweep that designed *two*
slices, anchored wholly to one of them. The whole sweep lands on one `(family, capability)` and every
other capability it exercised reads `unknown` — which
[design/track-record.md](../design/track-record.md) D3 promises means *not measured*, never *free*.
#147 charged the first role-bearing transition instead of the last; that fixed the instance and
missed the class, because its evidence came from runs where every sweep touched one task — and that
held because the briefs were being written small enough to guarantee it, not because the substrate
did.

**It is in v9's scope, and not as a stray fix.** The console displays spend, and a wrong number is
not an instrument — it is worse than a blank, because a blank does not mislead. The fix is
driver-side (report per transition, or a per-transition breakdown) plus `api.record_usage` accepting
it. Until it lands, per-capability spend is attributable to a *sweep*, not to a capability, and
**cost-aware routing must not be built on it** — routing on these numbers would prefer families on
the strength of which transition happened to be first.

### The v9 success gate

1. A family staffed on a project claims work in an epic created **after** its token was minted,
   with no re-provisioning and no token growth.
2. A family staffed on project A is refused, by the substrate, on project B's work.
3. A request produces one epic; its tasks are reachable from the epic and the epic from the request,
   by query, with no timestamp inference.
4. A completed epic is rejected by the customer, with a reason; unfinished tasks are cancelled,
   revert work is opened, and **no family's denials, strikes or track record change**.
5. The console exercises all six human-only acts, and an agent credential is refused on every one
   of them — the v8 verification, re-run against the new surface.
6. An act taken by the operator seat on the human's instruction records **both** the act and the
   instruction.
7. Per-capability spend is attributed per transition: a sweep crossing N capabilities produces N
   attributions, and no capability a family exercised reads `unknown`.

### In scope for v9

- Project-scoped capability matching (D1), the `features.kind` constraint, and the sweep across
  seed, `roles.sh`, and tests.
- Dynamic epics: creation, the D3 gate, idempotency, the brief as `lanes.context`, and a **name on a
  task** (D2).
- The customer's veto with its reason taxonomy, cancellation, and revert-work generation (D5).
- The loopback console over the six human-only acts, decision-first (D6).
- The instruction trail on the operator ledger (D7).
- Per-transition usage attribution (D8).
- **The skills.** All ten mention lanes; `operator-intake` alone has 22 references. The feature
  strings are trivial; the model — *"you work a lane"* → *"you are staffed on a project"* — is in
  every one, and the change is mostly **deletion** (`claim --lane dev` becomes `claim`). Two
  additions are not deletions: `operator-config`'s seating procedure becomes staffing, and the
  operator skills must state that **the seat cannot veto**, as explicitly as they state it cannot
  permanently ban — a capable agent operator is exactly the actor that would drift into the
  customer's chair. `skills/README.md` gains the third audience.
- ADR 0025's actor model absorbs **customer** as the human class's proper name.

### Out of scope for v9 — deferred (constraints, not built)

- **Off-host anything.** The console is loopback. A remote customer is 0025's widening contract and
  its own ADR.
- **The `goal` tier.** The vision's tier above `project` stays future.
- **Cost-aware routing.** D8 makes the numbers trustworthy; *using* them to pick a family still
  crosses the [0026](0026-v7-1-demand-shaped-scaling.md) router line.
- **An agent customer.** The veto is human-only, full stop. Automating acceptance would delete the
  only judgment this ADR exists to seat.
- **Multi-customer / multi-tenant.** One customer, per 0025. Project scoping is staffing, not
  tenancy, and must not be mistaken for it.
- **Pointing a lane at a repository the system did not write.** D1 makes it *possible* and it is
  deliberately the version after this one: it is the most informative experiment available and it
  wants a console to watch it through.

## Bootstrap discipline (recursive)

Per [0024](0024-v7-scope-the-standing-service.md) §bootstrap and the standing split:

- **Assisted, mock-verified before live:** everything touching authorization (D1 — auth is the
  failure class where a wrong answer is silent), the epic create-gate (D3), the veto and its
  cancellation/revert generation (D5 — irreversible-adjacent), the instruction trail (D7), and the
  usage change (D8). DB views stay assisted, per the wipe lesson.
- **Swarm-built, hands-off:** the console's **read** surface — the decision inbox rendered from
  views — is a pure formatter over rows, which is the shape five hands-off deliveries have already
  taken. The skills sweep is mostly mechanical deletion and is a good second candidate.
- The recursion again, and pointedly: **the machine builds the console its customer will use to
  reject the machine's work.**

## The one decision that can flip

**D1.** Project-scoped staffing amends the oldest decision in the substrate
([0007](0007-auth-identity-family-grant-deny.md)) and touches six authorization sites, a constraint,
~38 config references, 32 test files and ten skills. If the owner prefers lane-scoped features to
stay, then D2 needs a prefix/class feature (`lane:dev/*`) instead, tokens grow with the number of
open epics, and the cross-project isolation that makes the second-repo experiment safe has to be
invented separately. Everything else in this ADR survives that choice; it just gets more expensive
and less clean.

## Alternatives considered

- **A `parent_id` / `brief_id` column on `app.tasks`.** Rejected: `lane_id` already is that pointer
  once lanes are bounded, and a second lineage column would immediately disagree with the first.
- **`done → accepted` as a workflow stage.** Rejected per D4 — a per-task stage cannot see
  whole-delivery scope, it re-adds a standing human to the critical path, and it stalls the board on
  the customer's clock.
- **A rejection that penalizes the delivering families.** Rejected: three of the four rejection
  reasons have nothing to do with execution, and the one that does is already covered by
  reject/strike inside the workflow. Penalizing here would make the customer's commercial judgment
  into a performance review, which is precisely what [0022](0022-v5-scope-governance.md) forbids.
- **A wildcard lane feature (`lane:dev/*`).** Rejected in favour of D1: it makes dynamic epics work
  without explaining *why* a worker may touch them. Project scoping answers the question instead of
  routing around it — and delivers cross-project isolation as a side effect.
- **One general-purpose web admin panel.** Rejected: its scope would be "everything", and it would
  drift into doing things an agent should do. Deriving the console's surface from the EXECUTE grants
  keeps it small and makes widening it a visible act.
- **Fixing D8 separately, later.** Rejected — it has now slipped twice, and a console that displays
  per-capability spend built on sweep-level numbers would publish a wrong figure with a confident
  face.

## Consequences

- **The human becomes a modelled actor**, with a name (customer), a first-class thing to judge
  (the epic), an act that was previously unrepresentable (the veto), and two interfaces divided
  along a line the database already enforces.
- **Staffing moves to the tier where it belongs.** A worker is on an engagement, not posted to a
  queue; deliverables come and go inside it without touching anyone's credentials. Tokens stop
  growing with the board.
- **The first process-level signal.** Everything measured so far judges a family. Rejection reasons
  judge the pipeline — and give v5's unanswerable question its first data.
- **The oldest decision in the substrate is amended** for the first time since M2, deliberately and
  in one place, with the six call sites and the fallback written down.
- **Two things become possible that were not.** A repository the system did not write becomes a
  *project* with its own staff and its own perimeter. And an unwanted delivery becomes a reversible
  one, by the company, on the customer's word.
- **The spend signal becomes trustworthy**, which unblocks cost-aware routing as a *future* decision
  rather than a blocked one.
- [`design/customer-seat.md`](../design/customer-seat.md) settles the mechanics: the epic lifecycle and cancellation semantics, the
  verdict record's shape, the console's decision-inbox layout, the instruction record, and the
  per-transition usage protocol.
