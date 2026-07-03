-- M20 Slice A (v5 governance) — the one new write path of the family track record:
-- `api.record_usage`, a privileged verb that stamps a task's token spend into the
-- event log as a `type='usage'` event (design/track-record.md D1). It is the ONLY
-- new mechanism M20 adds; the competence signal is already in the `type='transition'`
-- events (M16), and the track-record VIEW (Slice B) reads both.
--
-- Why a privileged verb the DRIVER calls (not the agent): the `exec` model. Every
-- poller `exec`s into its tool, so the harness process is REPLACED and its result
-- JSON (the token counts) only exists AFTER it exits, captured by the driver into
-- $RUN_DIR/*.log. The agent literally cannot report its own usage — it is gone by the
-- time the number is known. So the driver parses the sweep log and calls this verb.
-- Attribution stays honest exactly as every other event: `p_actor` is the real `sub`
-- the driver minted for that sweep, so actor→agents→agent_families yields the true
-- FAMILY being charged; the driver only *asserts the number*, never the identity.
--
-- Tokens, never USD (design/track-record.md D3): the payload carries per-model token
-- counts; a `total_cost_usd` is meaningless for local/free models and is a UI-level
-- translation (two-plane, ADR 0003) — the substrate stores the primitive only.
--
-- Granted to `oversight` (not `agent`): oversight is the driver's privileged,
-- non-agent identity and is v5's write role for the human/driver side of governance
-- (M22's permanent-ban RPC lands there too). An agent token cannot call this — it
-- must not be able to write its own scorecard.

-- migrate:up

-- record_usage: append one `type='usage'` event for the task an actor most recently
-- worked, carrying the driver-parsed token payload. Resolves the task from the
-- actor's last transition when not given (the coarse "last task this sweep touched" —
-- track-record.md risk: a sweep may touch several tasks). A sweep that did no work
-- has no transition → no task → NO event: the empty-sweep invariant, enforced in the
-- substrate, not merely by driver discipline.
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
    -- The actor must resolve to a known agent (events.actor is a FK): no agent row
    -- means we cannot attribute a family, so we refuse rather than orphan the spend.
    if actor is null or not exists (select 1 from app.agents a where a.id = record_usage.actor) then
      return app.envelope(false, 'unknown_actor', 'no agent for actor; cannot attribute usage');
    end if;

    -- Resolve the charged task from the actor's most-recent transition when the
    -- caller did not name one (the driver may, or leave it to us).
    if v_task is null then
      select e.task_id into v_task
      from app.events e
      where e.actor = record_usage.actor and e.type = 'transition'
      order by e.created_at desc, e.id desc
      limit 1;
    end if;

    -- No task the actor transitioned → nothing chargeable → no event.
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

-- migrate:down
drop function if exists api.record_usage(uuid, jsonb, uuid);
