# The intaker: the front bookend — and two-tier creation, for free

> Design note for **M24** — the second v6 slice, seating the intaker (the Consultant)
> ([ADR 0023](../decisions/0023-v6-scope-seat-the-bookends.md) · [v6-plan](../plans/v6-plan.md)).
> Settles M24's open question (the shape of the "request-root / proposed brief") before code.
> Builds on the federation create-gate
> ([federation.md](federation.md) D4 · `20260701090000_create_requires_starter_role.sql`: to
> **create** in a lane you must hold the role that **advances out of its initial stage** —
> data-driven, no lane hardcoded), the feature model ([ADR 0004](../decisions/0004-feature-model.md):
> roles are features), and the auditor ([auditor.md](auditor.md) D8, which deferred a
> first-class delivery entity and anchored flags to a task — this note closes that loop).

## What M24 is for

The **intaker** (Consultant) is the front bookend the orchestrator still plays by hand: it
turns a raw request into a **well-formed brief** for the designer (Analyst) — elicit, scope,
clarify. Every brief the owner hand-writes and feeds the loop is an intaker act. M24 **names**
it a role and gives the brief a home, so the full chain — Customer → **Intaker** → Designer →
Implementer/Reviewer/Integrator → Auditor — is named end to end. It is **cognition, not a
channel**: the reasoning that shapes a request, not the pipe that carries it (that pipe is v7).

## The result: two-tier creation needs NO `create_task` change

The M24 open question was "new workflow vs. a `proposed` task state vs. a first-class brief
entity" for the request-root. Working it through collapses to a small, pleasing result:

**D4 already delivers two-tier creation. Intake is just a *second lane* whose starter role is
`role:intaker`.** The federation gate is data-driven: `create_task` refuses you unless you hold
a role that advances a task **out of that lane's initial stage**. For the `dev` lane that role
is `role:designer` (`proposed → designing`). Seed a **new `intake` lane** on a new
`ainarres-intake` workflow whose initial stage advances on **`role:intaker`**, and the *same*
gate now enforces:

- `role:intaker` may create in the **intake** lane (it can start a brief) — **not** in `dev`
  (it lacks `role:designer`);
- `role:designer` may create in the **dev** lane (it can start the decomposition) — **not** in
  `intake` (it lacks `role:intaker`).

**Two creators, two levels, one unchanged gate** — the request-root by the intaker, the
decomposition by the designer. No new create verb, no second create-path, no `create_task`
edit. This is the M24 headline, and it is why v6 stays "additive grants, no new mechanism"
(ADR 0023).

## Decisions (the open questions, settled)

**D1 — The request-root is a TASK in a new `intake` lane — not a prepended dev stage, not a
new entity.** Three shapes considered:
- **A prepended `requested` stage on the dev workflow** — *rejected*: a brief decomposes into
  **many** dev tasks (1 : N). A single task-row cannot be both the brief and its DAG; a linear
  stage can't model the fan-out.
- **A first-class `app.briefs` entity** — *rejected for v6*: heavier than needed, and M22 D8
  deliberately deferred the *symmetric* first-class **delivery** entity. Introducing a brief
  entity now, ahead of the v7 channel that would populate it, is premature.
- **A task in a new `intake` lane** — *chosen*: the "proposed brief" **is** an intake-lane
  task. It reuses workflow/lane/stage/task/event/board machinery **entirely**, and it is what
  makes D4 (above) fall out for free. The brief is a first-class *task*, not a first-class
  *entity* — the minimal move.

**D2 — The intake workflow is three stages, two transitions, mapping the two-tier handoff.**
```
proposed_brief (initial) --advance[role:intaker]--> briefed --advance[role:designer]--> accepted (terminal)
```
- `proposed_brief → briefed` requires **`role:intaker`** — this is both the intaker's *refine*
  step (elicit/scope/clarify → a brief ready for design) **and** the D4 starter that lets the
  intaker **create** intake tasks in the first place.
- `briefed → accepted` requires **`role:designer`** — the designer **accepting** a ready brief
  for decomposition. Accepting the brief and creating the dev DAG are the designer's two acts;
  the accept advance records "this brief is now being decomposed."
No reject/rework transitions in v1 (a brief that's wrong is re-worked by the intaker
in-place while still `proposed_brief`); a richer intake workflow is a later refinement.

**D3 — The brief ↔ dev-task link is a payload reference — and it closes M22's open loop.**
When the designer decomposes an accepted brief, each dev task it creates carries
`payload.brief = <intake_task_id>`. Chosen over `subject` (reserved for the entity a task
*operates on*, e.g. a family reprovision) and over `depends_on` (a DAG prerequisite, which the
brief is not) — a payload ref is explicit, least-invasive, and needs no schema change. **This
closes the loop M22 D8 left open:** the auditor audits "delivery **vs. the original
request**," and D8 could only anchor its flag to a *shipped task* for lack of a request-side
handle. The `payload.brief` link gives the auditor the **request → tasks** trail — the
intaker's crystallized brief is now the contract the auditor audits against (the roadmap's
"they pair" made real). The link is a **convention**, not an FK (no brief entity to reference);
enforcing it is deferred with the delivery entity.

**D4 — No `create_task` change; the gate is verified, not modified.** M24 writes **zero** verb
code for creation — it seeds the intake workflow and relies on the existing
`create_requires_starter_role` gate. The done-tests *exercise* the gate: an `role:intaker`
token creates an intake task and is **refused** creating a dev task; a `role:designer` token
creates a dev task and is **refused** creating an intake task; a family holding **both** can do
both (the owner-wears-both-hats case, D6). If the gate proves to need a tweak to resolve two
lanes cleanly, that surfaces here as an ADR — but the design intent is **reuse, unmodified**.

**D5 — `role:intaker` is a plain role feature, human-held first, federatable later.**
`(kind='role', key='intaker')`, seeded for existence only; **granting** it to a family stays an
owner reprovision (the ADR 0007 asymmetry, as with every role). Human-held in v6; a frontier
family doing requirements elicitation (the M19 move applied to intake) is v8+.

**D6 — No channel in v6; intake is exercised by hand on the existing loop.** The intaker is
*cognition*; v6 does **not** add an intake API/UI or external auth (all v7, with its ingress
threat-model ADR). v6 exercises the role the existing way: the owner, holding `role:intaker`,
creates and refines a brief via the current CLI/verbs, then (as the designer family, or holding
`role:designer`) decomposes it into the dev lane. The "interactivity" of intake in v6 is **the
human working the brief by hand**; a real Customer↔Intaker dialog is the v7 channel's job. This
keeps M24 additive — no new ingress, no topology change (ADR 0023).

**D7 — The surface is an "open briefs" board view + a report line.** `api.open_briefs`
(intake-lane tasks by stage — `proposed_brief` / `briefed` / `accepted`, newest-first, reusing
`api.board`) makes the intake state visible, and the report grows an **intake** line (pending /
briefed / accepted counts). Read-only; the same view+report-line pattern as every v5 surface.

## What changes: one role, one workflow, a link convention, a surface

```
role:intaker                       ← NEW feature (kind=role, key=intaker); human-held (D5)

workflow ainarres-intake + lane intake                                    ← NEW seed (D1/D2)
  stages:      proposed_brief (initial) · briefed · accepted (terminal)
  transitions: proposed_brief→briefed [role:intaker]   (starter — enables intaker create, D4)
               briefed→accepted        [role:designer] (designer accepts for decomposition)

dev tasks created from a brief carry  payload.brief = <intake_task_id>    ← convention (D3)
api.open_briefs                    ← NEW view: intake board by stage       (D7)
report: an "intake" line — pending / briefed / accepted briefs            (D7)
```

`create_task`, `effective_features`, the advance gates, M21/M22/M23 — all **unchanged**. The
two-tier property is entirely a consequence of the seed + the existing D4 gate.

## Slicing (build order within M24)

- **Slice A — seed `role:intaker` + the intake workflow/lane/stages/transitions, and verify
  the two-tier gate (ASSISTED, mock-verified).** Though it writes **no verb code**, it changes
  the **creation-gate surface** (a second lane, a second legitimate creator) — an auth-shaped
  change that must be correct before it runs live (the M19 D4 / M22 Slice A rule). Done-tests:
  the intake workflow exists with the two transitions; `role:intaker` creates in `intake` but
  is refused in `dev`; `role:designer` creates in `dev` but is refused in `intake`; a brief
  advances `proposed_brief → briefed` (intaker) → `accepted` (designer); down-migration drops
  the workflow, lane, and role feature.
- **Slice B — the open-briefs surface + report line (SWARM-ELIGIBLE → brief for the owner to
  run).** `api.open_briefs` (SQL view, **validated ASSISTED** — no DB in a worktree) and the
  report's **intake** line (a **pure formatter + graceful fetch**, **substrate-free** to
  validate — the hands-off #87/#91 slice). The end-to-end **exercise** of the gate (an intaker
  creating a real brief a designer decomposes and the loop delivers — the ADR 0023 success
  gate) rides a normal dev run, by hand, once Slice A is on `main`.

## Open risks (honest)

- **Intake is non-interactive in v6.** The role's essence is a back-and-forth to pin a request
  down; v6 has no channel, so the "dialog" is the human editing the brief by hand. Real
  Customer↔Intaker interaction is the v7 write-channel — the intaker is *named and seated*
  here, *conversationally exercised* there.
- **The brief↔task link is a convention, not enforced.** `payload.brief` has no FK (there is no
  brief entity to point at — D1). A first-class delivery/brief entity with a real reference —
  and auditing a brief's **whole task set** — is deferred, symmetric with M22 D8.
- **One family holding both `role:intaker` and `role:designer` collapses the two tiers.** In
  v6 that's the owner wearing both hats (expected — the loop is owner-fed). The *separation* is
  real and provable (grant distinct families distinct roles → D4 refuses each in the other's
  lane, Slice A done-test); whether the pipeline should *forbid* one family holding both is a
  federation-era question (v8+), not a v6 one.
- **A stalled brief has no rework path** (D2 keeps v1 minimal). A brief that should be abandoned
  is handled by the human; a reject/expire transition on the intake workflow is a later
  refinement.
