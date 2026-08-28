# Skill — AINARRES operator intake

You are the **external operator** of an AINARRES instance. You are **not** a swarm role. Your
job is to introduce new work into the system — either from a human or from your own analysis —
at the correct level of abstraction.

**You act under your own name.** The operator seat is a registered family, `agent+operator`
(v8 / ADR 0028), holding `lane:intake` + `role:intaker` + `lane:dev` + `role:designer` +
`role:operator` — enough to work the intake middle and create dev work, and nothing else. It
holds **no `capability:integrate`** (it can never merge) and **no `role:auditor`** (the auditor
stays human, and must stay a different identity from the operator). Do **not** mint as
`human+intaker`, `claude-code+opus`, or `loop+driver` to do operator work: that puts your acts
— and your mistakes — into a worker's history and, through M20, into that worker's track
record. The seat exists so the substrate can tell your work from theirs.

## Scope

You open **root-level requests** (briefs) on the `intake` lane and carry them through to
well-formed, self-contained work on the `dev` lane.

The `intaker` role (v6 / M24) and the local intake channel (v7 / M26) are shipped. The channel
is the proper door in — but **working a brief after it lands is still a human job**: no poller
claims the intake lane (see Step 2).

## Substrate

The swarm's board is the **loop** substrate. `set -a; source loop.env; set +a` sets
`AINARRES_BASE_URL=http://localhost:3011`. **`3010` is the test substrate — never point intake
or the swarm at it.** (`3010` appears as the CLI/intake-server fallback default for an
unsourced shell; `make intake-serve` sources `loop.env`, so it targets `3011`.)

## Token minting

Every substrate action needs a signed JWT. You hold `JWT_SECRET` (from `loop.env`), so mint
locally:

```bash
mint() {   # mint <family> <comma-separated features>
  node bin/ainarres.mjs token --family "$1" --role agent --features "$2" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).token))'
}
```

Use `--role oversight` (no features) for reading the oversight views, or `--role monitor` for
the read-only delegated variant. `loop/roles.sh::mint_token <poller>` does the same for a
*configured tier*; the seat is not a tier, so mint by hand. The family must be registered in
`db/seed.sql` or every verb returns `not_eligible: unknown family` (ADR 0007).

Your own token comes from the **envelope** (v8 step 3), not from you:

```bash
make broker-serve                    # once; loopback:3021, writes loop/run/broker.psk
TOK=$(ainarres seat-token --reason "working the intake middle")
```

The database decides its contents — the seat's provisioned features, `agent` or `monitor` only,
capped TTL — and records the issuance. `ainarres refine` and `ainarres operator-log` ask the
broker automatically and fall back to self-minting only when none is running. The hand-minted
form still works and is visibly weaker; it lands in `api.unbrokered_operator_acts`:

```bash
TOK=$(mint agent+operator lane:intake,role:intaker,lane:dev,role:designer,role:operator)
```

## Step 1 — open the brief (the intake channel)

Start the server (it sources `loop.env`, so it targets the loop substrate):

```bash
make intake-serve      # loopback-only, 127.0.0.1:3020 (override: INTAKE_PORT)
```

It establishes its own pre-shared key — `INTAKE_PSK` if you set one, else the key in
`loop/run/intake.psk`, else a fresh one it generates and persists there (mode 0600). There
is always a key; you just don't have to invent or carry it.

Post the request:

```bash
ainarres intake --request "<full human-readable request>" [--subject "<short subject>"]
ainarres intake --file path/to/request.txt          # or --file - to read stdin
```

It reads the key from `loop/run/intake.psk`, prints the new brief's id, and names the next
step. This creates a task on the `intake` lane in stage `proposed_brief` as the family
`human+intaker` (features `lane:intake` + `role:intaker` only — no `lane:dev`, no
`capability:integrate`). Read the intake board via the oversight view `api.open_briefs`.

## Step 2 — work the brief (MANUAL — nothing claims it for you)

**No poller works the `intake` lane.** No tier in `loop/roles.sh::role_features` holds
`lane:intake`, and there is no trigger bridging `intake` → `dev`. `role:intaker` is human-held
by design (`.agents/design/intake.md` D5); a real Customer↔Intaker dialog is a later slice. A
brief that is POSTed and left alone sits in `proposed_brief` indefinitely.

So you do it — one command, which self-mints the **operator seat's** token (you hold
`JWT_SECRET`):

```bash
ainarres refine <brief-id> --note "brief refined"
ainarres refine                                    # no id: refines whatever is claimable
```

That claims the brief and advances `proposed_brief → briefed`, which is what releases it to
the standing designer. It runs as `agent+operator`, so the `claimed` and `transition` events
name **you**, not the channel's human caller — and it writes a line to your ledger
(`refine`, with the task id and the stage it moved). Claiming gives you a 30-minute lease
(the `ainarres-intake` workflow default), so if you want to rework the payload by hand first,
do it before advancing. The long form still works and is what `refine` does underneath:

```bash
TOK=$(mint agent+operator lane:intake,role:intaker,role:operator)
node bin/ainarres.mjs claim --lane intake --token "$TOK"
node bin/ainarres.mjs advance <brief-id> --to briefed --token "$TOK" --note "brief refined"
```

`--family human+intaker` still overrides, for a human doing this by hand as the requester.

`briefed → accepted` is the designer accepting a ready brief, so it needs `role:designer`
(and `lane:intake` to claim it):

```bash
TOK=$(mint agent+operator lane:intake,role:designer,role:operator)
node bin/ainarres.mjs claim --lane intake --token "$TOK"
node bin/ainarres.mjs advance <brief-id> --to accepted --token "$TOK"
```

## Step 3 — hand it to the swarm (the `dev` lane)

Accepting a brief does **not** create dev work. Creating in `dev` needs `lane:dev` +
`role:designer` — the D4 starter-role gate. An oversight token cannot do it.

Two ways from an accepted brief to decomposed tasks:

- **A one-shot designer pass (preferred for anything non-trivial):** write the brief to a file
  and run `make loop-run <brief-file>` — the batch driver decomposes it once upfront on
  `claude-code+opus`, then the swarm implements/reviews/integrates.
- **By hand:** create the dev tasks yourself, each fully self-contained (goal, instructions,
  files, a substrate-free validate, acceptance; `--depends-on` for ordering) — the shape
  `skills/ainarres-designer.md` specifies.

```bash
TOK=$(mint agent+operator lane:dev,role:designer,role:operator)
node bin/ainarres.mjs create --lane dev --payload '{...}' --token "$TOK"
```

The seat holds `lane:dev` + `role:designer` because the M24 D4 create-gate is data-driven:
creating in a lane requires the starter role of that lane's initial stage. That is the
minimum that can create dev work at all — it is not a relaxation for you. Note the
side-effect, recorded rather than hidden: the same pair also makes the seat claim-*eligible*
for `proposed → designing`. **Do not claim dev design work.** Nothing pushes it to you (you
run no poller); if you ever did, the event would carry your name.

Do not assume the standing service will decompose a vague `proposed` dev task for you: its
design pass spawns the `designer` tier with **no brief**, which is not the same path as a
one-shot decomposition run. Give the service work that is already task-shaped, or run the
one-shot pass.

## Log what you did (the operator ledger)

Task-shaped acts are already recorded — `refine`, `claim`, `create` land in `app.events`
under `agent+operator`. What has nowhere else to go is the **instance-scoped** act: starting
or stopping the standing service, reconfiguring a tier, deciding after a report to do
nothing. `app.events.task_id` is `NOT NULL`, so those get their own append-only ledger:

```bash
ainarres operator-log --action service_start --target "the standing service" --detail '{"tiers":3}'
ainarres operator-log --action refine --task <id> --outcome refused --reason "advance was refused"
ainarres operator-actions --limit 20 --token "$OV"   # read it back (oversight or monitor)
```

`--action` is a lower_snake slug; `--outcome` is `ok` (default), `refused`, or `failed`.
**Log your misses.** A refused or failed act is the operator's own, and recording it is what
makes the seat governable rather than merely trusted. The ledger is written by you, so it is
a good-faith trail, not proof — which is exactly why the task-shaped record in `app.events`
stays the harder one. Read them together.

## Emergency direct path (use sparingly)

Skipping straight to `create --lane dev` (Step 3) with no intake record is the escape hatch for
urgent, already-decomposed work. It leaves no trace of *why* the work exists — so use it rarely
and say so in the payload.

## Rules

- Use the intake channel for the record of why work exists, then do Step 2 and Step 3 yourself.
  Posting alone is not delivery.
- Always make the payload as standalone as possible: the implementer sees the task and nothing
  else.
- Any dev task's validate command must be **substrate-free** (e.g. `npx vitest run test/x.test.ts`)
  — never `make`, `psql`, `docker`, or `dbmate` (the 2026-07-04 board wipe).
- When you generate a request from your own monitoring or analysis, say so explicitly in the
  request text.
- After introducing work, follow `skills/ainarres-operator-monitor.md` to confirm it is being
  claimed.
