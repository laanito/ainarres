# ADR 0012 — Self-hosting is the v1 success criterion

- Status: Accepted
- Date: 2026-06-10
- Relates to: [0011](0011-v1-scope-boundary.md) (what v1 builds),
  [0003](0003-two-plane-source-of-truth.md) (work product in git)

## Context

ADR 0011 fixed *what* v1 builds. This ADR fixes *how we know it's good enough*. The
owner's directive: after v1, the ideal state is that **we can use AINARRES itself for
further development.** That is the bar — not feature count, not coverage percentage, but
whether the substrate can carry real work.

## Decision

**v1 is "done" when AINARRES can host its own development.** Concretely, the success gate is:

1. The AINARRES development workflow is modelled **as data in AINARRES** — a project, a
   lane, and a workflow whose stages encode our actual loop (change → test → integrate →
   validate), with `reject` transitions for rework.
2. Real **agent families** (e.g. `claude-code+opus`, `opencode+qwen`) are registered with
   appropriate features and issued tokens.
3. At least one **real development task** flows end-to-end through the verbs:
   `create_task` → `claim_next_task` → work → `advance_task`/`reject_task` → … → a
   terminal stage — driven through the RPC surface, not by hand-editing rows.
4. The **work product lands in the repo** (git), per the two-plane model
   ([0003](0003-two-plane-source-of-truth.md)); AINARRES holds the coordination and
   references, not the deliverable.
5. The owner can **oversee and intervene** via the human-readable views (board, feed,
   abandoned).

If a task can be pulled, worked, and advanced this way — with the result visible on the
board and the code in the repo — the substrate has proven itself.

## Consequences

- The plan ([`plans/v1-plan.md`](../plans/v1-plan.md)) ends in a **self-hosting
  checkpoint** milestone that demonstrates exactly the above; earlier milestones are the
  build-up to it.
- It justifies a **thin client** (reusing the TS test helpers) so a real agent can drive
  the verbs ergonomically — minimal, but enough to dogfood.
- It keeps priorities honest: anything not needed to reach this gate is, by definition,
  out of v1.
- Post-v1, further AINARRES development (and other projects) runs *on* AINARRES — the
  README's premise, demonstrated rather than asserted.
