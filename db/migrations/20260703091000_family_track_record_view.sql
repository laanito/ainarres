-- M20 Slice B (v5 governance; design/track-record.md D2/D4/D5). The family track
-- record — the read-only signal M21's ban rule will consume. NO new mechanism: it
-- AGGREGATES the already-attributable event log (M16) plus the `type='usage'` events
-- Slice A began writing. Read-only; granted to oversight.
--
-- It is a SQL VIEW (not JS in the report — D2) because M20's ultimate consumer is
-- M21's ban rule, which runs in-DB. The report just reads the view; M21 reads the same
-- view. One source of truth for the record, in the plane that needs it.
--
-- Keyed per (family, capability) — competence is per-pairing-per-role (ADR 0007). The
-- "capability" is the role:* feature a transition required.
--
-- ATTRIBUTION (D4): a delivery is an advance by the family exercising a role. A reject
-- is credited to the PRODUCER — whoever last advanced INTO the rejected stage — at that
-- producer's role (the M19 familyOfTransition reuse), NOT to the reviewer who called it.
-- So each role is judged by the gate immediately downstream of it.
--
-- SEPARATION (D3): token-spend columns sit BESIDE the competence columns, never folded
-- in — spend ≠ competence. A family with no `usage` event reads as token-NULL
-- (unknown), never 0 (free): opencode/grok emit no parseable tokens, so Slice A writes
-- them no usage event, and this view's LEFT JOIN yields NULL — the "unknown ≠ free"
-- property, realized here rather than by writing empty events.
--
-- WINDOW (D5): raw, windowable aggregates + first/last-activity timestamps. The view
-- does NOT hardcode a window or a threshold — those are M21's to fix. Measure now,
-- judge later.

-- migrate:up

create view api.family_track_record as
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

  -- Token spend, attributed to the (family, capability) the sweep exercised: a usage
  -- event's capability = the acting family's most-recent transition on that task at or
  -- before the usage event (the driver records usage right after the sweep's
  -- transition). Tokens only — no USD is ever stored (D3). Cache fields may be null
  -- (an unrecognized sub-shape) → treated as 0 for summing; a family with NO usage
  -- event gets no row here at all, so the final LEFT JOIN leaves its tokens NULL.
  usage as (
    select
      fam.key as family,
      (
        select ur.role from tr ur
        where ur.task_id = e.task_id and ur.family = fam.key
          and ur.created_at <= e.created_at
        order by ur.created_at desc
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

revoke all on api.family_track_record from public;
grant select on api.family_track_record to oversight;

-- migrate:down
drop view if exists api.family_track_record;
