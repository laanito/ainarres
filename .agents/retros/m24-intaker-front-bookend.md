# Retro — M24: the intaker & the front bookend (v6's last milestone)

- Date: 2026-08-16
- PRs: fleet #114 (seat muse-glimmer + migrate grok 4.5→4.6), Slice A (intaker role +
  intake workflow) #115, Slice B view half (`api.open_briefs`) #116 (assisted), Slice B
  report-line #117 (built hands-off by the swarm); retro this PR.
- Plan: [v6-plan.md](../plans/v6-plan.md) (M24) · Design: [intake.md](../design/intake.md)
- Implements: [ADR 0023](../decisions/0023-v6-scope-seat-the-bookends.md); completes v6 —
  seats the second of the two out-of-loop bookends (M23 was the first).

## What shipped

M23 named the **back** bookend — the auditor's *operational* sense (pipeline health + token
spend). M24 names the **front** bookend — the **intaker** (Consultant), who turns a raw
request into a well-formed brief before any work starts. With both, the full chain — Customer
→ **Intaker** → Designer → Implementer/Reviewer/Integrator → **Auditor** — is named in the
substrate, end to end.

- **`role:intaker`** (D5) — a plain human-held role feature. Existence seeded; granting it
  stays an owner reprovision (the ADR 0007 asymmetry), exactly like every other role. It
  federates later (an agent shaping requirements is v8+); v6 seats it human-held.
- **The `ainarres-intake` workflow + lane** (D1/D2) — `proposed_brief` (initial) → `briefed`
  → `accepted` (terminal), two advance transitions gated `[role:intaker]` then
  `[role:designer]`. The request-root is a **task in a new lane**, not a prepended dev stage
  (a brief is 1:N its dev tasks) and not a first-class entity (deferred, symmetric with M22
  D8). No reject/rework in v1 — a wrong brief is reworked in place while still `proposed_brief`.
- **Two-tier creation — via the *unmodified* D4 gate** (D4, the headline). Zero `create_task`
  change. The federation create-gate is already data-driven ("to create in a lane you must
  hold the role that advances out of its initial stage"), so a second lane whose starter is
  `role:intaker` makes the *existing* gate enforce: intaker creates in intake / not dev;
  designer creates in dev / not intake. The milestone's core wrote **no verb code**.
- **`api.open_briefs`** (D7) — a read-only, oversight-only view over `api.board` scoped to the
  intake lane (briefs by stage, newest-first), and a report **intake block** (pending /
  briefed / accepted counts + open-brief list) — the same dumb-view + pure-report-line split
  as every v5/M23 surface.
- **Fleet** (#114) — `opencode+muse-glimmer` (30B local MLX) seated as a serial implementer,
  and the frontier migrated `grok-4.5 → grok-4.6` (a family *rename*, since the M20 track
  record is per-`(family, model)`).

`create_task`, `effective_features`, the advance gates, and all of M21/M22/M23 are
**unchanged**. The two-tier property is entirely a consequence of the seed + the existing gate
— "additive grants, no new mechanism" (ADR 0023) made literal.

## The v6 arc (the two bookends the orchestrator held by hand)

- **M23 — the back bookend.** The auditor grew from delivery *quality* (v5/M22) to operational
  *health*: a `raise_operational_flag` verb + append-only ledger, a spend watch
  (`tokens_per_delivery` vs the per-capability peer median) and a health watch (stalled/
  stranded claims), surfaced in the report — measuring, never auto-penalizing (cost ≠
  competence). PRs #110/#111/#113; blog installment 9.
- **M24 — the front bookend.** The intaker: a request-root lane, two-tier creation for free,
  the brief a lightweight stand-in for the vision's *epic* (`payload.brief` groups a brief's
  dev tasks — closing M22 D8's open request-side loop).

## The gate result (ADR 0023 success criterion, both conditions met)

1. **A `role:auditor` holder raises an operational flag** — a spinner (health watch) or an
   overspender (spend watch) — writing **no** denial, human-decided (M23; its first live
   render caught a real review-peer overspend at ~15× the peer median, tagged *cost* not a ban).
2. **A `role:intaker` holder creates a proposed brief that a `role:designer` decomposes** —
   two-tier creation works, and an agent lacking the starter role is refused **at the right
   level** (`intake.test.ts` proves the refusal is the D4 starter gate, not lane membership,
   by giving each actor *both* lanes and differing only by role).

Governance still only **removes** capability, never grants; the auditor still only **signals**,
never auto-bans. No topology change, no new attack surface — the loop is still owner-fed.

## The arc (findings, load-bearing)

1. **Two-tier creation fell out for free — the design's best result.** The M24 open question
   ("new workflow vs. a `proposed` task-state vs. a first-class brief entity") collapsed once
   we noticed the M19 create-gate was already data-driven. Seat a second lane; the gate does
   the rest. The headline milestone shipped its core as **pure seed data** — the strongest
   evidence yet that the substrate's create-vs-advance model was the right primitive.
2. **Design meets substrate at build time — and yields (again).** `intake.md` treated the
   intake workflow+lane as a migration with a clean down. The assisted build hit the ordering
   truth: **migrations run before `seed.sql`**, so the bootstrap `ainarres` project doesn't
   exist yet — every other lane lives in seed for exactly this reason. Resolution: the
   migration *ensures* the project idempotently (identical `on conflict do nothing`), keeping
   the intake workflow **self-contained** and the gate provable without seed. Same shape as
   M21's strikes-can't-live-in-denials and M22's actions-can't-be-events: the correct-first
   cores are cheap places for these to surface.
3. **The sharp negative test.** Proving D4 means proving the refusal is the *starter role*,
   not the lane. So each test actor holds **both** lane memberships and differs only by role —
   the intaker is refused in dev *while holding `lane:dev`*, isolating the gate under test.
4. **A model migration is a family rename, not a flag flip.** grok `4.5 → 4.6` renamed the
   family key (`grok+grok-4.6`) because competence/spend is per-`(family, model)` — a new
   model is a new identity, never blended with the old record. (The exact pattern #112 set
   for `grok-build → grok-4.5`.) It integrated the M24 report-line **autonomously** — the new
   frontier working end to end, hands-off, on first contact.
5. **Vet a new worker against the harness's *actual* toolset before seating.** muse-glimmer
   was dry-run through opencode first (drove `read`/`edit`/`write`, stopped cleanly, no
   hallucinated tools) — the discipline the disabled `nano` tier (which looped on a
   hallucinated `str_replace_editor`) taught. It passed; it is seated.

## Bootstrap honesty (ADR 0023 § recursive)

- **Assisted + verified:** the fleet config (#114), M24 Slice A (the intake migration — an
  **auth-shaped change to the creation surface**, correct-before-live per the M19 D4 / M22
  Slice A rule; it writes no verb code but changes *who may create*), and the Slice B **view**
  (a DB view can't self-validate in a worktree — the board-wipe rule).
- **Built hands-off by the swarm:** the Slice B **report-line** (#117) — a pure
  formatter + graceful fetch, substrate-free to validate. Designer(`opus`) →
  implementer(`opencode+big-pickle`) → reviewer(`grok+grok-4.6`) →
  **integrator(`grok+grok-4.6`, autonomous merge)**, board draining clean. The instrument the
  swarm built read the intake block back into its own end-of-run report.

## Decisions that held up

- **No `create_task` change; the gate is verified, not modified** (D4). The design intent was
  reuse-unmodified, and it held — the only surprise was the project-ordering plumbing, not the
  gate. v6 stayed "additive grants."
- **The request-root is a task, not an entity** (D1). Reusing workflow/lane/stage/task/event/
  board machinery entirely is what made D4 fall out; a first-class brief/delivery entity ahead
  of the v7 channel that would populate it would have been premature (symmetric with M22 D8).
- **The brief is a lightweight epic** (fit with `vision.md`). `payload.brief` groups a brief's
  dev tasks — banking the vision's *delivery = epic* cheaply, and closing the request-side loop
  M22 D8 left open, without building dynamic epics (that is the service era).

## Honest limits (carried to v7)

- **Intake is non-interactive in v6.** The role's essence is a back-and-forth to pin a request
  down; v6 has no channel, so the "dialog" is the human editing the brief by hand. A real
  Customer↔Intaker exchange is the v7 write-channel — the intaker is *named and seated* here,
  *conversationally exercised* there.
- **The brief↔task link is a convention, not enforced.** `payload.brief` has no FK (no brief
  entity to point at). A first-class delivery/brief entity — and auditing a brief's *whole*
  task set — is deferred, symmetric with M22 D8.
- **One family holding both roles collapses the two tiers.** In v6 that's the owner wearing
  both hats (expected — the loop is owner-fed). The *separation* is real and proven; whether
  the pipeline should *forbid* one family holding both is a federation-era question.
- **The new roster is only half-exercised.** grok-4.6 integrated for real, but a single-task
  run let big-pickle's pool drain the one task before the serial tiers got a turn, so
  muse-glimmer did no work yet — and the spend watch stayed correctly quiet (one implementer =
  no peer baseline, `peer_count < 2`). Both need a multi-task fan-out to earn their keep.
- **Still one laptop, owner-started.** The bookends run on the bootstrap project, by hand; the
  crank (`make loop-run`) is still human-pulled. The always-on version is the service.

## What's next

M24 closes v6. **v6 — seat the bookends — is complete**: the two roles the orchestrator still
played by hand are now first-class. The substrate's claim now reads: *no orchestrator, many
agents at once from different makers, the workflow removes capability from those who prove
unfit, failures a rule shouldn't judge reach a human — and the request that starts the work
and the health of the machine that does it are both named roles.*

Deferred to **v7 — the standing service** (per [ADR 0023](../decisions/0023-v6-scope-seat-the-bookends.md)
and the roadmap): the **channel** the intaker needs to hold a real dialog and the **always-on
runtime** the auditor's watch wants — behind a **security-posture ADR up front** (the first
external ingress this project has ever taken). The loop was always scaffolding; the service is
the real thing. Owner's call after the pause.
