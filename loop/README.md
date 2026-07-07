# `loop/` — the autonomous run harness (ADR 0020, M14)

The pieces that run AINARRES's own development **hands-off**: a *dumb*, **tiered**
driver. No component here coordinates — coordination is the substrate's job
(ADR 0001). It runs against the **isolated loop substrate** (M13, `loop.env` →
`localhost:3011`), never the test substrate.

```
loop/
  driver.sh                the dumb driver: brief → designer → each round runs a CONCURRENT
                           pool of cheap implementers + the serial tiers → stop when drained
  worktree.sh              per-sweep git worktree isolation (M17): enter/teardown/gc
  roles.sh                 config: the pool tier + serial tiers + frontier peers + each tier's harness, token features
  grok-frontier.sh         real frontier harness wrapper (grok; reviewer + the SINGLE integrator + escalated impl)
  claude-frontier.sh       real frontier PEER wrapper (M19; claude — opus designer / sonnet reviewer, never integrates)
  opencode-implementer.sh  real cheap-implementer harness wrapper (opencode; isolates in a worktree)
  cursor-implementer.sh    real fallback-implementer wrapper (cursor-agent + composer-2.5; serial, worktree-isolated)
  mock-harness.sh          deterministic stand-in (LOOP_MODE=mock) for the plumbing test
  examples/                feature briefs (incl. parallel-gate-brief.txt — the M18 gate)
  run/                     per-sweep logs + worktree sentinels (gitignored)
```

## Worker tiers (capability order, cheapest first)

| Tier / peer | Harness / family | Role(s) |
|---|---|---|
| `nano-implementer` | `opencode + nemotron-3-nano` | implementer (tier-0; **DISABLED** — hallucinated tools) |
| `cheap-implementer` | `opencode + big-pickle` (free API) | implementer (primary, ×3 pool) |
| `qwen-implementer` | `opencode + qwen3-coder-next` (80B) | implementer (cheap serial, big-pickle par; **1 session — never pooled**) |
| `cursor-implementer` | `cursor-agent + composer-2.5` | implementer (fallback, higher quality; not frontier) |
| `fallback-implementer` | `opencode + nemotron-3-ultra` (free API) | implementer (fallback) |
| `designer` | `claude-code + opus` | designer (one-shot decomposition) |
| `frontier` | `grok + grok-build` | reviewer + the **single integrator** + **escalated** implementer (`tier:2`) |
| `frontier-claude-reviewer` | `claude-code + sonnet` | reviewer (M19 peer, **never** integrates) |

The driver sweeps the tiers **in this order, in rounds** (`roles.sh::LOOP_TIERS`).
Because each cheap tier runs to "nothing claimable" *before* the next runs,
big-pickle's ×3 pool takes the bulk of the `implementing` work; then the serial tiers
in order: `qwen-implementer` (opencode + qwen3-coder-next, an 80B ~big-pickle-par cheap
implementer, single serial sweep — its `:cloud` backend allows one session) takes the
first serial crack, then the higher-quality `cursor-implementer` (cursor-agent +
composer-2.5), and behind it `fallback-implementer` (nemotron-3-ultra; swap via
`OPENCODE_FALLBACK_MODEL`) — each covers an earlier tier being down/depleted **and**
retries a task it failed, before the task escalates. (`nano-implementer` is the disabled
tier-0 pre-pass slot — `LOOP_PRE_TIERS=()`; see below.) The frontier only picks up what's left:
review/integrate, and M12-escalated tasks the cheap tiers couldn't finish (`tier:2`).
The dev `implementing` stage uses `escalate_after = 2`, so both cheap tiers get an
attempt before grok. (The local `qwen3.6` was dropped: it implemented correctly but
didn't reliably *complete* the loop — commit/advance/release — stranding tasks. Swap
models per tier via the `*_MODEL` vars.)

**M18 — the primary cheap implementer is fanned out into a concurrent pool.** Each
round launches `LOOP_POOL_SIZE` (default 3) simultaneous `cheap-implementer` sweeps
(`roles.sh::LOOP_POOL_TIER`), each isolated two ways so they implement independent DAG
tasks at once without colliding: (1) its own **M17 git worktree** (`LOOP_SWEEP_ID`), and
(2) its own **opencode session store** — a private `XDG_DATA_HOME` per sweep with the
shared `auth.json` symlinked in. The opencode isolation is load-bearing: opencode keeps
its session SQLite at `$XDG_DATA_HOME/opencode/opencode.db`, and concurrent opencode
processes sharing it collide (`database is locked`) — the first real gate run collapsed
the pool to one live worker for exactly this reason. This is the swarm's throughput. Ahead of the
pool each round, any **tier-0 pre-pass** tiers (`roles.sh::LOOP_PRE_TIERS`) run once,
serially, before big-pickle fans out — currently **empty** (`nano-implementer` sat here
until it was disabled). The remaining tiers (`LOOP_SERIAL_TIERS` = qwen-implementer,
cursor-implementer, fallback-implementer, then the frontier peers) still run once each,
serially, after the pool. A backend limited to **one concurrent session** (qwen, cursor)
lives in a serial slot, never in the ×`LOOP_POOL_SIZE` pool, which would collide on it.
**Integration stays single**: the lone
frontier integrator drains `integrating` FIFO, rebasing on the latest default branch +
re-validating before each merge — it *is* the merge queue (parallel-loop.md D2), which
is what keeps `main` coherent while implementing runs wide. A rebase conflict or a
post-rebase validate failure rejects the task back to `implementing` (D3), never a
dirty merge.

**M19 — the frontier role is federated across peers.** The one-shot `designer` runs on
`claude-code + opus`; each round, after the serial tiers, the **frontier peers**
(`roles.sh::LOOP_FRONTIER_PEERS` = `grok` + the `claude-code + sonnet` reviewer) sweep
**concurrently** (`driver.sh::run_concurrent`). A `reviewing` task is claimed by whoever
is free — `SKIP LOCKED` distributes it across families — so a claude reviewer routinely
verifies grok/opencode-authored work: the prize is **uncorrelated failure**, one family
catching what another's blind spots miss. It is *measured, not enforced* (the end-of-run
report attributes review per family; nothing blocks on cross-family review, so a peer
being down never stalls the board — design/federation.md D3). **Only `grok` holds
`capability:integrate`**, so integration stays the single merge queue even though review
fans out; the claude reviewer never receives an `integrating` task (D1/D5). Creation is
gated to the starter role too (`role:designer` on dev, D4) — a cheap implementer cannot
freelance-create work. Swap the claude models per role via `CLAUDE_DESIGNER_MODEL` /
`CLAUDE_REVIEWER_MODEL`.

Token features per tier live in `roles.sh::role_features` and are authoritative for
the run (the substrate trusts the signed token's features minus denials — ADR 0007).

## When the loop ends

The driver loops **rounds** until a full round makes **no progress** — either the
board is **drained** (every dev task terminal → success, exit 0) or **nobody can move
it** (stuck → exit 1, reported). It does not poll forever: when no tier has work left,
it stops. Termination is unchanged by the M18 pool: `run_pool`/`run_sweep` both reap
their sweeps before a round returns, so when the round body finishes nothing is running
— "board empty AND pool idle" (parallel-loop.md D4). (Token budgets and always-on
daemonized tiers remain later slices.)

## Run it for real (owner-invoked)

The real run is **owner-started by design**: Claude Code cannot spawn `grok
--always-approve` (the auto-mode guard treats it as laundering the company-denied
merge — retro `m11-bootstrap`), and the integrator boundary must stay independent
(ADR 0017). So a human starts the driver; from then on no human coordinates.

```sh
make loop-up && make loop-seed          # bring up the isolated loop substrate (5434/3011)
make loop-run BRIEF=path/to/feature-brief.txt
```

The harness wrappers (`grok-frontier.sh`, `opencode-implementer.sh`,
`cursor-implementer.sh`) resolve their binaries themselves (no PATH wiring needed);
override with `GROK_FRONTIER_CMD` / `OPENCODE_IMPLEMENTER_CMD` / `CURSOR_IMPLEMENTER_CMD`
(or `GROK_BIN`/`OPENCODE_BIN`/`CURSOR_BIN`, `*_MODEL`) to swap in a different invocation.
`cursor-agent` authenticates via `CURSOR_API_KEY` (or a prior `cursor-agent login`).
Per-tier sweep logs stream to `loop/run/<tier>.log`.

## Prove the plumbing (deterministic, no LLMs)

```sh
make loop-selftest
```

Brings up a fresh loop substrate and runs the driver with `LOOP_MODE=mock`: the mock
harness decomposes the brief into `LOOP_MOCK_TASKS` (default 3) **independent** tasks
and the tiers walk them
`proposed → designing → implementing → reviewing → integrating → validating → done`
through the correct role tokens, with the **concurrent pool** implementing them
simultaneously (each in its own worktree) and the single integrator "merging" them
FIFO. The board drains to `done` and the driver exits 0 — proving the driver + pool +
merge-queue + substrate wiring with zero stochastic harness behaviour.

```sh
LOOP_MOCK_CONFLICT=1 make loop-selftest
```

Same, plus one task the integrator **rejects once** (simulating a rebase conflict, D3)
before it merges — proving the merge-queue conflict policy still drains green.

## Judge the gate (M18 — does the substrate coordinate a real swarm?)

The M18 gate is **concurrency correctness, not a stopwatch** (ADR 0021 § Amendment
2026-06-30). The north star is the substrate coordinating **independent workers that
could be on different machines, networks, or universes** — so wall-clock on one laptop
is *not* the measure (a single host caps real parallelism via shared CPU, a free-API
backend that serializes calls, and per-tool state — none of which the substrate
controls). Per-worker isolation (M17 git worktree + per-sweep opencode state) is the
single-laptop stand-in for "each on its own machine."

```sh
make loop-reset && make loop-run BRIEF=loop/examples/parallel-gate-brief-2.txt
```

**Gate briefs are SINGLE-USE.** Each run ships its tasks to `main`, so re-running the
*same* brief is not a concurrency test — the work already exists, so a smart designer
creates nothing (exit 1) or the implementers hit empty diffs and the integrator
refuses-empty / rejects (churn), never genuine parallel work. Use a **fresh** brief each
time: `parallel-gate-brief.txt` shipped `humanize-seconds`/`pluralize`/`short-id`;
`parallel-gate-brief-2.txt` adds three more (`clamp`/`ordinal`/`percent`); write the next
when those are on `main` too.

The brief decomposes into **three independent** tasks (new file + test each, no shared
edits) so the pool fans out. **Pass =** during the run,
`ainarres status --watch --lane dev` (oversight token) shows **≥2 implementers holding
distinct tasks at the same time** (the `active` block) and the end-of-run report's
*activity by family* shows more than one implementer did real work; **`main` stays green**
(every merge rebased + re-validated, no double-claim, no corruption); and the loop
terminates. That demonstrates location-independent coordination — the same run would hold
with the workers on N machines. Wall-clock is worth a glance (`time …`) but is **not**
the gate. This run is **owner-invoked** (the integrator is owner-launched, above) — the
M18 gate / the milestone-scale self-build.

## Stopping

Killing the driver kills the loop. On Ctrl-C, `kill`, normal completion, or error,
the driver tears down the **in-flight sweep and its harness subtree** (grok/opencode
and their git/gh/node children) via a TERM→KILL `kill_tree` in an EXIT/INT/TERM trap
— so no runner is ever left doing real git/gh work after `make loop-run` exits.
(Interrupting shows `make: *** [loop-run] Error 130`; that 130 is the normal
"you interrupted it" exit, not a failure.)

## Resilience

If a sweep **ends still holding a task** (it stopped without advancing or releasing —
e.g. it implemented but never committed), the driver **releases that claim immediately**
after the sweep (`release_stranded` in `driver.sh`) — and the M18 pool reaps **each**
member with its own `release_stranded`. A *returned* sweep's worker is provably done
(it's no longer running), so releasing is safe even with the pool concurrent; releasing
bumps `attempts` (feeding M12 escalation), so the next round picks the task up at once —
no waiting for the lease. A sweep that is *killed* (interrupt) instead relies on lazy
reclaim (ADR 0009): the lease expires and a later claim hands the task out again. On
exit, the driver also `worktree gc`s any per-sweep checkouts (M17), so a crashed run
leaves no orphans.
