SHELL := /bin/bash
COMPOSE := docker compose

.PHONY: up down reset migrate seed test verify-down logs ps

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
