-- v8 — THE SPEND THE METRIC COULD NOT SEE: a sweep that claims nothing still costs.
--
-- What M20 assumed. api.record_usage resolves the charged task from the actor's most
-- recent transition, and when there is none it returns `no_work` and writes nothing. Its
-- own migration calls that "the empty-sweep invariant, enforced in the substrate, not
-- merely by driver discipline". At the time the reasoning was sound: an empty sweep was
-- assumed to have done nothing worth attributing.
--
-- What measurement showed (2026-08-28). In one real delivery, three implementer tiers woke
-- after the pool had already claimed the only pending task, found nothing, and burned:
--
--   opencode+nemotron-3-ultra   41 steps   304,210 tokens
--   opencode+muse-glimmer       20 steps   140,323 tokens
--   cursor-agent+composer-2.5   15 steps    29,706 tokens
--
-- ~474k tokens — about 21% of that delivery's recorded cost — spent discovering there was
-- nothing to do. NONE of it was recorded. An empty sweep does not cost nothing; it costs a
-- model load, a system prompt, a board read, and a decision to stop. The invariant was
-- measuring the wrong thing: not "was spend incurred" but "was a task moved".
--
-- Worse, the blindness is biased. It hides spend precisely where waste concentrates —
-- redundant tiers, thrashing pools, a family that claims nothing all day — so the metric
-- was quietest exactly when it should have been loudest. The demand-gate fix that removes
-- this waste (M27) could not be shown to work, because the thing it saves was never
-- counted.
--
-- Why this is a ledger and not an event. The same wall M22 (D7) and the v8 operator seat
-- hit: app.events.task_id is NOT NULL, and task-less spend HAS no task by definition. So
-- it gets its own append-only ledger, the third time that reconciliation has been the
-- right answer.
--
-- What this does NOT do. It does not fold task-less spend into api.family_track_record.
-- That view is per-(family, capability), and spend with no task has no capability to
-- attribute to — blending it would corrupt a competence signal with a cost one, which is
-- exactly the separation D3 exists to protect. It is surfaced ALONGSIDE, never merged.

-- migrate:up

-- The ledger. Append-only (belt: the triggers; suspenders: the revoked grants).
-- `sweep` is the driver's per-sweep uuid, so a row can be traced back to one harness
-- invocation and its log. No task column, deliberately: this table exists for the rows
-- that cannot have one, and a nullable task here would invite task-anchored spend to
-- drift out of app.events where it belongs.
create table app.sweep_usage (
  id         uuid primary key default uuidv7(),
  family_id  uuid not null references app.agent_families(id) on delete cascade,
  actor_sub  uuid,
  -- TEXT, not uuid: `sweep` is whatever the caller labelled the sweep, and the driver's
  -- uuid is only the current convention. A ledger that exists to stop spend being lost
  -- must never reject a real number because a label was not a uuid.
  sweep      text,
  tokens     jsonb not null default '{}'::jsonb,
  model      text,
  created_at timestamptz not null default now()
);
create index sweep_usage_feed on app.sweep_usage (created_at);
create index sweep_usage_by_family on app.sweep_usage (family_id, created_at);
revoke all on app.sweep_usage from public;
grant select on app.sweep_usage to oversight;
grant select on app.sweep_usage to monitor;

create function app.sweep_usage_append_only() returns trigger
  language plpgsql as $$
begin
  raise exception 'app.sweep_usage is append-only (% not allowed)', tg_op
    using errcode = 'restrict_violation';
end;
$$;
create trigger sweep_usage_no_update
  before update on app.sweep_usage
  for each row execute function app.sweep_usage_append_only();
create trigger sweep_usage_no_delete
  before delete on app.sweep_usage
  for each row execute function app.sweep_usage_append_only();

-- record_usage gains a `family` argument and a second destination. The TASK-ANCHORED path
-- is byte-for-byte what it was: actor must resolve to a known agent, the task comes from
-- the caller or the actor's last transition, and the row lands in app.events as before.
-- Only the case that previously returned `no_work` changes.
--
-- The actor check moves to where it is actually needed. A sweep that never claimed never
-- gets an app.agents row (ensure_agent runs on claim/create), so requiring one would
-- refuse exactly the spend this migration exists to capture. For the task-less path the
-- FAMILY is named by the driver — which is what the driver already knows, and no weaker a
-- claim than the number itself, which it has always been trusted to assert. Attribution
-- for task-anchored spend still goes actor→agents→agent_families and is NOT weakened.
--
-- The 3-arg form is dropped rather than overloaded: two candidates with defaults make a
-- 3-argument call ambiguous, and PostgREST resolves by named arguments anyway.
drop function if exists api.record_usage(uuid, jsonb, uuid);

create function api.record_usage(
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

-- The surface: task-less spend per family, newest first, with the token total already
-- summed so a formatter stays dumb. `tokens` keys mirror the event payload
-- (input/output/cache_read/cache_creation); a missing key counts as 0 HERE because the
-- row exists — this is a total over rows we HAVE, not a claim about families we have not
-- measured. An unmeasured family still has no row at all, and still reads as unknown.
create view api.sweep_usage as
select
  af.key as family,
  count(*)::int as sweeps,
  sum(coalesce((su.tokens ->> 'input')::bigint, 0)
    + coalesce((su.tokens ->> 'output')::bigint, 0)
    + coalesce((su.tokens ->> 'cache_read')::bigint, 0)
    + coalesce((su.tokens ->> 'cache_creation')::bigint, 0))::bigint as tokens,
  max(su.created_at) as last_seen
from app.sweep_usage su
join app.agent_families af on af.id = su.family_id
group by af.key
order by tokens desc;

revoke all on api.sweep_usage from public;
grant select on api.sweep_usage to oversight;
grant select on api.sweep_usage to monitor;

-- migrate:down
drop view if exists api.sweep_usage;
drop function if exists api.record_usage(uuid, jsonb, uuid, text);
create function api.record_usage(actor uuid, data jsonb default '{}'::jsonb, task uuid default null)
  returns jsonb
  language plpgsql
  security definer
  set search_path = app, pg_temp
  as $$
  declare
    v_task  uuid := task;
    v_event app.events;
  begin
    if actor is null or not exists (select 1 from app.agents a where a.id = record_usage.actor) then
      return app.envelope(false, 'unknown_actor', 'no agent for actor; cannot attribute usage');
    end if;
    if v_task is null then
      select e.task_id into v_task
      from app.events e
      where e.actor = record_usage.actor and e.type = 'transition'
      order by e.created_at desc, e.id desc
      limit 1;
    end if;
    if v_task is null then
      return app.envelope(true, 'no_work', 'actor transitioned no task; no usage recorded');
    end if;
    insert into app.events (task_id, actor, type, data)
    values (v_task, record_usage.actor, 'usage', coalesce(data, '{}'::jsonb))
    returning * into v_event;
    return app.envelope(true, 'ok', null, null, to_jsonb(v_event));
  end;
  $$;
revoke execute on function api.record_usage(uuid, jsonb, uuid) from public;
grant execute on function api.record_usage(uuid, jsonb, uuid) to oversight;
drop trigger if exists sweep_usage_no_delete on app.sweep_usage;
drop trigger if exists sweep_usage_no_update on app.sweep_usage;
drop table if exists app.sweep_usage;
drop function if exists app.sweep_usage_append_only();
