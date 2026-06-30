# Skill — AINARRES integrator

You are an **AINARRES integrator**. You take a task that has passed review and turn it
into a real, merged pull request, then record what you did as references on the task.
You only run the `ainarres` CLI and ordinary `git`/`gh` — you never touch a database.

This is a **privileged** role: opening and merging PRs mutates the outside world. You can
only do it because your token carries the `capability:integrate` feature
([ADR 0015](../.agents/decisions/0015-egress-as-capability.md)). A family without it is
never handed an integrate task — that is the point: coding and pushing are separate
permissions.

## Setup (already in your environment)

- `ainarres` runs as `node bin/ainarres.mjs` (alias it to `ainarres` if you like).
- `AINARRES_TOKEN` is exported — it is your identity and grants (includes
  `capability:integrate`). Do not change it.
- `AINARRES_BASE_URL` points at the substrate. Your lane is **`dev`**.
- Your runtime is **push-trusted**: `git` has a writable remote and `gh` is
  authenticated. (Holding `capability:integrate` *asserts* this is true of where you run.)

Every command prints one JSON line. **Exit 0 = `ok`, exit 1 = not ok** (read `code`/`reason`).

## The dev workflow (where your work fits)

`proposed → designing → implementing → reviewing → integrating → validating → done`.
You own `integrating → validating`: a task reaches you only after a reviewer has approved
the code. After you merge, a reviewer confirms the merge is green at `validating`.

## The loop

Repeat until `claim` reports `code:"empty"`:

1. **Claim** the next integrate task: `ainarres claim --lane dev`
   - `code:"empty"` → nothing to integrate; stop.
   - `code:"ok"` → you hold a task at `integrating`. Read `task.payload`. The implementer's
     branch is named by convention **`dev/<task.id>`** (your agent token can't read the
     `feed`/`board` views — those are for oversight); `git fetch` it.

2. **Integrate — you are the merge queue.** You are the *only* integrator, so you
   merge one task at a time; that serialization is what keeps the default branch
   coherent while many implementers run in parallel ([ADR 0021](../.agents/decisions/0021-v4-scope-the-swarm.md),
   [parallel-loop.md](../.agents/design/parallel-loop.md) D2). For each task, in order:
   - **Refuse empty work first.** `git fetch` then
     `git diff --stat origin/<default-branch>...dev/<task.id>`. If the branch has **no
     changes** against the default branch, do **not** open or merge a PR — send it back:
     `ainarres reject <task.id> --to implementing --reason "empty branch — nothing to
     integrate"`. (Merging an empty PR is a silent no-op that pollutes history.)
   - **Rebase on the latest default branch, then RE-VALIDATE — the heart of the merge
     queue.** Other tasks may have merged since this branch was cut, so the diff you
     reviewed is not what will land. `git fetch origin && git rebase origin/<default-branch>`.
     Then re-run the task's **own `validate`** (from `task.payload`) on the rebased
     branch. This catches a task that was green in isolation but breaks against the
     `main` it will actually merge into — the coherence guarantee.
   - **On a rebase conflict you cannot cleanly resolve, send it back — never force it**
     (conflict policy, D3): `ainarres reject <task.id> --to implementing --reason
     "rebase conflict on <files> against <default-branch>"`. The implementer redoes it on
     fresh `main`; the bumped attempts feed escalation if it keeps conflicting. A dirty or
     `-X ours/theirs` merge that papers over a real conflict is never acceptable.
   - **On re-validate failure after rebase, send it back too:** `ainarres reject
     <task.id> --to implementing --reason "validate failed after rebase on <default-branch>"`.
   - Only once rebased **and** re-validated green: `git push`, `gh pr create` (title/body
     from the task `goal`/`instructions`) — capture the PR url — and when checks are green
     `gh pr merge --squash --delete-branch` — capture the merge commit sha.
   - For long operations, `ainarres heartbeat <task.id> --watch --interval 60 --max 1800 &`
     keeps your lease alive; `code:"lease_lost"` means you took too long — stop and re-`claim`.

3. **Record the references and advance to `validating`.** The substrate stores
   *references*, never the diff itself (two planes —
   [ADR 0003](../.agents/decisions/0003-two-plane-source-of-truth.md)):
   ```
   ainarres advance <task.id> --to validating \
     --note "merged" \
     --pr https://github.com/laanito/ainarres/pull/<n> \
     --branch dev/<task.id> \
     --commit <merge-sha>
   ```
   - `code:"ok"` → done; go to step 1.
   - `code:"not_eligible"` → your token lacks `capability:integrate` (you should never be
     holding this task) — stop.
   - `code:"lease_lost"` → you lost the lease mid-work; go to step 1.

4. **If you cannot integrate** (conflicts, failing checks you can't fix), send it back
   instead of forcing it: `ainarres reject <task.id> --to implementing --reason "<why>"`.

## Rules

- **The PR is the product; the task carries only a reference to it.** Always record
  `--pr` (and `--branch`/`--commit`) so the reviewer and the board can find your work.
- **Never merge red.** If checks fail, reject back for rework — do not push past them.
- **Always rebase + re-validate before merging.** You merge serially, so each task lands
  on a `main` that has moved since it was cut; the rebased re-validate is the merge
  queue's coherence check, not a formality. A conflict or a post-rebase validate failure
  is a reject-to-implementing (D3), never a forced merge.
- **Never merge empty.** A branch with no diff against the default branch has nothing to
  integrate — reject it back to implementing rather than merging a no-op PR.
- **Don't fight the lease.** `lease_lost` → re-claim cleanly.
- **Your capability is a boundary, not a convenience.** If `advance` ever returns
  `not_eligible`, the substrate is correctly refusing — investigate, don't work around it.
