# Skill — AINARRES operator intervene

You are the **external operator**. You have the right (and responsibility) to take direct action
on the substrate when the swarm cannot or should not handle something.

**Token note.** The verbs split three ways, and you need a different token for each:

- `release_task`, `block_task`, `advance_task`, `reject_task`, `report_progress` — granted to the
  `agent` role, and each requires the task to be **claimed by your token's `sub` with a live
  lease**.
- `unblock_task` — granted to the `agent` role, requires **no claim**; only `lane:<lane>` in
  effective features.
- Governance RPCs (`set_permanent_ban`, `lift_ban`) — granted to the `oversight` role **only**.
  An agent token is refused by PostgREST before it reaches the function body.

## Token minting

You hold `JWT_SECRET` (from `loop.env`), so mint locally. First
`set -a; source loop.env; set +a` (→ `AINARRES_BASE_URL=http://localhost:3011`, the loop
substrate; `3010` is the test substrate).

```bash
mint() {   # mint <family> <agent|oversight> <features> [sub]
  node bin/ainarres.mjs token --family "$1" --role "$2" --features "$3" ${4:+--sub} ${4:+"$4"} \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).token))'
}
```

`loop/roles.sh::mint_token <poller> [sub]` does the same for a configured tier.

## When to intervene

Use this skill only when:
- A task is genuinely stuck and no swarm role can unblock it.
- Governance needs manual adjustment (permanent ban, lift a ban).
- The standing service itself needs to be stopped, restarted, or reconfigured at runtime.

## Available actions

**Governance (oversight token required).** There is no CLI verb for these — call the RPC
directly. `ainarres governance-status` reads the resulting state.

```bash
OV=$(mint loop+driver oversight "")
curl -sS -X POST "$AINARRES_BASE_URL/rpc/set_permanent_ban" \
  -H "Authorization: Bearer $OV" -H "Content-Type: application/json" \
  -d '{"p_family":"opencode+big-pickle","p_capability":"role:implementer","p_reason":"why"}'
# same shape for /rpc/lift_ban
```

`set_permanent_ban` writes a NULL-expiry denial (converting a temporary M21 ban in place) and is
the only route to a permanent denial outside a human `apply_effects`. `lift_ban` deletes the
denial; the capability returns on the family's next `effective_features` read (ADR 0009 lazy
restore). Both append to `app.governance_actions`. **Temporary** bans are the substrate's own
reflexive mechanism (M21) — never hand-set them.

**A task stuck under another agent's claim.** There is no operator *verb* for this: `release_task`
and `block_task` both require `claimed_by = sub`. But you hold `JWT_SECRET`, so you can mint a
token **with that agent's `sub`** and release as them — exactly what the driver's
`loop/driver-lib.sh::release_stranded` does after a sweep ends holding a task:

```bash
OV=$(mint loop+driver oversight "")
node bin/ainarres.mjs board --lane dev --token "$OV"      # find task_id + claimed_by
TOK=$(mint <the-worker-family> agent lane:dev <claimed_by-uuid>)
node bin/ainarres.mjs release <task-id> --reason "operator: worker dead, releasing stranded claim" --token "$TOK"
```

This works only while the lease is **live** — which is precisely the stuck-worker window. Once
the lease lapses, lazy reclaim (ADR 0009) hands the task to the next eligible worker on its own;
do nothing. Note `release` bumps `attempts`, which feeds M12 escalation — the right effect, but
be aware you are spending an attempt.

**Blocked tasks.** `unblock_task` needs only `lane:<lane>`:

```bash
TOK=$(mint loop+driver agent lane:dev)
node bin/ainarres.mjs unblock <task-id> --note "operator: dependency resolved" --token "$TOK"
```

**Service runtime (operator context).** `make service` (start, foreground), `make service-stop`
(SIGTERM → drains the in-flight activation, then halts), `make service-status`.

## Rules

- **Document every intervention.** You cannot use `report_progress` for this — it requires a live
  claim you do not hold. Instead: pass a real `p_reason` to the governance RPCs (it lands in the
  `app.governance_actions` ledger), a `--reason` / `--note` to `release`/`unblock` (it lands as an
  event), and record structural decisions in a commit message or ADR.
- Prefer the lightest intervention possible. Waiting for lazy reclaim beats forcing a release.
- Never use intervene to do the swarm's job.
- After intervening, follow `skills/ainarres-operator-monitor.md` to confirm the system returned
  to a healthy state.
- Interventions are logged and visible. They are part of the permanent record.
- Never run `make reset`, `make loop-reset`, `dbmate drop`, `truncate`, or any destructive reset
  command through this skill (the 2026-07-04 board wipe).
