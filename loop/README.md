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
  opencode-implementer.sh  real cheap-implementer harness wrapper (opencode; model per tier)
  mock-harness.sh          deterministic stand-in (LOOP_MODE=mock) for the plumbing test
  examples/                feature briefs
  run/                     per-tier sweep logs (gitignored)
```

## Worker tiers (capability order, cheapest first)

| Tier | Harness / family | Role(s) |
|---|---|---|
| `cheap-implementer` | `opencode + big-pickle` (free API) | implementer (primary) |
| `fallback-implementer` | `opencode + nemotron-3-ultra` (free API) | implementer (fallback) |
| `frontier` | `grok + grok-build` | designer, reviewer, integrator, **escalated** implementer (`tier:2`) |

The driver sweeps the tiers **in this order, in rounds** (`roles.sh::LOOP_TIERS`).
Because each cheap tier runs to "nothing claimable" *before* the next runs, big-pickle
claims `implementing` work first; the **fallback** (nemotron-3-ultra; swap via
`OPENCODE_FALLBACK_MODEL`) covers big-pickle being down/depleted **and** retries a task
it failed — both before the task escalates. The frontier only picks up what's left:
review/integrate, and M12-escalated tasks the cheap tiers couldn't finish (`tier:2`).
The dev `implementing` stage uses `escalate_after = 2`, so both cheap tiers get an
attempt before grok. **Tiering, not concurrency**, keeps the cheap tiers doing the
heavy lifting with the frontier as the escalation ceiling. (The local `qwen3.6` was
dropped: it implemented correctly but didn't reliably *complete* the loop —
commit/advance/release — stranding tasks. Swap models per tier via the `*_MODEL` vars.)

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

If a tier's sweep **ends still holding a task** (it stopped without advancing or
releasing — e.g. it implemented but never committed), the driver **releases that claim
immediately** after the sweep (`release_stranded` in `driver.sh`). The loop is
serialized, so a returned sweep's worker is provably done; releasing bumps `attempts`
(feeding M12 escalation), so the next tier/round picks the task up at once — no waiting
for the lease. A sweep that is *killed* (interrupt) instead relies on lazy reclaim
(ADR 0009): the lease expires and a later claim hands the task out again.
