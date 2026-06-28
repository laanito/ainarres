# Two substrates: the test substrate and the loop substrate

> Operability note for [ADR 0020](../decisions/0020-autonomous-run-topology.md)
> § pollution-proofing. Built in M13 ([v3-plan](../plans/v3-plan.md)).

AINARRES runs **two independent instances of the same substrate** on a developer
machine. They share one `docker-compose.yml` and one set of migrations; they
differ only by **compose project + env file + host ports**, so they have separate
containers, networks, and data volumes and can run **at the same time**.

| | Test substrate | Loop substrate |
|---|---|---|
| Purpose | `make reset` / the vitest suite | the hands-off v3 loop's `dev` board |
| Compose project | `ainarres` (the repo dir name) | `ainarres-loop` |
| Env file | `.env` (gitignored, dev defaults) | `loop.env` (committed) |
| DB host port | `5433` | `5434` |
| PostgREST port | `3010` | `3011` |
| `ainarres` CLI base URL | `http://localhost:3010` | `http://localhost:3011` |

## Why two

In the v2 bootstrap (retro `m11-bootstrap`) a per-task `validate` ran the **full
suite against the shared dev substrate**. The suite creates its own dev-lane
fixtures, which landed in the *live* board and blocked real tasks — the owner had
to remediate by hand. A hands-off loop ([ADR 0018](../decisions/0018-v3-scope-autonomous-loop.md))
can have no human watching for that.

Two layers keep an unattended run clean (ADR 0020):

1. **Validates are substrate-free** — a per-task `validate` is a targeted unit
   check / `node --check`, never the whole suite. Locked in the designer and
   reviewer skills (`skills/ainarres-designer.md`, `skills/ainarres-reviewer.md`).
2. **The loop runs on its own instance.** So even the full-suite regression at the
   `validating` stage — a real `make reset` — rebuilds the **test** substrate and
   leaves the **loop's** board untouched. The dangerous action is now harmless.

## Bringing them up

```sh
# Test substrate (unchanged): the suite + day-to-day dev.
make up        # or: make reset   (down -v → up → seed → npm test)

# Loop substrate: the board the v3 driver/pollers (M14) coordinate on.
make loop-up        # db → migrate → postgrest on project ainarres-loop
make loop-seed      # idempotent seed
make loop-reset     # known-zero rebuild (NO suite — see below)
make loop-ps        # status   ·   make loop-logs   ·   make loop-down
```

Both can be up simultaneously (different ports/volumes). The driver and pollers
(M14) `source loop.env` so the `ainarres` CLI talks to `http://localhost:3011`.

There is deliberately **no `loop-test`**: the vitest suite reaches its db via
`docker compose exec db …` against the default `ainarres` project (`test/helpers/db.ts`),
so the suite always targets the test substrate by construction.

## Proving isolation

```sh
make verify-isolation
```

`scripts/verify-isolation.sh` plants a sentinel task in the loop's `dev` lane,
runs a full `make reset` of the test substrate (the exact M11-pollution action,
including the suite that creates dev-lane fixtures), then asserts the loop's board
is unchanged — same task count, sentinel still at its initial stage. It is M13's
done-test; run it deliberately (it's heavy: a full reset + suite).
