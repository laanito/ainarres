-- v9 Slice A — PROJECT-SCOPED MATCHING, with a transitional OR (design/customer-seat.md D1).
--
-- ADR 0029: a worker is STAFFED ON A PROJECT, not seated in a lane. In v9 a lane becomes an
-- epic — one deliverable, created and closed as requests arrive — so lane membership can no
-- longer be how a family is admitted to work: nobody could be granted an epic that does not
-- exist yet. The membership feature becomes `project:<slug>`.
--
-- The four membership sites (D1 said six; there are four — do_transition gates on the holder
-- and the transition's own required_features, never on lane):
--   api.create_task · api.claim_next_task · api.unblock_task · api.demand
-- All of them now ask ONE question, app.staffed_on(eff, lane). The transitional OR lives in
-- that helper and nowhere else, so Slice C (drop the lane: half) edits one function rather
-- than re-touching four sites.
--
-- Why an OR at all. Live tokens carry lane:dev: a standing service mid-activation holds
-- them, and the brokered operator credential carries whatever family_features said at issue.
-- Accepting both for one slice lets every token roll over. Two accepted truths is the failure
-- mode this project avoids everywhere else, which is why Slice C is a NAMED slice, not a TODO.
--
-- api.demand reports the NEW truth (`project:<slug>` in each bundle): a bundle is a
-- conjunction a worker must satisfy, and an OR cannot be written into one. The loop tiers
-- carry both features for the transition (loop/roles.sh), so they satisfy either reading.
--
-- Grants: every family holding lane:<key> is granted project:<slug> of that lane's project.
-- That is a deliberate WIDENING, and it is the point of D1: membership was per lane, staffing
-- is per project. Roles still gate every transition, and the D4 create-gate still requires the
-- workflow's starter role, so no family gains a transition it could not make before. The one
-- verb gated by membership ALONE is unblock_task: a family staffed on the project may now
-- unblock work in any of its lanes.
--
-- api.claim_next_task(lane_key) keeps its argument — now a FILTER ("work this epic"), no
-- longer a gate.

-- migrate:up

alter table app.features drop constraint features_kind_check;
alter table app.features add constraint features_kind_check
  check (kind in ('capability', 'role', 'work-area', 'lane', 'tier', 'project'));

-- One membership feature per project, and a grant of it to every family seated in one of the
-- project's lanes (a fresh database has neither yet; db/seed.sql does the same after seeding).
insert into app.features (kind, key)
select 'project', p.slug from app.projects p
on conflict (kind, key) do nothing;

insert into app.family_features (family_id, feature_id)
select distinct ff.family_id, pf.id
from app.family_features ff
join app.features lf  on lf.id = ff.feature_id and lf.kind = 'lane'
join app.lanes    l   on l.key = lf.key
join app.projects p   on p.id = l.project_id
join app.features pf  on pf.kind = 'project' and pf.key = p.slug
on conflict (family_id, feature_id) do nothing;

-- The membership question, asked in one place. TRANSITIONAL: `or lane:<key>` is removed by
-- v9 Slice C, after which this reads `eff @> array['project:' || slug]` and nothing else.
create function app.staffed_on(eff text[], p_lane uuid) returns boolean
  language sql
  stable
  set search_path = app, pg_temp
  as $$
    select exists (
      select 1
      from app.lanes l
      join app.projects p on p.id = l.project_id
      where l.id = p_lane
        and (eff @> array['project:' || p.slug]
             or eff @> array['lane:' || l.key])
    );
  $$;
revoke execute on function app.staffed_on(text[], uuid) from public;

create or replace function api.create_task(
  lane_key text,
  payload jsonb default '{}'::jsonb,
  priority int default 0,
  required_features text[] default '{}',
  subject uuid default null,
  depends_on uuid[] default '{}'
) returns jsonb
  language plpgsql
  security definer
  set search_path = app, pg_temp
  as $$
  declare
    claims    jsonb := api.jwt_claims();
    sub       uuid  := nullif(claims ->> 'sub', '')::uuid;
    eff       text[] := api.effective_features();
    v_lane    app.lanes;
    v_initial app.stages;
    v_task    app.tasks;
    v_fid     uuid;
    v_missing text;
  begin
    if sub is null then
      return app.envelope(false, 'not_eligible', 'no subject in token');
    end if;

    select * into v_lane from app.lanes where key = lane_key;
    if not found then
      return app.envelope(false, 'not_found', format('no lane %L', lane_key));
    end if;

    if not app.staffed_on(eff, v_lane.id) then
      return app.envelope(false, 'not_eligible', format('not staffed on project:%s (lane:%s also admitted until v9 slice C)', (select p.slug from app.projects p where p.id = v_lane.project_id), v_lane.key));
    end if;

    select * into v_initial from app.stages
      where workflow_id = v_lane.workflow_id and is_initial;
    if not found then
      return app.envelope(false, 'not_found', 'workflow has no initial stage');
    end if;

    -- D4 gate: creation is a "starter" act. If the initial stage has any outbound
    -- 'advance' transition, the caller must satisfy at least ONE of them — i.e. be able
    -- to start the work it is creating. A lane with no such transition imposes nothing
    -- extra (create stays lane-membership-only). Data-driven: no lane name appears here.
    if exists (
      select 1 from app.transitions t
      where t.workflow_id = v_lane.workflow_id and t.from_stage = v_initial.id and t.kind = 'advance'
    ) and not exists (
      select 1 from app.transitions t
      where t.workflow_id = v_lane.workflow_id and t.from_stage = v_initial.id and t.kind = 'advance'
        and eff @> t.required_features
    ) then
      select array_to_string(t.required_features, ',') into v_missing
        from app.transitions t
        where t.workflow_id = v_lane.workflow_id and t.from_stage = v_initial.id and t.kind = 'advance'
        order by cardinality(t.required_features) asc
        limit 1;
      return app.envelope(false, 'not_eligible',
        format('create in lane %s requires the starter role to advance out of %s (e.g. %s)',
               v_lane.key, v_initial.key, coalesce(v_missing, '(none)')));
    end if;

    -- Prerequisites must already exist (acyclic by construction, ADR 0014).
    if depends_on is not null and cardinality(depends_on) > 0 then
      if exists (
        select 1 from unnest(depends_on) as dep(id)
        where not exists (select 1 from app.tasks t where t.id = dep.id)
      ) then
        return app.envelope(false, 'not_found', 'unknown prerequisite task');
      end if;
    end if;

    v_fid := app.ensure_agent(sub, claims ->> 'family');
    if v_fid is null then
      return app.envelope(false, 'not_eligible', 'unknown family');
    end if;

    insert into app.tasks (lane_id, stage, required_features, subject, payload, priority, created_by, depends_on)
    values (v_lane.id, v_initial.id, coalesce(required_features, '{}'),
            subject, coalesce(payload, '{}'::jsonb), coalesce(priority, 0), sub,
            coalesce(depends_on, '{}'))
    returning * into v_task;

    insert into app.events (task_id, actor, type, data)
    values (v_task.id, sub, 'created',
            jsonb_build_object('lane', v_lane.key, 'stage', v_initial.key,
                               'depends_on', to_jsonb(coalesce(depends_on, '{}'))));

    return app.envelope(true, 'ok', null, app.task_json(v_task));
  end;
  $$;

create or replace function api.claim_next_task(lane_key text default null)
  returns jsonb
  language plpgsql
  security definer
  set search_path = app, pg_temp
  as $$
  declare
    claims     jsonb  := api.jwt_claims();
    sub        uuid   := nullif(claims ->> 'sub', '')::uuid;
    eff        text[] := api.effective_features();
    v_fid      uuid;
    v_held     app.tasks;
    v_cand     app.tasks;
    v_lease    interval;
    v_max      int;
    v_attempts int;
  begin
    if sub is null then
      return app.envelope(false, 'not_eligible', 'no subject in token');
    end if;
    v_fid := app.ensure_agent(sub, claims ->> 'family');
    if v_fid is null then
      return app.envelope(false, 'not_eligible', 'unknown family');
    end if;
    select * into v_held from app.tasks
      where claimed_by = sub and lease_expires_at > now() limit 1;
    if found then
      return app.envelope(false, 'already_holding',
        'instance already holds an active task', app.task_json(v_held));
    end if;
    loop
      select t.* into v_cand
      from app.tasks t
      join app.lanes  l on l.id = t.lane_id
      join app.stages s on s.id = t.stage
      where (claim_next_task.lane_key is null or l.key = claim_next_task.lane_key)
        and not t.blocked
        and not s.is_terminal
        and (t.claimed_by is null or t.lease_expires_at < now())
        and app.staffed_on(eff, l.id)
        and eff @> t.required_features
        and exists (
          select 1 from app.transitions tr
          where tr.from_stage = t.stage and eff @> tr.required_features
        )
        and not exists (
          select 1 from unnest(t.depends_on) as dep(id)
          join app.tasks p   on p.id = dep.id
          join app.stages ps on ps.id = p.stage
          where not ps.is_terminal
        )
      order by t.priority desc, t.created_at
      for update of t skip locked
      limit 1;
      if not found then
        return app.envelope(true, 'empty', 'nothing claimable for these features');
      end if;
      v_lease := app.resolve_lease(v_cand.stage);
      if v_cand.claimed_by is not null then
        v_attempts := v_cand.attempts + 1;
        v_max := app.resolve_max_attempts(v_cand.stage);
        if v_attempts >= v_max then
          update app.tasks
            set blocked = true, blocked_reason = 'max attempts exceeded',
                attempts = v_attempts, claimed_by = null, lease_expires_at = null
            where id = v_cand.id;
          insert into app.events (task_id, actor, type, data)
          values (v_cand.id, sub, 'blocked',
                  jsonb_build_object('reason', 'max attempts exceeded', 'attempts', v_attempts, 'reclaim', true));
          continue;
        end if;
        -- Escalate on reclaim: if this crosses the threshold, raise the tier and skip
        -- the task (the current claimer may no longer meet the new tier requirement).
        if app.maybe_escalate(v_cand.id, v_attempts, sub) then
          update app.tasks
            set attempts = v_attempts, claimed_by = null, lease_expires_at = null
            where id = v_cand.id;
          continue;
        end if;
        update app.tasks
          set claimed_by = sub, lease_expires_at = now() + v_lease, attempts = v_attempts
          where id = v_cand.id returning * into v_cand;
        insert into app.events (task_id, actor, type, data)
        values (v_cand.id, sub, 'claimed',
                jsonb_build_object('lease_expires_at', v_cand.lease_expires_at, 'reclaimed', true, 'attempts', v_attempts));
        return app.envelope(true, 'ok', null, app.task_json(v_cand));
      end if;
      update app.tasks
        set claimed_by = sub, lease_expires_at = now() + v_lease
        where id = v_cand.id returning * into v_cand;
      insert into app.events (task_id, actor, type, data)
      values (v_cand.id, sub, 'claimed', jsonb_build_object('lease_expires_at', v_cand.lease_expires_at));
      return app.envelope(true, 'ok', null, app.task_json(v_cand));
    end loop;
  end;
  $$;

create or replace function api.unblock_task(task_id uuid, note text default null)
  returns jsonb
  language plpgsql
  security definer
  set search_path = app, pg_temp
  as $$
  declare
    sub     uuid   := nullif(api.jwt_claims() ->> 'sub', '')::uuid;
    eff     text[] := api.effective_features();
    v_task  app.tasks;
    v_lane  app.lanes;
  begin
    select * into v_task from app.tasks where id = task_id for update;
    if not found then
      return app.envelope(false, 'not_found', 'no such task');
    end if;
    select * into v_lane from app.lanes where id = v_task.lane_id;
    if not app.staffed_on(eff, v_lane.id) then
      return app.envelope(false, 'not_eligible', format('not staffed on project:%s (lane:%s also admitted until v9 slice C)', (select p.slug from app.projects p where p.id = v_lane.project_id), v_lane.key), app.task_json(v_task));
    end if;
    if not v_task.blocked then
      return app.envelope(true, 'ok', 'already unblocked', app.task_json(v_task));
    end if;

    update app.tasks
      set blocked = false, blocked_reason = null
      where id = v_task.id returning * into v_task;
    insert into app.events (task_id, actor, type, data)
    values (v_task.id, sub, 'unblocked', jsonb_build_object('note', note));
    return app.envelope(true, 'ok', null, app.task_json(v_task));
  end;
  $$;

create or replace view api.demand as
with pending as (
  -- claim_next_task's candidate predicate, minus `eff @>` (the capability terms are what we
  -- are REPORTING, not filtering by) and minus the lane argument (all lanes at once).
  select
    t.id,
    l.key   as lane,
    pr.slug as project,
    t.stage,
    t.required_features
  from app.tasks t
  join app.lanes    l  on l.id = t.lane_id
  join app.projects pr on pr.id = l.project_id
  join app.stages   s  on s.id = t.stage
  where not t.blocked
    and not s.is_terminal
    and (t.claimed_by is null or t.lease_expires_at < now())
    and not exists (
      select 1
      from unnest(t.depends_on) as dep(id)
      join app.tasks  p  on p.id = dep.id
      join app.stages ps on ps.id = p.stage
      where not ps.is_terminal
    )
),
bundles as (
  select
    p.lane,
    p.id,
    (
      select coalesce(array_agg(distinct f order by f), '{}')
      from unnest(
        p.required_features
        || tr.required_features
        || array['project:' || p.project]
      ) as u(f)
    ) as bundle
  from pending p
  join app.transitions tr on tr.from_stage = p.stage
)
select
  bundle,
  lane,
  count(distinct id)::int as pending
from bundles
group by bundle, lane
order by pending desc, bundle;

-- migrate:down

create or replace function api.create_task(
  lane_key text,
  payload jsonb default '{}'::jsonb,
  priority int default 0,
  required_features text[] default '{}',
  subject uuid default null,
  depends_on uuid[] default '{}'
) returns jsonb
  language plpgsql
  security definer
  set search_path = app, pg_temp
  as $$
  declare
    claims    jsonb := api.jwt_claims();
    sub       uuid  := nullif(claims ->> 'sub', '')::uuid;
    eff       text[] := api.effective_features();
    v_lane    app.lanes;
    v_initial app.stages;
    v_task    app.tasks;
    v_fid     uuid;
    v_missing text;
  begin
    if sub is null then
      return app.envelope(false, 'not_eligible', 'no subject in token');
    end if;

    select * into v_lane from app.lanes where key = lane_key;
    if not found then
      return app.envelope(false, 'not_found', format('no lane %L', lane_key));
    end if;

    if not (eff @> array['lane:' || v_lane.key]) then
      return app.envelope(false, 'not_eligible', format('missing feature lane:%s', v_lane.key));
    end if;

    select * into v_initial from app.stages
      where workflow_id = v_lane.workflow_id and is_initial;
    if not found then
      return app.envelope(false, 'not_found', 'workflow has no initial stage');
    end if;

    -- D4 gate: creation is a "starter" act. If the initial stage has any outbound
    -- 'advance' transition, the caller must satisfy at least ONE of them — i.e. be able
    -- to start the work it is creating. A lane with no such transition imposes nothing
    -- extra (create stays lane-membership-only). Data-driven: no lane name appears here.
    if exists (
      select 1 from app.transitions t
      where t.workflow_id = v_lane.workflow_id and t.from_stage = v_initial.id and t.kind = 'advance'
    ) and not exists (
      select 1 from app.transitions t
      where t.workflow_id = v_lane.workflow_id and t.from_stage = v_initial.id and t.kind = 'advance'
        and eff @> t.required_features
    ) then
      select array_to_string(t.required_features, ',') into v_missing
        from app.transitions t
        where t.workflow_id = v_lane.workflow_id and t.from_stage = v_initial.id and t.kind = 'advance'
        order by cardinality(t.required_features) asc
        limit 1;
      return app.envelope(false, 'not_eligible',
        format('create in lane %s requires the starter role to advance out of %s (e.g. %s)',
               v_lane.key, v_initial.key, coalesce(v_missing, '(none)')));
    end if;

    -- Prerequisites must already exist (acyclic by construction, ADR 0014).
    if depends_on is not null and cardinality(depends_on) > 0 then
      if exists (
        select 1 from unnest(depends_on) as dep(id)
        where not exists (select 1 from app.tasks t where t.id = dep.id)
      ) then
        return app.envelope(false, 'not_found', 'unknown prerequisite task');
      end if;
    end if;

    v_fid := app.ensure_agent(sub, claims ->> 'family');
    if v_fid is null then
      return app.envelope(false, 'not_eligible', 'unknown family');
    end if;

    insert into app.tasks (lane_id, stage, required_features, subject, payload, priority, created_by, depends_on)
    values (v_lane.id, v_initial.id, coalesce(required_features, '{}'),
            subject, coalesce(payload, '{}'::jsonb), coalesce(priority, 0), sub,
            coalesce(depends_on, '{}'))
    returning * into v_task;

    insert into app.events (task_id, actor, type, data)
    values (v_task.id, sub, 'created',
            jsonb_build_object('lane', v_lane.key, 'stage', v_initial.key,
                               'depends_on', to_jsonb(coalesce(depends_on, '{}'))));

    return app.envelope(true, 'ok', null, app.task_json(v_task));
  end;
  $$;

create or replace function api.claim_next_task(lane_key text default null)
  returns jsonb
  language plpgsql
  security definer
  set search_path = app, pg_temp
  as $$
  declare
    claims     jsonb  := api.jwt_claims();
    sub        uuid   := nullif(claims ->> 'sub', '')::uuid;
    eff        text[] := api.effective_features();
    v_fid      uuid;
    v_held     app.tasks;
    v_cand     app.tasks;
    v_lease    interval;
    v_max      int;
    v_attempts int;
  begin
    if sub is null then
      return app.envelope(false, 'not_eligible', 'no subject in token');
    end if;
    v_fid := app.ensure_agent(sub, claims ->> 'family');
    if v_fid is null then
      return app.envelope(false, 'not_eligible', 'unknown family');
    end if;
    select * into v_held from app.tasks
      where claimed_by = sub and lease_expires_at > now() limit 1;
    if found then
      return app.envelope(false, 'already_holding',
        'instance already holds an active task', app.task_json(v_held));
    end if;
    loop
      select t.* into v_cand
      from app.tasks t
      join app.lanes  l on l.id = t.lane_id
      join app.stages s on s.id = t.stage
      where (claim_next_task.lane_key is null or l.key = claim_next_task.lane_key)
        and not t.blocked
        and not s.is_terminal
        and (t.claimed_by is null or t.lease_expires_at < now())
        and eff @> array['lane:' || l.key]
        and eff @> t.required_features
        and exists (
          select 1 from app.transitions tr
          where tr.from_stage = t.stage and eff @> tr.required_features
        )
        and not exists (
          select 1 from unnest(t.depends_on) as dep(id)
          join app.tasks p   on p.id = dep.id
          join app.stages ps on ps.id = p.stage
          where not ps.is_terminal
        )
      order by t.priority desc, t.created_at
      for update of t skip locked
      limit 1;
      if not found then
        return app.envelope(true, 'empty', 'nothing claimable for these features');
      end if;
      v_lease := app.resolve_lease(v_cand.stage);
      if v_cand.claimed_by is not null then
        v_attempts := v_cand.attempts + 1;
        v_max := app.resolve_max_attempts(v_cand.stage);
        if v_attempts >= v_max then
          update app.tasks
            set blocked = true, blocked_reason = 'max attempts exceeded',
                attempts = v_attempts, claimed_by = null, lease_expires_at = null
            where id = v_cand.id;
          insert into app.events (task_id, actor, type, data)
          values (v_cand.id, sub, 'blocked',
                  jsonb_build_object('reason', 'max attempts exceeded', 'attempts', v_attempts, 'reclaim', true));
          continue;
        end if;
        -- Escalate on reclaim: if this crosses the threshold, raise the tier and skip
        -- the task (the current claimer may no longer meet the new tier requirement).
        if app.maybe_escalate(v_cand.id, v_attempts, sub) then
          update app.tasks
            set attempts = v_attempts, claimed_by = null, lease_expires_at = null
            where id = v_cand.id;
          continue;
        end if;
        update app.tasks
          set claimed_by = sub, lease_expires_at = now() + v_lease, attempts = v_attempts
          where id = v_cand.id returning * into v_cand;
        insert into app.events (task_id, actor, type, data)
        values (v_cand.id, sub, 'claimed',
                jsonb_build_object('lease_expires_at', v_cand.lease_expires_at, 'reclaimed', true, 'attempts', v_attempts));
        return app.envelope(true, 'ok', null, app.task_json(v_cand));
      end if;
      update app.tasks
        set claimed_by = sub, lease_expires_at = now() + v_lease
        where id = v_cand.id returning * into v_cand;
      insert into app.events (task_id, actor, type, data)
      values (v_cand.id, sub, 'claimed', jsonb_build_object('lease_expires_at', v_cand.lease_expires_at));
      return app.envelope(true, 'ok', null, app.task_json(v_cand));
    end loop;
  end;
  $$;

create or replace function api.unblock_task(task_id uuid, note text default null)
  returns jsonb
  language plpgsql
  security definer
  set search_path = app, pg_temp
  as $$
  declare
    sub     uuid   := nullif(api.jwt_claims() ->> 'sub', '')::uuid;
    eff     text[] := api.effective_features();
    v_task  app.tasks;
    v_lane  text;
  begin
    select * into v_task from app.tasks where id = task_id for update;
    if not found then
      return app.envelope(false, 'not_found', 'no such task');
    end if;
    select key into v_lane from app.lanes where id = v_task.lane_id;
    if not (eff @> array['lane:' || v_lane]) then
      return app.envelope(false, 'not_eligible', format('missing feature lane:%s', v_lane), app.task_json(v_task));
    end if;
    if not v_task.blocked then
      return app.envelope(true, 'ok', 'already unblocked', app.task_json(v_task));
    end if;

    update app.tasks
      set blocked = false, blocked_reason = null
      where id = v_task.id returning * into v_task;
    insert into app.events (task_id, actor, type, data)
    values (v_task.id, sub, 'unblocked', jsonb_build_object('note', note));
    return app.envelope(true, 'ok', null, app.task_json(v_task));
  end;
  $$;

drop view api.demand;
create view api.demand as
with pending as (
  -- claim_next_task's candidate predicate, minus `eff @>` (the capability terms are what we
  -- are REPORTING, not filtering by) and minus the lane argument (all lanes at once).
  select
    t.id,
    l.key   as lane,
    t.stage,
    t.required_features
  from app.tasks t
  join app.lanes  l on l.id = t.lane_id
  join app.stages s on s.id = t.stage
  where not t.blocked
    and not s.is_terminal
    and (t.claimed_by is null or t.lease_expires_at < now())
    and not exists (
      select 1
      from unnest(t.depends_on) as dep(id)
      join app.tasks  p  on p.id = dep.id
      join app.stages ps on ps.id = p.stage
      where not ps.is_terminal
    )
),
bundles as (
  select
    p.lane,
    p.id,
    (
      select coalesce(array_agg(distinct f order by f), '{}')
      from unnest(
        p.required_features
        || tr.required_features
        || array['lane:' || p.lane]
      ) as u(f)
    ) as bundle
  from pending p
  join app.transitions tr on tr.from_stage = p.stage
)
select
  bundle,
  lane,
  count(distinct id)::int as pending
from bundles
group by bundle, lane
order by pending desc, bundle;

comment on view api.demand is
  'v7.1 (M27/ADR 0026): pending work in CAPABILITY terms — one row per required-feature '
  'bundle a waiting task needs, with a count. Names no task, worker, tier or service; a '
  'service matches these bundles against its own workers to spawn only what is needed.';
revoke all on api.demand from public;
grant select on api.demand to oversight, monitor;

drop function app.staffed_on(text[], uuid);

delete from app.family_features ff
using app.features f
where f.id = ff.feature_id and f.kind = 'project';
delete from app.features where kind = 'project';

alter table app.features drop constraint features_kind_check;
alter table app.features add constraint features_kind_check
  check (kind in ('capability', 'role', 'work-area', 'lane', 'tier'));
