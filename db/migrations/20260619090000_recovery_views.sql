-- M5 recovery & views (ADR 0009). Two pieces:
--
-- 1. Reclaim accounting in claim_next_task. The availability predicate already
--    hands out expired-lease tasks (M3); now reclaiming one increments attempts,
--    and a task that has burned through max_attempts is auto-blocked ("poison")
--    instead of being handed out again. The increment happens lazily, at claim
--    time — no background process (the strongest "no orchestrator" statement).
-- 2. Human-facing read views (board / feed / abandoned) for oversight. They live
--    in the exposed `api` schema and are owner-rights views over the private
--    app.* tables, so oversight only needs SELECT on the view itself.

-- migrate:up

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

    -- One active task per instance.
    select * into v_held from app.tasks
      where claimed_by = sub and lease_expires_at > now() limit 1;
    if found then
      return app.envelope(false, 'already_holding',
        'instance already holds an active task', app.task_json(v_held));
    end if;

    -- Loop so poison tasks are blocked and skipped, handing out the next viable one.
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

      -- A still-claimed candidate can only be here because its lease expired:
      -- this is a reclaim. Count the attempt; poison → auto-block and move on.
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
          continue; -- skip the poison task, try the next candidate
        end if;

        update app.tasks
          set claimed_by = sub, lease_expires_at = now() + v_lease, attempts = v_attempts
          where id = v_cand.id returning * into v_cand;
        insert into app.events (task_id, actor, type, data)
        values (v_cand.id, sub, 'claimed',
                jsonb_build_object('lease_expires_at', v_cand.lease_expires_at, 'reclaimed', true, 'attempts', v_attempts));
        return app.envelope(true, 'ok', null, app.task_json(v_cand));
      end if;

      -- Fresh claim: attempts untouched (release/reclaim own the counter).
      update app.tasks
        set claimed_by = sub, lease_expires_at = now() + v_lease
        where id = v_cand.id returning * into v_cand;
      insert into app.events (task_id, actor, type, data)
      values (v_cand.id, sub, 'claimed', jsonb_build_object('lease_expires_at', v_cand.lease_expires_at));
      return app.envelope(true, 'ok', null, app.task_json(v_cand));
    end loop;
  end;
  $$;

-- ── Views ────────────────────────────────────────────────────────────────────

-- The kanban board: one row per task with readable project/lane/stage keys and
-- the orthogonal flags (blocked, abandoned).
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

-- The activity feed: every event with its task's lane/stage, newest first.
create view api.feed as
  select
    e.id        as event_id,
    e.created_at,
    e.type,
    e.actor,
    e.task_id,
    l.key       as lane,
    s.key       as stage,
    e.data
  from app.events e
  join app.tasks t   on t.id = e.task_id
  join app.lanes l   on l.id = t.lane_id
  join app.stages s  on s.id = t.stage
  order by e.created_at desc;

-- Stuck work: a lease that expired while still claimed (no sweeper needed).
create view api.abandoned as
  select * from api.board where abandoned;

revoke all on api.board, api.feed, api.abandoned from public;
grant select on api.board, api.feed, api.abandoned to oversight;

-- migrate:down
drop view if exists api.abandoned;
drop view if exists api.feed;
drop view if exists api.board;

-- Restore the M3 claim_next_task (no reclaim accounting).
create or replace function api.claim_next_task(lane_key text default null)
  returns jsonb
  language plpgsql
  security definer
  set search_path = app, pg_temp
  as $$
  declare
    claims    jsonb  := api.jwt_claims();
    sub       uuid   := nullif(claims ->> 'sub', '')::uuid;
    eff       text[] := api.effective_features();
    v_fid     uuid;
    v_held    app.tasks;
    v_task_id uuid;
    v_lease   interval;
    v_task    app.tasks;
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
    select t.id into v_task_id
    from app.tasks t
    join app.lanes  l on l.id = t.lane_id
    join app.stages s on s.id = t.stage
    where (claim_next_task.lane_key is null or l.key = claim_next_task.lane_key)
      and not t.blocked and not s.is_terminal
      and (t.claimed_by is null or t.lease_expires_at < now())
      and eff @> array['lane:' || l.key]
      and eff @> t.required_features
      and exists (select 1 from app.transitions tr where tr.from_stage = t.stage and eff @> tr.required_features)
    order by t.priority desc, t.created_at
    for update of t skip locked
    limit 1;
    if v_task_id is null then
      return app.envelope(true, 'empty', 'nothing claimable for these features');
    end if;
    select app.resolve_lease(t.stage) into v_lease from app.tasks t where t.id = v_task_id;
    update app.tasks
      set claimed_by = sub, lease_expires_at = now() + v_lease
      where id = v_task_id returning * into v_task;
    insert into app.events (task_id, actor, type, data)
    values (v_task_id, sub, 'claimed', jsonb_build_object('lease_expires_at', v_task.lease_expires_at));
    return app.envelope(true, 'ok', null, app.task_json(v_task));
  end;
  $$;
