# The customer's seat: staffing, deliverables, and a verdict

> Companion to [ADR 0029](../decisions/0029-v9-scope-the-customers-seat.md). The ADR decides *what*
> v9 is and which decision needs owner sign-off; this note settles *how*, and is the document a
> designer decomposes into slices.

## What v9 is for

v8 made the operator seat holdable by an agent. This makes the **customer** seat holdable by a
person who has better things to do than mint JWTs. Four mechanisms, one enabling change:

- capabilities are staffed at the **project** tier (the enabling change),
- **epics** become bounded deliverables that can be created, populated and finished,
- a finished epic can be **rejected**, which cancels what is unfinished and opens rework,
- the human gets a **console** for exactly the acts no agent may take for them, and an
  **instruction record** for the acts an agent takes on their word.

Plus the attribution fix that keeps slipping, which turns out to be a smaller change than either
previous attempt (D7).

## Decisions (the mechanism, settled)

### D1 — Project-scoped matching, with a transitional OR and a slice that removes it

Six sites change identically. Each already resolves the task's lane; `app.lanes.project_id` gives
the project with one join:

```sql
-- before
if not (eff @> array['lane:' || v_lane.key]) then …

-- after
if not (eff @> array['project:' || v_project.slug]) then …
```

`app.features.kind`'s check constraint gains `'project'`. The existing `'work-area'` kind stays:
it is unused in code and seed, but [data-model.md](data-model.md) documents it deliberately as part
of the trait vocabulary (its example is a transition requiring `work-area:asana`). Unused is not the
same as dead, and touching it would widen this diff for a question nobody asked.

**The rollover is the interesting part.** Every live token carries `lane:dev`. Tokens are minted per
sweep from `roles.sh`, so they roll over within one sweep — but a standing service mid-activation
holds live ones, and the brokered operator credential carries whatever `app.family_features` says at
issue time. So:

1. **Slice A** accepts **either** `project:<slug>` **or** `lane:<key>`, and seeds both.
2. **Slice B** deletes the `lane:` half, the seeds, and the OR.

Slice B is a **named slice, not a TODO**. Two accepted truths is the failure mode this project has
avoided everywhere else (`db/schema.sql`, the demand gate's two readers); leaving the OR in "for
safety" would install it deliberately.

**Not changed:** `api.claim_next_task(lane_key text default null)`. The argument stays and stays
optional — it is now a *filter* ("work this epic"), not a *gate*. What changes is that the loop
stops passing it: `LOOP_LANES` becomes `LOOP_PROJECT`, and `claim --lane dev` drops out of the three
harness wrappers that hardcode it (`claude-frontier.sh`, `cursor-implementer.sh`,
`grok-frontier.sh`) plus the two test harnesses (`mock-harness.sh`, `service-selftest.sh`) — which
must move together, or a mock run will diverge from a real one.

### D2 — An epic is a lane; its lifecycle is derived, and only the verdict is stored

`app.lanes` gains **no status column**. An epic's state is computed:

| state | how it is known |
| --- | --- |
| `open` | has at least one task not in a terminal stage and not cancelled |
| `delivered` | has ≥1 task, and every task is terminal-or-cancelled |
| `accepted` / `rejected` | a row exists in `app.epic_verdicts` (D3) |

Deriving `delivered` is deliberate: it cannot drift from the tasks it describes, and it needs no
verb to maintain. Only the verdict is irreducibly a record, because only it is a judgment.

`app.lanes.context` (already `jsonb`, already commented *"repo, rules, requisites"*) holds the
epic's definition — the request that produced it. `app.projects.context` (*"where the project's
work-truth lives"*) holds the repo pointer, which is how a second project gets its own repository
without a new mechanism.

**Two new columns, both small, both needed:**

- `app.tasks.title text` — the missing name. `check (title is null or length(title) between 1 and
  200)`. `create_task` accepts it; the designer sets it; every human-facing surface renders
  `title` and falls back to a short id. Without this the console has lineage and nothing to show.
- `app.tasks.cancelled_at timestamptz` — an **orthogonal flag, exactly like `blocked`**, not a
  stage. A "cancel from anywhere" transition cannot be expressed in a `from_stage → to_stage` table,
  and inventing one would be a bigger change than a column. Cancelled tasks are excluded from the
  claim predicate, from `api.demand`, and from the claimable view; a verb called on a cancelled task
  returns `task_cancelled`.

Cancelling does **not** force-release a live lease. A worker holding a cancelled task learns on its
next verb, and lazy reclaim ([ADR 0009](../decisions/0009-leases-reaper.md)) tidies up — the same
"never reach into a running worker" posture the whole substrate keeps.

### D3 — The verdict is an append-only record, oversight-gated, one per epic

```
app.epic_verdicts
  id            uuid pk
  lane_id       uuid not null references app.lanes(id)   -- the epic
  verdict       text not null check (verdict in ('accepted','rejected'))
  reason_code   text not null check (reason_code in
                  ('below_bar','scope_changed','requirements_missed','no_longer_meaningful','other'))
  reason        text not null            -- verbatim, never graded (auditor.md D2's posture)
  decided_by    text                     -- who, as text; there is no human user table and 0025 says one customer
  rework_lane   uuid references app.lanes(id)  -- the revert epic, when one was opened (D4)
  decided_at    timestamptz not null default now()
  unique (lane_id)
```

Append-only via the block trigger + revoked grants, the third reuse of that shape after
`governance_actions` and `operator_actions`. `unique (lane_id)` makes one epic carry one verdict —
if a rejected epic is reworked, the rework is a *different* epic with its own verdict, which keeps
"a deliverable gets one answer" true.

**The gate is the EXECUTE grant.** `api.record_verdict` is granted to `oversight` only, so an agent
token is refused by PostgREST before the function body — the same mechanism that already refuses the
seat on `set_permanent_ban`, verified 5/5 on 2026-08-29. No new enforcement idea.

**It writes nothing to governance.** No denial, no strike, no track-record row, per
[ADR 0029](../decisions/0029-v9-scope-the-customers-seat.md) D5. The aggregate surface
(`api.epic_verdicts`, and a rejection-reason rollup) is read *beside* the track record and is keyed
to the delivery, never to a family — the first signal in the project that is not
`(family, capability)`.

### D4 — Rejection cancels, then opens rework as a NEW epic

`api.record_verdict(lane, 'rejected', …)` does three things in one statement:

1. Sets `cancelled_at` on every non-terminal task in the epic.
2. Writes the verdict row.
3. **If any task in the epic reached a terminal stage** — i.e. something merged — opens a **rework
   epic**: a new lane in the same project, whose `context` carries the rejected epic's id, its
   reason, and the PR references already recorded against its tasks. The integrator has been
   attaching those as **event artifacts** since M6 (`{type: 'pr', url}`), and `formatReport`'s
   `prFor()` already walks the timeline for them. Nothing new is captured.

The rework epic starts empty at the workflow's initial stage and is **designed like any other**: the
designer decides *how* to unwind — revert, or supersede — which is a delivery judgment and belongs
with the discipline that makes delivery judgments. The customer said no; they do not specify the
git.

**Why a new epic rather than a task in the rejected one:** it keeps `unique (lane_id)` honest, keeps
`delivered` derivable (adding live tasks to a delivered epic would un-deliver it), and matches the
frame — rework is a new piece of work, not an amendment to a rejected one. Idempotent on the
rejected epic's id, so a double-submitted rejection cannot open two.

If nothing merged, step 3 is skipped: there is nothing to revert, and opening an empty rework epic
would be noise.

### D5 — The console is a decision inbox; its surface is derived from the EXECUTE grants

The console renders **at most six actions**, because those are exactly the acts no agent may take
for the customer:

| section | items | the act |
| --- | --- | --- |
| Awaiting your verdict | epics in `delivered` with no verdict row | accept / reject + reason |
| Awaiting your judgment | ban recommendations (`api.governance_status`), health + spend candidates | permanent ban / lift / audit flag / operational flag |
| Awaiting nothing — evidence | board, demand, track record, spend, ledgers, unbrokered acts | *read only* |

The inversion is the whole point: **every view we have is organised by the substrate's data model
(board, timeline, track record, governance status, demand). The console is organised by what
requires a decision**, with the same rows underneath. Anything an agent *could* do on the customer's
word — refine a brief, unblock a task, restart a service — is deliberately **not** an action here.
It is evidence, and the customer's route to it is the seat.

Each inbox item renders: **what** (titles, now that tasks have them), **why** (the evidence that
raised it, inline — never a link the customer has to chase), and **the act**.

**Build shape.** The renderer is a pure function from view rows to an inbox — no fetch, no clock,
total on empty — which is the exact shape of the five report-line slices already built hands-off.
The loopback server around it is small and assisted. Splitting there follows the standing rule and
lets the swarm build the surface the customer will judge it through.

**Perimeter.** `127.0.0.1`, PSK, the same posture as the broker and the intake channel.
[ADR 0025](../decisions/0025-v7-security-posture-local-service.md) is not revised; anything off-host
triggers its widening contract in full and is a different ADR.

### D6 — The instruction record: two columns, audited not enforced

`app.operator_actions` gains:

- `instruction text` — what the customer asked, verbatim,
- `instructed_by text` — who asked.

Mirroring `app.operator_credentials.requested_by`, which has recorded why a *token* was issued since
v8 while the action ledger never recorded why an *act* happened.

**Nothing can force an agent to record this honestly**, and pretending otherwise would be the same
mistake the credential envelope refused to make. So it takes the same posture: the CLI makes it the
default path (`operator-log --instruction …`, and `refine` carrying the request through), and the
console surfaces **operator acts with no instruction** as their own class — the sibling of
`api.unbrokered_operator_acts`. Audited, visible, not prevented.

**Scope note, to keep two records from blurring:** the *epic's* `context` holds the **request** (what
is to be built). The operator ledger's `instruction` holds an **instance-scoped instruction** (do
this thing now). D3's `requirements_missed` verdict is adjudicated against the first; the second
exists so that "the seat did X at 17:54" can be traced to a person asking for it.

### D7 — Per-transition usage: fix the writer's granularity, not the reader

Two attempts have now failed in the reader. #147 charged the first role-bearing transition instead
of the last; both are guesses about how to divide a number that arrives already merged.

**The real defect is cadence.** A harness reports usage **once, at the end of a sweep**, and a sweep
is however much of the board one agent drains — one measured sweep made eleven transitions across
two tasks and five capabilities under a single report. No reader can un-merge that.

**So report after each transition instead.** The wrappers already parse cumulative usage from their
harness output; each report sends the **delta since the last one**. Then:

- `api.record_usage`'s existing rule — anchor to the actor's most recent transition — becomes
  *correct by construction*, because at report time there is exactly one recent transition.
- The window logic added by #147 can be **deleted**, not extended. The view goes back to being
  simple.
- The empty-sweep ledger ([#143](https://github.com/laanito/ainarres/pull/143)) is untouched: a
  sweep with no transition still has no task and still lands in `app.sweep_usage`.
- Durability improves as a side effect. Today a harness that dies mid-sweep loses *all* of its
  spend; reporting incrementally keeps everything up to the last transition.

The substrate change is close to nil. The change is in the harness wrappers and the CLI call site —
which is why this is the third attempt and the first cheap one: the previous two were fixing the
reader because that is where the symptom was.

## The seat, concretely

```
  customer ──── console (127.0.0.1) ──── the six unmediatable acts
      │                                   verdict · ban · lift · audit flag
      │                                   operational flag · (key custody, out of band)
      │
      └──────── operator seat (agent) ─── everything mediatable
                    │                     refine · unblock · release · read · report
                    │
                    └── app.operator_actions{instruction, instructed_by}   ← D6

  request ──▶ epic (lane, context = the request)   ← D2
                 │
                 ├── task(title, …)  ← D2      designer fills the epic
                 ├── task(title, …)
                 │
                 ▼  all terminal-or-cancelled
             delivered ──▶ app.epic_verdicts  ← D3
                              │
                              ├── accepted → done
                              └── rejected → cancel unfinished (D2)
                                             + rework epic if anything merged (D4)
```

## Scope: one enabling change, four mechanisms, and a cadence fix

**Substrate:** the `project:` feature kind and six matching sites (D1); `tasks.title` +
`tasks.cancelled_at` (D2); `app.epic_verdicts` + `api.record_verdict` (D3/D4); epic creation and its
starter-role gate (ADR 0029 D3); `operator_actions.instruction/instructed_by` (D6); the epic and
verdict read views.

**Loop:** `LOOP_LANES` → `LOOP_PROJECT`; `claim --lane dev` removed from three wrappers and the two
test harnesses; per-transition usage reporting (D7).

**Skills:** all ten. Mostly deletion — `claim --lane dev` becomes `claim`, and "you work the dev
lane" becomes "you are staffed on a project". Two are not deletions: `operator-config`'s seating
procedure becomes staffing, and every operator skill must state that **the seat cannot record a
verdict**, as explicitly as it states it cannot permanently ban. `skills/README.md` gains the third
audience.

**Console:** the pure inbox renderer (swarm) and the loopback server (assisted).

## Slicing (build order within v9)

| # | Slice | Build | Why here |
| --- | --- | --- | --- |
| 0 | **Per-transition usage** (D7) | assisted | Independent of everything else, has slipped twice, and deletes code rather than adding it. Do it first and stop carrying it. |
| A | **Project matching, transitional OR** (D1) | assisted | The enabling change. Auth — mock-verified before live. Includes the seed/`roles.sh`/test sweep. |
| B | **Skills sweep** | swarm-eligible | Mechanical deletion across ten files; must land with A, because a merged auth change with stale skills is a broken swarm. |
| C | **Drop the `lane:` half** (D1) | assisted | The named slice that stops two truths becoming permanent. |
| D | **Epics: title, cancelled_at, dynamic creation + gate** (D2, ADR D3) | assisted | Everything downstream needs a deliverable to point at. |
| E | **The verdict: record, cancellation, rework epic** (D3, D4) | assisted | Irreversible-adjacent and oversight-gated; the core of the version. |
| F | **The instruction record** (D6) | assisted | Small; lands before the console so the console can surface acts that lack one. |
| G | **The decision inbox renderer** (D5) | **swarm, hands-off** | Pure formatter over view rows — the shape five hands-off slices have already taken. |
| H | **The loopback console** (D5) | assisted | The server around G. Last, because it displays everything above. |

Each slice is its own PR, ends green, and the version gets one blog on completion.

## Open risks (honest)

- **D1 is a wide diff on the oldest decision in the substrate.** Six sites, one constraint, ~38
  config references, 32 test files, ten skills. The mitigation is that it is *mechanical* and has a
  crisp invariant, and that slice C is scheduled rather than hoped for. The failure mode to watch is
  a test that passes because it grants both features.
- **`delivered` is derived, so an epic with zero tasks is vacuously delivered.** The view must
  require ≥1 task. Cheap to get wrong, cheap to pin.
- **The rework epic can loop.** Reject → rework → reject → rework. Nothing here prevents it, and
  nothing should: a customer entitled to reject twice is the point. But the console should show a
  rework chain's depth, because a chain of three is a signal about the *request*, not the work.
- **The instruction record is honest-agent-dependent**, exactly like unbrokered operator acts. It
  makes a gap visible, not impossible. That was the owner's explicit choice in v8 and is inherited
  here rather than re-litigated.
- **A console can grow.** Its scope is derived from the EXECUTE grants today; nothing stops a later
  slice adding a button for a mediatable act. The check is social, not structural: adding an action
  should require either widening a grant or writing down why the console is doing an agent's job.
- **Reason codes are a taxonomy invented before use.** Four codes plus `other`, from the frame
  rather than from data. Expect `other` to dominate at first and expect to learn a fifth code from
  reading the free text — which is why `reason` is `not null` and verbatim.
