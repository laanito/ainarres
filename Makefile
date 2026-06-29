SHELL := /bin/bash
COMPOSE := docker compose

# The autonomous-loop substrate (ADR 0020, M13): the SAME compose file, a SEPARATE
# compose project + env file (own containers, volume, and host ports 5434/3011).
# This is the instance the hands-off v3 loop coordinates on, isolated from the test
# substrate above so an unattended `make reset` can't pollute the live board.
COMPOSE_LOOP := docker compose -p ainarres-loop --env-file loop.env

.PHONY: up down reset migrate seed test verify-down logs ps \
        loop-up loop-down loop-seed loop-reset loop-ps loop-logs verify-isolation

## Bring the stack up (db → migrate → postgrest) and wait for db health.
up:
	$(COMPOSE) up -d

## Tear everything down, including the data volume (known-zero state).
down:
	$(COMPOSE) down -v

## Re-apply migrations against the running db.
migrate:
	$(COMPOSE) run --rm migrate --no-dump-schema up

## Load the idempotent seed fixture (piped into psql in the db container via the
## local trust socket, so no password is needed).
seed:
	@$(COMPOSE) exec -T db \
	  psql -v ON_ERROR_STOP=1 -U "$${POSTGRES_USER:-postgres}" -d "$${POSTGRES_DB:-ainarres}" \
	  < db/seed.sql > /dev/null
	@echo "✓ seed loaded"

## Run the test suite (the suite loads .env itself via test/setup.ts).
test:
	npm test

## The repeatable loop: known-zero → rebuild → validate.
reset: down up seed test
	@echo "✓ reset complete"

## Down-migration reversibility check: roll every migration back to zero, then
## re-apply. Proves each migrate:down runs cleanly and up is repeatable. Run
## against a live stack (`make up` first); it leaves the schema fully migrated.
verify-down:
	@echo "rolling all migrations down…"
	@for i in $$(seq 1 20); do \
	  $(COMPOSE) run --rm migrate --no-dump-schema down >/dev/null 2>&1 || break; \
	done
	@echo "re-applying all migrations…"
	@$(COMPOSE) run --rm migrate --no-dump-schema up
	@echo "✓ down-migrations reverted and re-applied cleanly"

logs:
	$(COMPOSE) logs -f

ps:
	$(COMPOSE) ps

# ── Autonomous-loop substrate (ADR 0020, M13) ─────────────────────────────────
# A second AINARRES instance on its own compose project + ports (loop.env), for
# the hands-off loop's `dev` board. Brings up db → migrate → postgrest, same as
# `up`, but fully isolated from the test substrate. NB: no `loop-test` target —
# the vitest suite targets the default `ainarres` project on purpose.

## Bring the loop substrate up (own project/volume/ports from loop.env).
loop-up:
	$(COMPOSE_LOOP) up -d

## Tear the loop substrate down, including its data volume.
loop-down:
	$(COMPOSE_LOOP) down -v

## Load the idempotent seed into the loop substrate's db.
loop-seed:
	@$(COMPOSE_LOOP) exec -T db \
	  psql -v ON_ERROR_STOP=1 -U postgres -d ainarres < db/seed.sql > /dev/null
	@echo "✓ loop seed loaded"

## Known-zero rebuild of the loop substrate (no test suite — see note above).
loop-reset: loop-down loop-up loop-seed
	@echo "✓ loop reset complete"

loop-ps:
	$(COMPOSE_LOOP) ps

loop-logs:
	$(COMPOSE_LOOP) logs -f

## Prove the two substrates are isolated: plant a sentinel task in the loop's
## `dev` lane, rebuild + run the full suite against the TEST substrate (which
## itself creates dev-lane fixtures there), and assert the loop's board is
## untouched. This is M13's done-test (ADR 0020 § pollution-proofing).
verify-isolation:
	@bash scripts/verify-isolation.sh

# ── The autonomous run harness (ADR 0020, M14) ────────────────────────────────
# The dumb, tiered driver (loop/). Sweeps worker tiers low→high in rounds against
# the loop substrate until the board drains. Runs against the loop substrate.

## Run the loop on a real brief with the real harnesses (owner-invoked — Claude
## Code cannot spawn grok; see loop/README.md). Usage: make loop-run BRIEF=path
## Starts from a FRESH loop board by default (the board is disposable per-feature;
## the product is the merged PR on git). This avoids resuming a dead/interrupted
## run's stranded claims. Pass LOOP_RESUME=1 to keep the board and continue.
loop-run:
	@test -n "$(BRIEF)" || { echo "usage: make loop-run BRIEF=<brief-file>"; exit 2; }
	@if [ -z "$(LOOP_RESUME)" ]; then \
	  echo "→ loop-run: fresh board (LOOP_RESUME=1 to continue an interrupted run)"; \
	  $(MAKE) --no-print-directory loop-reset >/dev/null; \
	fi
	@bash loop/driver.sh "$(BRIEF)"

## Deterministic plumbing test: a fresh loop substrate + the MOCK harness drive a
## brief to `done` with no human coordination. This is M14's done-test.
loop-selftest: loop-reset
	@LOOP_MODE=mock bash loop/driver.sh loop/examples/selftest-brief.txt
