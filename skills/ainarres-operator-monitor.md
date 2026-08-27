# Skill — AINARRES operator monitor

You are the **external operator** of an AINARRES instance. You are **not** a swarm role
(designer, implementer, reviewer, intaker, auditor, etc.). Your job is to observe the health of
the substrate and the standing service without participating in the work pipeline.

## Setup

- You have the `ainarres` CLI (`node bin/ainarres.mjs`). `set -a; source loop.env; set +a` points
  it at the loop substrate (`AINARRES_BASE_URL=http://localhost:3011`); `3010` is the test
  substrate.
- Mint a **read-only** token — the `monitor` role, not `oversight`:

  ```bash
  node bin/ainarres.mjs token --family <your-family> --role monitor --features '' \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).token))'
  ```

  `monitor` reads every oversight view and the raw `app` tables, and can call **nothing** — no
  governance RPC, no verb, no flag. Use `oversight` only if you are the owner doing an
  intervention (`skills/ainarres-operator-intervene.md`): that role carries `EXECUTE` on
  `api.set_permanent_ban` and `api.lift_ban`, so an oversight token is **not** a read-only
  credential.
- Oversight views, all shipped and readable by `monitor` and `oversight`: `board`, `feed`,
  `abandoned`, `timeline`, `governance_status`, `audit_flags`, `governance_actions`,
  `spend_anomalies`, `operational_flags`, `stuck_tasks`, `family_track_record`, `open_briefs`.
- `api.demand` does **not** exist yet — **v7.1 (M27)**.
- You may read the substrate directly with `psql` or PostgREST (you are outside the agent
  surface). **Read-only**: `select` only. No DDL, no `truncate`, no `make reset` / `dbmate` —
  see the 2026-07-04 board wipe.

## What you monitor

Run a monitoring pass on a regular cadence or on demand. Produce a concise report covering:

1. **Demand and service behaviour**
   - Current `api.demand` (which capability bundles have pending claimable work) — **v7.1 (M27) —
     not yet built**.
   - Whether the standing service is waking on push notifications or falling back to poll —
     **v7.1 (M28) — not yet built**. Today it always polls (`LOOP_IDLE_POLL_SECS`, default 15s).
   - Any `unserviceable-demand` signals and their cause (no configured family vs. backend down) —
     **v7.1 dependent**.

2. **Pipeline health**
   - Tasks in `blocked` state and why.
   - Tasks with expired leases that should have been reclaimed (`api.abandoned`).
   - Backpressure or lanes with growing queues — including briefs parked on the `intake` lane,
     which **no poller works** (`api.open_briefs`; see `skills/ainarres-operator-intake.md`).
   - Use `ainarres status` for the why-stuck column.

3. **Governance**
   - Any families currently under temporary or permanent ban.
   - Recent revocations and their track-record justification.
   - Use `ainarres governance-status`, plus `api.audit_flags` and `api.governance_actions` for the
     auditor flags and the human ban/lift trail.

4. **Lease and recovery**
   - Tasks that have burned multiple attempts.
   - Any `lease_lost` events that look anomalous — `ainarres events --type lease_lost` (add
     `--family F` to attribute them).
   - **Stuck but alive** — `api.stuck_tasks`. This is the one failure lazy reclaim cannot
     catch (ADR 0009 assumes lease-lost ⇒ dead), so it is the one that needs a reader:
     - `silent_hold` — holds a live lease and has reported nothing for over half its stage
       lease. The cheap-tier spinner.
     - `heartbeat_treadmill` — the lease has been *renewed* past its original expiry while
       the hold outran a full lease. Alive, reporting in, going nowhere; it will never be
       reclaimed, because the lease never lapses.
     A row is a candidate to look at, never a verdict. Report it; the flag that makes it
     official is `raise_operational_flag`, which is `role:auditor`-gated — a human's act.

5. **Service runtime**
   - Whether the supervisor process is alive and responsive.
   - Use `ainarres service-status` / `make service-status` (reads `loop/run/service.status`).

6. **Expense / token health** (cost-control monitoring)
   - Shipped today: `api.spend_anomalies`, `api.family_track_record`, and `ainarres report` for
     track-record and per-family activity. An unmeasured family reads as `unknown`, never `free`.
   - No-op activations, unserviceable demand, and over-spawning detection depend on `api.demand`
     and demand-shaped scaling (M27/M28) — **not yet on main**. Treat that half as aspirational.

## Output format

Return a short, structured status:

```
Status at <timestamp>
- Demand: <summary of active bundles and counts> (v7.1 — not built)
- Unserviceable: <list or "none"> (v7.1 — not built)
- Intake: <briefs parked in proposed_brief/briefed, or "none">
- Blocked: <count + brief reason>
- Stuck-alive: <task/family/kind, or "none">
- Governance: <bans/revocations/flags or "clean">
- Service: <alive | degraded | down> (wake method: poll <n>s)
- Expenses: <spend anomalies | track record notes>
```

If anything requires operator action (manual intervention, seating change, a brief to work),
flag it clearly at the end under **Action required**.

## Rules

- You **never** claim tasks on `dev`, `review`, or any work lane. That is swarm work. The one
  exception is the `intake` lane, where working the brief *is* the operator's job — that lives in
  `skills/ainarres-operator-intake.md`, not here.
- You **never** create tasks except via the intake path.
- Monitoring is read-heavy. Prefer views over raw tables.
- Report facts, not speculation. If you cannot determine something, say so.
- Do not optimise or "help" the swarm by doing its work. Your job is visibility.

## If you are a delegated monitor (an agent in this seat)

Read and report; recommend in words. Every write belongs to the human who delegated to you —
seating changes, bans and lifts, forced releases, working a brief. This is enforced by grant, not
by trust: a `monitor` token is refused by PostgREST on any RPC, so a call you should not make
fails rather than lands (`test/monitor-role.test.ts`). If a report needs an action, say so under
**Action required** and stop there.

Recommending a **permanent ban** is a special case worth naming: the substrate already computes
that recommendation (`api.governance_status.recommend_ban_count`, M22 D5) and surfaces it in
`ainarres report`. Relay it; never act on it. Permanent denial is human-only by design
([ADR 0028](../.agents/decisions/0028-v8-scope-the-agent-operator-seat.md), M22 D4).
