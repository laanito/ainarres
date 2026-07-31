-- M23 Slice B — view half (v6; design/auditor-operational.md D2/D3/D7). The oversight
-- WATCH views the operational facet reads before a human decides. Read-only, computed,
-- DUMB: they surface anomalies; they never write, never ban, never judge — the flag
-- (Slice A's api.raise_operational_flag) is the judgment, these are the inputs to it (D2).
--
--   1. api.spend_anomalies    — the SPEND watch (D3): tokens_per_delivery vs the
--                               per-capability PEER MEDIAN over overspend_multiple, plus
--                               the delivered=0 & usage>0 (burned-but-shipped-nothing) case.
--   2. api.operational_flags  — the auditor's open operational flags, newest-first (D7).
--
-- Built ASSISTED (a DB view cannot be self-validated in a worktree — the board-wipe
-- briefing rule). The report OPERATIONAL BLOCK that turns these rows into "review" /
-- "cost" lines is the swarm slice — its presentation lives in the PURE formatter, these
-- views stay dumb (D2/D5).

-- migrate:up

-- D3 — the spend watch. Compares each (family, capability)'s tokens_per_delivery (from
-- M20's api.family_track_record) to the MEDIAN across families holding the SAME capability
-- (implementers vs implementers, not vs integrators), flagging those over the seeded
-- overspend_multiple. Two anomaly kinds, one row each:
--   * 'overspending'      — tokens_per_delivery > peer_median * overspend_multiple. Requires
--                           a real peer baseline (peer_count >= 2): a single-family capability
--                           has no one to compare to and yields NO anomaly (reported honestly,
--                           never as a false positive — the design's peer-baseline caveat).
--   * 'no_delivery_spend' — delivered = 0 AND usage_events > 0: tokens burned, nothing
--                           shipped (a worker that recorded usage on a transition but never
--                           advanced — a spinner that got far enough to log spend).
-- Tokens only — no USD, no ranking into good/bad (M20 D3): an overspender is EXPENSIVE,
-- reported as such; the consequence line (never a ban for cost) is D5, in the formatter.
create view api.spend_anomalies as
with
  tr as (
    select family, capability, delivered, usage_events, tokens_per_delivery
    from api.family_track_record
  ),
  med as (
    select
      capability,
      percentile_cont(0.5) within group (order by tokens_per_delivery)::numeric as peer_median,
      count(*) as peer_count
    from tr
    where tokens_per_delivery is not null
    group by capability
  ),
  pol as (
    select overspend_multiple from app.governance_policy where scope_kind = 'system'
  )
select
  tr.family,
  tr.capability,
  'overspending'::text                                        as anomaly,
  tr.tokens_per_delivery,
  round(m.peer_median)                                        as peer_median,
  m.peer_count,
  round(tr.tokens_per_delivery / nullif(m.peer_median, 0), 2) as multiple_over_median,
  (select overspend_multiple from pol)                        as overspend_multiple,
  tr.delivered,
  tr.usage_events
from tr
join med m using (capability)
where tr.tokens_per_delivery is not null
  and m.peer_count >= 2
  and (select overspend_multiple from pol) is not null
  and tr.tokens_per_delivery > m.peer_median * (select overspend_multiple from pol)
union all
select
  tr.family,
  tr.capability,
  'no_delivery_spend'::text            as anomaly,
  tr.tokens_per_delivery,              -- NULL (no delivery to divide by)
  null::numeric                        as peer_median,
  null::bigint                         as peer_count,
  null::numeric                        as multiple_over_median,
  (select overspend_multiple from pol) as overspend_multiple,
  tr.delivered,
  tr.usage_events
from tr
where coalesce(tr.delivered, 0) = 0
  and coalesce(tr.usage_events, 0) > 0;

-- D7 — the auditor's open operational flags, newest-first, from the Slice A ledger.
create view api.operational_flags as
select
  af.key       as family,
  o.capability,
  o.kind,
  o.detail,
  o.severity,
  o.actor_sub,
  o.created_at
from app.operational_flags o
join app.agent_families af on af.id = o.family_id
order by o.created_at desc;

revoke all on api.spend_anomalies, api.operational_flags from public;
grant select on api.spend_anomalies, api.operational_flags to oversight;

-- migrate:down
drop view if exists api.operational_flags;
drop view if exists api.spend_anomalies;
