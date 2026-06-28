-- M12 dynamic capability escalation (ADR 0019, refined per roadmap #29 to ORDERED
-- tiers). A task a cheap family keeps failing is automatically raised to require a
-- higher capability TIER, so only a more capable family can then claim it — no human
-- noticing, no hand re-routing (the missing piece for the hands-off loop, ADR 0018).
--
-- Ordered tiers, not a lone boolean: a `tier:N` feature (new feature kind `tier`).
-- Escalation rewrites a task's required_features to require the next tier up. Families
-- hold the tier(s) they're capable of; "requires tier:N" is satisfied by the existing
-- feature-superset match — so ordering rides the matching we already have, and adding
-- rungs later (tier:3, …) is additive data, not a new mechanism. v3 ships ONE frontier
-- rung (tier:2); base work needs no tier feature (implicit tier 1).
--
-- Trigger: `attempts` crossing `escalate_after` (stage → workflow → system default 1),
-- checked on both failure paths — release_task and the lazy-reclaim branch of
-- claim_next_task. escalate_after < max_attempts, so the lifecycle is:
--   cheap attempt(s) → escalate at escalate_after → frontier attempt(s) → auto-block
--   at max_attempts (ADR 0009, unchanged).

-- migrate:up

-- Allow the ordered tier feature kind.
alter table app.features drop constraint features_kind_check;
alter table app.features add constraint features_kind_check
  check (kind in ('capability', 'role', 'work-area', 'lane', 'tier'));

-- Data-driven escalation threshold (stage → workflow → system), mirrors max_attempts.
-- Escalation is OPT-IN: NULL escalate_after (stage and workflow) means "never escalate".
-- Only a stage/workflow that sets it participates — so existing workflows are untouched.
alter table app.stages add column escalate_after int
  check (escalate_after is null or escalate_after > 0);
alter table app.workflows add column default_escalate_after int
  check (default_escalate_after is null or default_escalate_after > 0);

create function app.resolve_escalate_after(p_stage uuid) returns int
  language sql stable set search_path = app, pg_temp
  as $$
    select coalesce(s.escalate_after, w.default_escalate_after)  -- NULL ⇒ no escalation
    from app.stages s join app.workflows w on w.id = s.workflow_id
    where s.id = p_stage;
  $$;
revoke execute on function app.resolve_escalate_after(uuid) from public;

-- Raise a task to the next capability tier if it has failed enough (attempts >=
-- escalate_after) and a higher tier exists to escalate to. Rewrites required_features:
-- drops any current tier:N, adds tier:<next>. Idempotent at the top tier (returns
-- false when there's nothing higher). Returns whether it escalated.
create function app.maybe_escalate(p_task uuid, p_attempts int, p_actor uuid)
  returns boolean
  language plpgsql
  security definer
  set search_path = app, pg_temp
  as $$
  declare
    v_task    app.tasks;
    v_esc     int;
    v_cur     int;
    v_next    int;
    v_newreq  text[];
  begin
    select * into v_task from app.tasks where id = p_task;
    v_esc := app.resolve_escalate_after(v_task.stage);
    -- Opt-in: no threshold set, or not reached → don't escalate.
    if v_esc is null or p_attempts < v_esc then
      return false;
    end if;

    -- Current tier = highest tier:N already required (default 1 = base, no tier feature).
    select coalesce(max(split_part(rf, ':', 2)::int), 1) into v_cur
    from unnest(v_task.required_features) as rf
    where rf like 'tier:%';

    v_next := v_cur + 1;
    -- Nothing higher to escalate to → leave it (max_attempts will eventually block).
    if not exists (select 1 from app.features where kind = 'tier' and key = v_next::text) then
      return false;
    end if;

    -- Rewrite required_features: drop tier:* , add the single next tier.
    select coalesce(array_agg(rf), '{}') into v_newreq
    from unnest(v_task.required_features) as rf
    where rf not like 'tier:%';
    v_newreq := v_newreq || ('tier:' || v_next);

    update app.tasks set required_features = v_newreq where id = p_task;
    insert into app.events (task_id, actor, type, data)
    values (p_task, p_actor, 'escalated',
            jsonb_build_object('from_tier', v_cur, 'to_tier', v_next, 'attempts', p_attempts));
    return true;
  end;
  $$;
revoke execute on function app.maybe_escalate(uuid, int, uuid) from public;

-- release_task + escalation: a worker giving up may push the task up a tier.
create or replace function api.release_task(task_id uuid, reason text default null)
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

    -- Escalate before releasing: a higher-tier family will then pick it up.
    perform app.maybe_escalate(v_task.id, v_attempts, sub);

    update app.tasks
      set attempts = v_attempts, claimed_by = null, lease_expires_at = null
      where id = v_task.id returning * into v_task;
    insert into app.events (task_id, actor, type, data)
    values (v_task.id, sub, 'released', jsonb_build_object('reason', reason, 'attempts', v_attempts));
    return app.envelope(true, 'ok', null, app.task_json(v_task));
  end;
  $$;

-- claim_next_task + escalation in the lazy-reclaim branch. Identical to the M7 version
-- (dependency predicate) except: on reclaim past the escalate threshold, raise the tier
-- and DON'T hand the now-higher-tier task to the current (under-tier) claimer — skip it.
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

-- migrate:down

-- Restore the M4 release_task (no escalation).
create or replace function api.release_task(task_id uuid, reason text default null)
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

-- Restore the M7 claim_next_task (dependency predicate, no escalation).
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

drop function if exists app.maybe_escalate(uuid, int, uuid);
drop function if exists app.resolve_escalate_after(uuid);
alter table app.workflows drop column if exists default_escalate_after;
alter table app.stages drop column if exists escalate_after;

-- Remove any tier features (cascades their family grants) before reverting the kind check.
delete from app.features where kind = 'tier';
alter table app.features drop constraint features_kind_check;
alter table app.features add constraint features_kind_check
  check (kind in ('capability', 'role', 'work-area', 'lane'));
