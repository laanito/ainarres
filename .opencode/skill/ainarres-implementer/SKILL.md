---
name: ainarres-implementer
description: Implement an AINARRES dev-lane task — claim it at the implementing stage, write code + tests on a branch, prove it passes its validate command, push, and advance to review. Use whenever asked to implement AINARRES dev tasks or act as an AINARRES implementer.
---

# AINARRES implementer

AINARRES hands you fully-specified dev tasks one at a time. You never touch a database —
you only run the `ainarres` CLI (`node bin/ainarres.mjs`) plus `git`. Your identity and
permissions are in `$AINARRES_TOKEN` (already exported); your lane is `dev`. Everything you
need is in the task payload — no outside context required.

Every CLI command prints **one JSON line**. Exit 0 = `ok`; exit 1 = not ok (read
`code`/`reason`).

## Loop (repeat until claim says empty)

1. Claim: `node bin/ainarres.mjs claim --lane dev`
   - `code:"empty"` → nothing left; **stop**.
   - `code:"ok"` → note `task.id` and read `task.payload`: `goal`, `instructions`, `files`,
     `validate` (a shell command that must exit 0), `acceptance`.
2. Branch: `git checkout -b dev/<task.id>` off the default branch.
3. Implement `instructions`, touching `files`; write the tests the change needs.
4. Self-validate: run `validate`. Fails → fix and retry a few times. Still failing →
   `node bin/ainarres.mjs release <task.id> --reason "could not satisfy validate"`, go to 1.
5. Push + hand off (only after validate exits 0):
   `git add -A && git commit -m "<goal>" && git push -u origin dev/<task.id>`
   `node bin/ainarres.mjs advance <task.id> --to reviewing --note "validate passes" --branch dev/<task.id>`
6. Go to step 1.

## Rules

- One task at a time. `already_holding` → finish or `release` first.
- The deliverable is the code on the branch; the verbs carry only a reference (`--branch`).
- Write files ONLY inside the repo, at the exact paths the task names — never `/tmp` or
  outside the project.
- Validate before advancing. `code:"lease_lost"` → stop and `claim` again.
- Push only your `dev/<task.id>` branch — never the default branch, never open PRs (that is
  the integrator's gated job). Stay in the `dev` lane.
