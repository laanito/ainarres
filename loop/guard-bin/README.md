# loop/guard-bin — the harness command guard

Deny-list shims prepended to a **loop harness**'s `PATH` (by `grok-frontier.sh`,
`opencode-implementer.sh`, `claude-frontier.sh`) so a harness cannot run commands that
mutate the **shared** loop/test substrates:

- `make` — all targets are substrate/test lifecycle (`reset`, `loop-*`, `up`, `down`, …).
- `docker` — `docker compose down [-v]` tears down a substrate.
- `psql` — raw `truncate`/`delete`/`drop` wipes the board (workers use the HTTP CLI).
- `dbmate` — `down`/`drop` mutates the schema.

Each shim refuses (exit 97) via `.harness-deny` and points the worker at the task's
**substrate-free** validate (`npx vitest run <file>`).

**Why (2026-07-04 board-wipe):** a frontier harness, unable to run a mis-briefed
DB-dependent validate, ran `make reset` ×13 + `truncate task` off-script and wiped both the
loop and test boards mid-run. These commands are a **temporary substrate-control cheat** the
harness only has because there is no standing service; the **v7 service removes them
entirely**, at which point this guard is obsolete. It is a guard on the *cheat*, not a
band-aid on harness cognition.

This is defense-in-depth, not a hard sandbox: it catches `PATH`-resolved invocations (what an
agent actually types), not absolute-path calls. The real isolation is the v7 service.
