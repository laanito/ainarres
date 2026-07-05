-- M22 Slice B (v5 governance; design/auditor.md D1/D5) — the oversight SURFACE for the
-- human boundary. Read-only display of what M22 Slice A already writes: the auditor's
-- QUALITATIVE flags, the human ban/lift action trail, and the raw inputs the report's
-- pure formatter turns into a PERMANENT-BAN RECOMMENDATION (ban_count / flag_count vs the
-- seeded thresholds). This only DISPLAYS state; it applies no consequence, touches no auth
-- path. Oversight-only; public revoked. The recommendation DECISION lives in the pure
-- report formatter (substrate-free, swarm-eligible), not here — these views stay dumb.
--
-- Built ASSISTED (a DB view cannot be self-validated in a worktree — the board-wipe
-- briefing rule). The report-line half that consumes these is the swarm slice.

-- migrate:up

-- Aggregate the auditor's flags per FLAGGED (subject) family + capability. Sourced from the
-- 'audit_flag' events raise_audit_flag stamps (M22 Slice A, D2). One row per (family,
-- capability) that has ever been flagged; carries the flag count, the most recent gap /
-- severity, and the seeded flag→recommend threshold so the formatter can decide.
create view api.audit_flags as
select
  e.data ->> 'subject_family'  as family,
  e.data ->> 'capability'      as capability,
  count(*)::int                as flag_count,
  max(e.created_at)            as last_flagged_at,
  (array_agg(e.data ->> 'gap'      order by e.created_at desc))[1] as last_gap,
  (array_agg(e.data ->> 'severity' order by e.created_at desc))[1] as last_severity,
  (select recommend_flag_count from app.governance_policy where scope_kind = 'system') as recommend_flag_count
from app.events e
where e.type = 'audit_flag'
group by e.data ->> 'subject_family', e.data ->> 'capability';

-- The human governance-action trail: every permanent ban / lift, newest first. Sourced
-- from the append-only app.governance_actions ledger (M22 Slice A, D4/D7).
create view api.governance_actions as
select
  af.key      as family,
  f.name      as capability,
  ga.action,
  ga.reason,
  ga.actor_sub,
  ga.created_at
from app.governance_actions ga
join app.agent_families af on af.id = ga.family_id
join app.features f        on f.id  = ga.feature_id
order by ga.created_at desc;

revoke all on api.audit_flags, api.governance_actions from public;
grant select on api.audit_flags, api.governance_actions to oversight;

-- Extend api.governance_status with the ban→recommend threshold (the flag→recommend side
-- rides on api.audit_flags). Same column order as M21 Slice B, one new column appended so
-- CREATE OR REPLACE is legal. Everything above `recommend_ban_count` is unchanged from
-- 20260704100000.
create or replace view api.governance_status as
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
  active and f.name in ('role:integrator', 'capability:integrate') as singleton_halt,
  (select recommend_ban_count from app.governance_policy where scope_kind = 'system') as recommend_ban_count
from app.governance_strikes gs
join app.features f on f.id = gs.feature_id
join app.agent_families af on af.id = gs.family_id
left join app.feature_denials d on d.family_id = gs.family_id and d.feature_id = gs.feature_id
cross join lateral app.resolve_governance_policy(f.name, NULL) as pol(threshold, base, cap)
cross join lateral (values (
  d.family_id is not null and (d.expires_at is null or d.expires_at > now())
)) as a(active);

-- migrate:down
-- Restore the M21 Slice B governance_status (no recommend_ban_count column). CREATE OR
-- REPLACE cannot DROP a column, so drop + recreate the original definition.
drop view if exists api.governance_status;
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

drop view if exists api.governance_actions;
drop view if exists api.audit_flags;
