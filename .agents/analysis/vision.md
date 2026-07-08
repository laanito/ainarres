# Vision — AINARRES as general-purpose work coordination

> **A guiding principle, not committed scope.** This is the long-run picture the owner
> holds; it is the *compass* every version steers by, not a backlog. We deliberately take
> **shortcuts** now and rework them later — but any decision we can make today that already
> fits this vision is future work banked. Concrete scope is only ever committed in a version
> ADR (see [`roadmap.md`](roadmap.md)); this file exists so those ADRs, and the design notes
> under them, point at a shared destination. Same altitude as the roadmap: forward framing.

## The thesis, widened

AINARRES ([`analysis.md`](analysis.md)) is "coordinate a swarm of autonomous agents on shared
work without an orchestrator." The **long-run** reading of "shared work" is deliberately broad:
AINARRES is a **general-purpose work-coordination substrate** for humans *and* agents. The same
substrate should serve **anything from running a SaaS company to managing one person's daily
laptop work** — the difference is *seed data*, not code. The self-development loop that built
v1–v5 is just the **bootstrap project**: the first tenant of a substrate meant to hold many.

Discipline this imposes on us, now: **nothing self-development-specific belongs in the core.**
Workflows, lanes, roles, and capabilities are already *data*, not schema — the `ainarres-dev`
workflow is seed, not a built-in. Keep it that way. A decision that would only make sense for
"AINARRES building AINARRES" is a smell.

## The hierarchy (kanban, and the substrate already half-models it)

The owner sees the work model as a **kanban hierarchy**:

```
(goal / initiative)      — groups a set of projects          ← NEW tier, future
  project                — app.projects  ("top container")   ← exists
    epic  (= lane)       — app.lanes  ("an initiative           ← exists; the data-model note
                             within a project")                   ALREADY calls a lane this
      task / story       — app.tasks                          ← exists
```

The middle of this is **already the shape of the substrate** — `projects → lanes → tasks`, and
[`design/data-model.md`](../design/data-model.md) literally describes a lane as *"an initiative
within a project."* So **`lane = epic`** is naming what the middle tier already is, not a
retrofit. Two real deltas remain between today and the vision:

1. **A tier above `project`** — goals / initiatives grouping projects. Genuinely new; clearly
   future. (AINARRES itself holds many projects; a portfolio above them is a later concern.)
2. **Epic *lifecycle*.** Today lanes are *permanent work-areas* (`dev`, `snippets`). A kanban
   **epic is a bounded deliverable** — created per request, populated with tasks, eventually
   "done." Moving from a few standing lanes to many bounded, **dynamically-created** epics is
   the substantive evolution the human web interface will lean on. Deferred, but it is the
   direction.

## The epic is the delivery unit (why this simplifies the bookends)

If **epic = the bounded deliverable**, the epic is the natural anchor for the two out-of-loop
bookend roles ([`roadmap.md`](roadmap.md) role chain), and it collapses three things we had
been treating as hard:

- **The auditor's unit of work is the epic.** "Did this delivery meet the request?" =
  "does this epic's task-set satisfy the story it came from?" — not per-task, not per-run.
- **M22's deferred "delivery entity" IS the epic** ([`design/auditor.md`](../design/auditor.md)
  D8 anchored flags to a single task for lack of one). It already exists as `lanes`; no new
  entity is ultimately needed.
- **The intaker's output is a populated epic** — a story in, an epic-worth of tasks out. The
  "brief" is the epic's definition / `context`; the designer's decomposition fills it.

## The three-altitude pull model (what "symmetric" really means)

The substrate's founding move — **agents pull the work they're permitted to do; nobody assigns**
(`SKIP LOCKED` self-claim, [`analysis.md`](analysis.md)) — generalizes to **three altitudes of
pull-work**, all substrate-mediated and capability-matched:

| altitude | who pulls | pulls what | produces |
|---|---|---|---|
| **story** | intakers | pending requests | a populated **epic** |
| **task** | dev agents (designer/implementer/…) | tasks within epics | advanced/merged work |
| **epic** | auditors | completed epics | an audit verdict / flags |

This is what "**symmetric bookends**" means: intake and audit are not a privileged out-of-band
human act — they are **first-class pull-work**, at the story and epic altitudes, exactly as
task-work is at the middle. A service's intaker can process **any** pending story; its auditor
can audit **any** completed epic — never limited to what that service's own roster produced.
The bookends federate the same way the middle already does.

## Idempotent, federated truth (the load-bearing invariant)

**The substrate holds the truth and marks every interaction regardless of how many actors
touch it.** In the long run AINARRES is a **federated set of databases** (implementation
deliberately unspecified) with **many services running from many places** — and the substrate
is **indifferent to how many services there are or where they run**. Services are fungible,
stateless coordinators; the substrate has no concept of "which service." For that to be safe,
two rules, which split cleanly:

- **Work-item creation is idempotent** — dedup on a natural key (one open epic per story, one
  open audit per epic, `on conflict do nothing`). Two services racing the same story/epic
  converge to one truth, never a double.
- **Judgments are append-only** — flags, verdicts, and events accumulate, each attributed. Two
  auditors flagging the same gap is *coherent* (it aggregates), not corrupting.

And the invariant that keeps "no orchestrator" honest at scale: **a service is a
demand-scaler, never a router.** It asks the substrate *"is there pending work my roster's
capabilities can satisfy?"*, launches agents from its pool to match, and drains until nothing
claimable remains. The **scramble strategy** (all-at-once / round-robin / one-per-round) is
service config, invisible to the substrate. If a service ever decides *which* task goes to
*whom*, we have regrown the orchestrator. The matching currency is **features** (capabilities /
permissions), already the substrate's agnostic vocabulary — not "lanes" specifically.

## The human is one more actor (the web interface)

Because everything is tables/views, **oversight is a read, feeding is an INSERT, intervening is
editing a row** ([`analysis.md`](analysis.md)). The future **human web interface** is a *window
onto the same kanban* — the human is not a special path but **one more actor on the one truth**,
working the same epics/tasks the agents do. This is why the hierarchy and the idempotent-truth
invariant matter *now*: the UI renders the kanban, and the human's edits must be as safe under
concurrency as any agent's.

## What this means for the near versions (bank the cheap wins)

The full picture — dynamic epics, the goal tier, the federated DBs, the web UI, the standing
service — is **not** near-term. But several near-term decisions already fit it and cost little:

- **v6 (seat the bookends, [ADR 0023](../decisions/0023-v6-scope-seat-the-bookends.md)):**
  - Treat a **delivery = an epic**. v6's cheap stand-in is a **brief-group**: the intaker's
    brief groups a task-set (M24's `payload.brief` link), and the auditor audits *that group*.
    The epic model in miniature, on the existing `dev` lane — no dynamic epics, no schema
    upheaval.
  - **Anchor audit judgments to the delivery (the brief-group), not a lone task** — the cheap
    upgrade of M22 D8 that banks the "auditor audits an epic" shape for free.
  - **Idempotent creation + append-only judgments** wherever v6 writes — the federated-truth
    rule, applied early because it's nearly free and expensive to retrofit.
  - *Shortcuts taken, on purpose:* no dynamic/bounded epics, no goal tier, no channel, no
    audit **pull-queue** yet (its value is federation, which is v7). The bookends are exercised
    **by hand** on the bootstrap project.
- **v7 (the standing service):** where the three-altitude **pull-queues** become real
  (intake and audit as claimable work, not by-hand acts), the demand-scaling supervisor arrives,
  the channel/API + web UI land, and the security-posture ADR gates external ingress. Graduates
  to its own scope ADR + `design/service.md` when committed.
- **v8+:** federating the bookends across makers; dynamic epics + the goal tier; the federated
  multi-database, multi-service topology; cost-aware routing at the (correctly-placed) router
  layer.

## Relationship to the rest of `.agents/`

This file is the **destination**; [`roadmap.md`](roadmap.md) is the **route** (versioned
candidates); the `decisions/` ADRs **commit** each leg; the `design/` notes work out the
mechanism. When something here is committed, it moves down that chain — e.g. the service and its
pull-queues become `design/service.md` under a v7 scope ADR. Nothing here is a promise; it is
the shape we don't want to accidentally build *away* from.
