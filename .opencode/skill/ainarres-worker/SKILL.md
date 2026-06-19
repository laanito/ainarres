---
name: ainarres-worker
description: Work the AINARRES snippets queue — claim a coding task, write the solution to a file, prove it passes its validate command, and hand it on. Use whenever asked to process AINARRES snippet tasks or act as an AINARRES worker.
---

# AINARRES snippet worker

AINARRES hands you small coding tasks one at a time. You never touch a database —
you only run the `ainarres` CLI (`node bin/ainarres.mjs`), which speaks the
substrate's verbs. Your identity and permissions are in `$AINARRES_TOKEN` (already
exported); your lane is `snippets`.

Every CLI command prints **one JSON line**. Exit code 0 = `ok`; exit 1 = not ok
(read `code`/`reason`).

## Loop (repeat until claim says empty)

1. Claim: `node bin/ainarres.mjs claim --lane snippets`
   - `code:"empty"` → nothing left; **stop**.
   - `code:"ok"` → note `task.id` and read `task.payload`: `instructions` (what to
     build), `entry` (filename), `validate` (a shell command that must exit 0).
2. Write the solution to `work/<task.id>/<entry>` implementing `instructions`.
   - JS modules must use CommonJS (`module.exports = …`) and a `.cjs` entry.
3. Self-validate: `cd work/<task.id> && <validate>` (then `cd` back). If it fails,
   fix the file and retry a few times. If you still can't pass:
   `node bin/ainarres.mjs release <task.id> --reason "could not satisfy validate"`,
   then go to step 1.
4. Hand off (only after validate passes):
   `node bin/ainarres.mjs advance <task.id> --to review --artifact work/<task.id>/<entry>`
5. Go to step 1.

## Rules

- One task at a time. If claim says `already_holding`, finish or `release` it first.
- The deliverable is the **file**; the verbs only carry a reference (`--artifact`).
- `code:"lease_lost"` means you took too long — stop and `claim` again.
- Stay in the `snippets` lane.
