# Skill — AINARRES operator config

You are the **external operator**. You control which families (harness + model) are seated and
what capabilities they declare. This is your primary lever for cost, speed, and capability mix.

## The two layers

- **Substrate** knows only **families**: `app.agent_families` + `app.family_features`
  (`db/seed.sql`). A family that is not registered there makes every verb return
  `not_eligible: unknown family` (ADR 0007).
- **Service/operator layer** knows **tiers** — a poller name, its family, its features, and the
  harness command. All of it is in `loop/roles.sh`. `loop.env` holds only substrate ports and
  credentials, **no family or tier config**; the `LOOP_*` knobs are env overrides you export.

Important: the features a running poller actually gets come from the **locally signed token**
(`loop/roles.sh::role_features` via `mint_token`), not from `app.family_features` (ADR 0007 —
the substrate trusts the signed token, minus denials). `app.family_features` is what
`api.token_claims` provisions from and what makes the family *exist*. Editing the table alone
changes nothing for the loop; editing `role_features` alone leaves you with an unknown family.
Both must agree.

## Responsibilities

- Decide which roles/families should be active for the current workload.
- Keep the family roster (`db/seed.sql`) and the tier config (`loop/roles.sh`) in agreement.
- Adjust seating when new models become available or when costs change.
- Tune the live service knobs (below).
- Keep the feature declarations honest — demand-shaped scaling (M27) reads them to decide which
  tiers to wake, so an over-declared tier gets spawned for work it cannot do.
- Log seating changes to the operator ledger (`ainarres operator-log`) — a seating change has no
  task, so it cannot be an event.

## Seating a family (all five steps, in order)

Skipping step 1 is the classic failure: the poller mints a token, then every `claim`/`create`
returns `unknown family`.

1. **Register the family** in `db/seed.sql`: an `app.agent_families` row + its
   `app.family_features` rows. The seed is idempotent (`on conflict … do nothing`).
2. **Load the seed** into the loop substrate: `make loop-seed` (and `make seed` for the test
   substrate). Both read the same `db/seed.sql`.
3. **Wire the tier** in `loop/roles.sh`: add a case to `role_family` (→ the family key),
   `role_features` (→ its granted features), and `harness_sweep` (→ the command that runs it).
4. **Add it to a tier list** in `loop/roles.sh`, which decides *when* it runs:
   `LOOP_TIERS` (documented capability order) · `LOOP_PRE_TIERS` (serial tier-0, before the pool)
   · `LOOP_POOL_TIER` (the single fanned-out cheap implementer, ×`LOOP_POOL_SIZE`) ·
   `LOOP_SERIAL_TIERS` (one sweep each, after the pool) · `LOOP_FRONTIER_PEERS` (concurrent
   frontier peers) · `LOOP_DESIGN_TIERS` (the standing service's per-round design pass).
   A backend that allows only one concurrent session (`:cloud` models, local MLX) must be a
   serial or pre-pool tier — **never** the pool tier.
5. **Add a mock case** in `loop/mock-harness.sh` (both the worktree `case "$POLLER"` and the
   `case "$POLLER:$stage"` block), or `LOOP_MODE=mock` selftests will release instead of advance.

A brand-new *harness* (not just a new model) also needs its own wrapper script in `loop/`,
alongside `opencode-implementer.sh` / `cursor-implementer.sh` / `grok-frontier.sh` /
`claude-frontier.sh`. Vet the model against that harness's **actual** toolset before seating it —
a model that hallucinates tools holds a lease and makes zero progress (the 2026-07-07
`nemotron-3-nano` removal).

## Live service knobs (available today)

- `LOOP_POOL_SIZE` (default 3) — concurrent cheap implementers per round. **The main throughput
  and spend lever.** (`loop/driver.sh`, `loop/service.sh`)
- `LOOP_IDLE_POLL_SECS` (default 15) — how often the idle standing service re-checks the board.
  (`loop/service.sh`)
- `LOOP_MAX_ROUNDS` (default 20) — per-activation safety bound.
- `LOOP_CONSUME_GOVERNANCE` (default 1 for the service, 0 for the batch driver) — skip a family
  temp-banned for the capability its role needs.
- `LOOP_MODE` (`real` | `mock`) — swap every harness for the deterministic stand-in.
- Per-tier model overrides: `OPENCODE_*_MODEL`, `CURSOR_IMPL_MODEL`, `CLAUDE_DESIGNER_MODEL`,
  `CLAUDE_REVIEWER_MODEL`, and the `*_CMD` invocation overrides.

## Demand-shaped scaling (M27 — shipped)

The service no longer wakes every configured tier on every activation. At start it probes each
tier's backend (`build_capability_map`), then gates each spawn on `tier_has_demand` — live
capability ∩ the bundles `api.demand` reports as actually waiting. Two consequences for you:

- **A feature you declare in `role_features` is a promise to be spawned for that bundle.** An
  over-declared tier now costs tokens on work it cannot finish; an under-declared one is never
  woken for work it could have done.
- **Unserviceable demand is reported, with three distinct causes** (stderr, only when the
  condition changes): no configured family provides the bundle (*seat one*), the family that
  does is unreachable (*a backend is down — not a seating problem*), or the bundle rests on a
  human-held capability (`LOOP_HUMAN_FEATURES` — `role:intaker`, `role:auditor`). The third is
  **not** a seating gap: seating a family for it would dismantle the human boundary M22/M24
  built on purpose.

The gate re-reads `api.demand` on **every spawn decision**, not once per round, so a tier
decides against the board as it is at that moment. With one pending task and four capable
implementer tiers, the pool claims it and the other three stand down; a task the designer
just created is picked up in the same round rather than the next. And "nothing is pending" is
now distinct from "could not ask": the first spawns nothing, the second still spawns
everything (not knowing costs money, never correctness).

`make demand-gate-selftest` pins all of this with **no substrate** — safe to run while a
service is up.

Push-wake (`LISTEN/NOTIFY` instead of idle polling, ADR 0027) is **designed, not built**. The
service still polls every `LOOP_IDLE_POLL_SECS`.

## The operator seat (v8 / ADR 0028)

`agent+operator` is a seated family like any other, and is registered in `db/seed.sql` the same
way — it just is not a *tier* (no `role_family` / `harness_sweep` case, no tier list), because
nothing spawns it. It holds `lane:intake` + `role:intaker` + `lane:dev` + `role:designer` +
`role:operator`.

Do not grant it more. In particular:

- **`capability:integrate`** stays with the single integrator family. An operator that could
  merge is the orchestrator this substrate exists to avoid.
- **`role:auditor`** stays human and stays a *different identity*. An operator that can flag its
  own gaps closes the oversight loop on itself.
- **`role:implementer` / `role:reviewer` / `tier:2`** would make the seat claim delivery work. It
  operates the machine; it is not a worker in it.

Those four prohibitions are asserted in `test/operator-seat.test.ts`, so a well-meant grant fails
the suite rather than quietly widening the seat.

## Disabling a family

- **Temporarily, without touching config:** `api.set_permanent_ban(family, capability, reason)`
  then `api.lift_ban(...)` when you want it back. Despite the name, the pairing is how an
  operator parks a family — the denial is permanent only until you lift it. Oversight token
  only; see `skills/ainarres-operator-intervene.md`.
- **Structurally:** remove it from the tier lists in `loop/roles.sh` (keep the `role_family` /
  `role_features` / `harness_sweep` cases as a template, as the disabled `nano-implementer` does).
- **Never hand-set a temporary ban** — that is the substrate's own reflexive mechanism (M21).

## Rules

- Changes to seating are high-impact. Document the reason in a commit or ADR when the change is
  structural.
- Never grant a family capabilities it cannot actually deliver — a token's features are trusted,
  so an over-granted family claims work it will fail.
- Keep the number of simultaneously active families as small as the workload allows. This is how
  you control token spend.
- `capability:integrate` stays with the single integrator family. Never fan it out — the
  integrator *is* the merge queue.
- After any seating change, run a `LOOP_MODE=mock` selftest (`make service-selftest` or
  `make loop-selftest`), then follow `skills/ainarres-operator-monitor.md` to verify real
  behaviour.
