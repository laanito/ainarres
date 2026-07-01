# Federation: frontier peers, none privileged

> Design note for **M19** — the last v4 milestone ([v4-plan](../plans/v4-plan.md) ·
> [ADR 0021](../decisions/0021-v4-scope-the-swarm.md)). Settles M19's open questions
> before code. Builds on the proven parallel loop ([`parallel-loop.md`](parallel-loop.md)),
> M16 observability ([`observability.md`](observability.md)), the feature model
> ([ADR 0004](../decisions/0004-feature-model.md)), egress-as-capability
> ([ADR 0015](../decisions/0015-egress-as-capability.md)) and the independent-integrator
> boundary ([ADR 0017](../decisions/0017-context-clean-validation.md)).

## What M19 is for

M18 proved the substrate coordinates **many workers at once**, coherently, location-
independent. But every one of those workers was the *same kind*: a pool of
`opencode+big-pickle` implementers plus a single `grok` frontier doing design, review
and integrate. M19 adds the half ADR 0018 always named federation: **more than one
frontier family, sharing the non-implementer roles as peers, none privileged over the
others.**

The prize is **not** separation of duties — the loop already has that. Each poller sweep
is a distinct agent (its own token/sub), so today it is already *one grok sub designs, a
different grok sub reviews, a third integrates*. Duties are separated by actor. What
federation buys is **uncorrelated failure**: a `claude` reviewer catches what a `grok`
designer's blind spots let through *because it is a different model family*, not just a
different instance of the same one. "Variety helps" is a **quality** argument, and it is
the whole point.

**The gate** ([ADR 0021](../decisions/0021-v4-scope-the-swarm.md)): a real multi-task
AINARRES feature is designed and reviewed by **two different frontier families**
(`grok` + `claude`), coordinating only through the substrate, with the M16 report
**showing at least one cross-family review** (a `claude` reviewer accepted/returned a
`grok`-authored task, or vice versa), integrated by the **single** owner-invoked
integrator, `main` coherent. Cross-*maker* federation, on the substrate, no peer holding
power another lacks.

## What changes: peers layered on the proven loop

Almost nothing in the substrate. Roles are already **per-transition `required_features`**
matched by superset (`seed.sql`): `reviewing→integrating` needs `role:reviewer`,
`integrating→validating` needs `role:integrator` + `capability:integrate`, and so on.
Federating a role is therefore *pure grant*: give a second frontier family the same
`role:designer` + `role:reviewer` features grok holds, and both become co-eligible;
`SKIP LOCKED` distributes claims; neither is privileged because they hold the *same*
features. The seed already anticipates exactly this — `claude-code+opus` exists as a
family with `role:designer`, carrying the explicit comment that *`capability:integrate`
must NOT sit on it*.

```
M18:  designer/reviewer/integrate = one grok family (many subs)
M19:  designer ─┐                          ┌─ grok subs ─┐
      reviewer ─┼─ claimed concurrently by ┤              ├─ SKIP LOCKED picks whoever's free
                │                          └─ claude subs ┘
      integrate = grok ONLY (capability:integrate), single, owner-invoked  ← unchanged
```

The real work is **harness-side**: the loop has never run a `claude` peer, and building
that poller is the milestone's substance (see D2).

## Decisions (the open questions, settled)

**D1 — Bare-minimum-safe scope: federate designer + reviewer only; integrate stays a
single, owner-invoked grok.** `capability:integrate` is the one true privilege boundary
([ADR 0015](../decisions/0015-egress-as-capability.md)/[0017](../decisions/0017-context-clean-validation.md)):
whoever merges cannot be laundered by whoever directs. Design and review carry **no
egress** — two co-equal peers there is provably harmless. Federating *integrate* means
federating *who may merge*, which is a differential-trust question with no fair outcome
signal yet — that is **governance (v5)**, not M19. This sharpens the milestone boundary
rather than shrinking it: M19 federates the **peers**; v5 federates the **privilege**.

**D2 — The second peer is `claude`, closing a standing gap.** Claude has never
participated in an AINARRES run — a deliberate M14 property (the *orchestrator* stays out
of the loop) that we now distinguish from *the model never being a peer*. Cross-maker
(Anthropic × xAI) is the strongest federation signal and the highest-variety pairing.
Because family identity is `harness+model`, we can **split model by role**:
`claude-code+opus` for design judgment, `claude-code+sonnet` for review — two families,
more variety, cheaper. Build: a **headless `claude` poller** (`loop/claude-frontier.sh`,
the `grok-frontier.sh` analog — `claude -p` print mode, minting a token per sweep, running
the claim→act→advance role loop). `capability:integrate` is **withheld**; the poller is a
co-equal *standing poller*, owner-invoked, that only self-claims and advances — it never
sequences or routes another agent, so the M14 "no orchestrator in the loop" property
holds. (A designer/reviewer never merges, so the merge-deny guard is not in play.)

**D3 — Separation of duties (cross-family review) is *enabled and measured*, never
*enforced*.** We considered a substrate constraint — "a task's reviewer family must
differ from its designer/implementer family." We are **not** building it, and the reason
is principled, not lazy: enforcing cross-family review reintroduces a **single point of
failure**. If the `claude` poller is down, a `grok`-designed task could *never* be
reviewed and the pipeline would stall — directly contradicting the resilience M18 proved
(a peer dies, the work still lands). So instead: grant both families the roles, let
whoever is free claim, and use the **M16 report** to observe how often review actually
crossed families. Diversity most of the time; resilience always. The report *measures*
the property; the substrate never *blocks* on it.

**D4 — Create-vs-advance (the v3 freelance-creation concern).** The plan's M19 done-test
asks that "who may decompose vs. who may only advance" hold by capability, not by prompt.
On inspection this is smaller than it looks. Duplicate decomposition is already prevented
*structurally*: the driver invokes decomposition **once** per run (M14), and `SKIP
LOCKED` gives a `proposed` brief to exactly one designer — pollers thereafter only
claim/advance. The only residual is a poller calling `create_task` off-script mid-run;
`create_task` today is gated by lane membership alone, so any dev-lane family could. Two
ways to close it, **owner's call at review**:
- **(recommended, minimal) Gate `create_task` on `role:designer`** — a tiny migration
  (change the create gate from `lane:dev` to `lane:dev` + `role:designer`). Correct
  regardless of federation: only designers decompose; cheap implementers (no
  `role:designer`) then *cannot* freelance-create. Satisfies the done-test by capability.
- **(defer) Accept the structural backstops** (once-only decomposition + single
  integrator gating what reaches `main`) as sufficient for M19 and leave a hard
  create/propose capability to v5 governance.

This is the *one* place M19 might touch the substrate; everything else is harness-side.

**D5 — The integrator boundary is untouched.** `grok+grok-build` remains the sole holder
of `role:integrator` + `capability:integrate`, owner-invoked, single (the merge queue of
M18). No `claude` family ever holds it. Federation adds peers *beside* the integrator, not
*to* it.

## The claude poller, concretely

`loop/claude-frontier.sh`, mirroring `grok-frontier.sh`:
- Resolves the `claude` binary robustly (pollers run outside the interactive PATH — same
  lesson as `opencode-implementer.sh`).
- Reads `AINARRES_TOKEN` / `AINARRES_BASE_URL` from the environment (minted per sweep by
  the standing poller), never prints them.
- Runs headless (`claude -p "<the frontier role-loop prompt>"`) against the existing
  frontier role skills (designer/reviewer), which are harness-agnostic Markdown.
- Holds **no** `capability:integrate`; if it ever claims an `integrating` task the
  transition simply fails the feature check — defense in depth, not prompt discipline.
- `roles.sh` gains a `claude` frontier entry mapping design→opus, review→sonnet; the
  driver launches the `grok` and `claude` frontier pollers **concurrently** so both are
  eligible for design/review each round. Integrate remains grok's single standing poller.

## Judging the gate

Concurrency correctness was M18's bar; M19 adds a **diversity** bar, both read from the
M16 timeline (D3's measurement is the judge):
- ≥2 frontier **families** active on design/review during the run (not just ≥2 subs).
- The end-of-run report attributes **per-role family** — "designed by `grok`, reviewed by
  `claude`" — and shows **at least one cross-family review** on the shipped feature.
- `main` coherent, integrated by the single grok integrator, no peer holding a power
  another lacks.
- No human coordination beyond starting the loop.

Wall-clock is explicitly **not** a criterion (ADR 0021 § Amendment): the point is
uncorrelated judgment, not speed.

## Scope: harness-side, with at most one tiny substrate gate

- **Harness/driver/config:** the `claude` poller, `roles.sh` peer entries, the
  `role:reviewer` grant to the claude family (designer already seeded), concurrent
  frontier-poller launch. No schema.
- **Substrate (only if D4-recommended is chosen):** a one-line-of-intent migration gating
  `create_task` on `role:designer`, with a down that restores lane-only. plpgsql/plain-SQL
  ([ADR 0005](../decisions/0005-logic-language-escalation.md)/[0010](../decisions/0010-environment-migrations-testing.md)).
- **Observability (M16 extension):** per-role **family** attribution in the report — the
  slice that makes the gate judgeable and cross-family review measurable.

## Slicing (build order within M19)

- **Slice A — the claude peer (assisted + deterministic mock).** `claude-frontier.sh`,
  `roles.sh` entry, the `role:reviewer` grant, concurrent frontier launch; and, if chosen,
  the D4 create gate. Touches the loop cast and (maybe) the seed → must be trustworthy
  before a real run, exactly as M18 slices 1–2 were built assisted. Verify via the mock
  that two frontier-role families are co-eligible and `SKIP LOCKED` distributes design/
  review claims across families.
- **Slice B — federation observability (swarm-built).** Extend the M16 report /
  `api.timeline` consumption to attribute per-role family and flag cross-family review.
  Non-safety, self-contained — a clean task for the swarm to build on the parallel loop.
- **Slice C — the federation gate (owner-invoked).** A real feature run with `grok` +
  `claude` frontier pollers live, judged by the bar above. The milestone-scale self-build,
  now cross-maker.

## Open risks (honest)

- **The claude harness is unproven in this role.** `claude -p` headless as a
  self-claiming poller is new; Slice A's mock proves the *plumbing*, but the first real
  run is where token handling, PATH, and the role-loop prompt get shaken out — expect an
  assisted shakeout before Slice C, same as grok needed pre-M15.
- **Single-frontier backpressure still applies** to the integrator (unchanged from M18's
  honest-limits): review now fans across two families, but integrate stays single by
  design. Fine for the gate.
- **Cross-family review is probabilistic under D3.** A run *could* land where grok
  happened to review every grok task (claude busy/absent). That is acceptable — the report
  makes it *visible*, and it is strictly better than a constraint that would stall on a
  peer's death. If real runs rarely cross families, the fix is scheduling/weighting in the
  driver, not a blocking substrate rule.
- **Governance is still v5.** M19 produces the cross-family outcome signal (who reviewed
  whom, who returned what) that v5 will need — it does not consume it. No revocation, no
  differential trust, this milestone.
