-- M4 verbs II: the rest of the agent surface (ADR 0008). advance/reject move the
-- task and RELEASE the hold; release/block return it; report_progress/heartbeat
-- renew the lease. Every verb that acts on a held task asserts the lease_lost
-- invariant: claimed_by = sub AND lease_expires_at > now() — a reaped agent
-- returning late gets code:"lease_lost" and must re-claim.
--
-- All app-level outcomes are envelope VALUES, never exceptions (ADR 0008: always
-- HTTP 200). Internals stay in the private `app` schema.

-- migrate:up

-- Lease/attempt resolution: stage → workflow → system default (ADR 0009).
create function app.resolve_lease(p_stage uuid) returns interval
  language sql stable set search_path = app, pg_temp
  as $$
    select coalesce(s.lease_duration, w.default_lease, interval '5 minutes')
    from app.stages s join app.workflows w on w.id = s.workflow_id
    where s.id = p_stage;
  $$;
revoke execute on function app.resolve_lease(uuid) from public;

create function app.resolve_max_attempts(p_stage uuid) returns int
  language sql stable set search_path = app, pg_temp
  as $$
    select coalesce(s.max_attempts, w.default_max_attempts, 3)
    from app.stages s join app.workflows w on w.id = s.workflow_id
    where s.id = p_stage;
  $$;
revoke execute on function app.resolve_max_attempts(uuid) from public;

-- Reflexive-governance plumbing (ADR 0007): apply a transition's effects to the
-- task SUBJECT's family. revoke → feature_denials (instant); grant →
-- family_features (effective on token reissue). No-op without a subject/effects.
-- Returns a summary for the audit event.
create function app.apply_effects(p_subject uuid, p_effects jsonb) returns jsonb
  language plpgsql
  security definer
  set search_path = app, pg_temp
  as $$
  declare
    v_fid     uuid;
    v_revoked text[] := '{}';
    v_granted text[] := '{}';
    f         text;
  begin
    if p_effects is null or p_subject is null then
      return '{}'::jsonb;
    end if;
    select family_id into v_fid from app.agents where id = p_subject;
    if v_fid is null then
      return '{}'::jsonb;
    end if;

    if jsonb_typeof(p_effects -> 'revoke') = 'array' then
      for f in select jsonb_array_elements_text(p_effects -> 'revoke') loop
        insert into app.feature_denials (family_id, feature_id, reason)
        select v_fid, ft.id, 'transition effect' from app.features ft where ft.name = f
        on conflict (family_id, feature_id) do nothing;
        v_revoked := v_revoked || f;
      end loop;
    end if;

    if jsonb_typeof(p_effects -> 'grant') = 'array' then
      for f in select jsonb_array_elements_text(p_effects -> 'grant') loop
        insert into app.family_features (family_id, feature_id)
        select v_fid, ft.id from app.features ft where ft.name = f
        on conflict (family_id, feature_id) do nothing;
        v_granted := v_granted || f;
      end loop;
    end if;

    return jsonb_build_object('granted', to_jsonb(v_granted), 'revoked', to_jsonb(v_revoked));
  end;
  $$;
revoke execute on function app.apply_effects(uuid, jsonb) from public;

-- Shared body for advance_task and reject_task (they differ only in `kind` and
-- that reject is separately permission-gated — ADR 0008). Executes a transition
-- of the given kind out of the held task's current stage.
create function app.do_transition(
  p_task uuid, p_kind text, p_to_stage text, p_note text, p_reason text, p_artifacts jsonb
) returns jsonb
  language plpgsql
  security definer
  set search_path = app, pg_temp
  as $$
  declare
    claims      jsonb  := api.jwt_claims();
    sub         uuid   := nullif(claims ->> 'sub', '')::uuid;
    eff         text[] := api.effective_features();
    v_task      app.tasks;
    v_to_stage  uuid;
    v_from_key  text;
    v_tr        app.transitions;
    v_guard_ok  boolean;
    v_effects   jsonb := '{}'::jsonb;
    v_event     app.events;
  begin
    select * into v_task from app.tasks where id = p_task for update;
    if not found then
      return app.envelope(false, 'not_found', 'no such task');
    end if;
    if v_task.claimed_by is distinct from sub or coalesce(v_task.lease_expires_at, '-infinity') <= now() then
      return app.envelope(false, 'lease_lost', 'you no longer hold this task', app.task_json(v_task));
    end if;

    -- Resolve the target stage by key within the task's workflow.
    select s.id into v_to_stage
    from app.stages s
    join app.lanes l on l.workflow_id = s.workflow_id
    where l.id = v_task.lane_id and s.key = p_to_stage;
    if v_to_stage is null then
      return app.envelope(false, 'illegal_transition', format('unknown target stage %L', p_to_stage), app.task_json(v_task));
    end if;

    -- A legal transition of this kind that the caller is eligible for.
    select * into v_tr
    from app.transitions tr
    where tr.from_stage = v_task.stage and tr.to_stage = v_to_stage and tr.kind = p_kind
      and eff @> tr.required_features
    order by cardinality(tr.required_features) desc
    limit 1;
    if not found then
      if exists (
        select 1 from app.transitions tr
        where tr.from_stage = v_task.stage and tr.to_stage = v_to_stage and tr.kind = p_kind
      ) then
        return app.envelope(false, 'not_eligible', 'missing features for this transition', app.task_json(v_task));
      end if;
      return app.envelope(false, 'illegal_transition', format('no %s transition to %L', p_kind, p_to_stage), app.task_json(v_task));
    end if;

    -- Guard (optional): a trusted boolean SQL expression; the task is $1 (jsonb).
    if v_tr.guard is not null then
      begin
        execute format('select (%s)', v_tr.guard) into v_guard_ok using to_jsonb(v_task);
      exception when others then
        return app.envelope(false, 'guard_failed', 'guard error: ' || sqlerrm, app.task_json(v_task));
      end;
      if v_guard_ok is not true then
        return app.envelope(false, 'guard_failed', 'guard not satisfied', app.task_json(v_task));
      end if;
    end if;

    v_effects := app.apply_effects(v_task.subject, v_tr.effects);
    select key into v_from_key from app.stages where id = v_task.stage;

    -- Move the stage and RELEASE the hold.
    update app.tasks
      set stage = v_to_stage, claimed_by = null, lease_expires_at = null
      where id = v_task.id
      returning * into v_task;

    insert into app.events (task_id, actor, type, data)
    values (v_task.id, sub, 'transition', jsonb_build_object(
      'kind', p_kind, 'from', v_from_key, 'to', p_to_stage,
      'note', p_note, 'reason', p_reason, 'artifacts', coalesce(p_artifacts, '[]'::jsonb),
      'effects', v_effects))
    returning * into v_event;

    return app.envelope(true, 'ok', null, app.task_json(v_task), to_jsonb(v_event));
  end;
  $$;
revoke execute on function app.do_transition(uuid, text, text, text, text, jsonb) from public;

-- advance_task: execute an `advance` transition; release the hold.
create function api.advance_task(task_id uuid, to_stage text, note text default null, artifacts jsonb default '[]'::jsonb)
  returns jsonb
  language sql
  security definer
  set search_path = app, pg_temp
  as $$ select app.do_transition(task_id, 'advance', to_stage, note, null, artifacts); $$;
revoke execute on function api.advance_task(uuid, text, text, jsonb) from public;
grant execute on function api.advance_task(uuid, text, text, jsonb) to agent;

-- reject_task: execute a `reject` transition; separately gated; release the hold.
create function api.reject_task(task_id uuid, to_stage text, reason text, artifacts jsonb default '[]'::jsonb)
  returns jsonb
  language sql
  security definer
  set search_path = app, pg_temp
  as $$ select app.do_transition(task_id, 'reject', to_stage, null, reason, artifacts); $$;
revoke execute on function api.reject_task(uuid, text, text, jsonb) from public;
grant execute on function api.reject_task(uuid, text, text, jsonb) to agent;

-- release_task: return a held task unchanged; attempts++; auto-block at the cap.
create function api.release_task(task_id uuid, reason text default null)
  returns jsonb
  language plpgsql
  security definer
  set search_path = app, pg_temp
  as $$
  declare
    claims    jsonb := api.jwt_claims();
    sub       uuid  := nullif(claims ->> 'sub', '')::uuid;
    v_task    app.tasks;
    v_attempts int;
    v_max     int;
  begin
    select * into v_task from app.tasks where id = task_id for update;
    if not found then
      return app.envelope(false, 'not_found', 'no such task');
    end if;
    if v_task.claimed_by is distinct from sub or coalesce(v_task.lease_expires_at, '-infinity') <= now() then
      return app.envelope(false, 'lease_lost', 'you no longer hold this task', app.task_json(v_task));
    end if;

    v_attempts := v_task.attempts + 1;
    v_max := app.resolve_max_attempts(v_task.stage);

    if v_attempts >= v_max then
      update app.tasks
        set attempts = v_attempts, claimed_by = null, lease_expires_at = null,
            blocked = true, blocked_reason = 'max attempts exceeded'
        where id = v_task.id returning * into v_task;
      insert into app.events (task_id, actor, type, data)
      values (v_task.id, sub, 'blocked',
              jsonb_build_object('reason', 'max attempts exceeded', 'attempts', v_attempts));
      return app.envelope(true, 'blocked', 'max attempts exceeded', app.task_json(v_task));
    end if;

    update app.tasks
      set attempts = v_attempts, claimed_by = null, lease_expires_at = null
      where id = v_task.id returning * into v_task;
    insert into app.events (task_id, actor, type, data)
    values (v_task.id, sub, 'released', jsonb_build_object('reason', reason, 'attempts', v_attempts));
    return app.envelope(true, 'ok', null, app.task_json(v_task));
  end;
  $$;
revoke execute on function api.release_task(uuid, text) from public;
grant execute on function api.release_task(uuid, text) to agent;

-- block_task: park a held task (orthogonal flag); release the hold.
create function api.block_task(task_id uuid, reason text)
  returns jsonb
  language plpgsql
  security definer
  set search_path = app, pg_temp
  as $$
  declare
    claims jsonb := api.jwt_claims();
    sub    uuid  := nullif(claims ->> 'sub', '')::uuid;
    v_task app.tasks;
  begin
    select * into v_task from app.tasks where id = task_id for update;
    if not found then
      return app.envelope(false, 'not_found', 'no such task');
    end if;
    if v_task.claimed_by is distinct from sub or coalesce(v_task.lease_expires_at, '-infinity') <= now() then
      return app.envelope(false, 'lease_lost', 'you no longer hold this task', app.task_json(v_task));
    end if;

    update app.tasks
      set blocked = true, blocked_reason = reason, claimed_by = null, lease_expires_at = null
      where id = v_task.id returning * into v_task;
    insert into app.events (task_id, actor, type, data)
    values (v_task.id, sub, 'blocked', jsonb_build_object('reason', reason));
    return app.envelope(true, 'ok', null, app.task_json(v_task));
  end;
  $$;
revoke execute on function api.block_task(uuid, text) from public;
grant execute on function api.block_task(uuid, text) to agent;

-- unblock_task: clear the block; task open again at its stage. Does not require a
-- hold (a blocked task isn't held), but the caller must work the task's lane.
create function api.unblock_task(task_id uuid, note text default null)
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
revoke execute on function api.unblock_task(uuid, text) from public;
grant execute on function api.unblock_task(uuid, text) to agent;

-- report_progress: append a progress event (artifacts are references, ADR 0003);
-- renew the lease. Payload is the event.
create function api.report_progress(task_id uuid, note text, artifacts jsonb default '[]'::jsonb)
  returns jsonb
  language plpgsql
  security definer
  set search_path = app, pg_temp
  as $$
  declare
    sub     uuid := nullif(api.jwt_claims() ->> 'sub', '')::uuid;
    v_task  app.tasks;
    v_event app.events;
  begin
    select * into v_task from app.tasks where id = task_id for update;
    if not found then
      return app.envelope(false, 'not_found', 'no such task');
    end if;
    if v_task.claimed_by is distinct from sub or coalesce(v_task.lease_expires_at, '-infinity') <= now() then
      return app.envelope(false, 'lease_lost', 'you no longer hold this task', app.task_json(v_task));
    end if;

    update app.tasks
      set lease_expires_at = now() + app.resolve_lease(v_task.stage)
      where id = v_task.id returning * into v_task;
    insert into app.events (task_id, actor, type, data)
    values (v_task.id, sub, 'progress', jsonb_build_object('note', note, 'artifacts', coalesce(artifacts, '[]'::jsonb)))
    returning * into v_event;
    return app.envelope(true, 'ok', null, app.task_json(v_task), to_jsonb(v_event));
  end;
  $$;
revoke execute on function api.report_progress(uuid, text, jsonb) from public;
grant execute on function api.report_progress(uuid, text, jsonb) to agent;

-- heartbeat: renew the lease during long work.
create function api.heartbeat(task_id uuid)
  returns jsonb
  language plpgsql
  security definer
  set search_path = app, pg_temp
  as $$
  declare
    sub    uuid := nullif(api.jwt_claims() ->> 'sub', '')::uuid;
    v_task app.tasks;
  begin
    select * into v_task from app.tasks where id = task_id for update;
    if not found then
      return app.envelope(false, 'not_found', 'no such task');
    end if;
    if v_task.claimed_by is distinct from sub or coalesce(v_task.lease_expires_at, '-infinity') <= now() then
      return app.envelope(false, 'lease_lost', 'you no longer hold this task', app.task_json(v_task));
    end if;

    update app.tasks
      set lease_expires_at = now() + app.resolve_lease(v_task.stage)
      where id = v_task.id returning * into v_task;
    return app.envelope(true, 'ok', null, app.task_json(v_task));
  end;
  $$;
revoke execute on function api.heartbeat(uuid) from public;
grant execute on function api.heartbeat(uuid) to agent;

-- migrate:down
drop function if exists api.heartbeat(uuid);
drop function if exists api.report_progress(uuid, text, jsonb);
drop function if exists api.unblock_task(uuid, text);
drop function if exists api.block_task(uuid, text);
drop function if exists api.release_task(uuid, text);
drop function if exists api.reject_task(uuid, text, text, jsonb);
drop function if exists api.advance_task(uuid, text, text, jsonb);
drop function if exists app.do_transition(uuid, text, text, text, text, jsonb);
drop function if exists app.apply_effects(uuid, jsonb);
drop function if exists app.resolve_max_attempts(uuid);
drop function if exists app.resolve_lease(uuid);
