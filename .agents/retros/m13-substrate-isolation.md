# Retro — M13: substrate isolation (pollution-proofing)

- Date: 2026-06-28
- PR: build/m13-substrate-isolation
- Plan: [v3-plan.md](../plans/v3-plan.md) (M13)
- Implements: [ADR 0020](../decisions/0020-autonomous-run-topology.md) § pollution-proofing

## What shipped

The second of the two layers that make an unattended run safe (the first —
substrate-free validates — already lives in the role skills). The hands-off loop
now coordinates its `dev` board on its **own AINARRES instance**, separate from the
one the test suite tears down and rebuilds.

- **`loop.env`** (committed — shared run config, not a secret): a second compose
  *project* (`ainarres-loop`) + ports (`5434`/`3011`) over the **same**
  `docker-compose.yml` and migrations. Distinct containers, network, and volume.
- **`loop-*` Makefile targets** (`loop-up`/`loop-seed`/`loop-reset`/`loop-ps`/
  `loop-logs`/`loop-down`) via `docker compose -p ainarres-loop --env-file loop.env`.
- **`make verify-isolation`** (`scripts/verify-isolation.sh`): the done-test, run
  deliberately.
- **`.agents/design/substrates.md`**: the operability doc (a table of the two
  substrates + how to bring each up); README points to it.
- **Validate convention confirmed locked** (no skill change needed): designer
  (`validate` must be substrate-free, never the whole suite) and reviewer (re-runs
  only the targeted validate at `reviewing`; full suite is the `validating` stage on
  a clean rebuild) already encode it from v2. M13 makes that `validating` rebuild
  *harmless*: it now hits the test substrate, not the live board.

## The elegant bit

No new image, no second compose file, no migration. Isolation is **just a different
compose project + env file** over the artifacts that already exist — because the
compose file was fully env-parameterized from M0 (ADR 0010). The test suite needed
zero changes: it reaches its db via `docker compose exec db …` against the default
`ainarres` project (`test/helpers/db.ts`), so it targets the test substrate *by
construction*. That's also why there is deliberately **no `loop-test`** target.

## Done-tests (met)

- `make verify-isolation` green: a sentinel planted in the loop's `dev` lane
  survives a full `make reset` of the test substrate — `down -v` (volume wipe) + the
  70-test suite, which itself creates dev-lane fixtures in the test substrate. After
  the reset the loop's board is unchanged (same task count, sentinel still at the
  initial `proposed` stage). The suite ran green inside that reset (the script is
  `set -e`).
- Both substrates ran simultaneously without a port/volume/network clash
  (`5433`/`3010` vs `5434`/`3011`; projects `ainarres` vs `ainarres-loop`).
- This is exactly the M11 pollution action made harmless (retro `m11-bootstrap`):
  the full-suite run that injected fixtures into the shared board now can't reach it.

## Bootstrap honesty (ADR 0018)

Built **by hand / assisted** (it's run-harness infra; the loop can't isolate itself
before the isolation exists). No new substrate *mechanism* — M13 is operability +
discipline. The hands-off flip is still M15; M14 next wires the dumb driver + headless
pollers to run *against this loop substrate*.

## Follow-ups

- **Driver/pollers source `loop.env`** (M14) so the `ainarres` CLI hits
  `http://localhost:3011` — the loop substrate is the board they coordinate on.
- **Always-on daemons** (post-v3): the loop substrate is the natural home for a
  long-running instance once the driver session model graduates.

**Blog:** "Two substrates: keeping the swarm's world clean."
