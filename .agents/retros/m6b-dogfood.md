# Retro — M6b: live qwen dogfood (success gate ✅)

- Date: 2026-06-19
- PR: build/m6b-dogfood
- Plan: [m6-self-hosting.md](../plans/m6-self-hosting.md) (M6b)
- **Closes the v1 success criterion — [ADR 0012](../decisions/0012-self-hosting-success-criterion.md).**

## What we proved

A **real agent** completed real coding tasks **entirely through the AINARRES verbs**.

- **Worker:** `opencode + qwen3.6:35b-mlx` (local, via ollama) running the
  `ainarres-worker` agent, calling the `ainarres` CLI for every verb — no special
  casing, no human in the worker loop.
- **Reviewer:** Claude, independently re-running each task's `validate` before
  accepting.
- **Journey (per task), all via verbs:**
  `create → claim(qwen) → solve+self-validate(qwen) → advance:review(qwen) →
   claim(reviewer) → independent verify → advance:done(reviewer)`.
- Two tasks (`add`, `reverse`) both reached `done`; the board showed the journey and
  the feed recorded `created/claimed/transition` with real actors. Work product is in
  git (`examples/dogfood-2026-06-19/`); the DB held only path references (ADR 0003).

The qwen worker drove the whole loop unattended: claimed, wrote `solution.cjs`,
ran the task's own `validate` (exit 0), advanced to review, repeated, and stopped
cleanly on `code:"empty"`.

## How opencode was wired (answering "how to get opencode to pick skills")

- **Skill:** `.opencode/skill/ainarres-worker/SKILL.md` — Anthropic-style frontmatter
  (`name`, `description`); opencode discovers it and exposes it as a model-invoked
  `skill` tool. Confirmed: the model listed `ainarres-worker` among its skills.
- **Agent:** `.opencode/agent/ainarres-worker.md` — `mode: primary`,
  `model: ollama/qwen3.6:35b-mlx`, tools `bash/read/write/edit`, body = the explicit
  claim→solve→validate→advance loop. Invoked with `--agent ainarres-worker`.
- **Run:** `opencode run "<kickoff>" --agent ainarres-worker -m ollama/qwen3.6:35b-mlx`
  with `AINARRES_TOKEN` + `AINARRES_BASE_URL` in the env.
- We use **both**: the agent keeps the loop always in context (reliable for a small
  local model), while the skill answers the "discoverable skill" question. Details in
  the `opencode-local` memory.

## What surprised us

- **Default model gotcha (as predicted):** opencode's configured default is
  `ollama/dolphin3:latest`, which isn't pulled — every invocation must pass
  `-m ollama/qwen3.6:35b-mlx`.
- **qwen needed no hand-holding** on these tiny tasks: it used method-shorthand for
  `add` and a clean `split('').reverse().join('')` for `reverse`, and self-validated
  before advancing — exactly the loop the agent prescribed. A ~32s warm latency per
  model turn; the two-task run finished in a couple of minutes.
- **opencode scaffolds into `.opencode/`** (a 61 MB `node_modules` + plugin manifest)
  on first run. Gitignored everything there except our authored `skill/` and `agent/`.

## Done-tests / success gate (met)

- A real dev task goes `create → claim → advance → … → terminal` entirely through the
  verbs, driven by a real agent. ✅
- Work product is in git (`examples/dogfood-2026-06-19/`). ✅
- The board shows the journey; the feed shows the events. ✅
- The owner can intervene as oversight (block/unblock + the views) — exercised in M4/M5
  and available via the CLI. ✅
- The deterministic `test/e2e.test.ts` (M6a) keeps the pipeline regression-tested in
  `make reset`; this live run is the real-agent proof on top.

## v1 status

**AINARRES coordinates real work by real agents — v1's success criterion is met.**
The substrate is self-hosting: it can carry AINARRES's own development tasks. From
here, AINARRES itself can be used to coordinate further work (the original aim).

## Follow-ups (post-v1, not blocking)

- Blog article "AINARRES, building AINARRES" (pending the owner's publish guidelines).
- A richer self-hosting workflow (the real dev loop: change→test→integrate→validate
  with rework) seeded for ongoing dogfooding — natural next step now that the
  mechanism is proven.
- Worker ergonomics: an `ainarres` PATH shim/alias so agents don't type
  `node bin/ainarres.mjs`; bounded auto-heartbeat for long tasks.
- `validate` sandboxing (trusted-author assumption today).
