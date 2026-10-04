-- v9 Slice 0 — SPEND IS CHARGED TO THE TRANSITION THAT EARNED IT, named by the writer.
--
-- design/customer-seat.md D7. Two readers have failed at this. The original rule charged a
-- sweep's spend to the LAST transition it made; #147 switched to the FIRST. Both are guesses
-- about how to divide a number that arrived already merged — one measured sweep made eleven
-- transitions across two tasks and five capabilities under a single report.
--
-- The defect is in the writer. A harness reported usage ONCE, at the end of a sweep. Now the
-- claude and grok wrappers stream (opencode always did), and the CLI's record-usage cuts
-- the stream at each transition the sweep made — the transition's event is right there in
-- the log, as the tool result of the `advance` that made it — and records one usage event
-- per transition, each naming its anchor in data.transition.
--
-- What changes here:
--   * api.record_usage validates the anchor: it must be a transition event THIS actor
--     made (on the named task, if one is named). Otherwise `bad_anchor`, nothing written.
--     Signature, grants, and the task-less ledger path are unchanged.
--   * api.family_track_record charges an anchored event to exactly that transition's role.
--
-- What does NOT change, and why D7's "delete #147" is deferred: an UNANCHORED event keeps
-- #147's first-transition-in-window reading. Two writers still produce them — every row of
-- pre-v9 history (re-reading the past with a cruder rule would un-fix the Hermes run), and
-- cursor-agent, whose stream shape is not yet verified. The window's lower bound ("the
-- family's previous usage report on this task") only gets tighter when reports are more
-- frequent, so the legacy rule stays sound alongside anchored rows.

-- migrate:up

create or replace function api.record_usage(
  actor  uuid,
  data   jsonb default '{}'::jsonb,
  task   uuid default null,
  family text default null
) returns jsonb
  language plpgsql
  security definer
  set search_path = app, pg_temp
  as $$
  declare
    v_task  uuid := task;
    v_fid   uuid;
    v_event app.events;
    v_row   app.sweep_usage;
    v_known boolean;
    v_anchor app.events;
  begin
    v_known := actor is not null
               and exists (select 1 from app.agents a where a.id = record_usage.actor);

    -- v9: an ANCHORED report names the transition this spend earned (data.transition).
    -- The anchor must be a transition THIS actor made — on the named task, if one is
    -- named — or the report is refused: a writer that can file spend under any event
    -- could launder one family's cost into another's capability.
    if record_usage.data ? 'transition' then
      select e.* into v_anchor
      from app.events e
      where e.id::text = record_usage.data ->> 'transition'
        and e.type = 'transition'
        and e.actor = record_usage.actor;
      if not found or (v_task is not null and v_task <> v_anchor.task_id) then
        return app.envelope(false, 'bad_anchor',
          'data.transition is not a transition this actor made on this task');
      end if;
      v_task := v_anchor.task_id;
    end if;

    -- Resolve the charged task from the actor's most-recent transition when the caller
    -- did not name one (the driver may, or leave it to us).
    if v_task is null and v_known then
      select e.task_id into v_task
      from app.events e
      where e.actor = record_usage.actor and e.type = 'transition'
      order by e.created_at desc, e.id desc
      limit 1;
    end if;

    -- The task-anchored path, unchanged.
    if v_task is not null then
      if not v_known then
        return app.envelope(false, 'unknown_actor', 'no agent for actor; cannot attribute usage');
      end if;
      insert into app.events (task_id, actor, type, data)
      values (v_task, record_usage.actor, 'usage', coalesce(data, '{}'::jsonb))
      returning * into v_event;
      return app.envelope(true, 'ok', null, null, to_jsonb(v_event));
    end if;

    -- No task: the sweep moved nothing. It still SPENT. Attribute to the named family, or
    -- to the actor's family when the actor is known (a worker that claimed earlier in the
    -- run but not in this sweep).
    if family is not null then
      select f.id into v_fid from app.agent_families f where f.key = family;
    elsif v_known then
      select ag.family_id into v_fid from app.agents ag where ag.id = record_usage.actor;
    end if;

    if v_fid is null then
      -- Refuse rather than orphan the spend — an unattributable number is worse than a
      -- missing one, because it reads as somebody's.
      return app.envelope(false, 'unknown_family',
        'no task and no resolvable family; cannot attribute sweep spend');
    end if;

    insert into app.sweep_usage (family_id, actor_sub, sweep, tokens, model)
    values (v_fid,
            record_usage.actor,
            nullif(data ->> 'sweep_id', ''),
            coalesce(data -> 'tokens', '{}'::jsonb),
            nullif(data ->> 'model', ''))
    returning * into v_row;

    return app.envelope(true, 'no_task_spend',
      'sweep moved no task; spend recorded against the family', null, to_jsonb(v_row));
  end;
  $$;

revoke execute on function api.record_usage(uuid, jsonb, uuid, text) from public;
grant execute on function api.record_usage(uuid, jsonb, uuid, text) to oversight;

create or replace view api.family_track_record as
with
  -- Every transition event decoded, with the acting family, the task's workflow, and
  -- the role:* the transition required (resolved from the transition definition).
  tr as (
    select
      e.id, e.task_id, e.actor, e.created_at,
      fam.key                    as family,
      e.data ->> 'kind'          as kind,
      e.data ->> 'from'          as from_key,
      e.data ->> 'to'            as to_key,
      s.workflow_id,
      (
        select rf
        from app.transitions x
        join app.stages sf on sf.id = x.from_stage
        join app.stages st on st.id = x.to_stage
        cross join lateral unnest(x.required_features) as rf
        where sf.workflow_id = s.workflow_id
          and sf.key = e.data ->> 'from'
          and st.key = e.data ->> 'to'
          and x.kind = e.data ->> 'kind'
          and rf like 'role:%'
        limit 1
      )                          as role
    from app.events e
    join app.agents ag         on ag.id = e.actor
    join app.agent_families fam on fam.id = ag.family_id
    join app.tasks t           on t.id = e.task_id
    join app.stages s          on s.id = t.stage
    where e.type = 'transition'
  ),

  -- Deliveries: an advance exercises the role the transition required.
  deliveries as (
    select family, role as capability, created_at
    from tr
    where kind = 'advance' and role is not null
  ),

  -- Rejects credited to the PRODUCER (D4): whoever last advanced INTO the rejected
  -- stage, before the reject. The capability charged is that producing advance's role;
  -- cross_family flags a reject called by a DIFFERENT family than produced the work.
  rejects as (
    select
      p.family                              as family,
      p.capability                          as capability,
      r.from_key                            as reject_stage,
      (r.family is distinct from p.family)  as cross_family,
      r.created_at
    from tr r
    join lateral (
      select a.family, a.role as capability
      from tr a
      where a.task_id = r.task_id
        and a.kind = 'advance'
        and a.to_key = r.from_key
        and a.role is not null
        and a.created_at < r.created_at
      order by a.created_at desc
      limit 1
    ) p on true
    where r.kind = 'reject'
  ),

  -- Token spend, attributed to the (family, capability) the sweep exercised.
  --
  -- The sweep's capability is the role of the FIRST role-bearing transition the family
  -- made in that sweep — not the last. A sweep may cross more than one stage: the
  -- integrator that merges (integrating→validating, role:integrator) and then confirms
  -- the merge is green (validating→done, role:reviewer) does both under ONE harness
  -- invocation and reports usage ONCE, at the end. Charging the last transition put the
  -- whole cost on role:reviewer and left role:integrator reading `unknown` — which M20
  -- promises means "not measured", not "measured and filed elsewhere". The first
  -- transition is the work that earned the spend; the later ones are what it went on to
  -- do with it.
  --
  -- The SWEEP WINDOW is bounded by the family's previous usage event on the same task,
  -- because usage is reported once per sweep: everything after that report and at or
  -- before this one belongs to this sweep. Without the lower bound, "first" would reach
  -- back into an earlier sweep — an implementer whose work was rejected and who
  -- re-implements would have its second sweep charged to its first transition, forever.
  -- A family's first sweep on a task has no previous report, so the window opens at
  -- -infinity, which is correct: there is nothing earlier to confuse it with.
  --
  -- Tokens only — no USD is ever stored (D3). Cache fields may be null (an unrecognized
  -- sub-shape) → treated as 0 for summing; a family with NO usage event gets no row here
  -- at all, so the final LEFT JOIN leaves its tokens NULL (unknown ≠ free).
  usage as (
    select
      fam.key as family,
      case when e.data ? 'transition' then (
        -- ANCHORED (v9): the writer named the transition this spend earned. Exact.
        select ar.role from tr ar
        where ar.id::text = e.data ->> 'transition' and ar.family = fam.key
      ) else (
        -- UNANCHORED (pre-v9 history, and harnesses without a streamed shape): #147's
        -- reading — the first role-bearing transition of the sweep window.
        select ur.role from tr ur
        where ur.task_id = e.task_id and ur.family = fam.key
          and ur.role is not null
          and ur.created_at <= e.created_at
          and ur.created_at > coalesce(
            (
              select pe.created_at
              from app.events pe
              join app.agents pag on pag.id = pe.actor
              where pe.type = 'usage'
                and pe.task_id = e.task_id
                and pag.family_id = ag.family_id
                and pe.created_at < e.created_at
              order by pe.created_at desc, pe.id desc
              limit 1
            ),
            '-infinity'::timestamptz)
        order by ur.created_at asc, ur.id asc
        limit 1
      ) end as capability,
      coalesce((e.data -> 'tokens' ->> 'input')::bigint, 0)          as input_tokens,
      coalesce((e.data -> 'tokens' ->> 'output')::bigint, 0)         as output_tokens,
      coalesce((e.data -> 'tokens' ->> 'cache_read')::bigint, 0)     as cache_read_tokens,
      coalesce((e.data -> 'tokens' ->> 'cache_creation')::bigint, 0) as cache_creation_tokens,
      e.created_at
    from app.events e
    join app.agents ag          on ag.id = e.actor
    join app.agent_families fam on fam.id = ag.family_id
    where e.type = 'usage'
  ),

  -- Aggregate each signal per (family, capability).
  d_agg as (
    select family, capability,
           count(*)          as delivered,
           min(created_at)   as first_delivery,
           max(created_at)   as last_delivery
    from deliveries group by family, capability
  ),
  r_agg as (
    select family, capability,
           count(*)                                            as rejected,
           count(*) filter (where cross_family)                as cross_family_rejected,
           count(*) filter (where reject_stage = 'reviewing')  as review_rejected,
           count(*) filter (where reject_stage = 'validating') as validation_rejected,
           max(created_at)                                     as last_reject
    from rejects group by family, capability
  ),
  u_agg as (
    select family, capability,
           count(*)                    as usage_events,
           sum(input_tokens)           as total_input_tokens,
           sum(output_tokens)          as total_output_tokens,
           sum(cache_read_tokens)      as total_cache_read_tokens,
           sum(cache_creation_tokens)  as total_cache_creation_tokens,
           sum(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens) as total_tokens,
           max(created_at)             as last_usage
    from usage where capability is not null group by family, capability
  ),

  -- Every (family, capability) that shows up in any signal.
  keys as (
    select family, capability from d_agg
    union
    select family, capability from r_agg
    union
    select family, capability from u_agg
  )

select
  k.family,
  k.capability,
  -- competence
  coalesce(d.delivered, 0)               as delivered,
  coalesce(r.rejected, 0)                as rejected,
  coalesce(r.review_rejected, 0)         as review_rejected,
  coalesce(r.validation_rejected, 0)     as validation_rejected,
  coalesce(r.cross_family_rejected, 0)   as cross_family_rejected,
  round(coalesce(r.rejected, 0)::numeric / nullif(d.delivered, 0), 3) as reject_rate,
  -- token spend (SEPARATE — never blended into competence; tokens, never USD)
  u.usage_events,
  u.total_input_tokens,
  u.total_output_tokens,
  u.total_cache_read_tokens,
  u.total_cache_creation_tokens,
  u.total_tokens,
  case when coalesce(d.delivered, 0) > 0
       then round(u.total_tokens::numeric / d.delivered) end as tokens_per_delivery,
  -- window handles (M21 fixes the semantics)
  least(d.first_delivery, r.last_reject)                       as first_activity,
  greatest(d.last_delivery, r.last_reject, u.last_usage)       as last_activity
from keys k
left join d_agg d using (family, capability)
left join r_agg r using (family, capability)
left join u_agg u using (family, capability);

-- migrate:down

create or replace function api.record_usage(
  actor  uuid,
  data   jsonb default '{}'::jsonb,
  task   uuid default null,
  family text default null
) returns jsonb
  language plpgsql
  security definer
  set search_path = app, pg_temp
  as $$
  declare
    v_task  uuid := task;
    v_fid   uuid;
    v_event app.events;
    v_row   app.sweep_usage;
    v_known boolean;
  begin
    v_known := actor is not null
               and exists (select 1 from app.agents a where a.id = record_usage.actor);

    -- Resolve the charged task from the actor's most-recent transition when the caller
    -- did not name one (the driver may, or leave it to us).
    if v_task is null and v_known then
      select e.task_id into v_task
      from app.events e
      where e.actor = record_usage.actor and e.type = 'transition'
      order by e.created_at desc, e.id desc
      limit 1;
    end if;

    -- The task-anchored path, unchanged.
    if v_task is not null then
      if not v_known then
        return app.envelope(false, 'unknown_actor', 'no agent for actor; cannot attribute usage');
      end if;
      insert into app.events (task_id, actor, type, data)
      values (v_task, record_usage.actor, 'usage', coalesce(data, '{}'::jsonb))
      returning * into v_event;
      return app.envelope(true, 'ok', null, null, to_jsonb(v_event));
    end if;

    -- No task: the sweep moved nothing. It still SPENT. Attribute to the named family, or
    -- to the actor's family when the actor is known (a worker that claimed earlier in the
    -- run but not in this sweep).
    if family is not null then
      select f.id into v_fid from app.agent_families f where f.key = family;
    elsif v_known then
      select ag.family_id into v_fid from app.agents ag where ag.id = record_usage.actor;
    end if;

    if v_fid is null then
      -- Refuse rather than orphan the spend — an unattributable number is worse than a
      -- missing one, because it reads as somebody's.
      return app.envelope(false, 'unknown_family',
        'no task and no resolvable family; cannot attribute sweep spend');
    end if;

    insert into app.sweep_usage (family_id, actor_sub, sweep, tokens, model)
    values (v_fid,
            record_usage.actor,
            nullif(data ->> 'sweep_id', ''),
            coalesce(data -> 'tokens', '{}'::jsonb),
            nullif(data ->> 'model', ''))
    returning * into v_row;

    return app.envelope(true, 'no_task_spend',
      'sweep moved no task; spend recorded against the family', null, to_jsonb(v_row));
  end;
  $$;

revoke execute on function api.record_usage(uuid, jsonb, uuid, text) from public;
grant execute on function api.record_usage(uuid, jsonb, uuid, text) to oversight;

create or replace view api.family_track_record as
with
  -- Every transition event decoded, with the acting family, the task's workflow, and
  -- the role:* the transition required (resolved from the transition definition).
  tr as (
    select
      e.id, e.task_id, e.actor, e.created_at,
      fam.key                    as family,
      e.data ->> 'kind'          as kind,
      e.data ->> 'from'          as from_key,
      e.data ->> 'to'            as to_key,
      s.workflow_id,
      (
        select rf
        from app.transitions x
        join app.stages sf on sf.id = x.from_stage
        join app.stages st on st.id = x.to_stage
        cross join lateral unnest(x.required_features) as rf
        where sf.workflow_id = s.workflow_id
          and sf.key = e.data ->> 'from'
          and st.key = e.data ->> 'to'
          and x.kind = e.data ->> 'kind'
          and rf like 'role:%'
        limit 1
      )                          as role
    from app.events e
    join app.agents ag         on ag.id = e.actor
    join app.agent_families fam on fam.id = ag.family_id
    join app.tasks t           on t.id = e.task_id
    join app.stages s          on s.id = t.stage
    where e.type = 'transition'
  ),

  -- Deliveries: an advance exercises the role the transition required.
  deliveries as (
    select family, role as capability, created_at
    from tr
    where kind = 'advance' and role is not null
  ),

  -- Rejects credited to the PRODUCER (D4): whoever last advanced INTO the rejected
  -- stage, before the reject. The capability charged is that producing advance's role;
  -- cross_family flags a reject called by a DIFFERENT family than produced the work.
  rejects as (
    select
      p.family                              as family,
      p.capability                          as capability,
      r.from_key                            as reject_stage,
      (r.family is distinct from p.family)  as cross_family,
      r.created_at
    from tr r
    join lateral (
      select a.family, a.role as capability
      from tr a
      where a.task_id = r.task_id
        and a.kind = 'advance'
        and a.to_key = r.from_key
        and a.role is not null
        and a.created_at < r.created_at
      order by a.created_at desc
      limit 1
    ) p on true
    where r.kind = 'reject'
  ),

  -- Token spend, attributed to the (family, capability) the sweep exercised.
  --
  -- The sweep's capability is the role of the FIRST role-bearing transition the family
  -- made in that sweep — not the last. A sweep may cross more than one stage: the
  -- integrator that merges (integrating→validating, role:integrator) and then confirms
  -- the merge is green (validating→done, role:reviewer) does both under ONE harness
  -- invocation and reports usage ONCE, at the end. Charging the last transition put the
  -- whole cost on role:reviewer and left role:integrator reading `unknown` — which M20
  -- promises means "not measured", not "measured and filed elsewhere". The first
  -- transition is the work that earned the spend; the later ones are what it went on to
  -- do with it.
  --
  -- The SWEEP WINDOW is bounded by the family's previous usage event on the same task,
  -- because usage is reported once per sweep: everything after that report and at or
  -- before this one belongs to this sweep. Without the lower bound, "first" would reach
  -- back into an earlier sweep — an implementer whose work was rejected and who
  -- re-implements would have its second sweep charged to its first transition, forever.
  -- A family's first sweep on a task has no previous report, so the window opens at
  -- -infinity, which is correct: there is nothing earlier to confuse it with.
  --
  -- Tokens only — no USD is ever stored (D3). Cache fields may be null (an unrecognized
  -- sub-shape) → treated as 0 for summing; a family with NO usage event gets no row here
  -- at all, so the final LEFT JOIN leaves its tokens NULL (unknown ≠ free).
  usage as (
    select
      fam.key as family,
      (
        select ur.role from tr ur
        where ur.task_id = e.task_id and ur.family = fam.key
          and ur.role is not null
          and ur.created_at <= e.created_at
          and ur.created_at > coalesce(
            (
              select pe.created_at
              from app.events pe
              join app.agents pag on pag.id = pe.actor
              where pe.type = 'usage'
                and pe.task_id = e.task_id
                and pag.family_id = ag.family_id
                and pe.created_at < e.created_at
              order by pe.created_at desc, pe.id desc
              limit 1
            ),
            '-infinity'::timestamptz)
        order by ur.created_at asc, ur.id asc
        limit 1
      ) as capability,
      coalesce((e.data -> 'tokens' ->> 'input')::bigint, 0)          as input_tokens,
      coalesce((e.data -> 'tokens' ->> 'output')::bigint, 0)         as output_tokens,
      coalesce((e.data -> 'tokens' ->> 'cache_read')::bigint, 0)     as cache_read_tokens,
      coalesce((e.data -> 'tokens' ->> 'cache_creation')::bigint, 0) as cache_creation_tokens,
      e.created_at
    from app.events e
    join app.agents ag          on ag.id = e.actor
    join app.agent_families fam on fam.id = ag.family_id
    where e.type = 'usage'
  ),

  -- Aggregate each signal per (family, capability).
  d_agg as (
    select family, capability,
           count(*)          as delivered,
           min(created_at)   as first_delivery,
           max(created_at)   as last_delivery
    from deliveries group by family, capability
  ),
  r_agg as (
    select family, capability,
           count(*)                                            as rejected,
           count(*) filter (where cross_family)                as cross_family_rejected,
           count(*) filter (where reject_stage = 'reviewing')  as review_rejected,
           count(*) filter (where reject_stage = 'validating') as validation_rejected,
           max(created_at)                                     as last_reject
    from rejects group by family, capability
  ),
  u_agg as (
    select family, capability,
           count(*)                    as usage_events,
           sum(input_tokens)           as total_input_tokens,
           sum(output_tokens)          as total_output_tokens,
           sum(cache_read_tokens)      as total_cache_read_tokens,
           sum(cache_creation_tokens)  as total_cache_creation_tokens,
           sum(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens) as total_tokens,
           max(created_at)             as last_usage
    from usage where capability is not null group by family, capability
  ),

  -- Every (family, capability) that shows up in any signal.
  keys as (
    select family, capability from d_agg
    union
    select family, capability from r_agg
    union
    select family, capability from u_agg
  )

select
  k.family,
  k.capability,
  -- competence
  coalesce(d.delivered, 0)               as delivered,
  coalesce(r.rejected, 0)                as rejected,
  coalesce(r.review_rejected, 0)         as review_rejected,
  coalesce(r.validation_rejected, 0)     as validation_rejected,
  coalesce(r.cross_family_rejected, 0)   as cross_family_rejected,
  round(coalesce(r.rejected, 0)::numeric / nullif(d.delivered, 0), 3) as reject_rate,
  -- token spend (SEPARATE — never blended into competence; tokens, never USD)
  u.usage_events,
  u.total_input_tokens,
  u.total_output_tokens,
  u.total_cache_read_tokens,
  u.total_cache_creation_tokens,
  u.total_tokens,
  case when coalesce(d.delivered, 0) > 0
       then round(u.total_tokens::numeric / d.delivered) end as tokens_per_delivery,
  -- window handles (M21 fixes the semantics)
  least(d.first_delivery, r.last_reject)                       as first_activity,
  greatest(d.last_delivery, r.last_reject, u.last_usage)       as last_activity
from keys k
left join d_agg d using (family, capability)
left join r_agg r using (family, capability)
left join u_agg u using (family, capability);
