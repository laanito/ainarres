-- M3 verbs I: create_task + claim_next_task (ADR 0008). The first real agent
-- surface. Both return the uniform envelope {ok, code, reason?, task?, event?} and
-- always succeed at the HTTP level (app outcomes are values, not exceptions).
--
-- Internal helpers live in the PRIVATE `app` schema (not REST-exposed); the verbs
-- live in `api` and are SECURITY DEFINER so they can touch app.* on behalf of an
-- `agent` that has no direct table rights. Eligibility comes from effective
-- features (ADR 0007), never from arguments.

-- migrate:up

-- The uniform envelope (ADR 0008). Private helper.
create function app.envelope(
  ok boolean, code text, reason text default null,
  task jsonb default null, event jsonb default null
) returns jsonb
  language sql immutable
  as $$
    select jsonb_build_object('ok', ok, 'code', code, 'reason', reason, 'task', task, 'event', event);
  $$;
revoke execute on function app.envelope(boolean, text, text, jsonb, jsonb) from public;

-- Serialize a task row for the agent, enriched with human-readable stage/lane keys.
create function app.task_json(t app.tasks) returns jsonb
  language sql stable
  set search_path = app, pg_temp
  as $$
    select to_jsonb(t)
      || jsonb_build_object(
           'stage_key', (select key from app.stages where id = t.stage),
           'lane_key',  (select key from app.lanes  where id = t.lane_id)
         );
  $$;
revoke execute on function app.task_json(app.tasks) from public;

-- Lazily register an instance (id = token sub) so claimed_by/created_by FKs
-- resolve. Returns the family id, or null if the family is unknown.
create function app.ensure_agent(p_sub uuid, p_family_key text) returns uuid
  language plpgsql
  security definer
  set search_path = app, pg_temp
  as $$
  declare fid uuid;
  begin
    select id into fid from app.agent_families where key = p_family_key;
    if fid is null then
      return null;
    end if;
    insert into app.agents (id, family_id) values (p_sub, fid)
      on conflict (id) do nothing;
    return fid;
  end;
  $$;
revoke execute on function app.ensure_agent(uuid, text) from public;

-- create_task: insert at the lane's workflow initial stage; created_by = sub.
-- Gated by lane membership (the implicit (lane, key) feature).
create function api.create_task(
  lane_key text,
  payload jsonb default '{}'::jsonb,
  priority int default 0,
  required_features text[] default '{}',
  subject uuid default null
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

    -- Resolve the lane by key (v1: a single project, keys are unambiguous).
    select * into v_lane from app.lanes where key = lane_key;
    if not found then
      return app.envelope(false, 'not_found', format('no lane %L', lane_key));
    end if;

    -- Gate: caller must hold the lane membership feature.
    if not (eff @> array['lane:' || v_lane.key]) then
      return app.envelope(false, 'not_eligible', format('missing feature lane:%s', v_lane.key));
    end if;

    -- Register the instance (needed for the created_by FK).
    v_fid := app.ensure_agent(sub, claims ->> 'family');
    if v_fid is null then
      return app.envelope(false, 'not_eligible', 'unknown family');
    end if;

    select * into v_initial from app.stages
      where workflow_id = v_lane.workflow_id and is_initial;
    if not found then
      return app.envelope(false, 'not_found', 'workflow has no initial stage');
    end if;

    insert into app.tasks (lane_id, stage, required_features, subject, payload, priority, created_by)
    values (v_lane.id, v_initial.id, coalesce(required_features, '{}'),
            subject, coalesce(payload, '{}'::jsonb), coalesce(priority, 0), sub)
    returning * into v_task;

    insert into app.events (task_id, actor, type, data)
    values (v_task.id, sub, 'created',
            jsonb_build_object('lane', v_lane.key, 'stage', v_initial.key));

    return app.envelope(true, 'ok', null, app.task_json(v_task));
  end;
  $$;
revoke execute on function api.create_task(text, jsonb, int, text[], uuid) from public;
grant execute on function api.create_task(text, jsonb, int, text[], uuid) to agent;

-- claim_next_task: next available, unblocked, non-terminal task the caller is
-- eligible for, claimed race-free with FOR UPDATE SKIP LOCKED. One active task
-- per instance (ADR 0008/0009).
create function api.claim_next_task(lane_key text default null)
  returns jsonb
  language plpgsql
  security definer
  set search_path = app, pg_temp
  as $$
  declare
    claims     jsonb := api.jwt_claims();
    sub        uuid  := nullif(claims ->> 'sub', '')::uuid;
    eff        text[] := api.effective_features();
    v_fid      uuid;
    v_held     app.tasks;
    v_task_id  uuid;
    v_lease    interval;
    v_task     app.tasks;
  begin
    if sub is null then
      return app.envelope(false, 'not_eligible', 'no subject in token');
    end if;

    v_fid := app.ensure_agent(sub, claims ->> 'family');
    if v_fid is null then
      return app.envelope(false, 'not_eligible', 'unknown family');
    end if;

    -- One active task per instance: a still-leased hold blocks a new claim.
    select * into v_held from app.tasks
      where claimed_by = sub and lease_expires_at > now()
      limit 1;
    if found then
      return app.envelope(false, 'already_holding',
        'instance already holds an active task', app.task_json(v_held));
    end if;

    -- Pick the best eligible, available candidate and lock it. Available =
    -- unclaimed OR lease expired (lazy reclaim, ADR 0009). Eligible = effective
    -- features cover the lane, the task's extras, and at least one legal outbound
    -- transition out of its current (non-terminal) stage.
    select t.id into v_task_id
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
    order by t.priority desc, t.created_at
    for update of t skip locked
    limit 1;

    if v_task_id is null then
      return app.envelope(true, 'empty', 'nothing claimable for these features');
    end if;

    -- Resolve the lease: stage → workflow → system default (ADR 0009).
    select coalesce(s.lease_duration, w.default_lease, interval '5 minutes')
      into v_lease
    from app.tasks t
    join app.stages s on s.id = t.stage
    join app.workflows w on w.id = s.workflow_id
    where t.id = v_task_id;

    update app.tasks
      set claimed_by = sub,
          lease_expires_at = now() + v_lease
      where id = v_task_id
      returning * into v_task;

    insert into app.events (task_id, actor, type, data)
    values (v_task_id, sub, 'claimed',
            jsonb_build_object('lease_expires_at', v_task.lease_expires_at));

    return app.envelope(true, 'ok', null, app.task_json(v_task));
  end;
  $$;
revoke execute on function api.claim_next_task(text) from public;
grant execute on function api.claim_next_task(text) to agent;

-- migrate:down
drop function if exists api.claim_next_task(text);
drop function if exists api.create_task(text, jsonb, int, text[], uuid);
drop function if exists app.ensure_agent(uuid, text);
drop function if exists app.task_json(app.tasks);
drop function if exists app.envelope(boolean, text, text, jsonb, jsonb);
