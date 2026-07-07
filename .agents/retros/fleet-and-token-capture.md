# Retro — the measurable fleet: diversifying the swarm & capturing its spend

- Date: 2026-07-07
- A **post-v5 interlude** (between the governance milestones and the v6 "seat the bookends"
  scope), not a numbered milestone — but a coherent stage worth its own account.
- PRs: fleet — #93 (nano tier-0), #94 (cursor fallback), #96 (nano saga: disable + qwen +
  branch-race fix); dogfood surfaces — #95 (`status --compact`), #97 (`status --json`),
  #98 (`report --json`); token capture — #99 (opencode `--format json`), #100 (cursor
  `--trust` + allowlist), #101 (grok `--debug-file` bridge), #102/#103/#104 (`parseUsage`
  for opencode / cursor / grok); retro this PR.
- Builds on: [track-record.md](../design/track-record.md) (M20 — the token signal this stage
  finally populated) and [ADR 0020](../decisions/0020-autonomous-run-topology.md) (the tiered
  loop this stage widened). Sets up v6 (see *What's next*).

## What shipped

Two intertwined goals: give the swarm a **wider fleet** of implementers (cheaper and more
capable options, from more makers) and make **every family's token spend measurable** —
completing the usefulness of M20's track record, which read `unknown` for everyone but claude.

- **The fleet grew from one cheap implementer to a graded ladder.** `opencode+big-pickle`
  (the ×3 pool) gained: a **tier-0** slot (nano, #93 — then disabled, below), a **cheap
  serial** peer (`opencode+qwen3-coder-next`, 80B, #96), a **higher-quality fallback**
  (`cursor-agent+composer-2.5`, #94/#100), backed by the existing `nemotron-3-ultra` and the
  grok frontier. Adding a worker is now a known recipe ([[swarm-family-registration]]): a
  seed-registered family (else `unknown family`) + a `roles.sh` tier (+ a wrapper for a new
  harness) + a mock-harness case.
- **Three dogfood features, all built hands-off by the swarm** (`status --compact`,
  `status --json`, `report --json`). These weren't the point — they were *real, useful,
  substrate-free work* used to exercise the widened fleet and shake out issues. Each: a pure
  formatter/shaper + a CLI flag, validated by a substrate-free vitest — the #87/#91 pattern.
- **Token capture, end to end, for all five families.** Each harness reports usage
  *differently*, so this was three capture wirings + four parser branches:
  - **opencode** — `--format json` emits a `step_finish` event stream carrying **per-step**
    `part.tokens`; `parseUsage` sums them. (big-pickle now reads ~550–970k/delivery.)
  - **cursor** — `--output-format json` carries a `usage` object (camelCase, cache separate).
  - **grok** — usage is printed **only to `--debug-file`**, so the wrapper bridges the
    single-line `_meta` into the captured log; its `inputTokens` *includes* `cachedReadTokens`
    (the opposite convention), so the parser subtracts.
  - `parseUsage` dispatches by family regex (`claude-code+` / `opencode+` / `cursor-agent+` /
    `grok+`); unknown shapes still return `null` — **`unknown` ≠ `0`** held throughout.

## The arc (findings, load-bearing)

1. **Vet a model against the harness's ACTUAL toolset before seating it.** nano
   (`nemotron-3-nano`) kept calling a hallucinated `str_replace_editor` tool — absent from
   opencode's toolset — and **spun on the rejection for two hours**, holding a task's lease
   while making zero progress. A tier-0 that can't drive the real tools is worse than none;
   it was disabled the same day (#96). **This spin is the seed of v6's spend-audit** (below):
   the failure a reject-counter can't see, but a token-watch can.
2. **The lease-vs-liveness race.** nano's spin exposed a buried assumption in ADR 0009's
   optimistic reclaim: *lease-lost ⇒ worker dead*. A slow-but-alive worker breaks it — its
   lease lapses, another tier reclaims, two workers touch one task. `main` was never at risk
   (the `lease_lost` invariant rejects the stale worker; `release_stranded` keys on the
   worker's sub; the single integrator re-validates), but task-id branch names could collide
   on a non-ff push. Fixed with **per-sweep branch names** `dev/<task.id>-$LOOP_SWEEP_ID`
   (#96). See [[lease-liveness-race]].
3. **Org policy shapes the fleet — and "preallow" beats "force."** cursor couldn't run
   headless: the admin **disabled `--force`/"Run Everything."** But cursor's `approvalMode`
   is `allowlist` — with `--trust`, file edits run and shell commands run *if pre-allowed*
   in `~/.cursor/cli-config.json`. A three-line allowlist (`Shell(git)`/`npx`/`node`) runs
   it **within** the policy (#100). The blunt override was disabled; the scoped grant works.
4. **Every harness meters differently; the substrate stays honest.** Three distinct usage
   shapes + claude's fourth, none matching. Per-harness `parseUsage` dispatch keeps the
   messy harness reality at the edge; the `type='usage'` event and the M20 view never learn
   about it. And the design's **`unknown` ≠ `0`** discipline meant a not-yet-parseable family
   read as *unmeasured*, never *free* — no false economy.
5. **M20's coarse attribution surfaced — as documented.** grok as *integrator* still reads
   `unknown` while *reviewer* shows tokens: `record_usage` stamps one usage event per sweep on
   "the last task the actor touched," and grok's frontier sweep spans roles. The verb's own
   comment flagged this ("a sweep may touch several tasks"). Family-level spend is visible
   (enough for the v6 watch); per-role precision is a later per-transition refinement. Not a
   bug — a known coarseness, met honestly.

## Discipline that held

- **Assisted vs. swarm split, by *checkability*.** Harness wrappers (real-output config, not
  substrate-free) were built **assisted**; the pure parsers and formatters (substrate-free
  vitest) were **briefed to the swarm** and shipped hands-off. The line is "can it validate
  itself in a worktree?", not "is it important?" — the same rule the board-wipe taught.
- **Design-first caught a mis-scope in *this* retro's neighbourhood.** Before designing
  "cost-aware routing," reading the roadmap showed it's a *router* (picks who does what) —
  which AINARRES doesn't have (SKIP LOCKED self-claim is the routing) and which the docs put
  at v7+. The owner reframed it to its real shape: **the auditor auditing spend**, not
  routing. Reading before building saved a wrong turn.

## Honest limits (carried forward)

- **The new tiers are barely exercised.** Every run this stage was implemented by
  big-pickle + reviewed/integrated by grok (sometimes the claude reviewer). qwen and cursor
  **swept but claimed nothing** — the serial tiers are *insurance*, and a healthy ×3 pool
  leaves them nothing. Their real validation comes **organically** when big-pickle's free
  credits deplete and work falls through — not from a forced run.
- **cursor's first real task is still unproven**, and needs the one-time `permissions.allow`
  setup on the host. Its parser is ready; its *implementing* is not yet demonstrated.
- **grok's per-role spend split is coarse** (limit #5). And **cursor tokens** won't appear
  until it actually claims a task.

## What's next (the owner's plan)

This stage produced both halves of the next milestone: the **token signal** (now populated)
and the **motivating incident** (nano's spin). They compose into **v6's auditor operational
facet** — the auditor *audits spend*, flagging a model that **spins** or **consistently
overspends vs. peers**: a qualitative flag (the M22 pattern), human-decided, **no auto-denial**
(respecting track-record.md D3 — tokens never auto-ban). Sequenced:

1. **Close this stage** — this retro + a blog installment.
2. **Design v6 and v7** — scope ADRs + design notes. v6 "seats the bookends": the *intaker*
   (Consultant) and the *auditor's operational facet* (health/integrity, incl. the spend
   watch). v7 is the standing service.
3. **A first approach to the service MVP** — sketch what turning AINARRES from the
   `make`-loop into a **service** requires. The loop was always scaffolding; the running
   service is AINARRES's real MVP. Expect the sketch to surface prerequisites — possibly a
   v8/v9 — before the service is responsible to run unattended.

**Blog:** an installment on the measurable fleet — the spinning worker, the lease race, the
`--force`-vs-allowlist saga, and four harnesses that each count tokens their own way.
