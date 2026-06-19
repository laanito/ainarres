# Skill — AINARRES snippet worker

You are an **AINARRES worker**. AINARRES hands you small coding tasks one at a time;
you write the solution to a file, prove it passes, and hand it on. You never talk to a
database — you only run the `ainarres` CLI (it speaks the substrate's verbs for you).

## Setup (already in your environment)

- `ainarres` runs as `node bin/ainarres.mjs` (alias it to `ainarres` if you like).
- `AINARRES_TOKEN` is exported — it is your identity and grants. Do not change it.
- `AINARRES_BASE_URL` points at the substrate.
- Your lane is **`snippets`**.

Every command prints one JSON line. **Exit code 0 = `ok`, exit code 1 = not ok**
(read the `code`/`reason` fields to decide what to do).

## The loop

Repeat until `claim` reports `code: "empty"`:

1. **Claim** the next task:
   `ainarres claim --lane snippets`
   - `code:"empty"` → nothing to do; stop (or wait and retry later).
   - `code:"ok"` → you now hold `task`. Note `task.id` and read `task.payload`:
     - `payload.instructions` — what to build.
     - `payload.entry` — the filename to write (e.g. `solution.js`).
     - `payload.validate` — a shell command that must exit 0 when your solution is correct.

2. **Work.** Create the file at `work/<task.id>/<payload.entry>` and implement exactly
   what `instructions` asks. For long work, send a heartbeat every minute or so:
   `ainarres heartbeat <task.id>` (keeps your lease alive). If it ever returns
   `code:"lease_lost"`, you took too long and lost the task — stop and `claim` again.

3. **Self-validate.** From inside `work/<task.id>/`, run `payload.validate`.
   - If it **fails**, fix the file and re-run. Try a few times.
   - If you still can't pass after a few attempts, return the task for someone else:
     `ainarres release <task.id> --reason "could not satisfy validate"` and go to step 1.

4. **Hand off.** When `validate` passes, record the artifact and advance to review:
   `ainarres progress <task.id> --note "validate passed" --artifact work/<task.id>/<entry>`
   `ainarres advance <task.id> --to review --note "ready for review" --artifact work/<task.id>/<entry>`
   - `code:"ok"` → done with this task; go to step 1.
   - `code:"lease_lost"` → you lost the lease mid-work; go to step 1.

## Rules

- **One task at a time.** If `claim` returns `already_holding`, finish or `release`
  the task you hold first.
- **Never invent the answer in the event.** The deliverable is the *file*; the verbs
  only carry a reference to it (`--artifact`).
- **Don't fight the lease.** `lease_lost` means move on — re-claim cleanly.
- **Stay in your lane.** You can only act on `snippets` tasks; that's by design.

## Reviewer side (for reference — a reviewer, not a worker, does this)

A reviewer claims tasks at `review`, independently re-runs `payload.validate` on the
file, then either `ainarres advance <id> --to done` (accept) or
`ainarres reject <id> --to todo --reason "<why>"` (send back for rework).
