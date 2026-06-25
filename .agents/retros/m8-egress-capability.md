# Retro — M8: egress as a capability

- Date: 2026-06-22
- PR: build/m8-egress-capability
- Plan: [v2-plan.md](../plans/v2-plan.md) (M8)
- Implements: [ADR 0015](../decisions/0015-egress-as-capability.md)

## What shipped

Pushing to git / opening a PR is now a **gated capability**, not an ambient power: a
family can be allowed to code but not push, which makes it ineligible for an
`integrate` transition. The substrate — not the agent — decides who may touch the
outside world.

- **Seed:** `capability:integrate` feature + grant to the frontier family
  (`claude-code+opus`), which plays the integrator role.
- **CLI artifact richness:** `advance`/`reject`/`progress` gain `--pr URL`,
  `--branch NAME`, `--commit SHA`, recorded as typed references
  (`{type:"pr",url}`, `{type:"branch",name}`, `{type:"commit",sha}`) in the event
  `data.artifacts` — references, never content ([ADR 0003](../decisions/0003-two-plane-source-of-truth.md)).
- **Integrator recipe:** `skills/ainarres-integrator.md` — claim an integrate task,
  `git push` + `gh pr create` + merge-on-green, record the PR/branch/commit refs, advance.

## The headline: no new mechanism

**M8 added zero schema and zero verb code.** ADR 0015's thesis was that egress-gating is
*just another feature on a transition*, and that held: the feature model
([ADR 0004](../decisions/0004-feature-model.md)) and the existing eligibility checks
already express it completely. Concretely, with the integrate transition requiring
`capability:integrate`:

- `claim_next_task` already skips a task at the integrate stage for a caller lacking the
  capability — its "≥1 eligible outbound transition" predicate fails — so the task is
  *never handed out*.
- `advance_task` (`do_transition`) already returns `not_eligible` if a holder's effective
  features don't cover the transition's `required_features`.

So the work was *proving* the property and adding the egress *convention* (artifact
shape + recipe), not building a gate.

## Done-tests (met)

- `make reset` green: **56 tests pass**, incl. 3 new in `test/egress.test.ts`:
  a coder (no `capability:integrate`) gets `empty` when only an integrate task remains;
  an integrator claims it, advances to `done`, and the **PR reference is discoverable on
  the feed** (two planes — DB holds only the reference); a holder whose token is stripped
  of the capability gets `not_eligible` on advance.
- Seed idempotency + the `family_features` count (now 8) updated and green.

## Bootstrap honesty (ADR 0013)

**Built 100% by hand.** Still floor-laying: the dev workflow that *consumes*
`capability:integrate` (the integrate stage and the integrator family proper) arrives in
M9, and the role skills + context-clean rehearsal in M10. M8's integrator skill is the
recipe those will build on.

## Follow-ups (not blocking)

- The integrator skill's `.opencode/` agent wiring + the context-clean rehearsal that
  actually exercises a real `gh pr create` belong to M10 (role skills) / M11 (bootstrap),
  where the integrator runtime + `gh` auth question (still open) is resolved.

**Blog:** "Let the substrate decide who may push."
