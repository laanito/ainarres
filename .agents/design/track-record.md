# The family track record: the signal before the sentence

> Design note for **M20** — the first v5 milestone ([v5-plan](../plans/v5-plan.md) ·
> [ADR 0022](../decisions/0022-v5-scope-governance.md)). Settles M20's open questions before
> code. Builds on M16's already-attributable event log ([`observability.md`](observability.md),
> migration `…0630_observability_views`), M19's per-transition family attribution
> ([`federation.md`](federation.md), `familyOfTransition`), the two-plane model
> ([ADR 0003](../decisions/0003-two-plane-source-of-truth.md)), and the token-grant − DB-veto
> model ([ADR 0007](../decisions/0007-auth-identity-family-grant-deny.md)).

## What M20 is for

Governance (M21) removes a capability from a family that has proven bad at it. Before you can
*sentence* a family you need a fair, attributable **record**. M20 builds that record — and
only the record; it applies no consequence. It is the deliberate runway ADR 0021 named when
it deferred governance: *"the substrate does not yet capture enough rich, attributable outcome
signal to judge a family fairly."*

Two facts shape the milestone:

- **The competence signal already exists, structured and unforgeable.** M16 found the event
  log was *already* attributable: `advance`/`reject` stamp one `type='transition'` event whose
  `data` carries `{kind, from, to, reason, effects}` — `kind` **is** the verdict, `reason`
  **is** the reject reason — and `actor` is server-stamped from the JWT `sub`, joined to a
  family by `api.timeline`. M20 does not enrich the verbs; it **aggregates** what's there.
- **The spend signal is emitted but discarded.** Every headless harness result carries
  per-model **token counts** (in `loop/run/*.log`). It never reaches the substrate. M20
  captures the **tokens** — the [[idea-token-spend-metric]], finally recorded. (The harness
  also emits a `total_cost_usd`; we deliberately **do not** store it — see D3.)

**The output** ([ADR 0022](../decisions/0022-v5-scope-governance.md)): a read-only,
per-`(family, capability)` scored record — reject rate, validation outcomes, cross-family
review, **and token spend as its own separate signal** — that a hand-audit of the timeline
confirms, and that M21's ban rule can read in-DB. No consequence, this milestone.

## What changes: one write path, one view — no verb rewrites

Almost nothing in the mechanism, mirroring M16. The competence aggregates read from the
existing `type='transition'` events; the only genuinely new data is **cost**, and the only new
write is stamping it.

```
competence:  app.events (type='transition', already attributable) ──▶ aggregate  ──┐
tokens:      harness JSON (per-model token counts, in run/*.log)                   ├─▶ api.family_track_record
             └─ driver parses post-sweep ─▶ app.record_usage() ─▶ events(type='usage') ─┘   (read-only view, tokens only)
                                                                                       ──▶ end-of-run report reads the view
                                                                       (USD, if ever wanted, is a UI-level translation — never in the substrate)
```

## Decisions (the open questions, settled)

**D1 — Token spend is captured driver-side and written by a privileged verb — never
self-reported by the agent.** The `exec` model forces this: every poller (`grok-frontier.sh`,
`opencode-implementer.sh`, `claude-frontier.sh`) `exec`s into its tool, so the process is
*replaced* and the result JSON (with the token counts) only exists **after** it exits, captured
by the driver into `$RUN_DIR/*.log`. The agent literally cannot call a verb to report its own
usage — it's gone by the time the number is known. So the **driver** parses the sweep log and
calls a privileged `app.record_usage(p_actor, p_task, p_data)` that inserts a `type='usage'`
event (`data = {tokens: {input, output, cache_read, cache_creation}, model, sweep_id}` —
**tokens and model, no USD**). Attribution stays honest: `p_actor` is the real `sub` the driver
minted, so `actor→agents→agent_families` yields the true family — the driver *asserts* the
number, but the *family* is unforgeable exactly as every other event. The verb is granted to a
privileged role (the driver already mints an `OVERSIGHT_TOKEN` and can mint `admin`/`reaper`);
it is **append-only usage data with no capability effect** — a modest write, not a governance
action.

**D1 amendment (v8, 2026-08-28) — an empty sweep is not a free sweep.** As built, M20's verb
resolved the charged task from the actor's last transition and, finding none, wrote **nothing**;
the migration called that "the empty-sweep invariant, enforced in the substrate, not merely by
driver discipline". The reasoning was that a sweep which moved no task had done nothing worth
attributing. Measurement disproved it. In one real delivery, three implementer tiers woke after
the pool had already claimed the only pending task, found nothing, and burned:

| family | steps | tokens |
| --- | --- | --- |
| `opencode+nemotron-3-ultra` | 41 | 304,210 |
| `opencode+muse-glimmer` | 20 | 140,323 |
| `cursor-agent+composer-2.5` | 15 | 29,706 |

~474k tokens — about **21% of that delivery's recorded cost** — spent discovering there was
nothing to do, none of it recorded. An empty sweep costs a model load, a system prompt, a board
read and a decision to stop. The invariant measured the wrong thing: not "was spend incurred"
but "was a task moved".

The blindness was also **biased**. It hid spend precisely where waste concentrates — redundant
tiers, thrashing pools, a family that claims nothing all day — so the signal was quietest exactly
when it should have been loudest, and the demand-gate fix that removes this waste (M27) could not
be shown to work because the thing it saves was never counted.

So task-less spend now lands in **`app.sweep_usage`**, its own append-only ledger, surfaced by
`api.sweep_usage`. It is a LEDGER and not an event for the third time the same reason has applied:
`app.events.task_id` is `NOT NULL`, and task-less spend has no task by definition (M22 D7, and the
v8 operator action ledger). The task-anchored path is unchanged. Two constraints hold:

- **It is never folded into `api.family_track_record`.** That view is per-(family, capability) and
  spend with no task has no capability to attribute to; blending would contaminate a competence
  signal with a cost one, which is exactly what **D3** exists to prevent. It is surfaced alongside.
- **Attribution is still refused rather than guessed.** A sweep that never claimed has no agent
  row, so the driver names the family — no weaker a claim than the number itself, which it has
  always been trusted to assert. When neither the actor nor a named family resolves, the verb
  refuses: an unattributable number is worse than a missing one, because it reads as somebody's.

**D2 — The track record is a SQL view (`api.family_track_record`), not JS in the report.** M16
and M19 put family attribution in `bin/ainarres.mjs` (`familyOfTransition`) because the
*consumer* was the report. M20's ultimate consumer is **M21's ban rule, which runs in-DB** —
so the record must be readable from SQL, not computed in Node. The attribution `familyOfTransition`
did in JS ("who advanced task X from `from`→`to`") is expressible in SQL over `app.events`
(the transition event's `actor`). The report then just *reads the view* (simpler JS); M21
reads the same view. One source of truth for the record, in the plane that needs it.

**D3 — The substrate records TOKENS, not USD; and token spend is a SEPARATE signal from
competence.** Two distinct points:

- **Tokens, never dollars.** A `total_cost_usd` is *meaningless* for a local `ollama` worker or
  a free-tier API, and even for a paid API the price map is deployment- and time-specific.
  Tokens are the **primitive, universal fact**; USD is a *derived* view. By the two-plane
  model ([ADR 0003](../decisions/0003-two-plane-source-of-truth.md)), the substrate stores the
  primitive; **any USD translation happens at the UI level (v7), against a price map that lives
  where the human reads it** — never baked into an append-only event that would then be wrong
  for half the families and stale for the rest. The harness emits `total_cost_usd`; we drop it.
- **Spend ≠ competence.** The ADR 0022 invariant: *"a family that is merely expensive (not
  failing) is not governed."* Token-spend columns (`total_tokens`, `tokens_per_shipped_task`)
  sit beside — never folded into — the competence columns (reject rate, validation,
  cross-family). A token-heavy-but-passing family reads as *expensive*, never as *failing*.
  Blending them would let M21 ban a family for burning tokens, which is a **routing** decision
  (v7+, and *that* is the layer that may price tokens in USD), not a governance one.

**D3 amendment (v8, 2026-08-29) — spend follows the work that EARNED it, not the work it
finished on.** The view resolved a usage event's capability as the family's **most recent**
transition on that task at or before the event. That is right for a sweep that crosses one
stage, which is nearly every sweep — and wrong for the one that does not. The first Hermes run
(2026-08-29, PR #146) produced the counter-example: `grok+grok-4.6` merged
(`integrating→validating`, `role:integrator`) and then confirmed the merge green
(`validating→done`, `role:reviewer`) inside **one** harness invocation, reporting usage once at
the end. All 52,536 tokens were booked to `role:reviewer`; `role:integrator` was left with no
usage row at all.

The damage is not the missing number — it is what the missing number **says**. D1's whole
contract is that an unmeasured family reads `unknown`, never `0`: *unknown ≠ free*. Here
`unknown` was neither. The spend existed, was captured, and was filed under a neighbour, and
nothing in the view distinguishes "we did not measure this" from "we measured it and attributed
it wrong". The second reading is worse, because it also **inflates the neighbour** — a reviewer
whose `tokens_per_delivery` carries a merge it never performed is being described as expensive
for someone else's work, which is exactly the misreading D3's spend/competence separation
exists to prevent.

As amended, the charge goes to the **first role-bearing transition of the sweep**. The sweep
window is bounded below by that family's **previous usage report on the same task** — usage is
reported once per sweep, so the previous report is precisely where this sweep begins. Without
that bound, "first" would reach back into an earlier sweep and an implementer that was rejected
and re-implemented would have every later sweep charged to its first transition forever.

Two properties worth stating, because they are what make this safe to apply to history:

- **View-only.** No table, no verb, no grant. `api.record_usage` writes the same event, the
  driver still reports once per sweep. It is a *reading* of existing rows, so the correction is
  retroactive — the Hermes run re-reads correctly the moment the migration lands.
- **Still no blending.** This moves spend between capabilities; it never moves spend into
  competence. A family that spent a lot integrating is *expensive at integrating* — which is
  the sentence the signal was failing to be able to say.

**D3 amendment, part two (2026-09-03) — a sweep is not a task, so the first fix is not finished.**
The amendment above charges the *first* role-bearing transition of a sweep instead of the last, and
it is correct as far as it goes. It does not go far enough, and the run that proved it is the same
run that first exercised a problem-shaped brief.

One measured sweep (#150–#153, 2026-09-02): a single actor made **eleven transitions across two
tasks and five capabilities** — reviewer, designer, implementer, integrator, reviewer — and filed
**one** usage report. `api.record_usage` resolves the charged task from the actor's *last*
transition, so the report anchors to one task; the view then picks the first role-bearing transition
*on that task*. The result is that one `(family, capability)` carries the entire sweep and every
other capability it exercised reads `unknown`. In the same run the designer filed a single report of
5,053,327 tokens for a sweep that designed **two** slices, anchored wholly to one of them; the other
records a delivery that apparently cost nothing. `tokens_per_delivery` is therefore dividing a
sweep-level number by a transition-level count.

**Why the first fix looked sufficient.** Its evidence came from runs where every sweep touched
exactly one task — which held because the briefs were being written small enough to guarantee it,
not because anything in the substrate did. A problem brief produces sweeps that drain whole regions
of the board, and the assumption failed on first contact. The measurement was outgrown by the thing
it measures.

**The remaining fix is the option skipped in the first amendment: report usage PER TRANSITION, not
per sweep.** That is a driver-side change (report as each transition is made, or report a
per-transition breakdown) plus `api.record_usage` accepting it — not a view change, which is why it
was deferred and why deferring it was wrong. Until it lands, treat per-capability spend as
*attributable to a sweep, not to a capability*, and do not build cost-aware routing on it: routing
on these numbers would prefer families on the strength of which transition happened to be first.

**D4 — A failure credits the PRODUCING family, per `(family, capability)`.** A reject is called
by a reviewer/integrator, but the family being judged is the **producer** whose work bounced —
"who advanced *into* the stage that was then rejected" (the implementer who did
`implementing→reviewing`, via the transition event's `actor`). The strike lands on that family
for the capability it exercised (`role:implementer`), reusing the exact M19 attribution. The
record is keyed `(family, capability)` because competence is per-pairing-per-role (ADR 0007 /
governance D2).

**D5 — The view exposes raw aggregates + a recent window; window *semantics* are M21's to
fix.** The score needs a window (M21 bans on "N rejects within a window"), but the precise
semantics — rolling-N-runs vs. time-window, whether an expired strike decays — are governance
tuning, settled where the threshold lives (M21). M20 provides the **raw, windowable
aggregates** (counts + timestamps per `(family, capability)`); it does **not** hardcode a
window or a threshold. Measure now; judge in M21.

## The `record_usage` verb + the view, concretely

- **`app.record_usage(p_actor uuid, p_task uuid, p_data jsonb)`** — `SECURITY DEFINER`, granted
  to a privileged role only (not `agent`). Inserts `app.events(task_id=p_task, actor=p_actor,
  type='usage', data=p_data)`. `p_task` is the task the sweep acted on; the driver resolves it
  (the sub's most-recently-transitioned task) or the verb resolves it from `p_actor`'s last
  transition. A sweep that did no work (claim returned `empty`) has **no task** → **no usage
  event** (idle-poll cost is out of scope; the drop is `log()`-ged, no silent cap).
- **`api.family_track_record`** — read-only, `grant select` to `oversight`. Per
  `(family, capability)`:
  - *competence:* deliveries, rejects, `reject_rate`, validation pass/fail, cross-family-review
    outcomes (from `type='transition'` events, producing-family attribution).
  - *token spend (separate, tokens only):* `total_tokens`, `tokens_per_shipped_task` (from
    `type='usage'` events). **No USD** — see D3.
  - the timestamps M21 needs to apply a window.

## Scope: one privileged write verb, one view, driver wiring, a report line

- **Substrate:** `app.record_usage` verb + grant; `api.family_track_record` view. One
  migration, plain-SQL/plpgsql up+down
  ([ADR 0005](../decisions/0005-logic-language-escalation.md)/[0010](../decisions/0010-environment-migrations-testing.md)).
- **Harness/driver:** after each sweep, parse the **token counts** from `$RUN_DIR/*.log`
  (per family — the JSON shapes differ across opencode/grok/claude; unknown → **null, not
  zero**, so a family never looks free) and call `record_usage`. The `total_cost_usd` field is
  ignored.
- **Observability (M16 extension):** the end-of-run report reads `api.family_track_record` and
  prints the per-`(family, capability)` record, cost in its own column.

## Slicing (build order within M20)

- **Slice A — cost capture (careful, small).** The `record_usage` verb + grant + the driver
  parser/wiring. The one write path — privileged, so reviewed carefully — but modest
  (append-only usage events, no capability effect). Mock-verify the verb writes a `usage`
  event attributed to the right family and that an empty sweep writes nothing.
- **Slice B — the track-record view + report line (swarm-built).** Read-only SQL + a report
  extension. Non-safety, self-contained — clean swarm work on the parallel loop. Verify the
  view matches a hand-audit of the timeline and that cost/competence never blend.

## Open risks (honest)

- **Harness token-shape heterogeneity.** opencode, grok, and claude report token counts
  differently; the parser is per-family and will drift as tools change. Degrade to **null
  tokens** (never zero) on an unrecognized shape, and `log()` the miss — unparsed usage must
  look *unknown*, not *free*, or a family could dodge the future router by emitting counts we
  can't read.
- **Task attribution when a sweep touches several tasks.** A frontier sweep can advance more
  than one task; charging its whole token spend to the last one is a coarse approximation.
  Acceptable for M20 (token spend is a *separate*, not-yet-acted-on signal); refine if
  per-task spend drives routing later.
- **Bad-rejection false strikes (carried to M21).** D4 credits the producer of a rejected
  stage, but a reject can be the *reviewer's* fault — wrongly striking the producer. M20 only
  *records*; the mis-attribution bites at M21, where the human/hard path (auditor) is the
  backstop. A reviewer track record (who rejects work that later ships unchanged) is a richer
  v6+ signal, noted not built.
- **The record is inert by design.** M20 applies no consequence — deliberately. The temptation
  to "just also ban here" is exactly the M21 boundary; keeping M20 read-only is what lets us
  audit the signal's *fairness* before anything acts on it.
