-- unblock_task registers its caller, as create_task and claim_next_task do.
--
-- Found building v9 Slice A (#158). Every other verb's caller is either creating (registers
-- itself), claiming (registers itself), or already the holder (registered when it claimed).
-- Unblocking is the one act a NON-holder performs, so its caller may never have acted on this
-- substrate before. The 'unblocked' event's actor is a foreign key to app.agents, so a
-- first-time unblocker hit a raw 23503 from PostgREST instead of an envelope — and the
-- unblock did not happen. Since Slice A widened unblock to anyone staffed on the project,
-- first-time unblockers are now the expected case, not a corner.
--
-- Same refusals as claim: no subject → not_eligible; unregistered family → not_eligible
-- (ADR 0007 — a valid signature is not enough).

-- migrate:up

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
    if sub is null then
      return app.envelope(false, 'not_eligible', 'no subject in token');
    end if;
    -- Register the caller, as create/claim do. Unblocking is the one verb a NON-holder
    -- performs, so its caller may never have acted before — and the 'unblocked' event's
    -- actor is a foreign key to app.agents. Without this a first-time unblocker got a raw
    -- 23503 instead of an envelope.
    if app.ensure_agent(sub, api.jwt_claims() ->> 'family') is null then
      return app.envelope(false, 'not_eligible', 'unknown family');
    end if;
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

-- migrate:down

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
