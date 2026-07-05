# The auditor: did we build the right thing? — and the line a rule shouldn't cross

> Design note for **M22** — the human boundary that completes v5 ([v5-plan](../plans/v5-plan.md) ·
> [ADR 0022](../decisions/0022-v5-scope-governance.md)). Settles M22's open questions before
> code. Builds on the token-grant − DB-veto model
> ([ADR 0007](../decisions/0007-auth-identity-family-grant-deny.md): `feature_denials`,
> `app.apply_effects`, `effective = token features − denials`), M21's reflexive core
> ([`reflexive-revocation.md`](reflexive-revocation.md): `governance_strikes`, expiring
> denials, `api.governance_status`), M20's attributable record
> ([`track-record.md`](track-record.md), producing-family attribution), and the append-only
> event log the whole substrate is spined on.

## What M22 is for

M21 taught the substrate to say no **mechanically** — a family whose work crosses a reject
threshold at a capability loses it, temporarily and automatically. M22 completes the
envelope with the failures a **rule must not decide alone**:

- **Qualitative failure** — "the delivery does not meet the request or the design," or an
  agent *did something no rule anticipated* (the [board-wipe incident](loop-harness-command-guard)
  — grok's rampage bounced no reviewer, crossed no counter, yet was plainly wrong). No
  reject fires. A **human**, reading the board, catches it. M22 names the role that carries
  that judgment — the **auditor** — and records its verdict as substrate signal.
- **Permanent revocation** — the one capability change the substrate **never** applies on its
  own. M21 writes only *temporary* denials; a permanent ban is a human act, through an
  audited RPC, recommended by signal but never self-applied.

M22 adds **no new revocation mechanism** (ADR 0022: v5 is signal + policy + envelope). The
temporary ban is M21; the permanent ban is `apply_effects` with a NULL expiry, which already
exists. M22 adds a **role** (`role:auditor`), a **flag verb** that emits a qualitative signal
and *nothing else*, an **oversight RPC** for the human's permanent decision, and the
**read-only surface** that routes a human's attention to what needs it.

## The two paths, kept apart (the crux)

| | reviewer **reject** (M21) | auditor **flag** (M22) |
|---|---|---|
| judges | the **implementer**, per task | the **designer / integrator**, whole delivery |
| scope | one task's diff, in-flight | the delivery vs. the original **request + design** |
| when | inside the workflow (`reviewing → implementing`) | **out of band**, over shipped/merged work |
| attributable? | objectively (a bounce) | qualitatively (a judgment call) |
| consequence | a **strike** → automatic temp ban | an **escalation event** → **no denial**, raised to a human |

A bad *design* does not bounce — it is faithfully implemented, then fails the request later.
A bad *integration* can be green yet off-ask. A destructive *behavior* trips no per-task
check. Only a delivery-vs-request-and-design audit surfaces those — which is exactly why the
designer and integrator sit on the **hard** path, and why that path ends at a person, not a
counter.

## Decisions (the open questions, settled)

**D1 — Placement: the auditor is an OUT-OF-BAND oversight audit, NOT a gating workflow
stage.** The open question was `validating → audited → done` (a new required stage) vs. an
out-of-band audit of shipped work. **Out-of-band wins**, for three reasons that reinforce
each other:
- **Scope.** The auditor judges the *whole delivery against the original request*. A delivery
  is a **brief → one or more tasks**; the dev workflow is **per-task**. A per-task `audited`
  stage structurally cannot see whole-delivery/request scope.
- **The north star.** A gating stage puts a **standing human on the critical path of every
  task** — precisely what v5 removes for the mechanical case (ADR 0022). The auditor is the
  *non-mechanical* case; making it a toll would re-freeze the hands-off loop the season
  proved.
- **The evidence.** The [board-wipe incident](loop-harness-command-guard) is the live model:
  the human read the board **after** the run and caught what no in-line check could. Audit is
  the **backstop, not the tollbooth**. The reviewer gates per task, in-workflow; the auditor
  annotates delivered work, off the critical path. The loop still ships hands-off.

**D2 — The flag is a verb that emits an EVENT and writes NO denial.** `api.raise_audit_flag`
(SECURITY DEFINER, gated on `role:auditor`) stamps a `type='audit_flag'` event — actor = the
auditor, `task_id` = the shipped task that embodies the gap (D8), `data = {subject_family,
capability, gap, severity, request_ref?, design_ref?}` — attributed to the flagged
**designer / integrator** family + capability (M20's producing-family derivation). It writes
**no `feature_denials`**: the qualitative path *never* auto-penalizes (ADR 0022 envelope).
The flag is a recorded judgment, surfaced at once; the consequence, if any, is a human's.

**D3 — Flag vs. reject is a clean line (see the table above).** A **reject** is per-task,
mechanical, in-workflow, objectively attributable → feeds M21 strikes → automatic temp ban,
and judges the **implementer**. A **flag** is out-of-band, qualitative, whole-delivery, writes
no denial, is raised to a human, and judges the **designer / integrator**. They are different
actors, scopes, and consequences by design; a flag is never "a reject a rule missed" — it is
the class of failure a per-task rule *cannot* express.

**D4 — Permanent ban / lift is an OVERSIGHT-only RPC, the ONLY route to a permanent denial,
and audited.** `api.set_permanent_ban(p_family, p_capability, p_reason)` writes a
family-scoped `feature_denials` row with **`expires_at = NULL`** (permanent — reusing the
`apply_effects` revoke shape at family granularity, ADR 0007), and `api.lift_ban(p_family,
p_capability)` removes any denial for that pair (it can lift a *temporary* M21 ban too — the
human's override). Both are **`oversight`-role only** — not `role:auditor`, not an agent
token — and each stamps a `type='governance_action'` event (`data = {action, family,
capability, reason}`) so every human capability change is on the same append-only trail as
the machine's. This is the human end of the envelope: the substrate auto-applies only
*temporary* bans (M21); **permanence is human-only** (ADR 0022).

**D5 — The permanent-ban RECOMMENDATION is a computed read-only signal, never self-applied.**
Two inputs, both already recorded: (a) **recurring reflexive bans** —
`governance_strikes.ban_count ≥ recommend_after`; (b) **repeated auditor flags** — count of
`audit_flag` events against a `(family, capability) ≥ flag_recommend_after`. Surfaced in the
oversight view + report as **"RECOMMEND PERMANENT — human review"**, naming which input
tripped it. Thresholds are **policy data** (an added column on `app.governance_policy`, the
D5-of-M21 pattern — tunable without a migration), not constants. A recommendation only routes
attention; **only the D4 RPC mutates** capability.

**D6 — The auditor is human-held now, a PLAIN role, federatable later; its separation from
`oversight` is load-bearing.** `role:auditor` is a feature like any other (`kind='role',
key='auditor'`), held by a human this version. It gates **only the flag** — the qualitative
*judgment*, which is the part federatable later to a frontier family (the M19 move applied to
audit, v6). It does **not** grant the permanent-ban RPC: that stays `oversight` (the owner).
The split is deliberate — federating the auditor later must **never** hand an agent the
permanent-ban trigger. Judgment (flaggable, eventually automatable) is cleanly separated from
the irreversible capability mutation (human-only). This mirrors M21's D8 "governance only
removes": here the auditor only **signals**; only `oversight` **acts** on permanence.

**D7 — Everything is append-only; no new mutable capability state beyond M21's.** Flags are
**events** (task-anchored — D8, so they fit `events.task_id NOT NULL`); recommendations are
**computed** from events + `governance_strikes` (no new table). *Reconciliation found during
the assisted build:* the **human governance actions** (permanent ban / lift) are
family/capability-scoped, **not** task-scoped, and `events.task_id` is `NOT NULL` — so putting
them in `app.events` is impossible without weakening a core invariant every task-view relies
on. They therefore live in a small **append-only `app.governance_actions` ledger** (block
trigger + revoked grants, mirroring `events`). This honors the "append-only, no *mutable*
state" intent while respecting the substrate's task-scoped event log. The only writes to
capability state remain (temporary) M21's `register_reject` and (permanent / lift) the D4
oversight RPC — both through `feature_denials`. M22 stays "signal + envelope," adding one
feature, verbs, one append-only ledger, and read-only surface — no new *revocation* mechanism
(ADR 0022).

**D8 — A flag anchors to a shipped TASK; a "delivery" is its task(s) in v1.** `events.task_id`
is `NOT NULL`. An out-of-band audit of a delivery (brief → task[s]) **anchors its flag to the
specific shipped task that embodies the gap**, naming the producing family + capability via
the same attribution M20/M21 use. This satisfies the constraint and reuses attribution with
**no new delivery/brief entity** — a first-class "delivery" object is deferred (open risk
below).

## What changes: one feature, three verbs, read-only surface

```
role:auditor                      ← NEW feature (kind=role, key=auditor); human-held

api.raise_audit_flag(task, subject_family, capability, gap, severity)   ← NEW, role:auditor
    └─▶ events(type='audit_flag', actor=auditor, data={subject_family, capability, gap, …})
        NO feature_denials written.                       (D2 — signal only)

api.set_permanent_ban(family, capability, reason)          ← NEW, oversight only
    └─▶ feature_denials(family, capability, expires_at = NULL)   (D4 — the only permanent route)
        + events(type='governance_action', data={action:'ban_permanent', …})
api.lift_ban(family, capability)                           ← NEW, oversight only
    └─▶ delete feature_denials(family, capability)  (temp or permanent)
        + events(type='governance_action', data={action:'lift', …})

app.governance_policy += recommend_after, flag_recommend_after   ← NEW policy data (D5)
oversight surface: audit flags · RECOMMEND PERMANENT · human-action trail   ← read-only (D5)
```

`effective_features`, the SET-ROLE, the `eff @> required_features` match — all unchanged. A
permanently-banned family simply presents a smaller `effective_features` on its next claim,
exactly like a temp ban, but it never self-heals (NULL expiry). ADR 0009 lazy semantics
throughout.

## Slicing (build order within M22)

- **Slice A — the auditor role + the human RPCs (ASSISTED, mock-verified before live).**
  Seed `role:auditor`; `api.raise_audit_flag` with its `role:auditor` gate (and the invariant
  that it writes **no** denial); `api.set_permanent_ban` / `api.lift_ban` as **`oversight`-only**
  writes of a NULL-expiry / removed `feature_denials`, each stamping a `governance_action`
  event; the `governance_policy` recommend-threshold columns. These touch **auth and
  irreversible capability state** — a rule about who may permanently strip a capability must
  be correct **before** it runs live, exactly as M19 Slice A / M21 Slice A were. Mock-verified.
  Done-tests: a flag appears as an event with **no** denial and names the flagged family +
  gap; `set_permanent_ban` writes a NULL-expiry denial effective on next claim and is audited;
  `lift_ban` removes it (temp or permanent); **only `oversight`** may call the RPCs (an agent
  token is refused); **only `role:auditor`** may flag; down-migration drops the feature, verbs,
  and policy columns.

- **Slice B — the oversight surface + report line (SWARM-ELIGIBLE → brief for the owner to
  run).** Extend `api.governance_status` (or a sibling read-only view) with the audit-flag
  count and the **RECOMMEND PERMANENT** signal (D5), and extend the end-of-run report's
  governance section to list open audit flags, recommendations, and the human-action trail —
  a **pure formatter + graceful fetch**, the exact shape M21 Slice B (#87) shipped hands-off.
  The pure report-line half is **substrate-free to validate** (`npx vitest run
  test/status-format.test.ts`) → the clean hands-off slice; the view half is written by the
  swarm but **validated assisted** (a worktree has no DB — the [board-wipe](loop-harness-command-guard)
  briefing rule). Built on a brief the owner runs; the leftover
  `loop/examples/governance-report-line-brief.txt` (M21 Slice B's clean brief) rides along in
  an M22 PR rather than a standalone one.

## Open risks (honest)

- **The audit is non-gating — a delivery can merge unaudited.** Intended for v5: the reviewer
  gates per task; the auditor is the **backstop**, not a toll (D1). A *gating* or *federated*
  auditor (an agent-judge in the critical path) is v6 — and needs judgment we do not yet trust
  to a rule (ADR 0022).
- **Human bandwidth.** Flags and recommendations pile up if no human returns. v5 accepts this
  — single owner, owner-started loop; the **always-on service (v7)** is where standing
  oversight lives. The surface (Slice B) exists so the backlog is *visible*, not silent.
- **The flag's task-anchor is a simplification.** A "delivery" is really the brief and all its
  tasks (D8); anchoring to one task is the v1 shortcut. A first-class delivery/brief entity —
  and auditing a *set* — is deferred.
- **Auditor judgment is subjective and unscored in v1.** The flag records a `gap` verbatim; it
  is not graded, and a *reviewer* track record (who waves through work an audit later flags)
  is the real check on rubber-stamping — a v6+ signal, noted not built (carried from
  track-record / reflexive-revocation risks).
- **`raise_audit_flag` and the RPCs are SECURITY DEFINER.** Fail-safe: they validate the
  caller's role, never grant, and the flag never writes a denial (D2). The permanent RPCs are
  the *only* NULL-expiry writers outside a human `apply_effects` — narrow, audited, oversight-only.
