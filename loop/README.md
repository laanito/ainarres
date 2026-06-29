# `loop/` — the autonomous run harness (ADR 0020, M14)

The pieces that run AINARRES's own development **hands-off**: a *dumb*, **tiered**
driver. No component here coordinates — coordination is the substrate's job
(ADR 0001). It runs against the **isolated loop substrate** (M13, `loop.env` →
`localhost:3011`), never the test substrate.

```
loop/
  driver.sh                the dumb driver: brief → designer → sweep tiers in rounds → stop when drained
  roles.sh                 config: the ordered worker tiers + each tier's harness, token features
  grok-frontier.sh         real frontier harness wrapper (grok; designer/reviewer/integrator/escalated-impl)
  opencode-implementer.sh  real cheap-implementer harness wrapper (opencode + qwen3.6)
  mock-harness.sh          deterministic stand-in (LOOP_MODE=mock) for the plumbing test
  examples/                feature briefs
  run/                     per-tier sweep logs (gitignored)
```

## Worker tiers (capability order, cheapest first)

| Tier | Harness / family | Role(s) |
|---|---|---|
| `cheap-implementer` | `opencode + qwen3.6` (local) | implementer (the default) |
| `fallback-implementer` | `opencode + big-pickle` (free API) | implementer (fallback for qwen) |
| `frontier` | `grok + grok-build` | designer, reviewer, integrator, **escalated** implementer (`tier:2`) |

The driver sweeps the tiers **in this order, in rounds** (`roles.sh::LOOP_TIERS`).
Because each cheap tier runs to "nothing claimable" *before* the next runs, the local
qwen implementer claims `implementing` work first; the **fallback** opencode model
(swap via `OPENCODE_FALLBACK_MODEL`) covers qwen being down/slow/depleted **and**
retries a task qwen failed — both before the task escalates. The frontier only picks
up what's left: review/integrate, and M12-escalated tasks the cheap tiers couldn't
finish (`tier:2`). The dev `implementing` stage uses `escalate_after = 2`, so both
cheap tiers get an attempt before grok. **Tiering, not concurrency**, keeps the cheap
tiers doing the heavy lifting with the frontier as the escalation ceiling — and avoids
the race where a concurrent frontier poller would grab implementing work first.

Token features per tier live in `roles.sh::role_features` and are authoritative for
the run (the substrate trusts the signed token's features minus denials — ADR 0007).

## When the loop ends

The driver loops **rounds** until a full round makes **no progress** — either the
board is **drained** (every dev task terminal → success, exit 0) or **nobody can move
it** (stuck → exit 1, reported). It does not poll forever: when no tier has work left,
it stops. (A richer scheduler — token budgets, multiple workers per tier, always-on
daemonized tiers — is a later v3+ slice. This is the minimal tiered, terminating loop.)

## Run it for real (owner-invoked)

The real run is **owner-started by design**: Claude Code cannot spawn `grok
--always-approve` (the auto-mode guard treats it as laundering the company-denied
merge — retro `m11-bootstrap`), and the integrator boundary must stay independent
(ADR 0017). So a human starts the driver; from then on no human coordinates.

```sh
make loop-up && make loop-seed          # bring up the isolated loop substrate (5434/3011)
make loop-run BRIEF=path/to/feature-brief.txt
```

`loop-run` starts from a **fresh board** by default (it resets the loop substrate
first) — the board is disposable per-feature, so this avoids resuming a previous,
interrupted run's stranded claims (a worker that died mid-task holds its claim until
its lease expires). To deliberately continue an interrupted run instead, pass
`LOOP_RESUME=1 make loop-run BRIEF=…` (the driver then skips decomposition and resumes
the existing board).

The harness wrappers (`grok-frontier.sh`, `opencode-implementer.sh`) resolve their
binaries themselves (no PATH wiring needed); override with `GROK_FRONTIER_CMD` /
`OPENCODE_IMPLEMENTER_CMD` (or `GROK_BIN`/`OPENCODE_BIN`, `*_MODEL`) to swap in a
different invocation. Per-tier sweep logs stream to `loop/run/<tier>.log`.

## Prove the plumbing (deterministic, no LLMs)

```sh
make loop-selftest
```

Brings up a fresh loop substrate and runs the driver with `LOOP_MODE=mock`: the mock
harness decomposes the brief into one trivial task and the tiers walk it
`proposed → designing → implementing → reviewing → integrating → validating → done`
through the correct role tokens, with the integrator role "merging" without per-task
invocation. The board drains to `done` and the driver exits 0 — proving the
driver + tier + substrate wiring with zero stochastic harness behaviour.

## Stopping

Killing the driver kills the loop. On Ctrl-C, `kill`, normal completion, or error,
the driver tears down the **in-flight sweep and its harness subtree** (grok/opencode
and their git/gh/node children) via a TERM→KILL `kill_tree` in an EXIT/INT/TERM trap
— so no runner is ever left doing real git/gh work after `make loop-run` exits.
(Interrupting shows `make: *** [loop-run] Error 130`; that 130 is the normal
"you interrupted it" exit, not a failure.)

## Resilience

A sweep that dies mid-task is recovered with no special handling: the held task's
lease expires and the next claim hands it out again (lazy reclaim, ADR 0009 — already
tested). A non-zero harness sweep is logged and the next round retries.
