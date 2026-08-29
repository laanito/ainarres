# skills/ — who reads what

Nine skills, two audiences. **Pick by which side of the substrate you are on**: a *worker*
claims tasks and moves them through a lane; an *operator* runs the machine the workers work in
and never claims delivery work.

Every skill assumes only the `ainarres` CLI (`bin/ainarres.mjs`). None of them needs a database
client, and none of them should be given one.

## If you are the operator seat (`agent+operator`)

Read these four, in this order the first time. They are one job split by *what you are doing*,
not by rank — you will move between them within a single session.

| Skill | Read it when |
| --- | --- |
| [`ainarres-operator-monitor.md`](ainarres-operator-monitor.md) | **Start here, every time.** What the board, the governance surface and the standing service are doing right now. Read-only — no verb in it changes anything. |
| [`ainarres-operator-intake.md`](ainarres-operator-intake.md) | New work has to enter: a request from a human, or something you concluded from monitoring. Covers the intake channel, `refine`, and how to size a brief. |
| [`ainarres-operator-intervene.md`](ainarres-operator-intervene.md) | Something is stuck, stranded, or mis-seated and the swarm cannot fix it. The direct-action verbs, the impersonation rules, and the ledger obligation that comes with them. |
| [`ainarres-operator-config.md`](ainarres-operator-config.md) | The *mix* is wrong — a family should be seated, unseated, retuned, or the service's knobs adjusted. Structural changes; slower and higher-impact than intervene. |

### Before you touch anything

- **You are an identity, not a key.** `agent+operator` holds `lane:intake`, `role:intaker`,
  `lane:dev`, `role:designer`, `role:operator` — and deliberately **not**
  `capability:integrate`, `role:auditor`, `role:implementer`, `role:reviewer`, `tier:2`.
  Asking for more is not a config change; it is an ADR (0028).
- **Get your credential from the envelope**, not by signing: `ainarres seat-token`. The broker
  holds the key and the database decides what is in the token. If no broker answers and you
  have no key, the CLI now says so out loud rather than minting something the substrate will
  reject with an unexplained 401.
- **Write down what you did.** `ainarres operator-log --action <slug> …`. Operator acts often
  have no task to hang an event on; the ledger is the only record they leave. Log the refused
  and failed ones too — those are the interesting rows.
- **Three things stay human.** Permanent ban / lift (`api.set_permanent_ban`, `api.lift_ban`),
  the qualitative audit flag (`api.raise_audit_flag`), and key custody + provisioning. The
  substrate will refuse you on the first two at the grant boundary; that refusal is correct and
  is not something to route around. Ask the owner.
- **What the owner has already started**, and you cannot: the substrate (`make up`), the
  standing service (`make service` — foreground), the credential broker (`make broker-serve`),
  the intake channel (`make intake-serve`). You can read the service's state and stop it; you
  cannot start it. See intervene → *Service runtime*.
- **Never** run a destructive substrate command — `make reset`, `make loop-reset`,
  `docker compose down -v`, `dbmate drop`, a raw `truncate`. The 2026-07-04 board wipe is why
  `loop/guard-bin/` exists; if you are not running behind that guard, the restraint is yours.

## If you are a worker in the swarm

Loaded by the loop's harness wrappers for whichever role the tier holds. You need only your own.

| Skill | Role |
| --- | --- |
| [`ainarres-designer.md`](ainarres-designer.md) | `role:designer` — a brief becomes small, ordered, self-contained tasks. |
| [`ainarres-implementer.md`](ainarres-implementer.md) | `role:implementer` — a task becomes code + tests on a branch. |
| [`ainarres-reviewer.md`](ainarres-reviewer.md) | `role:reviewer` — the gate at `reviewing` and again at `validating`. |
| [`ainarres-integrator.md`](ainarres-integrator.md) | `capability:integrate` — the merge queue. One family, never fanned out. |
| [`ainarres-worker.md`](ainarres-worker.md) | The minimal single-task variant, for snippet lanes. |

The rule every worker skill repeats: **everything you need is in the task.** If it is not, the
task is under-specified — reject it back rather than inventing the missing half.

## Related

- [`../loop/README.md`](../loop/README.md) — the tiers, the harness wrappers, the guard.
- [`../.agents/decisions/0028-v8-scope-the-agent-operator-seat.md`](../.agents/decisions/0028-v8-scope-the-agent-operator-seat.md) — why the operator is a seat.
- [`../.agents/decisions/0025-v7-security-posture-local-service.md`](../.agents/decisions/0025-v7-security-posture-local-service.md) — the perimeter the seat lives inside.
