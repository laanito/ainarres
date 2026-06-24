-- M7 task dependencies (ADR 0014). A task may declare prerequisite task(s); it is
-- not claimable until every prerequisite is satisfied (= sits at a terminal stage).
-- This is the smallest mechanism that lets a feature decompose into ordered work
-- items (ADR 0013/0016) — design before implement, implement before review.
--
-- Two changes to the M3/M5 verbs:
--   * create_task gains an optional depends_on uuid[]; every id must already exist
--     (acyclic by construction — you can only depend on tasks created before you).
--   * claim_next_task skips any task with an unsatisfied prerequisite, alongside the
--     existing blocked / terminal / lease checks. No new envelope code: a
--     dependency-blocked task is simply not handed out, like a blocked one.

-- migrate:up

alter table app.tasks add column depends_on uuid[] not null default '{}';

-- Supports dependency queries (who depends on task X — the oversight read model).
-- The per-candidate satisfaction check itself rides the tasks PK on the prereqs.
create index tasks_depends_on on app.tasks using gin (depends_on);

-- ── create_task: validate + store prerequisites ─────────────────────────────
-- Signature changes (adds depends_on), so drop the M3 function and recreate.
drop function if exists api.create_task(text, jsonb, int, text[], uuid);

create function api.create_task(
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
revoke execute on function api.create_task(text, jsonb, int, text[], uuid, uuid[]) from public;
grant execute on function api.create_task(text, jsonb, int, text[], uuid, uuid[]) to agent;

-- ── claim_next_task: skip tasks with unsatisfied prerequisites ───────────────
-- Identical to the M5 reclaim-loop version, plus one predicate in the candidate
-- scan: a task is not claimable while any prerequisite is at a non-terminal stage.
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
          -- An unsatisfied prerequisite (not yet at a terminal stage) holds the
          -- task back (ADR 0014). depends_on '{}' / null → no rows → satisfied.
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

-- migrate:down

-- Restore the M5 reclaim-loop claim_next_task (no dependency predicate).
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

-- Restore the M3 create_task (no depends_on).
drop function if exists api.create_task(text, jsonb, int, text[], uuid, uuid[]);

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
    select * into v_lane from app.lanes where key = lane_key;
    if not found then
      return app.envelope(false, 'not_found', format('no lane %L', lane_key));
    end if;
    if not (eff @> array['lane:' || v_lane.key]) then
      return app.envelope(false, 'not_eligible', format('missing feature lane:%s', v_lane.key));
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

drop index if exists app.tasks_depends_on;
alter table app.tasks drop column if exists depends_on;
