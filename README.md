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

**Crashed agents self-heal.** Every claim sets a lease. A `pg_cron` job inside the
database returns expired leases to the queue, so a dead agent can't hold work forever.
The recovery mechanism runs *in* Postgres — still no external process.

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
        │   pg_cron reaper — returns expired leases    │
        └───────────────────────────────────────────┘
```

One database, one stateless HTTP layer in front of it. That's the entire stack.

## Status

Early. The schema and the core verbs exist; the transition model and the human board
are in flux. Expect breaking changes. This README describes intent as much as it
describes what runs today.

## Quickstart (local)

The same image is your local composer and your production core — only the topology
changes, never the contract.

```bash
git clone https://github.com/<you>/ainarres
cd ainarres
docker compose up
```

This brings up PostgreSQL (with the schema, RPC functions, and the `pg_cron` reaper
loaded) and PostgREST on `localhost:3000`. Point a local agent or model at it and
have it pull work; open the board to watch.

> A connection pooler (PgBouncer, transaction mode) sits in front of the writer in
> any non-toy deployment — a herd of agents will otherwise exhaust Postgres'
> process-per-connection model. The RPC calls are short transactions, ideal for it.

## Writing the logic

Workflow logic is not limited to PL/pgSQL. Anything Postgres can host is fair game:

- **Trusted / sandboxed** (`plpgsql`, `plv8`, `plperl`, `pltcl`) — safe to expose on
  the agent-facing surface. The six verbs live here. `plv8` is the recommended default:
  JSON-native (tasks, capabilities, and artifacts are all JSON-shaped) and shareable
  with JS/TS agents, so a client can dry-run the same transition check the DB enforces.
- **Untrusted** (`plpython3u`, `plperlu`, `plr`) — full OS access. Heavy scoring or
  anything that touches the filesystem lives here, invoked **only** by privileged roles
  or `pg_cron`, **never** exposed through PostgREST. Keep the dangerous power behind the
  thin trusted wrappers.

## Scaling

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

Propagating to external systems (deploys, GitHub, notifications) and crossing a
shard boundary use the same pattern: **never a synchronous dual-write.** An
`advance_task` writes locally and drops an **outbox** row; a `LISTEN/NOTIFY` consumer
ships it onward with retries. Eventual, not transactional, across every seam. Resist
foreign data wrappers on the hot path — an FDW call inside the claim transaction
couples your race-free local claim to some other system's latency.

> `NOTIFY` is node-local and does not cross replication. In the single-writer model the
> writer notifies; replicas don't. Plan the wake topology around that.

## License

[Apache License 2.0](LICENSE). Copyright 2026 Luis Alberto Amigo Navarro. See also
[NOTICE](NOTICE).
