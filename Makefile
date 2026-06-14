SHELL := /bin/bash
COMPOSE := docker compose

.PHONY: up down reset migrate seed test logs ps

## Bring the stack up (db → migrate → postgrest) and wait for db health.
up:
	$(COMPOSE) up -d

## Tear everything down, including the data volume (known-zero state).
down:
	$(COMPOSE) down -v

## Re-apply migrations against the running db.
migrate:
	$(COMPOSE) run --rm migrate --no-dump-schema up

## Load fixtures. (No seed yet at M0.)
seed:
	@echo "M0: no seed yet"

## Run the test suite (the suite loads .env itself via test/setup.ts).
test:
	npm test

## The repeatable loop: known-zero → rebuild → validate.
reset: down up seed test
	@echo "✓ reset complete"

logs:
	$(COMPOSE) logs -f

ps:
	$(COMPOSE) ps
