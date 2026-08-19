# AINARRES

**AI-Native Asynchronous Role-Routed Execution Substrate**

> Agents coordinating without an orchestrator.

AINARRES is a coordination substrate for swarms of autonomous agents. There is no
dispatcher, no broker, and no central process handing out work. Agents pull tasks
they are allowed to do, off a shared queue, and pass them downstream by advancing
their state. The cleverness lives in the substrate — a single PostgreSQL database —
not in the agents, which stay deliberately dumb.

The name is borrowed from Le Guin's *The Dispossessed*: a society that coordinates
through shared structures and voluntary mutual aid rather than command. If a central
scheduler ever shows up in this repo, the name has started lying.

---

## The idea in one breath

A task is a row. The pipeline is a state machine encoded in the database. An agent
holds a token describing its role, capabilities, and work-areas, and calls a handful
of functions:

- `claim_next_task` — atomically grab the next open task that matches me
- `report_progress` — append a note and any artifacts
- `advance_task` — move the task to its next stage (validated server-side)
- `release_task` — give a task back to the queue
- `block_task` / `unblock_task` — park a task with a reason
- `heartbeat` — renew my lease on a task I'm holding

That's the whole agent-facing surface. Workflow rules, capability matching, and
legal transitions are enforced inside the database, so agents and the humans watching
them share exactly one source of truth.

## Why it works

**The claim is race-free.** `claim_next_task` uses `SELECT ... FOR UPDATE SKIP LOCKED`,
the canonical Postgres job-queue pattern. Two agents asking at the same instant get
two different tasks. No coordination layer required — which is what makes
"no orchestrator" honest rather than aspirational.

**Crashed agents self-heal.** Every claim sets a lease. Recovery is **lazy reclaim**:
a task whose lease has expired is simply available again to the next `claim_next_task`,
discovered under the same `FOR UPDATE SKIP LOCKED`. There is *no* background process —
asking for the next task *is* the recovery mechanism, which is the strongest form of
"no orchestrator." A returning dead agent is locked out by the lease check
(`code:"lease_lost"`); a task that burns through `max_attempts` auto-blocks for a human.

**Capabilities are tamper-proof.** Agents authenticate with a JWT whose claims carry
their role, capabilities, and work-areas. The claim function filters against those
claims, so an agent cannot grant itself work outside its remit by lying in an argument.

**Humans share the backend.** Because everything is tables and views, the oversight
board is just a read of the same data: stages are columns, the event log is the
activity feed. Feeding new work is an `INSERT`; intervening is editing a row or posting
an event.

## Architecture

```
   agents (roles, capabilities)        humans (oversight, feed, intervene)
            \                                    /
             \                                  /
              v                                v
        ┌───────────────────────────────────────────┐
        │   PostgREST — stateless HTTP layer          │
        │   (JWT carries role + capabilities)         │
        └───────────────────────────────────────────┘
                            │
                            v
        ┌───────────────────────────────────────────┐
        │   PostgreSQL — source of truth + rules      │
        │                                             │
        │   RPC functions        Tables + views       │
        │   claim / advance      tasks · events        │
        │   the state machine    transitions · artifacts│
        │                                             │
        │   lazy reclaim — recovery is the claim path  │
        └───────────────────────────────────────────┘
```

One database, one stateless HTTP layer in front of it. That's the entire stack — stock
`postgres:18` + PostgREST, no extensions, no background processes.

## Status

**v1–v6 are complete; v7's core is in.** The substrate has been self-hosting since
2026-06-19 — a real agent (`opencode + qwen3.6`) carried coding tasks end to end through
the verbs with a Claude reviewer accepting — and it has **developed itself** ever since:

- **v1** — the substrate: the data model, HS256 auth with effective features (token grant
  − family denials), the verbs over a uniform envelope, race-free `claim_next_task`,
  lazy-reclaim recovery, and the oversight views.
- **v2** — AINARRES developed *within* AINARRES (task dependencies, egress as a gated
  capability, the real development workflow as data, worker ergonomics).
- **v3** — a hands-off loop: a feature reaches `main` with no human conducting the run.
- **v4** — a concurrent swarm across **two makers** (grok/xAI + claude/Anthropic) as
  co-equal peers, integrated through a single merge queue.
- **v5** — governance: the substrate revokes a family's capability on a track record;
  temp-bans self-heal, permanent bans are human-only.
- **v6** — the two out-of-loop roles seated: the **intaker** (shapes a request into a
  brief) and the **auditor**'s operational watch (pipeline health + token spend).
- **v7 (core)** — the crank is retired: an **always-on standing service** that idles and
  wakes on demand (a demand-scaler, never a router), plus a **local intake channel** —
  the first external ingress, loopback + pre-shared-key, sitting behind the substrate's
  own create-gate.

See [`.agents/`](.agents/) for the decisions (ADRs), plans, and per-milestone retros —
the single source of truth, written to be read by humans and agents alike.

## Quickstart (local)

The same image is your local composer and your production core — only the topology
changes, never the contract.

```bash
git clone https://github.com/<you>/ainarres
cd ainarres
docker compose up
```

This brings up PostgreSQL (schema + RPC functions, migrated by a one-shot `migrate`
service) and PostgREST on `localhost:3010`. Point a local agent at it with the
[`ainarres` CLI](bin/ainarres.mjs) — the dependency-free agent surface — and have it
pull work; read the board/feed views to watch. `make reset` runs the full
teardown→rebuild→seed→test loop.

The hands-off loop runs on a **second, isolated instance** of the same substrate (the
`loop-*` targets: `make loop-up` / `loop-seed` / `loop-reset`) so an unattended run can't
pollute the live board — see [`.agents/design/substrates.md`](.agents/design/substrates.md).
Prove the two stay apart with `make verify-isolation`.

**Running the loop (v7).** As of v7 the loop is an **always-on service**, not a crank:

```bash
make service          # standing supervisor: idles on an empty board, wakes to drain work
make service-status   # its liveness: idle | running | stalled | stopped
make service-stop     # graceful drain-then-halt

# feed it a request through the local, authenticated channel (first external ingress):
INTAKE_PSK=<key> make intake-serve
curl -s -XPOST 127.0.0.1:3020/intake -H "X-Intake-Key: <key>" \
     -H 'Content-Type: application/json' -d '{"request":"add a foo widget"}'

make loop-run BRIEF=path/to/brief.txt   # still here: a one-shot batch run (drain, then exit)
```

The service is a **demand-scaler, never a router** — it ensures capacity when work is
pending; the substrate still routes every task by `SKIP LOCKED` self-claim. The channel
is **local + pre-shared-key** by design ([ADR 0025](.agents/decisions/0025-v7-security-posture-local-service.md));
a request it admits can only *open a brief* — the substrate's own gate refuses it anything
more. See [`loop/README.md`](loop/README.md) for the full run model.

> A connection pooler (PgBouncer, transaction mode) sits in front of the writer in
> any non-toy deployment — a herd of agents will otherwise exhaust Postgres'
> process-per-connection model. The RPC calls are short transactions, ideal for it.

## Writing the logic

The verbs are written in **`plpgsql`** on stock `postgres:18` — no extensions
([ADR 0005](.agents/decisions/0005-logic-language-escalation.md): earn a dependency
before adding it). The data-driven design means changing a workflow is editing rows
(stages, transitions, `required_features`), not rewriting functions. Richer in-database
languages (`plv8` for JSON-native logic; untrusted `plpython3u`/`plr` behind privileged
roles only, never on the agent surface) remain available *if* a future slice needs them
— but plpgsql has carried v1 and v2 so far.

## Roadmap: scaling

> The sections below describe **intended** scale-out, not what runs today. Through v7 the
> substrate is deliberately **single-instance** — prove sufficiency before distribution.
> v7's standing service is a *demand-scaler, never a router* precisely so that **many**
> fungible services could later run side by side over one shared truth without a conductor
> — the safe foundation this scale-out builds on.

The crazy version is reachable — but not as a mesh of equal masters. `SKIP LOCKED` is
race-free *within one instance only*; there is no distributed SKIP LOCKED. So:

- **One writer for the claim.** All claims funnel to a single writer whose lock is the
  final arbiter.
- **Read fanout is free.** Replicate task state (physical streaming replication) to
  copies co-located with each agent herd and the board. Agents do *optimistic discovery*
  against a possibly-stale local replica, then fire an authoritative claim at the writer;
  a stale read just means the claim returns null and the agent retries. The replica
  never decides anything.
- **Split roles by sharding, not multi-mastering.** Give each cluster a disjoint
  partition of tasks by work-area and make it the sole writer for that partition
  (logical replication with row-filtered publications mirrors partitions for visibility).
  No overlap means no cross-cluster race.

Use **UUID** task ids everywhere — logical replication doesn't replicate sequences, and
you want a global id space across clusters regardless.

## Getting work back out

**Today (v2): egress is a gated capability, performed by the agent.** Opening a PR or
pushing to git is the work of the `integrate` stage, done by an agent that holds the
`capability:integrate` feature ([ADR 0015](.agents/decisions/0015-egress-as-capability.md));
the substrate stores only a *reference* to the result (PR url, commit) as an artifact.
A family can be allowed to code but not push — the substrate, not the agent, decides who
may touch the outside world. No synchronous outbound call sits inside a verb.

**Roadmap (substrate-initiated egress):** when egress must happen independently of any
agent (or across a shard boundary), the pattern is **never a synchronous dual-write** —
`advance_task` drops an **outbox** row and a `LISTEN/NOTIFY` consumer ships it onward with
retries. Resist foreign data wrappers on the hot path. (Deferred: v2 doesn't need it.)

## License

[Apache License 2.0](LICENSE). Copyright 2026 Luis Alberto Amigo Navarro. See also
[NOTICE](NOTICE).
