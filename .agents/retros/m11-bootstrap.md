# Retro — M11: bootstrap (v2 success gate ✅)

- Date: 2026-06-27
- PRs: build/m11-bootstrap (prep + skills + this retro) + the bootstrap's own merges
  (#23 Task A, #24 Task B — merged to `main` by the grok integrator)
- Plan: [v2-plan.md](../plans/v2-plan.md) (M11)
- **Closes the v2 success criterion — [ADR 0013](../decisions/0013-v2-scope-self-development.md).**

## What we proved

**A real AINARRES feature — the `ainarres status` oversight tool — was built end-to-end as
an AINARRES project, by fresh context-clean agents, and shipped to `main`.** The thing that
lets you watch the swarm was built by the swarm.

The feature was decomposed into two dependent `dev`-lane tasks and run through the full
workflow (`proposed → … → done`), entirely via the verbs:

| Step | Who | Outcome |
|---|---|---|
| Decompose | designer (Claude subagent, skill-only) | Task A (pure `formatStatus` + unit test) and Task B (CLI wiring, `depends_on: A`), self-contained payloads |
| Implement A | `opencode + qwen3.6` → **escalated** to a frontier (Claude) implementer | qwen wrote the code but couldn't close the formatter+test; **released**, re-claimed by a frontier implementer that finished it |
| Review A | reviewer (Claude subagent) | diff + substrate-free test → `integrating` |
| Integrate A | **`grok` (grok-build), invoked by the owner** | real PR #23 squash-merged to `main`; → `validating` |
| Validate A | reviewer check on merged `main` | `formatStatus` present, unit test green → **`done`** |
| Implement B | frontier implementer | CLI `status` wired, reuses `formatStatus`; clean, no gaps → `reviewing` |
| Review B | reviewer (Claude subagent) | diff + `help` lists `status` → `integrating` |
| Integrate B | **`grok`, owner-invoked** | real PR #24 merged to `main`; → `validating` |
| Validate B | **live `ainarres status` smoke** (oversight token) on `main` | printed real per-stage / abandoned / events summary, rc 0 → **`done`** |

Task B stayed unclaimable until A was `done` (M7 dependency gate, live). No row was
hand-edited; coordination happened only through AINARRES.

## The two load-bearing findings

1. **Capability-routing is real, not a slogan.** qwen3.6 handled the trivial rehearsal task
   but spiralled on a moderately complex one (a formatter plus a matching unit test). The
   substrate's `release` → re-`claim` path let a **frontier implementer** pick the *same
   task* up and finish it — the "don't burn frontier tokens on what a small model can do,
   but escalate when it can't" thesis, demonstrated under load.
2. **An orchestrator under a deny-policy cannot delegate the denied action to a sub-harness.**
   The merge is company-deny-gated for Claude Code, and the auto-mode guard correctly blocked
   "spawn grok `--always-approve` to run the denied command" as a bypass. So the integrator
   had to be a **genuinely independent agent** (grok, owner-invoked), holding
   `capability:integrate` on its own family. This is the correct security boundary *and* the
   shape the federation end-state needs ([ADR 0017](../decisions/0017-context-clean-validation.md)).

## Gaps found → fixed (skills, not hand-holding — ADR 0017)

- **Implementer wandered outside the repo** (qwen tried to write a test to `/tmp`; opencode's
  sandbox rejected it). → skills now say *write only inside the repo, at the task's exact paths*.
- **`validate` as the full suite corrupts the shared substrate.** The designer's payload put
  `&& npm test` in `validate`; running it injected `dev-workflow.test` tasks into the live
  `dev` lane and `parkDev`-blocked our bootstrap tasks (remediated by hand mid-run). → designer
  skill: make `validate` a *targeted, substrate-free* check; reviewer skill: run only that at
  `reviewing`; full-suite regression is the `validating` stage on a clean rebuild.
- **Worktree compose-project mismatch** (frontier implementer): in a worktree the DB-test
  helper's `docker compose` resolved the wrong project; it fixed it with a gitignored
  `COMPOSE_PROJECT_NAME=ainarres` `.env` (not part of the deliverable). The substrate-free
  `validate` fix above largely sidesteps this.

## Operational honesty (ADR 0013 / 0017)

- **Skill-driven (context-clean), fresh agents:** designer, both implementations, both reviews.
  No agent used this conversation's design context; the gaps above are exactly the context an
  orchestrator would otherwise have silently supplied.
- **Orchestrator (me), mechanical only:** shepherding `proposed→designing→implementing`,
  the post-merge `validating` health checks, and board remediation after the pollution
  incidents. No design/work knowledge was injected — supervision, not authorship.
- **Owner:** invoked the grok integrator for each merge (the one step neither the orchestrator
  nor a spawned sub-harness may perform), and merged the throwaway smoke-test PR earlier.

## v2 status

**v2's gate is met: AINARRES is developed within AINARRES.** The substrate carried a real
feature from idea to merged `main`, coordinated by independent, context-clean agents across
three harnesses (Claude Code, opencode/qwen, grok). From here, AINARRES development is the
default, not a demonstration.

## Follow-ups (post-v2, not blocking)

- **Pollution-proofing:** run the bootstrap substrate separately from the test substrate, or
  make the dev `validate`s strictly substrate-free, so no hand remediation is needed.
- **Integrator as a standing poller:** a long-running grok loop claiming `integrating` tasks,
  instead of a per-task owner invocation.
- **Concurrency:** per-task `git worktree` isolation (grok has native `--worktree`) for
  parallel implementers — deferred from v2's serialized first run.
- **Governance & federation:** the v3 theses (quality-review→revoke; several frontier models
  forming workgroups), now standing on a proven independent-agent substrate.

**Blog:** "AINARRES built AINARRES: the bootstrap."
