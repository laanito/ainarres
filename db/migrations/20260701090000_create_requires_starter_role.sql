-- migrate:up
-- M19 / D4 (federation, ADR 0021 · design/federation.md): create-vs-advance.
--
-- Until now api.create_task was gated by lane membership alone, so ANY dev-lane
-- family — a cheap implementer, a stray frontier peer — could freelance-create tasks
-- off-script (the v3 anomaly the M19 plan flagged). With multiple frontier peers
-- (M19), "who may decompose vs. who may only advance" must hold by capability, not by
-- an agent remembering to behave.
--
-- The rule, derived from the workflow itself (data-driven, ADR 0001 — NOT hardcoded
-- per lane): to create a task you must be able to move it OUT of the initial stage.
-- Creating a task IS starting the work, so only an agent that could take the first
-- step may create it. For the dev workflow that outbound transition is
-- proposed→designing (role:designer), so dev creation now requires role:designer;
-- snippets requires role:worker; a lane whose initial stage has no outbound advance
-- transition stays lane-membership-only (unchanged).
--
-- Modifies the current (M7) 6-arg create_task — the one carrying depends_on — via
-- create-or-replace; only the D4 gate block is added.
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

-- migrate:down
-- Restore the M7 behaviour: create_task gated by lane membership only (no starter-role
-- gate), still carrying depends_on.
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

    select * into v_initial from app.stages
      where workflow_id = v_lane.workflow_id and is_initial;
    if not found then
      return app.envelope(false, 'not_found', 'workflow has no initial stage');
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
