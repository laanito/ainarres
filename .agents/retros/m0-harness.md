# Retro — M0: harness & skeleton

- Date: 2026-06-10
- PR: build/m0-harness
- Plan: [v1-plan.md](../plans/v1-plan.md) milestone M0

## What we built

The repeatable loop, proven before any domain logic exists:

- `docker-compose.yml`: stock `postgres:18` + `postgrest/postgrest` + a one-shot
  `amacneil/dbmate` migrate step (ADR 0010). No extensions, no custom image.
- `db/migrations/20260610120000_bootstrap.sql`: the minimum PostgREST needs to boot —
  `api` schema, `authenticator` + `anon` roles, and a harness-only `api.ping()`.
- `Makefile`: `reset` = `down -v → up → seed → test`; plus `up`/`down`/`migrate`/`logs`/`ps`.
- TS test layer (vitest): a zero-dep HS256 JWT minter, a readiness poller, and a smoke
  suite asserting the whole chain (compose → db → migrate → PostgREST → JWT).

## Done-tests (all green)

- `make reset` brings the stack from zero to passing, **twice**, deterministically.
- Teardown (`make down`) leaves no containers and no volumes.
- The loop also passes with **no `.env`** present (inline defaults), so a fresh clone works.
- `tsc --noEmit` is clean.

## What surprised us

1. **Port 3000 was taken** by another local service (`open-webui`). Made the host ports
   configurable (`PGRST_PORT`, default **3010**; `DB_PORT`) so AINARRES doesn't collide.
2. **`BASE_URL` is reserved by Vite/Vitest** — it injects `process.env.BASE_URL = "/"`
   (the app base path) inside the worker, silently overriding ours (the smoke test fetched
   `//`). Renamed our var to `AINARRES_BASE_URL`. Lesson: avoid Vite-reserved env names
   (`BASE_URL`, `MODE`, `DEV`, `PROD`, `SSR`) in vitest-run code.
3. **npm blocked esbuild's postinstall** (native binary). Approved just `esbuild`
   (recorded in `package.json` `allowScripts`) and rebuilt.

## Decisions made in passing

- `.env` is **gitignored**; defaults live inline in compose + `test/config.ts`, and
  `.env.example` documents overrides. No secret is committed; production overrides via env.
- The test suite loads `.env` itself (`process.loadEnvFile` in `test/setup.ts`), so it's
  independent of how it's invoked.

## Ready for M1

The loop is trustworthy, so M1 (core schema + roles) can lean on it as the validate step.
The bootstrap migration's `anon`/`authenticator` roles stay; M1 adds the domain tables and
the `agent`/`oversight`/`reaper` roles.

## Follow-up

- Blog article for M0 pending the owner's publish guidelines (tracked in the plan).
