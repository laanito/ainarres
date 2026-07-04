-- M21 Slice B (v5 governance; design/reflexive-revocation.md D7). The governance
-- status view — read-only display of ban/heal/trending/singleton-halt state per
-- struck (family, capability). This only DISPLAYS state M21 Slice A already writes.
-- READ-ONLY: do NOT modify Slice A tables/functions. plpgsql/plain-SQL only.
-- Oversight-only; public revoked. Uses the policy resolver (with grant).

-- migrate:up

create view api.governance_status as
select
  af.key        as family,
  f.name        as capability,
  gs.strikes,
  gs.ban_count,
  pol.threshold,
  active        as banned,
  active and d.expires_at is null as permanent,
  case when active and d.expires_at is not null then d.expires_at else null end as heal_at,
  case when active and d.expires_at is not null
       then extract(epoch from (d.expires_at - now()))::int else null end as seconds_to_heal,
  (not active) and gs.strikes >= pol.threshold - 1 as trending,
  active and f.name in ('role:integrator', 'capability:integrate') as singleton_halt
from app.governance_strikes gs
join app.features f on f.id = gs.feature_id
join app.agent_families af on af.id = gs.family_id
left join app.feature_denials d on d.family_id = gs.family_id and d.feature_id = gs.feature_id
cross join lateral app.resolve_governance_policy(f.name, NULL) as pol(threshold, base, cap)
cross join lateral (values (
  d.family_id is not null and (d.expires_at is null or d.expires_at > now())
)) as a(active);

revoke all on api.governance_status from public;
grant select on api.governance_status to oversight;
grant execute on function app.resolve_governance_policy(text, uuid) to oversight;

-- migrate:down
drop view if exists api.governance_status;
revoke execute on function app.resolve_governance_policy(text, uuid) from oversight;
