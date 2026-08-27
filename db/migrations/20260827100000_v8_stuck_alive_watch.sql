-- v8 step 1 (ADR 0028 — the seat's preconditions): the STUCK-ALIVE watch.
--
-- The failure mode leases cannot catch. ADR 0009's recovery is lazy reclaim, and it rests
-- on one assumption: lease lost ⇒ worker dead. A worker that is ALIVE but going nowhere
-- breaks it — it holds a live lease (renewing it, if it heartbeats) while the task never
-- moves. Nothing reclaims it, nothing flags it, and the board looks busy. That is exactly
-- what happened on 2026-07-07: nemotron-3-nano hallucinated a `str_replace_editor` tool
-- and looped on the rejection, holding a 2h lease making zero progress until it lapsed.
--
-- With a human at the terminal this is a curiosity noticed in the report. With the operator
-- seat delegated (ADR 0028) nobody is reading, so it becomes the main SILENT failure mode —
-- the standing service now stalls visibly on a board nothing can move (#131), but a task
-- that merely *looks* claimed and alive produces no signal at all. This view is that signal.
--
-- DUMB and READ-ONLY, exactly like M23's watch views (design/auditor-operational.md D2):
-- it surfaces candidates; it never writes, never bans, never judges. Raising a flag stays
-- api.raise_operational_flag — role:auditor-gated, i.e. a human's act (M22 D6 / M23 D1).
-- A row here is "look at this", never "this family is bad".
--
-- Two kinds, from two different signatures:
--
--   'silent_hold'          — holds a LIVE lease and has said NOTHING (no `progress` event)
--                            for longer than stuck_silence_fraction of its stage lease. The
--                            cheap-tier spinner: took the task, reported nothing.
--   'heartbeat_treadmill'  — the lease has been RENEWED beyond its original expiry (that is
--                            what api.heartbeat does — it bumps lease_expires_at and writes
--                            NO event, so renewal is invisible in the event trail) while the
--                            hold has already outrun a full stage lease. Alive, reporting in,
--                            going nowhere. THIS is the lease-vs-liveness race made visible:
--                            lazy reclaim can never fire, because the lease never lapses.
--
-- Why `extended_by` works: a claim sets lease_expires_at = claimed_at + stage_lease. Only a
-- heartbeat pushes it past that. So lease_expires_at - (claimed_at + stage_lease) > 0 is a
-- reliable "this worker has renewed" with no new bookkeeping.
--
-- The stage lease is INLINED (coalesce over stages/workflows) rather than calling
-- app.resolve_lease: function EXECUTE is checked against the CALLER even inside a view, so
-- calling it would force a new grant onto oversight and monitor. Reading two tables they
-- already SELECT costs nothing and widens nothing.
--
-- Built ASSISTED (a DB view cannot be self-validated in a worktree — the board-wipe briefing
-- rule). The report line that renders these rows is the SWARM slice; the view stays dumb.

-- migrate:up

-- The threshold, alongside M21's reject policy and M23's overspend_multiple — one policy
-- table, one place to tune. Fraction OF THE STAGE LEASE, so it self-scales: at 0.5, a 2h
-- `implementing` hold flags after 1h of silence and a 30m `integrating` hold after 15m,
-- with no per-stage configuration to maintain.
alter table app.governance_policy
  add column stuck_silence_fraction numeric;

update app.governance_policy
  set stuck_silence_fraction = 0.5
  where scope_kind = 'system';

create view api.stuck_tasks as
with policy as (
  select coalesce(max(stuck_silence_fraction), 0.5) as silence_fraction
  from app.governance_policy
  where scope_kind = 'system'
),
held as (
  select
    t.id                              as task_id,
    l.key                             as lane,
    s.key                             as stage,
    t.attempts,
    t.lease_expires_at,
    af.key                            as family,
    coalesce(s.lease_duration, w.default_lease, interval '5 minutes') as stage_lease,
    -- The CURRENT hold: the newest `claimed` event. A re-claim after release/reclaim
    -- writes a new one, so this is always this hold's start, never an older one's.
    (select max(e.created_at) from app.events e
      where e.task_id = t.id and e.type = 'claimed')  as claimed_at,
    (select max(e.created_at) from app.events e
      where e.task_id = t.id and e.type = 'progress') as last_progress_at
  from app.tasks t
  join app.lanes     l on l.id = t.lane_id
  join app.stages    s on s.id = t.stage
  join app.workflows w on w.id = s.workflow_id
  left join app.agents        a  on a.id = t.claimed_by
  left join app.agent_families af on af.id = a.family_id
  where t.claimed_by is not null
    and t.lease_expires_at > now()   -- ALIVE: a lapsed lease is lazy reclaim's job, not ours
    and not t.blocked
    and not s.is_terminal
),
measured as (
  select
    h.*,
    now() - h.claimed_at as held_for,
    -- Silence since THIS hold began: progress from an earlier hold must not count.
    now() - greatest(h.claimed_at, coalesce(h.last_progress_at, h.claimed_at)) as silent_for,
    h.lease_expires_at - (h.claimed_at + h.stage_lease) as extended_by,
    p.silence_fraction
  from held h cross join policy p
  where h.claimed_at is not null
)
select
  task_id,
  lane,
  stage,
  family,
  attempts,
  held_for,
  silent_for,
  extended_by,
  stage_lease,
  lease_expires_at,
  case
    when extended_by > interval '0' and held_for > stage_lease then 'heartbeat_treadmill'
    else 'silent_hold'
  end as kind
from measured
where (extended_by > interval '0' and held_for > stage_lease)
   or silent_for > stage_lease * silence_fraction::double precision
order by held_for desc;

comment on view api.stuck_tasks is
  'v8: claimed tasks holding a LIVE lease that are not progressing — silent_hold (no progress '
  'for stuck_silence_fraction of the stage lease) or heartbeat_treadmill (lease renewed past '
  'its original expiry while the hold outran a full lease). A watch input for a human/auditor, '
  'never a verdict: lazy reclaim cannot catch these because the lease never lapses (ADR 0009).';

revoke all on api.stuck_tasks from public;
grant select on api.stuck_tasks to oversight, monitor;

-- migrate:down
drop view if exists api.stuck_tasks;
alter table app.governance_policy
  drop column if exists stuck_silence_fraction;
