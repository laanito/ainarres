-- M1 seed fixture: a minimal but complete instance of the model so the schema is
-- exercised end to end (a project, a lane, a reusable workflow with stages and
-- both advance + reject transitions, the trait vocabulary, and two agent families
-- with grants). This is NOT the real self-hosting dev workflow — that arrives in
-- M6; this is a generic fixture for M1's schema/seed tests.
--
-- Idempotent by construction: every statement keys on a natural unique constraint
-- (ON CONFLICT DO NOTHING) or guards with NOT EXISTS, so `make seed` is safe to
-- run on every `reset` and re-running it changes no row counts.

begin;

-- Trait vocabulary (canonical name = kind:key).
insert into app.features (kind, key) values
  ('lane',       'api'),
  ('role',       'analyst'),
  ('role',       'reviewer'),
  ('capability', 'plan')
on conflict (kind, key) do nothing;

-- A reusable flow encoding a tiny review loop.
insert into app.workflows (key, description) values
  ('dev-loop', 'Generic build → review → done loop with rework (M1 fixture).')
on conflict (key) do nothing;

-- Its stages. Exactly one is_initial (backlog), one is_terminal (done).
insert into app.stages (workflow_id, key, ordering, is_initial, is_terminal)
select w.id, v.key, v.ordering, v.is_initial, v.is_terminal
from app.workflows w
cross join (values
  ('backlog',     0, true,  false),
  ('in-progress', 1, false, false),
  ('review',      2, false, false),
  ('done',        3, false, true)
) as v(key, ordering, is_initial, is_terminal)
where w.key = 'dev-loop'
on conflict (workflow_id, key) do nothing;

-- A project and a lane that runs the flow.
insert into app.projects (slug, context) values
  ('ainarres', '{"repo": "https://github.com/laanito/ainarres"}'::jsonb)
on conflict (slug) do nothing;

insert into app.lanes (project_id, key, workflow_id, ordering, context)
select p.id, 'api', w.id, 0, '{"area": "business-logic"}'::jsonb
from app.projects p, app.workflows w
where p.slug = 'ainarres' and w.key = 'dev-loop'
on conflict (project_id, key) do nothing;

-- Transitions: who may move work where. required_features are canonical names.
-- No natural unique key on transitions (multiple OR-paths are allowed), so guard
-- each with NOT EXISTS on (workflow, from, to, kind).
insert into app.transitions (workflow_id, from_stage, to_stage, kind, required_features)
select w.id, sf.id, st.id, 'advance', array['lane:api', 'role:analyst']
from app.workflows w
join app.stages sf on sf.workflow_id = w.id and sf.key = 'backlog'
join app.stages st on st.workflow_id = w.id and st.key = 'in-progress'
where w.key = 'dev-loop'
  and not exists (
    select 1 from app.transitions t
    where t.workflow_id = w.id and t.from_stage = sf.id and t.to_stage = st.id and t.kind = 'advance'
  );

insert into app.transitions (workflow_id, from_stage, to_stage, kind, required_features)
select w.id, sf.id, st.id, 'advance', array['lane:api', 'role:analyst']
from app.workflows w
join app.stages sf on sf.workflow_id = w.id and sf.key = 'in-progress'
join app.stages st on st.workflow_id = w.id and st.key = 'review'
where w.key = 'dev-loop'
  and not exists (
    select 1 from app.transitions t
    where t.workflow_id = w.id and t.from_stage = sf.id and t.to_stage = st.id and t.kind = 'advance'
  );

insert into app.transitions (workflow_id, from_stage, to_stage, kind, required_features)
select w.id, sf.id, st.id, 'advance', array['lane:api', 'role:reviewer']
from app.workflows w
join app.stages sf on sf.workflow_id = w.id and sf.key = 'review'
join app.stages st on st.workflow_id = w.id and st.key = 'done'
where w.key = 'dev-loop'
  and not exists (
    select 1 from app.transitions t
    where t.workflow_id = w.id and t.from_stage = sf.id and t.to_stage = st.id and t.kind = 'advance'
  );

-- Rework: a reviewer can reject back to in-progress (kind = reject, separately gated).
insert into app.transitions (workflow_id, from_stage, to_stage, kind, required_features)
select w.id, sf.id, st.id, 'reject', array['lane:api', 'role:reviewer']
from app.workflows w
join app.stages sf on sf.workflow_id = w.id and sf.key = 'review'
join app.stages st on st.workflow_id = w.id and st.key = 'in-progress'
where w.key = 'dev-loop'
  and not exists (
    select 1 from app.transitions t
    where t.workflow_id = w.id and t.from_stage = sf.id and t.to_stage = st.id and t.kind = 'reject'
  );

-- Two agent families (durable competence units).
insert into app.agent_families (key, description) values
  ('opencode+qwen',    'opencode harness, qwen model'),
  ('claude-code+opus', 'Claude Code harness, Opus model')
on conflict (key) do nothing;

-- Provisioning grants. opencode+qwen can analyst on the api lane and plan;
-- claude-code+opus can do everything including review.
insert into app.family_features (family_id, feature_id)
select f.id, ft.id
from app.agent_families f
join app.features ft on ft.name = any (array['lane:api', 'role:analyst', 'capability:plan'])
where f.key = 'opencode+qwen'
on conflict (family_id, feature_id) do nothing;

insert into app.family_features (family_id, feature_id)
select f.id, ft.id
from app.agent_families f
join app.features ft on ft.name = any (array['lane:api', 'role:analyst', 'role:reviewer', 'capability:plan'])
where f.key = 'claude-code+opus'
on conflict (family_id, feature_id) do nothing;

commit;
