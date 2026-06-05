# `.agents/` — working memory for AINARRES

This directory is the **single source of truth** for how AINARRES is built. It is
written by and for agents (and the humans reading over their shoulder). If a decision,
plan, or rationale matters, it lives here — not only in commit messages or in someone's
head.

## Layout

| Dir            | What goes here                                                                 |
|----------------|--------------------------------------------------------------------------------|
| `analysis/`    | Problem framing, constraints, and the living list of open questions.            |
| `design/`      | Worked-out design: data model, state machine, the agent-facing verbs, auth.     |
| `decisions/`   | ADRs — one file per resolved decision, with the alternatives we rejected.       |
| `plans/`       | Autonomous work plans. A plan is only "ready" when each step has a done-test.    |
| `followups/`   | Deferred items, TODOs, and things parked mid-stream so they aren't lost.         |
| `retros/`      | Retrospective per completed plan slice: what we did, what surprised us.          |
| `blog/`        | Blog drafts documenting each completed slice (published per separate guidelines).|

## Phase gate

We are in **Phase 2: analysis → design → planning. No code yet.** Implementation does
not begin until there is a plan in `plans/` complete enough to execute autonomously.

## Conventions

- **ADRs** (`decisions/NNNN-title.md`): numbered, immutable once accepted. Changing a
  decision means a new ADR that supersedes the old one — we keep the history.
- **Settled vs open:** only **Postgres + PostgREST** are settled constraints. Everything
  else (logic language, auth model, state-machine representation, lease mechanics,
  scaling, egress) is an open question until an ADR closes it.
- **Done means verified:** an item is complete only when its tests and validation pass.
  No item is committed otherwise.
- **PR-based delivery:** every set of changes goes on its own branch → commit → push →
  open a PR. The owner reviews PRs (gatekeeping early, stepping back once the
  change→test→validate cycle is self-sustaining). Don't push straight to `main`.

## Status

| Date       | Phase     | Note                                          |
|------------|-----------|-----------------------------------------------|
| 2026-06-05 | Analysis  | `.agents/` created; analysis + open questions drafted. |
