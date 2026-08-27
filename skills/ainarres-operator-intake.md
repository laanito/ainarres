# Skill — AINARRES operator intake

You are the **external operator** of an AINARRES instance. You are **not** a swarm role. Your
job is to introduce new work into the system — either from a human or from your own analysis —
at the correct level of abstraction.

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

Use `--role oversight` (no features) for reading the oversight views.
`loop/roles.sh::mint_token <poller>` does the same for a *configured tier*; there is no intaker
tier, so mint by hand. The family must be registered in `db/seed.sql` or every verb returns
`not_eligible: unknown family` (ADR 0007).

## Step 1 — open the brief (the intake channel)

Start the server (it sources `loop.env`, so it targets the loop substrate):

```bash
INTAKE_PSK=<key> make intake-serve      # loopback-only, 127.0.0.1:3020 (override: INTAKE_PORT)
```

POST the request:

```bash
curl -X POST http://127.0.0.1:3020/intake \
  -H "X-Intake-Key: $INTAKE_PSK" \
  -H "Content-Type: application/json" \
  -d '{
    "request": "<full human-readable request>",
    "subject": "<optional short subject>"
  }'
```

This creates a task on the `intake` lane in stage `proposed_brief` as the family
`human+intaker` (features `lane:intake` + `role:intaker` only — no `lane:dev`, no
`capability:integrate`). Read the intake board via the oversight view `api.open_briefs`.

## Step 2 — work the brief (MANUAL — nothing claims it for you)

**No poller works the `intake` lane.** No tier in `loop/roles.sh::role_features` holds
`lane:intake`, and there is no trigger bridging `intake` → `dev`. `role:intaker` is human-held
by design (`.agents/design/intake.md` D5); a real Customer↔Intaker dialog is a later slice. A
brief that is POSTed and left alone sits in `proposed_brief` indefinitely.

So you do it. Claiming gives you a 30-minute lease (the `ainarres-intake` workflow default), so
refine promptly or re-claim:

```bash
TOK=$(mint human+intaker lane:intake,role:intaker)
node bin/ainarres.mjs claim --lane intake --token "$TOK"
# refine in place: sharpen the goal, name the files, define a SUBSTRATE-FREE validate
node bin/ainarres.mjs advance <brief-id> --to briefed --token "$TOK" --note "brief refined"
```

`briefed → accepted` is the designer accepting a ready brief, so it needs `role:designer`
(and `lane:intake` to claim it):

```bash
TOK=$(mint claude-code+opus lane:intake,role:designer)
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
TOK=$(mint claude-code+opus lane:dev,role:designer)
node bin/ainarres.mjs create --lane dev --payload '{...}' --token "$TOK"
```

Do not assume the standing service will decompose a vague `proposed` dev task for you: its
design pass spawns the `designer` tier with **no brief**, which is not the same path as a
one-shot decomposition run. Give the service work that is already task-shaped, or run the
one-shot pass.

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
