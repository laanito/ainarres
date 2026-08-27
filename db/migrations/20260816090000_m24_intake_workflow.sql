-- M24 Slice A (v6 — seat the bookends) — the intaker & two-tier creation.
-- design/intake.md · ADR 0023. Seats the FRONT bookend: the intaker (Consultant),
-- who turns a raw request into a well-formed brief for the designer. The headline is
-- that two-tier creation needs NO create_task change — it falls out of the existing,
-- unmodified D4 create-gate (20260701090000_create_requires_starter_role.sql: to
-- CREATE in a lane you must hold the role that ADVANCES out of its initial stage).
--
-- This migration seeds a SECOND lane (intake) on a new ainarres-intake workflow whose
-- initial stage advances on role:intaker. The same data-driven gate then enforces:
--   role:intaker  may create in intake (starter of proposed_brief→briefed) — NOT dev;
--   role:designer may create in dev    (starter of proposed→designing)      — NOT intake.
-- Two creators, two levels, one unchanged gate (D4). No verb code here — the done-tests
-- EXERCISE the gate, they do not modify it.
--
-- Ordering note: migrations run BEFORE db/seed.sql on a fresh DB, so the 'ainarres'
-- project (seeded in seed.sql) does not yet exist when this runs. To keep the intake
-- workflow+lane SELF-CONTAINED (the gate is provable from the migration alone, no seed
-- dependency), this ensures the project row idempotently with the SAME context seed.sql
-- uses — a no-op whichever runs first (both `on conflict (slug) do nothing`).

-- migrate:up

-- D5 — role:intaker, a plain role feature, human-held this version, federatable later.
-- Existence is all this seeds; GRANTING it to a family is an owner reprovision (the
-- ADR 0007 asymmetry, exactly like every other role). Plus the intake lane-membership
-- feature the workflow routes by.
insert into app.features (kind, key) values
  ('lane', 'intake'), ('role', 'intaker')
on conflict (kind, key) do nothing;

-- D1/D2 — the ainarres-intake workflow: three stages, two advance transitions, mapping
-- the two-tier handoff. No reject/rework in v1 (a wrong brief is re-worked in place while
-- still proposed_brief). Leases mirror the dev workflow's shape (initial + terminal null).
insert into app.workflows (key, description, default_lease, default_max_attempts) values
  ('ainarres-intake',
   'AINARRES intake: a raw request → a well-formed brief, handed to the designer (M24).',
   interval '30 minutes', 3)
on conflict (key) do nothing;

-- proposed_brief (initial) → briefed → accepted (terminal). The intaker works the brief
-- while it sits in proposed_brief; the advance to briefed IS the intaker's refine step and
-- the D4 starter that lets the intaker create intake tasks at all.
insert into app.stages (workflow_id, key, ordering, is_initial, is_terminal, lease_duration)
select w.id, v.key, v.ord, v.ini, v.term, v.lease
from app.workflows w
cross join (values
  ('proposed_brief', 0, true,  false, null::interval),
  ('briefed',        1, false, false, interval '1 hour'),
  ('accepted',       2, false, true,  null::interval)
) as v(key, ord, ini, term, lease)
where w.key = 'ainarres-intake'
on conflict (workflow_id, key) do nothing;

-- D2/D4 — the two advance transitions. proposed_brief→briefed [role:intaker] is BOTH the
-- intaker's refine step AND the create-gate starter (so role:intaker can create in intake).
-- briefed→accepted [role:designer] is the designer accepting a ready brief for decomposition.
insert into app.transitions (workflow_id, from_stage, to_stage, kind, required_features)
select w.id, sf.id, st.id, 'advance', v.req
from app.workflows w
cross join (values
  ('proposed_brief', 'briefed',  array['role:intaker']),
  ('briefed',        'accepted', array['role:designer'])
) as v(from_key, to_key, req)
join app.stages sf on sf.workflow_id = w.id and sf.key = v.from_key
join app.stages st on st.workflow_id = w.id and st.key = v.to_key
where w.key = 'ainarres-intake'
  and not exists (select 1 from app.transitions t
    where t.workflow_id = w.id and t.from_stage = sf.id and t.to_stage = st.id and t.kind = 'advance');

-- The intake lane on the bootstrap project. Ensure the project exists first (idempotent,
-- identical to seed.sql — see the ordering note above), then attach the lane.
insert into app.projects (slug, context) values
  ('ainarres', '{"repo": "https://github.com/laanito/ainarres"}'::jsonb)
on conflict (slug) do nothing;

insert into app.lanes (project_id, key, workflow_id, context)
select p.id, 'intake', w.id, '{"area": "requirements"}'::jsonb
from app.projects p, app.workflows w
where p.slug = 'ainarres' and w.key = 'ainarres-intake'
on conflict (project_id, key) do nothing;

-- migrate:down
-- Reverse dependency order: intake tasks (events cascade) → lane (no cascade from the
-- workflow) → workflow (cascades its stages + transitions) → features (cascade any grants).
-- Leaves the 'ainarres' project in place — it is the shared bootstrap project, restored
-- by seed.sql, not owned by this migration.
--
-- The events trigger has to stand down for the cascade. app.events is append-only (ADR
-- 0006, enforced by the events_no_update / events_no_delete triggers), and deleting a task
-- cascades into its events —
-- so on any substrate that has ever taken a brief, this down FAILED with "app.events is
-- append-only (DELETE not allowed)", which `make verify-down` swallowed via its `|| break`
-- (it then silently proved only the migrations NEWER than this one). Append-only is an
-- invariant for AGENTS at runtime, not a bar on the schema's owner tearing its own objects
-- down: the trigger is disabled for this statement only, inside the migration's
-- transaction, and re-enabled immediately.
alter table app.events disable trigger events_no_delete;
delete from app.events
  where task_id in (select t.id from app.tasks t
    join app.lanes l on l.id = t.lane_id
    where l.key = 'intake'
      and l.workflow_id = (select id from app.workflows where key = 'ainarres-intake'));
alter table app.events enable trigger events_no_delete;
delete from app.tasks
  where lane_id in (select id from app.lanes where key = 'intake'
    and workflow_id = (select id from app.workflows where key = 'ainarres-intake'));
delete from app.lanes
  where key = 'intake' and workflow_id = (select id from app.workflows where key = 'ainarres-intake');
delete from app.workflows where key = 'ainarres-intake';
delete from app.features where (kind, key) in (('lane', 'intake'), ('role', 'intaker'));
