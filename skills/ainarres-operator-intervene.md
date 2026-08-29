# Skill — AINARRES operator intervene

You are the **external operator**. You have the right (and responsibility) to take direct action
on the substrate when the swarm cannot or should not handle something.

**Act under your own name.** The operator seat is a registered family, `agent+operator` (v8 /
ADR 0028). Use it for anything you do *as the operator*. It holds no `capability:integrate` and
no `role:auditor` — you can never merge, and you are not the auditor. Two exceptions below
genuinely require another family's identity (releasing another agent's stranded claim needs
that agent's `sub`; the driver's own lane acts are the driver's) — those are impersonation with
a reason, and the reason belongs in your ledger.

**Token note.** The verbs split three ways, and you need a different token for each:

- `release_task`, `block_task`, `advance_task`, `reject_task`, `report_progress` — granted to the
  `agent` role, and each requires the task to be **claimed by your token's `sub` with a live
  lease**.
- `unblock_task` — granted to the `agent` role, requires **no claim**; only `lane:<lane>` in
  effective features.
- Governance RPCs (`set_permanent_ban`, `lift_ban`) — granted to the `oversight` role **only**.
  An agent token is refused by PostgREST before it reaches the function body.

## Getting a token

**Prefer the envelope (v8 step 3).** Start the broker once (`make broker-serve`) and ask it:

```bash
TOK=$(ainarres seat-token --reason "unblocking task X")     # role agent
OVR=$(ainarres seat-token --role monitor --reason "reading the board")
```

The **database** decides what is in that credential — the seat family's provisioned features,
`agent` or `monitor` only, capped TTL — and every issuance is recorded. You do not get to ask
for `oversight`, `capability:integrate`, or another family's identity; the envelope refuses,
out loud.

Two interventions below still need a token the envelope will not issue (another agent's `sub`;
an `oversight` token for the governance RPCs). Those are the OWNER's acts, minted by hand with
the key. When you do that, **say so in your ledger** — they will otherwise surface in
`api.unbrokered_operator_acts` as an operator act nobody issued a credential for, which is
exactly what that view is for.

## Token minting (the fallback, and the owner's own path)

**"You" in this section is the OWNER, not the seat.** Minting needs `JWT_SECRET` (from
`loop.env`), and the seat is deliberately not near it — that is the whole point of the envelope
above. If you are the seat and `ainarres seat-token` gives you nothing, the answer is *ask the
owner to start the broker*, not *find the key*. The CLI will tell you which half is missing.

For the owner: `set -a; source loop.env; set +a` (→ `AINARRES_BASE_URL=http://localhost:3011`,
the loop substrate; `3010` is the test substrate), then:

```bash
mint() {   # mint <family> <agent|oversight> <features> [sub]
  node bin/ainarres.mjs token --family "$1" --role "$2" --features "$3" ${4:+--sub} ${4:+"$4"} \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).token))'
}
```

`loop/roles.sh::mint_token <poller> [sub]` does the same for a configured tier. Your own seat
token: `mint agent+operator agent lane:intake,role:intaker,lane:dev,role:designer,role:operator`.

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
and `block_task` both require `claimed_by = sub`. The owner holds `JWT_SECRET`, so they can mint a
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
TOK=$(ainarres seat-token --reason "unblock: dependency resolved")   # the seat's own path
node bin/ainarres.mjs unblock <task-id> --note "operator: dependency resolved" --token "$TOK"
```

**Service runtime (operator context).** Know which of these you can actually drive.

| | Command | The seat? |
| --- | --- | --- |
| status | `ainarres service-status` | **yes** — reads `loop/run/service.status`, touches nothing |
| stop | SIGTERM to the pid in that status file | **yes** — drains the in-flight activation, then halts |
| start | `make service` | **no — ask the owner** |

```bash
ainarres service-status                       # state, pid, last activation
# stop: the pid comes from the status file; this is exactly what `make service-stop` does
pid=$(ainarres service-status --json | node -e 'let b="";process.stdin.on("data",d=>b+=d).on("end",()=>process.stdout.write(String(JSON.parse(b).pid||"")))')
[ -n "$pid" ] && kill -TERM "$pid" && ainarres operator-log --action service_stop --target "the standing service"
```

**Why start is the owner's.** `make service` runs **in the foreground** — a seat that starts it
that way blocks until the service dies, and then the service dies with the seat. There is no
non-`make` start path yet (ADR 0028 lists one as in scope, unbuilt). Starting it the other
obvious way — `bash loop/service.sh` — first sources `loop.env`, which holds `JWT_SECRET`; the
seat is not supposed to be near that. So: **ask the owner to start the service**, and log the ask
(`--action service_start_requested --outcome refused`) so the gap shows up in the ledger rather
than only in your reasoning.

Note also that `make` is deny-listed on a *loop harness*'s `PATH` (`loop/guard-bin/`, the
2026-07-04 board wipe). You may not be running behind that guard — which makes the destructive
targets your responsibility, not the shim's. See the last rule below.

## Rules

- **Document every intervention** — and now there is a place for it. Pass a real `p_reason` to
  the governance RPCs (it lands in the `app.governance_actions` ledger), a `--reason` / `--note`
  to `release`/`unblock` (it lands as an event), and log the act itself:

  ```bash
  ainarres operator-log --action release_stranded --task <id>     --reason "worker dead, lease still live" --detail '{"as_family":"opencode+big-pickle"}'
  ainarres operator-log --action service_stop --target "the standing service"
  ```

  This matters most for the two impersonations above: when you act as another family, the
  substrate's event will name *them*, so the only record that it was really you is the ledger
  line you write. Name the family you borrowed in `--detail`. Log the misses too — an
  intervention that was refused or made things worse goes in with `--outcome refused|failed`.
  You cannot use `report_progress` for any of this; it requires a live claim you do not hold.
  Structural decisions still belong in a commit message or an ADR.
- Prefer the lightest intervention possible. Waiting for lazy reclaim beats forcing a release.
- Never use intervene to do the swarm's job.
- After intervening, follow `skills/ainarres-operator-monitor.md` to confirm the system returned
  to a healthy state.
- Interventions are logged and visible. They are part of the permanent record.
- Never run `make reset`, `make loop-reset`, `dbmate drop`, `truncate`, or any destructive reset
  command through this skill (the 2026-07-04 board wipe).
