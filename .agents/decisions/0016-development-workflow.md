# ADR 0016 — The AINARRES development workflow, modelled as data

- Status: Accepted
- Date: 2026-06-22
- Builds on: [0001](0001-data-driven-state-machine.md) (flow as data),
  [0004](0004-feature-model.md) (roles as features, requirements on transitions),
  [0008](0008-verb-contracts.md) (advance/reject), [0009](0009-leases-reaper.md)
  (per-stage leases), [0014](0014-task-dependencies.md) (decomposition),
  [0015](0015-egress-as-capability.md) (integrate capability)
- Decides: the stages, transitions, roles, and lease shape of self-development

## Context

v1's seed carried a *snippet-factory* workflow (`todo → review → done`) — enough to prove
the mechanism, too thin for real development. [ADR 0013](0013-v2-scope-self-development.md)
requires a workflow whose stages encode our actual loop — change → test → integrate →
validate, with rework — so that a real feature can flow through it. Per
[ADR 0001](0001-data-driven-state-machine.md) this is **data, not code**: stages,
transitions, and required-features are rows.

## Decision

### Stages (one terminal success stage)

A `dev` lane whose workflow has these stages:

| Stage | `is_initial` | `is_terminal` | Meaning |
|---|---|---|---|
| `proposed` | ✓ | | Created; awaiting design |
| `designing` | | | A designer is settling the approach |
| `implementing` | | | An implementer is writing code + tests |
| `reviewing` | | | A reviewer is checking the diff and running tests |
| `integrating` | | | An integrator opens/merges the PR (egress) |
| `validating` | | | Post-merge: the repeatable loop passes on `main` |
| `done` | | ✓ | Shipped |

`done` is the **only terminal stage**, so it cleanly doubles as "dependency satisfied"
([ADR 0014](0014-task-dependencies.md)). Failure never goes to a terminal stage: it loops
back via a `reject` transition (rework) or parks on the orthogonal `blocked` flag
(human-investigate), per [ADR 0009](0009-leases-reaper.md).

### Transitions (advance forward, reject for rework)

- **advance:** `proposed→designing→implementing→reviewing→integrating→validating→done`.
- **reject (rework):** `reviewing→implementing` (review found problems),
  `validating→implementing` (broke on `main`), `integrating→implementing` (PR could not be
  cleanly opened/merged). Reject is gated independently of advance
  ([ADR 0008](0008-verb-contracts.md)), so only a reviewer/integrator can send work back.

### Roles as features (who may do what)

Functional roles are features ([ADR 0004](0004-feature-model.md)), set as
`required_features` on the transitions *out of* each stage:

| Transition out of | requires |
|---|---|
| `proposed`, `designing` | `role:designer` |
| `implementing` | `role:implementer` |
| `reviewing` (advance or reject) | `role:reviewer` |
| `integrating` (advance or reject) | `role:integrator` + `capability:integrate` |
| `validating` (advance or reject) | `role:reviewer` |

Plus the implicit `lane:dev` feature on every task in the lane
([ADR 0007](0007-auth-identity-family-grant-deny.md)). `capability:integrate`
([ADR 0015](0015-egress-as-capability.md)) is what makes integration require a
push-trusted runtime; a family without it can hold every other role but never integrate.

A frontier model (Claude) typically holds `role:designer` + `role:reviewer` +
`role:integrator` + `capability:integrate`; a worker model holds `role:implementer` (and,
if its runtime is push-trusted, `capability:integrate`). The split is configuration, not
code.

Each of these roles carries a **published skill** that fully specifies how to perform it
through the verbs ([ADR 0017](0017-context-clean-validation.md)) — the holder operates
from the skill, not from ambient context. The feature gates *who may*; the skill defines
*how*.

### Decomposition convention

A **feature** is a set of `dev`-lane tasks linked by `depends_on`
([ADR 0014](0014-task-dependencies.md)) — typically a design task others depend on, then
implementation tasks, then a tests/docs task — and **each task traverses the stages
above**. Two mechanisms compose: dependencies order the work items; stages drive each
item's change→review→integrate→validate loop. The owner (or a frontier model in the
designer role) lays out the tasks and edges at the start of a feature.

### Lease shape

`dev` stages run for **minutes, not milliseconds** (a frontier model designing, a worker
implementing, a human-paced review). Per [ADR 0009](0009-leases-reaper.md), leases are
data-driven on the stage; this workflow sets generous per-stage `lease_duration`s and
relies on **bounded auto-heartbeat** in the agent client so a long, healthy task is not
reclaimed under its holder. Lease tuning + auto-heartbeat are built as worker ergonomics
in the plan; this ADR only fixes that the workflow *depends* on them.

## Alternatives considered

- **Keep the snippet workflow, add stages ad hoc.** Rejected: the dev loop is the thing
  v2 must encode faithfully; designing it once as an ADR keeps the seed honest and
  reviewable.
- **One stage = one task (no per-task review loop).** Rejected: review and validation are
  gates every work item passes, not separate work items; modelling them as stages lets
  reject-for-rework live where it belongs.
- **Bake role→stage rules into verb code.** Rejected outright — that is exactly the
  data-driven principle ([ADR 0001](0001-data-driven-state-machine.md)) we refuse to
  violate; roles-as-required-features on transitions keeps it as data.

## Consequences

- The seed gains a `dev` project/lane/workflow with the stages, transitions, and
  `required_features` above, plus the role/capability features and the real agent families
  that hold them.
- This workflow is what the bootstrap milestone ([ADR 0013](0013-v2-scope-self-development.md))
  runs on; the oversight tool is built as a feature decomposed into `dev`-lane tasks.
- Changing the loop later (add a stage, regate a transition) is editing rows, not
  rewriting verbs — the property that justified the data-driven machine in the first place.
