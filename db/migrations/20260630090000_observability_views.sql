-- M16 observability (ADR 0021 § observability; design `.agents/design/observability.md`).
--
-- READ SURFACE ONLY. A deliberate finding while implementing: the event log is
-- *already* attributable and structured. advance/reject both stamp a single
-- `type='transition'` event whose data carries {kind, from, to, note, reason,
-- artifacts, effects} — `kind` IS the verdict, `reason` IS the reject reason; the
-- M12 verbs already stamp released {reason, attempts} and escalated {from_tier,
-- to_tier, attempts}; and `actor` is server-stamped from the JWT `sub`, so it is
-- already unforgeable. So M16 adds NO columns and rewrites NO verbs (the design's
-- "enrich the verb bodies" turned out to be already-done). What was genuinely
-- missing is the *read* side: board/feed expose holders/actors as bare uuids with
-- no family. This migration closes exactly that gap:
--   1. enrich api.board  — claimed_by_family, age_in_stage, blocked_by
--   2. add    api.timeline — api.feed joined to the acting agent's family
--      (the actor→agents→agent_families join the v3 pollution post-mortem
--       needed hand-written SQL to do).
-- Down restores the M5 (recovery_views) board/abandoned verbatim and drops timeline.

-- migrate:up

-- abandoned is `select * from board`, so it must be dropped before board can be.
drop view if exists api.abandoned;
drop view if exists api.board;

-- The kanban board, enriched for a swarm you have to watch:
--   * claimed_by_family — who holds it, by durable family (not a bare instance uuid)
--   * age_in_stage      — now() − updated_at. Exact for an unclaimed task (the
--                         transition that moved it in set stage+updated_at together);
--                         for a held task it reads as time-since-claim. Either way it
--                         is the "how long has this been sitting" signal oversight wants.
--   * blocked_by        — the unsatisfied prerequisites (ADR 0014): depends_on ids
--                         whose task is not yet at a terminal stage. Mirrors the exact
--                         predicate claim_next_task skips on. '{}' when nothing pends.
create view api.board as
  select
    pr.slug                                                  as project,
    l.key                                                    as lane,
    s.key                                                    as stage,
    s.is_terminal,
    t.id                                                     as task_id,
    t.priority,
    t.attempts,
    t.blocked,
    t.blocked_reason,
    t.claimed_by,
    fam.key                                                  as claimed_by_family,
    t.lease_expires_at,
    (t.claimed_by is not null and t.lease_expires_at < now()) as abandoned,
    date_trunc('second', now() - t.updated_at)               as age_in_stage,
    coalesce((
      select array_agg(dep.id)
      from unnest(t.depends_on) as dep(id)
      join app.tasks  pt on pt.id = dep.id
      join app.stages ps on ps.id = pt.stage
      where not ps.is_terminal
    ), '{}')                                                 as blocked_by,
    t.subject,
    t.created_at,
    t.updated_at
  from app.tasks t
  join app.lanes l    on l.id = t.lane_id
  join app.stages s   on s.id = t.stage
  join app.projects pr on pr.id = l.project_id
  left join app.agents ag  on ag.id = t.claimed_by
  left join app.agent_families fam on fam.id = ag.family_id;

-- Stuck work: a lease that expired while still claimed (inherits the new columns).
create view api.abandoned as
  select * from api.board where abandoned;

-- The activity feed, joined to the ACTING family — the surface the v3 pollution
-- post-mortem needed raw SQL for. actor is null for human/system events → family null.
create view api.timeline as
  select
    e.id        as event_id,
    e.created_at,
    e.type,
    e.actor,
    fam.key     as family,
    e.task_id,
    l.key       as lane,
    s.key       as stage,
    e.data
  from app.events e
  join app.tasks t   on t.id = e.task_id
  join app.lanes l   on l.id = t.lane_id
  join app.stages s  on s.id = t.stage
  left join app.agents ag  on ag.id = e.actor
  left join app.agent_families fam on fam.id = ag.family_id
  order by e.created_at desc;

revoke all on api.board, api.abandoned, api.timeline from public;
grant select on api.board, api.abandoned, api.timeline to oversight;

-- migrate:down
drop view if exists api.timeline;
drop view if exists api.abandoned;
drop view if exists api.board;

-- Restore the M5 (recovery_views) board + abandoned verbatim.
create view api.board as
  select
    pr.slug                                                  as project,
    l.key                                                    as lane,
    s.key                                                    as stage,
    s.is_terminal,
    t.id                                                     as task_id,
    t.priority,
    t.attempts,
    t.blocked,
    t.blocked_reason,
    t.claimed_by,
    t.lease_expires_at,
    (t.claimed_by is not null and t.lease_expires_at < now()) as abandoned,
    t.subject,
    t.created_at,
    t.updated_at
  from app.tasks t
  join app.lanes l    on l.id = t.lane_id
  join app.stages s   on s.id = t.stage
  join app.projects pr on pr.id = l.project_id;

create view api.abandoned as
  select * from api.board where abandoned;

revoke all on api.board, api.abandoned from public;
grant select on api.board, api.abandoned to oversight;
