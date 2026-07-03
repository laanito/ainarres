# The substrate learns to say no: reflexive temporary revocation

> Design note for **M21** — the heart and the gate of v5 ([v5-plan](../plans/v5-plan.md) ·
> [ADR 0022](../decisions/0022-v5-scope-governance.md)). Settles M21's open questions
> before code. Builds on the token-grant − DB-veto model
> ([ADR 0007](../decisions/0007-auth-identity-family-grant-deny.md): `feature_denials`,
> `effective = token features − denials`), the lazy substrate-side reckoning pattern
> ([ADR 0009](../decisions/0009-leases-reaper.md)), the resolution pattern
> (stage→workflow→default, from `resolve_lease`/`resolve_max_attempts`), and M20's
> attributable track record ([`track-record.md`](track-record.md),
> `api.family_track_record`).

## What M21 is for

M20 built the **record**; M21 is the **sentence**. A family that proves bad at a
capability — its work crossing a reject threshold — loses that capability
**temporarily and automatically**, with exponential backoff, self-healing on expiry,
the strike history surviving so a repeat offense bites harder. Permanent revocation and
qualitative failure stay with a human (M22). This is the v5 gate: *the swarm demotes one
of its own families for cause, autonomously, correctly, while `main` stays coherent.*

The revocation **mechanism already exists** (ADR 0007: `feature_denials`,
`app.apply_effects`). M21 adds only what makes autonomous use *safe*: a **temporal
dimension** (bans expire), a **strike ledger** (repeat offenses escalate), and the
**substrate-side rule** that pulls the trigger on attributable evidence — no agent, no
orchestrator, no standing human for the mechanical case.

## Decisions (the open questions, settled)

**D1 — The strike ledger is a SEPARATE table from the denials; only denials gate auth.**
The obvious shortcut — accumulate strikes on the `feature_denials` row itself — is
wrong: `effective_features` denies *any* feature with a denial row, so a family would
lose the capability on its **first** strike, not its Nth. So strikes live in a new
`app.governance_strikes(family_id, feature_id, strikes, ban_count, last_strike_at)`,
which **auth never consults**. A denial is written to `feature_denials` **only when the
threshold is crossed**. The ledger is the memory; the denial is the consequence.

**D2 — A denial carries an expiry; the ledger survives it (no shed by waiting).**
`feature_denials` gains `expires_at timestamptz` (**NULL = permanent**, the M22 / human
case; backward-compatible — existing denials read as permanent). `effective_features`
ignores a denial whose `expires_at <= now()` — instant self-heal, preserving ADR 0007's
instant-veto direction (removing access never waits; *restoring* it is lazy, on the next
`effective_features` call / next claim). The **`governance_strikes` row persists past the
denial's expiry** (D2 of [governance.md](governance.md)): `ban_count` keeps climbing, so
a family cannot shed its history by waiting a ban out.

**D3 — Backoff is `base · 2^ban_count`, capped; `ban_count` drives it, not raw strikes.**
Two counters, distinct roles:
- `strikes` — attributable rejects **since the last ban** (or ever, if never banned).
  Crossing `threshold` triggers a ban, then **resets to 0**. (Without the reset, every
  post-ban reject would immediately re-ban.)
- `ban_count` — total bans this `(family, capability)` has ever received. **Monotonic,
  never resets** (it is the surviving history). The next ban's duration is
  `least(base · 2^ban_count, cap)`: 1st ban = base, 2nd = 2·base, 3rd = 4·base, … ≤ cap.

**D4 — The reject is credited to the PRODUCER, reusing M20's exact attribution.** A
reject is *called* by a reviewer/integrator but *judges* the producer — whoever last
advanced INTO the rejected stage (`track-record.md` D4). The strike lands on
`(producer_family, producer_role)`. This is the same producing-family / capability
derivation the `api.family_track_record` view already computes; M21 reuses it so the
sentence rests on exactly the record M20 lets a human audit. A reject with **no
resolvable producer** (no prior advance into the stage — a malformed history) strikes
**no one** (fail-safe: never guess who to punish).

**D5 — Threshold + backoff resolve capability → workflow → system default, seeded.**
The lease/max-attempts pattern. A tiny `app.governance_policy(scope_kind, scope_id,
reject_threshold, backoff_base, backoff_cap)` with `scope_kind ∈
('capability','workflow','system')`; resolution tries the most specific first. **Seed a
single `system` row** — the first-cut values, deliberately conservative:
- `reject_threshold = 3` — three attributable rejects at a capability before the first
  ban. Forgiving enough that one bad task or one harsh reviewer never bans; strict enough
  that a persistently-failing family is caught.
- `backoff_base = 1 hour`, `backoff_cap = 24 hours` — a first ban long enough to matter
  for a loop that runs in rounds, short enough to self-heal within a working day;
  doubling reaches the cap at the 5th ban.
These are **data, not constants** — tunable per capability/workflow without a migration,
and revisited once real runs show the true reject-rate distribution.

**D6 — No strike decay in v1 (strict-but-simple); a successful delivery does NOT reset
strikes.** The open question ("does a lifted/expired ban's strike decay over time")
resolves to **no** for the first cut, consistent with governance.md D2's "no shed by
waiting." `strikes` resets only on a ban (D3); `ban_count` never resets. Decay — and
whether a clean delivery streak should lower `strikes` — is a **later tuning** noted, not
built: it needs evidence about false-strike rates (D8) before we soften the rule.

**D7 — The singleton (`role:integrator` / `capability:integrate`) obeys the SAME rule; the
loudness lives in the surface, not the core.** The rule is uniform — the integrator's
work is judged like any other (a reject from `validating` credits the integrator at
`role:integrator`). Banning the singleton integrator **halts the merge queue** (grok is
the only holder — [federation.md](federation.md) D5), which is the natural human signal
governance.md D4 wants: an autonomous halt no agent can route around. Making that
**loud** (an unmistakable oversight/report alarm rather than a silent stall) is a
**read-only surface** — carved out as the swarm-eligible slice below, not baked into the
capability-stripping core. The core stays minimal and uniform; it never special-cases the
singleton.

**D8 — Governance only REMOVES; it never grants (the M19 boundary holds).** The rule
writes `feature_denials` and `governance_strikes` — nothing else. It cannot grant
`capability:integrate` or any feature to a new family; granting remains an owner
reprovision (ADR 0007's deliberate asymmetry, ADR 0022 gate condition 4). Trivially
enforced: the code path has no grant.

## What changes: one schema addition, one auth-filter line, one rule

```
reject_task ─▶ do_transition (stamps the reject event, as today)
                    │
                    └─▶ app.register_reject(producer_family, capability)   ← NEW, substrate-side
                            strikes++            (app.governance_strikes)
                            if strikes ≥ threshold(resolve capability→workflow→system):
                                feature_denials.expires_at = now() + least(base·2^ban_count, cap)
                                ban_count++, strikes = 0

effective_features():  … − feature_denials WHERE expires_at IS NULL OR expires_at > now()   ← NEW filter
```

Everything else — the token grant, the SET-ROLE, the `eff @> required_features` match —
is unchanged. A banned family simply presents a smaller `effective_features` on its next
claim; the transition it wants is no longer eligible; it is routed around (federated
capability) or the queue halts (singleton). ADR 0009 lazy semantics throughout: nothing
scans, nothing wakes — the veto is read at claim time.

## Slicing (build order within M21)

- **Slice A — the reflexive core (ASSISTED, mock-verified before live).** The schema
  (`feature_denials.expires_at`, `app.governance_strikes`, `app.governance_policy` +
  seed), the `effective_features` expiry filter, the `resolve_governance_policy`
  resolver, and `app.register_reject` wired into the reject path. A rule that strips
  capabilities **must be correct first** — built assisted and verified deterministically
  on the mock (ADR 0022 bootstrap discipline), exactly as M19 Slice A / M20 Slice A were.
  Done-tests: threshold-cross → temp denial effective on next claim; expiry → capability
  back; repeat → strictly longer ban with `ban_count` reflecting history that outlived
  the earlier expiry; producer-not-rejecter is struck; a federated capability routes
  around the ban while the singleton halts; governance never grants; down-migration
  restores permanent-only `feature_denials`.

- **Slice B — the loud governance surface (SWARM-ELIGIBLE → brief for the owner to run).**
  A read-only oversight view + report line: who is currently banned (with time-to-heal),
  who is trending toward a ban (strikes approaching threshold from the M20 record), and —
  unmistakably — when the **singleton integrator is halted** (the merge queue is stopped
  and a human is needed). No capability effect, no auth path, self-contained SQL +
  display: exactly the swarm-shaped work the split rule ([[feedback-swarm-vs-manual-split]])
  routes to the loop. Built by the swarm on a brief; the owner starts the run.

## Open risks (honest)

- **Bad-rejection false strikes.** D4 credits the producer, but a reject can be the
  *reviewer's* fault — wrongly striking a good producer. M21's mitigations: a forgiving
  threshold (3), temporariness + backoff (a wrong ban self-heals), and the **human/hard
  path (M22 auditor)** as the backstop for systematic mis-attribution. A *reviewer* track
  record (who rejects work that later ships unchanged) is the real fix — a v6+ signal,
  noted not built (track-record.md risk, carried).
- **Threshold tuning is a guess until real runs.** The seeds (3 / 1h / 24h) are
  conservative first values; being data (D5) they move without a migration once the true
  reject-rate distribution is observed.
- **Singleton halt is a real stop, by design.** Banning the sole integrator stops
  integration until a human acts. That is the *intended* signal (D7), not a bug — but it
  MUST be loud (Slice B), or a halted queue reads as a silent stall.
- **The rule runs inside `reject_task`.** It adds a small write to the reject path. It is
  SECURITY DEFINER, fail-safe (a resolver miss → no ban, never a spurious one), and never
  throws into the caller's transaction in a way that would fail the legitimate reject
  (the reject must land even if the strike bookkeeping is a no-op).
