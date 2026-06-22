# Plan — AINARRES v2

> Scope and the success gate are fixed by [ADR 0013](../decisions/0013-v2-scope-self-development.md);
> the net-new mechanisms by [ADR 0014](../decisions/0014-task-dependencies.md) (dependencies),
> [ADR 0015](../decisions/0015-egress-as-capability.md) (egress-as-capability), and
> [ADR 0016](../decisions/0016-development-workflow.md) (the dev workflow). Each milestone is
> one PR-sized slice that ends green, then gets a blog article. The within-milestone loop is
> still **change → test → integrate → validate**, iterated until all tests pass *before*
> committing.

## Objective

Build the plumbing that lets **AINARRES be developed within AINARRES**, and prove it by
bootstrapping: ship a real AINARRES feature — the bare-minimum oversight tool — as an
AINARRES project, decomposed into dependent tasks, worked through the verbs, integrated to
a real merged PR, with the owner supervising and zero out-of-band coordination.

## Success criterion ([ADR 0013](../decisions/0013-v2-scope-self-development.md))

A real feature is decomposed into dependent `dev`-lane tasks; agents `claim`/`advance`
them through `proposed → … → done`; the integrate stage produces a real merged PR via an
agent holding `capability:integrate`; work product is in git; the owner oversees via the
new tool. Reached at **M10**.

## Execution discipline

- **Branch → commit → push → PR** per milestone ([workflow](../../README.md)). Owner reviews.
- **Done = verified:** a milestone's done-tests all pass in the repeatable loop before the
  PR. No item committed red.
- **Repeatable loop** is the validate step for every milestone: `down -v → up → dbmate up
  → seed → test`. v2 adds no new infra — still stock `postgres:18` + PostgREST + dbmate +
  vitest, single instance ([ADR 0013](../decisions/0013-v2-scope-self-development.md)).
- **plpgsql only** ([ADR 0005](../decisions/0005-logic-language-escalation.md)); migrations
  are plain-SQL up/down ([ADR 0010](../decisions/0010-environment-migrations-testing.md)).
- **Bootstrap honesty:** dogfooding flips on as early as feasible (target: M9 onward); each
  retro states how much of the milestone ran *on* AINARRES versus by hand. M10 is fully
  on-AINARRES by definition.
- One blog article per merged milestone (continues the *AINARRES* series, `Series_Order`
  increments from 1).

## Dependency order

```
M7 dependencies ─▶ M8 egress-as-capability ─▶ M9 dev workflow + ergonomics + docs ─▶ M10 bootstrap (gate)
```
M7 and M8 are independent of each other in principle, but M7 first keeps the schema change
ahead of the feature work. M9 needs both. M10 needs all three.

---

## M7 — Task dependencies

**Goal:** a task can wait for prerequisites; the claim respects ordering.
([ADR 0014](../decisions/0014-task-dependencies.md))

**Steps**
- Migration: `tasks.depends_on uuid[]` (nullable) + a supporting index for the
  satisfaction check. Down-migration drops both.
- `create_task(…, depends_on?)`: validate every id exists (else `{ok:false,
  code:"not_found"}`); acyclic-by-construction (prerequisites must pre-exist).
- `claim_next_task`: add the predicate "no unsatisfied prerequisite", where satisfied =
  prerequisite at a terminal stage; compose with existing `blocked`/lease checks.
- CLI: `create` accepts `--depends-on <id>[,<id>…]`.

**Done-tests**
- A task with an unsatisfied prerequisite is never claimed; once the prerequisite reaches a
  terminal stage, the dependent becomes claimable.
- A blocked prerequisite keeps its dependents unclaimable.
- `create_task` with a non-existent prerequisite id returns `not_found`; existing v1 tasks
  (no `depends_on`) are unaffected.
- Down-migration reverts cleanly; `make reset` stays deterministic.

**Blog:** "Ordering work without an orchestrator: task dependencies."

## M8 — Egress as a capability

**Goal:** a push-trusted agent turns an `integrate` task into a real PR; the power is a
gated feature. ([ADR 0015](../decisions/0015-egress-as-capability.md))

**Steps**
- Seed `capability:integrate` as a feature; grant it to the integrator family only.
- Confirm the gating works end to end: an agent without `capability:integrate` gets
  `not_eligible` for an integrate transition and is never handed an integrate task; one
  with it succeeds.
- Artifact richness: a documented shape for recording branch / PR url / commit sha as
  references in the event `data jsonb`; CLI support to attach them on
  `report_progress`/`advance`.
- The integrate-stage agent recipe (skill/agent): the `git push` + `gh pr create` (+ merge
  on review pass) steps, then the artifact-recording verb calls.

**Done-tests**
- Effective-features gate holds: integrate transition requires `capability:integrate`;
  withholding it yields `not_eligible`; granting it allows advance.
- An integrate task records a discoverable PR reference visible on the feed/board.
- Two-plane respected: the DB holds only references; the product is in git.
- No new long-running process; the stack is unchanged.

**Blog:** "Let the substrate decide who may push."

## M9 — The dev workflow, worker ergonomics, and docs

**Goal:** seed the real development workflow and make real (minutes-long, multi-task) work
ergonomic. ([ADR 0016](../decisions/0016-development-workflow.md))

**Steps**
- Seed the `dev` project/lane/workflow: stages `proposed→designing→implementing→reviewing→
  integrating→validating→done`, the advance + reject(rework) transitions, role features
  (`role:designer/implementer/reviewer/integrator`) and `capability:integrate` on the
  right transitions, per-stage generous `lease_duration`s.
- Register real agent families with their role/capability features; mint tokens
  (frontier = designer+reviewer+integrator+integrate; worker = implementer [+integrate if
  its runtime is push-trusted]).
- Worker ergonomics: **bounded auto-heartbeat** in the agent client (renew while working,
  capped so a dead agent still expires); confirm a long task is not reclaimed under a
  healthy holder; an `ainarres` PATH shim/alias so agents call `ainarres …` not
  `node bin/ainarres.mjs`.
- Docs cleanup: README reconciled with the implementation — lazy reclaim (not `pg_cron`),
  plpgsql (not `plv8`), status reflects v1-done/v2-in-progress, ports/quickstart accurate.

**Done-tests**
- The `dev` workflow seeds idempotently; the role/capability gating matches
  [ADR 0016](../decisions/0016-development-workflow.md) (each transition admits only the
  intended features).
- A simulated long task with auto-heartbeat survives past one lease period and is not
  reclaimed; a *stopped* heartbeat lets the lease expire and the task reclaim (the safety
  property still holds).
- README contains no claim the code contradicts (checked against the running stack).

**Blog:** "Teaching AINARRES its own development loop."

## M10 — Bootstrap: build the oversight tool on AINARRES (success gate)

**Goal:** prove [ADR 0013](../decisions/0013-v2-scope-self-development.md) — ship a real
feature as an AINARRES project.

**Steps**
- Decide the oversight tool's form (lean toward a non-interactive `ainarres status`
  dashboard or a small read-only TUI over the board/feed/abandoned + dependency view).
- As a **frontier (designer) agent**, decompose it into `dev`-lane tasks with `depends_on`
  edges (design → implement → tests → docs), all via `create_task`.
- Run the feature on AINARRES: worker agent(s) claim and implement; the frontier reviews;
  an integrator agent opens and merges the PR; post-merge validation advances to `done` —
  **entirely through the verbs**.
- The owner supervises the run using the very tool being built (once partially landed) and
  the existing views; intervenes via `block`/`unblock` if needed.

**Done-tests / success gate**
- A real feature reaches `done` with its tasks having traversed the dev workflow via the
  verbs, ordered by dependencies, with a **real merged PR** and work product in git.
- No row was hand-edited; no coordination happened outside AINARRES.
- The board/feed show the journey; the owner oversaw it; the retro records the
  on-AINARRES-vs-by-hand split honestly.

**Blog:** "AINARRES built AINARRES: the bootstrap."

---

## Open follow-ups (tracked, not blocking v2)

- **Governance policy** (quality-review → `feature_denial`) — plumbing dormant; activated
  in v3 when multi-worker failure makes it meaningful ([ADR 0004](../decisions/0004-feature-model.md)).
- **Scaling** — pooling, replication, sharding; single-instance until proven needed
  ([ADR 0013](../decisions/0013-v2-scope-self-development.md)).
- **Substrate-initiated egress** — the outbox + `LISTEN/NOTIFY` consumer, when a case needs
  egress not tied to an agent ([ADR 0015](../decisions/0015-egress-as-capability.md)).
- **Federation** — several frontier models forming workgroups (the v3 thesis).
- **`stages.satisfies_dependency`** — only if a workflow ever needs a terminal *failure*
  stage ([ADR 0014](../decisions/0014-task-dependencies.md)).
- **`validate` sandboxing** — trusted-author assumption today (carried from M6b).
