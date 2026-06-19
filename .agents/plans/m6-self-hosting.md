# Plan — M6: self-hosting checkpoint (the success gate)

> Elaborates milestone **M6** of [v1-plan.md](v1-plan.md) into a concrete, runnable
> validation. Proves [ADR 0012](../decisions/0012-self-hosting-success-criterion.md):
> AINARRES coordinates real work done by real agents. Scope decisions below were
> taken with the owner on 2026-06-19.

## Objective

A **continuous pipeline of tiny coding tasks**, run end to end through the verbs:
**Claude** (creator + reviewer) enqueues small snippet tasks; **opencode + qwen3.6**
workers claim them, write a solution file, self-validate, and advance; **Claude**
independently verifies the solution and the worker's validation, then accepts
(advance → done) or sends back (reject → rework). The board/feed show the journey.

This is both the dogfood proof and the thing that makes AINARRES **usable by agents**
(no client/skill existed before this milestone).

## Locked decisions (owner, 2026-06-19)

1. **Agent interface = a thin `ainarres` CLI + a worker SKILL.** Shell-callable, so
   opencode+qwen (and Claude) drive it directly. The CLI reuses the existing test
   helpers (JWT mint, `rpc`, `restGet`).
2. **Workers for the first run = opencode + qwen3.6, driven by Claude** locally; the
   same queue stays open for the owner to attach their own workers.
3. **Work product = files** under `work/<task-id>/`; the DB stores a typed
   **reference** (path) in event `data.artifacts` (true to ADR 0003 two-plane).
   Accepted solutions are committed (success gate: "work product in git").

## The pipeline — `snippet-factory` workflow, `snippets` lane

A real, long-running flow with short tasks. Stages (work happens while a task is
**held** at a stage; `advance` hands off and releases):

```
todo (initial) ──advance[worker]──▶ review ──advance[reviewer]──▶ done (terminal)
                                       └────reject[reviewer]────▶ todo   (rework)
```

- `todo` — a **worker** claims, writes `work/<id>/<entry>`, runs the task's
  `validate` command, then `advance → review` (artifact ref in the event).
- `review` — a **reviewer** (Claude) claims, re-runs `validate` on the file
  independently, then `advance → done` (accept) or `reject → todo` (rework + reason).
- `done` — terminal.

Transitions / required features:
- `advance todo→review`: `[lane:snippets, role:worker]`
- `advance review→done`: `[lane:snippets, role:reviewer]`
- `reject review→todo`: `[lane:snippets, role:reviewer]`

**Task payload** (the "steps to process and validate"):
```json
{
  "instructions": "Write a JS module exporting add(a,b) that returns a+b.",
  "entry": "solution.js",
  "validate": "node -e \"const {add}=require('./solution.js'); process.exit(add(2,3)===5?0:1)\""
}
```
The worker self-validates with `validate`; the reviewer re-runs the same command
independently before accepting. (Security note: `validate` is a shell command —
acceptable because tasks are authored by the trusted creator in v1; sandboxing is a
post-v1 concern. Recorded as a follow-up.)

## Identity & tokens

- New worker family **`opencode+qwen3.6`** (durable competence unit, ADR 0007),
  provisioned `lane:snippets` + `role:worker`.
- Reviewer/creator identity = a `role:reviewer` + `lane:snippets` token Claude holds
  (creating tasks needs `lane:snippets`; reviewing needs `role:reviewer`).
- The `ainarres token` subcommand mints HS256 tokens locally with **explicit
  features** (`--features lane:snippets,role:worker`) — the operator holds the signing
  secret anyway (signing lives outside the DB, M2), so no DB read/coupling. The
  authoritative `api.token_claims` still exists server-side for real provisioning.
  Workers receive a token via the `AINARRES_TOKEN` env var.

## Deliverables

1. **`ainarres` CLI** — a **single self-contained Node ESM file** (`bin/ainarres.mjs`,
   `#!/usr/bin/env node`) importing **only `node:` built-ins**: `node:crypto`
   (HS256 sign), the global `fetch` (the PostgREST HTTP surface — no DB driver),
   `node:util.parseArgs` (flags), `node:fs` (artifact files). **No npm install, no
   transpile, no bundler**; runs anywhere Node ≥18 exists. Subcommands: `token`,
   `create`, `claim`, `progress`, `advance`, `reject`, `release`, `block`,
   `unblock`, `heartbeat`, `board`, `feed`, `abandoned`. Reads `AINARRES_BASE_URL`,
   `JWT_SECRET`, `AINARRES_TOKEN` from env. Prints the verb envelope as JSON to
   stdout; non-`ok` → exit code 1 so a shell-driven worker can branch. (Accepts a
   small, deliberate duplication of the ~10-line JWT minter with
   `test/helpers/jwt.ts` to keep the file import-free and copy-anywhere portable.)
2. **Worker SKILL** (`skills/ainarres-worker.md`) — the loop a dumb agent follows:
   claim → read `payload.instructions` → write `entry` under `work/<id>/` →
   run `payload.validate` → on pass `advance --to review` (with `--artifact`); on
   fail iterate a bounded number of times, else `release`; `heartbeat` during long
   work; loop until `claim` returns `empty`.
3. **Pipeline seed** (`db/seed-snippets.sql` or folded into a migration) — the
   `snippet-factory` workflow + `snippets` lane + `role:worker`/`role:reviewer`/
   `lane:snippets` features + the `opencode+qwen3.6` family with grants. Idempotent.
4. **Task generator** — a small set of ~5–8 tiny snippet tasks (add, isPalindrome,
   fizzbuzz, etc.) enqueued via `ainarres create` (a script or a JSON fixture).
5. **Deterministic e2e test** (`test/e2e.test.ts`) — a **scripted** worker (no LLM)
   drives the full loop (create → claim → write file → validate → advance → review →
   verify → done, plus one reject→rework cycle). Runs in `make reset`, so the
   pipeline itself is regression-tested without depending on qwen/network.
6. **Live dogfood run** — Claude drives **real opencode + qwen3.6** workers through
   the same pipeline; the transcript, final board, and feed are captured in the retro
   as the actual self-hosting proof. (Non-deterministic, so it lives in the retro,
   not the CI suite.)

## Execution order

- **M6a — usability + deterministic e2e** (one PR): CLI, worker skill, pipeline seed,
  task generator, scripted `e2e.test.ts`. Green in the reset loop.
- **M6b — live dogfood** (follow-up PR): real opencode+qwen3.6 run driven by Claude;
  capture results; retro + blog. This is the success-gate sign-off.

Splitting keeps the repeatable loop honest (M6a is deterministic) while the
inherently non-deterministic real-agent run (M6b) is demonstrated and recorded
separately.

## Done-tests / success gate (ADR 0012)

**M6a (automated, every reset):**
- A snippet task goes `create → claim → advance → review → advance → done` entirely
  through the verbs (scripted worker + reviewer).
- A bad solution is `reject`ed → reworked → accepted (the rework loop).
- The solution file exists under `work/<id>/` and the event carries its path
  reference; `board` shows the task at `done`; `feed` shows created/claimed/
  transition events.
- `make reset` green twice; `verify-down` clean; `tsc` clean.

**M6b (live, recorded in retro):**
- Real opencode+qwen3.6 worker(s) claim and solve ≥1 task end to end through the
  verbs; Claude verifies the output + the worker's self-validation; the board reflects
  the journey; an accepted work product is committed to git. Owner can intervene
  (block/unblock) as oversight.

## Risks / open items

- **opencode invocation**: confirm the exact headless command (`opencode run …`) and
  qwen3.6 model selector at the M6b step; the binary resolves in a login shell but not
  the bare tool shell — may need the `!`-prefixed run or an explicit path.
- **qwen reliability**: a small model may need a tightly-scripted SKILL and bounded
  retries; if it struggles to drive the CLI, fall back to a thinner per-step prompt.
  M6a's scripted worker guarantees the substrate is proven regardless.
- **`validate` as shell**: trusted-author assumption for v1 (see above).

## Blog

"AINARRES, building AINARRES." (Pending the owner's publish guidelines, as for M0–M5.)
