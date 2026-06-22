# ADR 0015 — Egress as a capability: agent-driven integration, gated by a feature

- Status: Accepted
- Date: 2026-06-22
- Builds on: [0004](0004-feature-model.md)/[0007](0007-auth-identity-family-grant-deny.md)
  (features, effective = grant − deny), [0003](0003-two-plane-source-of-truth.md) (two
  planes, references), [0008](0008-verb-contracts.md) (verbs, artifacts as references)
- Decides: how a task becomes a real branch/PR/merge, and how that power is controlled

## Context

For AINARRES to be developed within AINARRES ([ADR 0013](0013-v2-scope-self-development.md)),
a task reaching the **integrate** stage must turn into a real branch, a real PR, and a
real merge — otherwise "developed within AINARRES" still means a human opens the PR by
hand, and the loop is not closed.

Two questions: *who performs the egress*, and *how is the power to mutate the outside
world controlled*. The owner answered the second directly: **pushing should be a
capability of the agent**, so we can have agents that work locally but are not allowed to
push — making them unsuitable for, and ineligible for, coding/integration stages.

## Decision

### Egress is agent-driven; the substrate coordinates and references

The agent holding an `integrate` task performs the egress **itself**, in its own runtime,
using the tools it already has (`git push`, `gh pr create`, and — once review passes — the
merge). It then records the result (branch name, PR url, commit sha) as **artifact
references** in the task's event `data jsonb`
([ADR 0006](0006-task-identity-events-artifacts.md)) via `report_progress`/`advance_task`.

This keeps the two-plane model intact ([ADR 0003](0003-two-plane-source-of-truth.md)): the
**database coordinates** (which task, what stage, who did it, a reference to the PR); the
**product lives in git/GitHub**. The substrate never makes a synchronous outbound call —
no new process, no foreign data wrapper on the hot path, no dent in "Postgres + PostgREST
is the whole stack."

### The power to push is a gated feature

Integration is gated by a **capability feature**, `capability:integrate` (carrying the
right to `git push` + open/merge a PR). It is just another feature in the unified model
([ADR 0004](0004-feature-model.md)):

- The `integrate` transition in the development workflow
  ([ADR 0016](0016-development-workflow.md)) carries `capability:integrate` in its
  `required_features`.
- Eligibility is **effective features = token grant − family denials**, read from verified
  claims, never from arguments. An agent family without `capability:integrate` is simply
  **not eligible** for the integrate transition: it can claim and work design, implement,
  and review tasks, but `claim_next_task` will never hand it an integrate task, and
  `advance_task` into integration returns `code:"not_eligible"`.

So a "local-only coder" family (e.g. a small model trusted to write code but not to mutate
the repo) is expressible by **withholding one feature** — no special-casing, no new
mechanism. The substrate, not the agent, decides who may touch the outside world.

### The capability is also a trust boundary

Holding `capability:integrate` asserts that the family's **runtime is trusted and
provisioned** for egress: a working git remote and an authenticated `gh` (or equivalent).
This is a deployment property of where that family runs, granted deliberately. Untrusted
or experimental families are granted the coding features but not this one. (GitHub
operations use the `gh` CLI; the substrate issues no outbound HTTP itself.)

## Alternatives considered

- **Substrate-driven egress (outbox + `LISTEN/NOTIFY` consumer).** The v1-noted design,
  and genuinely better when egress must be *substrate-initiated* (e.g. crossing a shard
  boundary, or retried independently of any agent). Rejected for v2: it adds a
  long-running consumer process — the exact moving part v1 worked to avoid — for no gain
  while a single trusted agent can perform the push inline. The seam stays open: when
  substrate-initiated egress is needed, the outbox slots in without changing this
  capability gate.
- **Egress open to any coding agent.** Rejected: it removes the owner's ability to run a
  model locally for code without granting it repo-write. Gating push as a feature is the
  whole point.
- **A dedicated `integrate`/`push` verb.** Rejected: integration *is* advancing a task
  across the `integrate` transition; the side effects (push, PR) are the agent's work for
  that stage, recorded as artifacts. No verb-surface change is warranted
  ([ADR 0008](0008-verb-contracts.md)).

## Consequences

- New capability feature `capability:integrate`; the development workflow's integrate
  transition requires it. No schema change — features are `(kind, key)` rows.
- The integrate-stage agent recipe (skill/agent) includes the git/`gh` steps and the
  artifact-recording calls; non-integrating workers never see those steps because they
  never claim those tasks.
- The substrate's outbound-mutation surface is **exactly the set of families holding
  `capability:integrate`** — auditable via effective-features and the event log.
- v2 reaches [ADR 0013](0013-v2-scope-self-development.md)'s gate with no new
  infrastructure; substrate-initiated egress remains a clean future addition.
