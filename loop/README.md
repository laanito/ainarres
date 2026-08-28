# `loop/` — the autonomous run harness (ADR 0020, M14)

The pieces that run AINARRES's own development **hands-off**: a *dumb*, **tiered**
driver. No component here coordinates — coordination is the substrate's job
(ADR 0001). It runs against the **isolated loop substrate** (M13, `loop.env` →
`localhost:3011`), never the test substrate.

```
loop/
  driver.sh                the dumb BATCH driver: brief → designer → ONE activation (rounds
                           of a CONCURRENT pool + serial tiers + frontier peers) → EXIT when drained
  service.sh               the STANDING SERVICE (v7, ADR 0024): always-on supervisor — idle when
                           the board is empty, wake + run one activation on pending work, never exits
  driver-lib.sh            the SHARED coordination primitives (board reads, spawn/reap, teardown,
                           run_activation) — sourced by BOTH driver.sh and service.sh
  service-selftest.sh      deterministic mock lifecycle test (M25): idle→wake→drain→idle→stop
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
| `muse-implementer` | `opencode + muse-glimmer` (30B local MLX) | implementer (cheap serial, local; **1 session — never pooled**) |
| `cursor-implementer` | `cursor-agent + composer-2.5` | implementer (fallback, higher quality; not frontier) |
| `fallback-implementer` | `opencode + nemotron-3-ultra` (free API) | implementer (fallback) |
| `designer` | `claude-code + opus` | designer (one-shot decomposition) |
| `frontier` | `grok + grok-4.6` | reviewer + the **single integrator** + **escalated** implementer (`tier:2`) |
| `frontier-claude-reviewer` | `claude-code + sonnet` | reviewer (M19 peer, **never** integrates) |

The driver sweeps the tiers **in this order, in rounds** (`roles.sh::LOOP_TIERS`).
Because each cheap tier runs to "nothing claimable" *before* the next runs,
big-pickle's ×3 pool takes the bulk of the `implementing` work; then the serial tiers
in order: `qwen-implementer` (opencode + qwen3-coder-next, an 80B ~big-pickle-par cheap
implementer, single serial sweep — its `:cloud` backend allows one session) takes the
first serial crack, then `muse-implementer` (opencode + muse-glimmer, a 30B local MLX
model, single serial sweep — a local model loads one at a time), then the higher-quality
`cursor-implementer` (cursor-agent + composer-2.5), and behind it `fallback-implementer`
(nemotron-3-ultra; swap via `OPENCODE_FALLBACK_MODEL`) — each covers an earlier tier being down/depleted **and**
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
— "board empty AND pool idle" (parallel-loop.md D4). (Token budgets remain a later slice.)

## The standing service (v7, ADR 0024 / design/service.md)

`make loop-run` is the **batch** shape: one brief, drain, exit. The **standing service**
(`make service`) is v7's flip — it **retires the crank**. Instead of exiting when the
board drains, it **idles** (holding no workers) and **wakes** on the next poll when work
appears, running the **same activation** (`run_activation`, shared via `driver-lib.sh`)
the batch driver runs — so AINARRES becomes a process that *runs*, not a script you *run*.

```sh
make service                 # start the always-on supervisor (foreground; owner-run)
make service-status          # its liveness: running | idle | stalled | stopped (raw JSON for now)
make service-stop            # SIGTERM it → drains the in-flight activation, then halts cleanly
```

Key differences from the batch driver (all in `service.sh`; the primitives are shared):

- **Termination inverts** (design/service.md D1): drained ≠ done, drained = *quiescent*.
  The idle service spawns nothing and holds no lease; it wakes every `LOOP_IDLE_POLL_SECS`.
- **It decomposes continuously** (`LOOP_DESIGN_TIERS=(designer)`): unlike the batch driver
  (one upfront designer pass on the brief), the service keeps seeing proposed dev tasks
  (and, in M26, accepted intake briefs) and runs the designer each round before the pool.
- **Never a router** (ADR 0024): the demand gate is coarse — "is there active work?" — and
  the tiers self-claim via `SKIP LOCKED`; the service never picks which task goes to whom.
- **Consumes governance** (design/service.md D6): before spawning a tier the service reads
  `api.governance_status` and **skips a family temp-banned** for the capability its role needs
  (`LOOP_CONSUME_GOVERNANCE=1`; the batch driver leaves it off). Best-effort — an unreadable
  view degrades to spawn-anyway (measured-not-enforced). Reading a denial the substrate already
  enforces, never routing. (`ainarres governance-status` shows the same view.)
- **Stalls are held, not spun** (design/service.md D3): a no-progress activation records the
  stuck board signature and enters `stalled` — it will **not** re-activate that board until a
  human changes it (the signature). The cost bound (bounded rounds) is preserved; it neither
  spins nor exits. Stranded *claims* stay surfaced by the M23 auditor health watch.
- **Graceful stop** (design/service.md D5): SIGTERM sets a draining flag; `run_activation`
  finishes the current round's (already-reaped) sweeps, starts no new round, and the exit
  trap runs the same `stop_active` teardown — "always-on" never means "cannot be turned off".

Prove the lifecycle deterministically (no LLMs), the M25 done-test:

```sh
make service-selftest        # loop-reset + MOCK: idle→wake→drain→idle→2nd activation→clean stop
```

Deferred to the M25 Slice B **swarm** half: the **pure** status/liveness formatter (a nice
`ainarres service-status` readout over the status file) — substrate-free, briefed to the loop.

## The intake channel (v7 M26, ADR 0024 Stage 2 / ADR 0025)

The **first external ingress**: a loopback-bound HTTP endpoint (`bin/intake-server.mjs`) an
external Customer POSTs a request to — the intaker's write channel. It authenticates a
**pre-shared key**, then opens a `proposed_brief` in the `intake` lane **as a distinct human
identity** (`human+intaker`, holding only `lane:intake` + `role:intaker`), which the standing
service then decomposes and drains. Kept **local + light** per ADR 0025.

```sh
make intake-serve                               # loopback:3020, targets the loop substrate
# submit a request (reads the key file; --file PATH or --file - also work):
ainarres intake --request "add a foo widget"
#   → brief 01a0…  stage=proposed_brief
ainarres refine <brief-id>                      # the intaker's step → briefed
```

**The key needs no ceremony (v8).** The channel establishes its own: `INTAKE_PSK` if you set
one, else the key already in `loop/run/intake.psk` (so a restart keeps configured clients
working), else a fresh 32-byte key it generates. It always persists the key there at mode
0600, which is where `ainarres intake` reads it — so the key is never carried between shells.
There is **always** a key: generated is not absent, and an unauthenticated POST is still 401
with no row. The raw `curl` form still works if you prefer it (`X-Intake-Key: $(cat
loop/run/intake.psk)`).

Security posture (ADR 0025 — deliberately light, first stage): binds **loopback only** (the
server *refuses* to start on a non-loopback host), **PSK always** (supplied or generated —
never absent; constant-time compare), single-owner, no TLS / multi-tenant / rate-limiting (deferred with
a written widening contract in ADR 0025). **Defence in depth:** the PSK is the outer wall; the
**unchanged M24 two-tier create-gate** is the inner one — the channel's identity can open a
brief but the substrate refuses it any dev create or merge, so a channel bug can't grant what
the substrate withholds. Verified by `test/intake-channel.test.ts` (real server + real
`create_task`).

## The operator seat (v8, ADR 0028)

The operator is an **identity**, not "whoever holds `JWT_SECRET`". `agent+operator` is a
registered family (`db/seed.sql`) holding `lane:intake` + `role:intaker` + `lane:dev` +
`role:designer` + `role:operator` — enough to work the intake middle and create the dev work,
and no more: **no `capability:integrate`** (it can never merge) and **no `role:auditor`** (the
auditor stays human, and stays a different identity). `ainarres refine` runs as the seat, so
the `claimed` / `transition` events name the operator rather than the channel's human caller.

Before this, operator work was minted as whichever worker family the act happened to need, so
the operator's work — and its mistakes — landed in that worker's history and, through M20, in
its track record. The substrate was measuring the wrong family.

```sh
ainarres operator-log --action service_start --target "the standing service"
ainarres operator-log --action refine --task <id> --outcome refused --reason "advance refused"
ainarres operator-actions --limit 20 --token "$OV"     # oversight or monitor
```

`app.operator_actions` is append-only and exists for the acts that **cannot** be events:
`app.events.task_id` is `NOT NULL`, so starting the service or reseating a tier has nowhere
else to go (the same reconciliation M22 D7 made for human ban/lift). It is written *by the
seat*, so it is a good-faith trail, not proof — everything task-shaped is independently in
`app.events` under `agent+operator`, and that stays the harder record. Read them together.

### The credential envelope (v8 step 3)

The seat no longer signs its own tokens. It asks a loopback broker, and the **database** decides
what may be in the credential:

```sh
make broker-serve                       # loopback:3021, holds JWT_SECRET, writes loop/run/broker.psk
ainarres seat-token --reason "why"      # → a token the seat did not get to specify
ainarres operator-credentials --token "$OV"   # the issuance trail
```

`api.issue_operator_credential` enforces four rules, none of them in the broker: role ∈
{`agent`, `monitor`} — never `oversight` (it carries the human's ban/lift `EXECUTE`) and never
`reaper` (it could issue credentials); the family must hold `role:operator`, which makes the seat
whoever the **owner** provisioned rather than a name in code; features are the family's
provisioned snapshot, whole and unedited, because asking for a subset or superset is not part of
the protocol; and the TTL is capped, since a long-lived credential is a key with extra steps. The
issuance is recorded in the same statement, so nothing mints without a trail.

`ainarres refine` and `operator-log` prefer the broker and fall back to self-minting when none is
running — the fallback still works and is visibly weaker.

The mechanism is not new. `api.token_claims` has read provisioned features and returned claims
**for a separate minter to sign** since M2; this is the caller it was waiting for.

**What this does NOT do, chosen deliberately.** On one host with one OS user, a shell-capable
seat can read `loop.env` and sign whatever it likes; no code here prevents that. The owner chose
an **audited boundary**: the envelope binds a cooperating seat and *exposes* one that is not.

```sh
ainarres operator-credentials      # what the envelope issued
curl .../unbrokered_operator_acts  # operator acts with no issuance behind them
```

`api.unbrokered_operator_acts` covers **both** places an operator act can land — `app.events`
and `app.operator_actions` — because the seat's own ledger is one of the likelier bypasses. A row
there is a question ("who signed this?"), never a verdict; the owner's own hand-minted acts
appear too, which is correct.

**To make it prevention rather than detection**, run the seat as a separate OS user (or in a
container) with no read access to `loop.env` / `.env`, and the broker as the owner. That is a
deployment choice, not something the substrate can enforce.

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

**cursor requires a one-time allowlist.** The wrapper runs cursor with `--trust` (not
`--force`/"Run Everything", which the org admin disables). cursor's `approvalMode` is
`allowlist`, so file edits run headless but SHELL commands run only if pre-allowed in
`~/.cursor/cli-config.json` → `permissions.allow`. Add the implementer's commands once. **Essential**: `Shell(git)` (covers all git
subcommands), `Shell(npx)` (the vitest validate), `Shell(node)` (`node bin/ainarres.mjs`).
The rest below are **read-only insurance** — a model that reaches for shell `cat`/`grep`
instead of cursor's native Read/Grep tools would otherwise block mid-task:

```json
"permissions": {
  "allow": [
    "Shell(git)", "Shell(npx)", "Shell(node)",
    "Shell(cat)", "Shell(grep)", "Shell(head)", "Shell(tail)",
    "Shell(find)", "Shell(pwd)", "Shell(wc)", "Shell(ls)"
  ],
  "deny": []
}
```

Do NOT add `make`/`docker`/`psql`/`dbmate` — the guard-bin denies those for cursor anyway;
nor destructive ops (`rm`/`mv`/`chmod`) — cursor's Write/Edit tools handle mutations.
Without the essentials a cursor sweep claims a task but its git/npx calls are blocked and it
can't advance (the task falls to the next tier). Compound `a && b` shell calls may need each
command allowed — if cursor stalls on those, have it run them separately or widen the list.

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
