# `loop/` — the autonomous run harness (ADR 0020, M14)

The pieces that run AINARRES's own development **hands-off**: a *dumb* driver and
independent *standing pollers*. No component here coordinates — coordination is the
substrate's job (ADR 0001). These run against the **isolated loop substrate** (M13,
`loop.env` → `localhost:3011`), never the test substrate.

```
loop/
  driver.sh        the dumb driver: brief → designer → run pollers until drained → stop
  poller.sh        one standing role poller: mint token, relaunch harness, sleep, until STOP
  roles.sh         config: which harness runs which role + each role's token features
  mock-harness.sh  deterministic stand-in (LOOP_MODE=mock) for the plumbing test
  examples/        a self-test brief
  run/             per-poller logs + the STOP sentinel (gitignored)
```

## What runs which role (ADR 0020 cast, v3 — serialized)

| Poller | Harness / family | Role(s) |
|---|---|---|
| `cheap-implementer` | `opencode + qwen3.6` | implementer (the default) |
| `frontier` | `grok + grok-build` | designer, reviewer, integrator, **escalated** implementer (`tier:2`) |

When M12 escalates a stuck implementing task to `tier:2`, the cheap poller is no
longer eligible and the frontier poller picks it up — automatically, decided by the
substrate, not the driver. The integrator runs as a **standing poller** (continuous
claim of `integrating` tasks), not a per-task invocation.

Token features per role live in `roles.sh::role_features` and are authoritative for
the run (the substrate trusts the signed token's features minus denials — ADR 0007).

## Run it for real (owner-invoked)

The real run is **owner-started by design**: Claude Code cannot spawn `grok
--always-approve` (the auto-mode guard treats it as laundering the company-denied
merge — retro `m11-bootstrap`), and the integrator boundary must stay independent
(ADR 0017). So a human starts the driver; from then on no human coordinates.

```sh
make loop-up && make loop-seed          # bring up the isolated loop substrate (5434/3011)

# Wire the real harnesses (thin shims in roles.sh read these env vars):
export GROK_FRONTIER_CMD='~/.grok/bin/grok --output-format json … <frontier role skills>'
export OPENCODE_IMPLEMENTER_CMD='opencode run -m ollama/qwen3.6:35b-mlx … <implementer skill>'

make loop-run BRIEF=path/to/feature-brief.txt
```

The driver hands the brief to a designer once, launches the pollers, watches the
board, and stops when it drains. Logs stream to `loop/run/<poller>.log`. Filling in
the exact harness commands is the M14 **assisted shakeout** (owner present) before
the M15 fully-unattended gate.

## Prove the plumbing (deterministic, no LLMs)

```sh
make loop-selftest
```

Brings up a fresh loop substrate and runs the driver with `LOOP_MODE=mock`: the mock
harness decomposes the brief into one trivial task and walks it
`proposed → designing → implementing → reviewing → integrating → validating → done`
through the correct role tokens, with the integrator-role poller "merging" without
per-task invocation. The board drains to `done` and the driver exits 0 — proving the
driver + pollers + substrate wiring with zero stochastic harness behaviour. This is
M14's done-test.

## Stopping

Killing the driver kills the loop. On Ctrl-C, `kill`, normal drain, or error, the
driver tears down every poller **and its harness subtree** (grok/opencode and their
git/gh children) via a TERM→KILL `kill_tree` in an EXIT/INT/TERM trap — so no runner
is ever left doing real git/gh work after `make loop-run` exits. A `STOP` sentinel is
dropped first so a poller resting between sweeps exits cleanly.

## Resilience

A poller that dies mid-task is recovered with no driver involvement: the held task's
lease expires and the next claim hands it out again (lazy reclaim, ADR 0009 —
already tested). `poller.sh` also treats a non-zero harness sweep as transient and
just retries on the next sweep. Exercising a real mid-run kill/restart is part of the
assisted shakeout.
