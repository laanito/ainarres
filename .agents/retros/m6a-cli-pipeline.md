# Retro — M6a: agent CLI + snippet pipeline + deterministic e2e

- Date: 2026-06-19
- PR: build/m6-self-hosting (M6a)
- Plan: [m6-self-hosting.md](../plans/m6-self-hosting.md) (elaborates
  [v1-plan.md](../plans/v1-plan.md) M6)

## What we built

The pieces that make AINARRES **usable by agents**, plus a deterministic
end-to-end proof of the self-hosting pipeline.

- **`bin/ainarres.mjs`** — the agent CLI. A single self-contained Node ESM file,
  **only `node:` built-ins** (`crypto` HS256, global `fetch`, `util.parseArgs`),
  **no npm install / transpile / bundler**. Talks only the PostgREST HTTP surface
  (no DB driver). Subcommands: `token`, `create`, `claim`, `progress`, `advance`,
  `reject`, `release`, `block`, `unblock`, `heartbeat`, `board`, `feed`,
  `abandoned`. JSON out; exit 1 on a non-`ok` envelope so shell agents can branch.
- **`skills/ainarres-worker.md`** — the worker skill: the claim → solve →
  self-validate → advance loop, heartbeats, bounded retries, `lease_lost` handling.
- **Snippet pipeline** (seeded): `snippet-factory` workflow
  (`todo → review → done`, reviewer reject → `todo`), `snippets` lane, the
  `lane:snippets`/`role:worker`/`role:reviewer` features, and the
  `opencode+qwen3.6` worker family.
- **`test/e2e.test.ts`** — a **scripted** worker drives the whole loop through the
  CLI (create → claim → write file → self-validate → advance → review → verify →
  done) plus a reject→rework cycle, asserting board/feed/file-reference. Runs in
  `make reset`.

## What surprised us (two real bugs the e2e caught)

1. **`role` claim is the *Postgres* role, not the functional one.** I minted worker
   and reviewer tokens with `role: "worker"` / `role: "reviewer"`; PostgREST tried
   `SET ROLE "reviewer"` → *role does not exist*. The Postgres role is
   `agent`/`oversight`/`reaper`; *worker*/*reviewer* are **features**
   (`role:worker`, `role:reviewer`). Fix: both workers and reviewers authenticate as
   Postgres role `agent`; the functional split is purely in features. (The M2/M4
   tests had this right — the slip was only here, and the e2e caught it immediately.)
2. **`"type":"module"` breaks CJS snippet files.** Worker solutions written as
   `work/<id>/solution.js` were treated as ESM (the repo's `package.json` is
   `type:module`), so `require()` returned empty and `validate` failed with
   "m.add is not a function". Fix: snippet entry is **`.cjs`** (CommonJS regardless
   of the repo type). A task-authoring convention, captured in the e2e/tasks.

Both are exactly the kind of integration gap a real end-to-end (CLI → PostgREST →
SET ROLE → file/validate seam) surfaces that unit tests don't.

## Decisions made in passing

- **CLI duplicates the ~10-line JWT minter** (vs. importing `test/helpers/jwt.ts`)
  to stay a single import-free, copy-anywhere file. Deliberate.
- **`work/` is gitignored** scratch; the DB stores only path references
  (ADR 0003). Accepted demo deliverables get committed deliberately in M6b.
- **Pipeline lives in the seed**, not a migration — it's reloadable config and the
  scoped seed test stays green (assertions key on the dev-loop seed, not globals).

## Done-tests (all green — 48 total, 2 new)

- Full snippet loop via the CLI: create → claim → solve → self-validate → advance →
  review → independent verify → done; deliverable on disk, DB carries the reference;
  board shows `done`; feed shows created/claimed/transition.
- Reject→rework: reviewer rejects a wrong solution, worker fixes it, accepted; the
  feed records the reject transition.
- `make reset` zero→green twice; `make verify-down` clean; teardown leaves nothing;
  `tsc` clean.

## Ready for M6b (the success-gate sign-off)

The substrate is proven deterministically and the agent surface exists. M6b: drive
**real opencode + qwen3.6** workers (via the CLI + `skills/ainarres-worker.md`)
through the same `snippets` queue while Claude reviews; capture the board/feed/
transcript and commit an accepted deliverable to git. Open item: confirm the
headless opencode invocation + qwen3.6 selector (the binary resolves in a login
shell but not the bare tool shell).
