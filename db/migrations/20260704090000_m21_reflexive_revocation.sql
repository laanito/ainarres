-- M21 Slice A (v5 governance) — reflexive temporary revocation: THE GATE.
-- design/reflexive-revocation.md · ADR 0022. The substrate temp-bans a family that
-- crosses a reject threshold at a capability — autonomously, exponential backoff,
-- self-healing — while permanent + qualitative stay human (M22).
--
-- The revocation MECHANISM already exists (ADR 0007: feature_denials, apply_effects).
-- This migration adds only what makes autonomous use SAFE:
--   1. a temporal dimension on denials (they expire)  — D2
--   2. a strike ledger, SEPARATE from denials          — D1
--   3. seeded, resolvable policy (threshold + backoff) — D5
--   4. the substrate-side rule, on the reject event    — D4/D3
--   5. effective_features ignoring expired denials     — D2
-- Governance only REMOVES; it never grants (D8) — this code path has no grant.

-- migrate:up

-- D2 — a denial can carry an expiry. NULL = permanent (the human / M22 case, and the
-- backward-compatible reading of every denial written before now). effective_features
-- (below) ignores a denial once expires_at <= now(): instant self-heal, lazy on the
-- next claim (ADR 0009), preserving ADR 0007's instant-veto direction.
alter table app.feature_denials add column expires_at timestamptz;
comment on column app.feature_denials.expires_at is
  'NULL = permanent (human). Non-null = a reflexive temporary ban that self-heals at this instant (M21).';

-- D1 — the strike ledger. SEPARATE from feature_denials because auth denies ANY
-- feature with a denial row, so strikes cannot live there (a single strike would ban).
-- `strikes` counts attributable rejects SINCE THE LAST BAN (resets on ban — D3);
-- `ban_count` is the total bans ever, MONOTONIC, and SURVIVES a denial's expiry (no
-- shed by waiting — D2/governance.md). Auth never consults this table.
create table app.governance_strikes (
  family_id      uuid not null references app.agent_families(id) on delete cascade,
  feature_id     uuid not null references app.features(id) on delete cascade,
  strikes        int  not null default 0,
  ban_count      int  not null default 0,
  first_strike_at timestamptz not null default now(),
  last_strike_at  timestamptz not null default now(),
  primary key (family_id, feature_id)
);

-- D5 — resolvable, seeded policy: threshold + backoff resolve
-- capability → workflow → system default (the resolve_lease / resolve_max_attempts
-- pattern). Data, not constants: tunable per capability/workflow with no migration.
-- scope_key holds the capability NAME ('role:implementer') or the workflow id::text;
-- NULL for the system row.
create table app.governance_policy (
  scope_kind       text not null check (scope_kind in ('capability','workflow','system')),
  scope_key        text,
  reject_threshold int,
  backoff_base     interval,
  backoff_cap      interval,
  unique (scope_kind, scope_key)
);
-- The seeded system default (conservative first values — design D5).
insert into app.governance_policy (scope_kind, scope_key, reject_threshold, backoff_base, backoff_cap)
values ('system', null, 3, interval '1 hour', interval '24 hours');

revoke all on app.governance_strikes, app.governance_policy from public;
grant select on app.governance_strikes, app.governance_policy to oversight;

-- Resolve the policy for a (capability, workflow): most specific first, with a
-- hardcoded system fallback so the rule is safe even if the seed row is absent.
create function app.resolve_governance_policy(p_capability text, p_workflow uuid)
  returns table (threshold int, base interval, cap interval)
  language sql stable
  set search_path = app, pg_temp
  as $$
    select
      coalesce(cap_p.reject_threshold, wf_p.reject_threshold, sys_p.reject_threshold, 3),
      coalesce(cap_p.backoff_base,     wf_p.backoff_base,     sys_p.backoff_base,     interval '1 hour'),
      coalesce(cap_p.backoff_cap,      wf_p.backoff_cap,      sys_p.backoff_cap,      interval '24 hours')
    from (select 1) _
    left join app.governance_policy cap_p on cap_p.scope_kind = 'capability' and cap_p.scope_key = p_capability
    left join app.governance_policy wf_p  on wf_p.scope_kind  = 'workflow'   and wf_p.scope_key  = p_workflow::text
    left join app.governance_policy sys_p on sys_p.scope_kind = 'system';
  $$;
revoke execute on function app.resolve_governance_policy(text, uuid) from public;

-- D4/D3 — the reflexive rule. Credit a reject to the PRODUCER (whoever last advanced
-- INTO the rejected stage — the M20 family_track_record attribution), add a strike at
-- that producer's role, and when strikes cross the resolved threshold, write an
-- EXPIRING denial with `base · 2^ban_count` backoff (capped). Fail-safe throughout: no
-- resolvable producer / capability / feature → strike no one (never guess who to
-- punish). Never grants (D8). SECURITY DEFINER to write the app.* governance tables.
create function app.register_reject(p_task uuid, p_rejected_stage text)
  returns void
  language plpgsql
  security definer
  set search_path = app, pg_temp
  as $$
  declare
    v_workflow    uuid;
    v_actor       uuid;
    v_from_key    text;
    v_family      uuid;
    v_capability  text;
    v_feature     uuid;
    v_threshold   int;
    v_base        interval;
    v_cap         interval;
    v_strikes     int;
    v_bans        int;
  begin
    select l.workflow_id into v_workflow
    from app.tasks t join app.lanes l on l.id = t.lane_id
    where t.id = p_task;
    if v_workflow is null then return; end if;

    -- The producing advance: the most recent advance INTO the rejected stage.
    select e.actor, e.data ->> 'from' into v_actor, v_from_key
    from app.events e
    where e.task_id = p_task and e.type = 'transition'
      and e.data ->> 'kind' = 'advance' and e.data ->> 'to' = p_rejected_stage
      and e.actor is not null
    order by e.created_at desc
    limit 1;
    if v_actor is null then return; end if;               -- fail-safe: no producer to credit

    select family_id into v_family from app.agents where id = v_actor;
    if v_family is null then return; end if;

    -- The capability the producer exercised = the role:* that advance required.
    select rf into v_capability
    from app.transitions x
    join app.stages sf on sf.id = x.from_stage
    join app.stages st on st.id = x.to_stage
    cross join lateral unnest(x.required_features) as rf
    where sf.workflow_id = v_workflow and sf.key = v_from_key and st.key = p_rejected_stage
      and x.kind = 'advance' and rf like 'role:%'
    limit 1;
    if v_capability is null then return; end if;

    select id into v_feature from app.features where name = v_capability;
    if v_feature is null then return; end if;

    select threshold, base, cap into v_threshold, v_base, v_cap
    from app.resolve_governance_policy(v_capability, v_workflow);

    -- Add the strike (create the ledger row on first offense).
    insert into app.governance_strikes (family_id, feature_id, strikes, ban_count, last_strike_at)
    values (v_family, v_feature, 1, 0, now())
    on conflict (family_id, feature_id) do update
      set strikes = app.governance_strikes.strikes + 1, last_strike_at = now()
    returning strikes, ban_count into v_strikes, v_bans;

    -- Threshold crossed → apply an EXPIRING denial (never weaken a permanent/human one),
    -- bump ban_count, reset strikes. Backoff = base · 2^ban_count, capped.
    if v_strikes >= v_threshold then
      insert into app.feature_denials (family_id, feature_id, reason, expires_at)
      values (v_family, v_feature,
              format('reflexive: %s rejects at %s', v_strikes, v_capability),
              now() + least(v_base * (2 ^ v_bans), v_cap))
      on conflict (family_id, feature_id) do update
        set expires_at = excluded.expires_at, reason = excluded.reason
        where app.feature_denials.expires_at is not null;   -- D2: never override a permanent ban

      update app.governance_strikes
        set ban_count = ban_count + 1, strikes = 0
        where family_id = v_family and feature_id = v_feature;
    end if;
  end;
  $$;
revoke execute on function app.register_reject(uuid, text) from public;

-- The substrate-side hook: fire the rule when a reject transition is stamped. On the
-- EVENT insert (not by editing do_transition) so the reject path is untouched and the
-- rule is decoupled. Fail-safe: any error is swallowed so bookkeeping NEVER fails the
-- legitimate reject (design risk note). No recursion — register_reject writes no events.
create function app.on_reject_register_strike()
  returns trigger
  language plpgsql
  security definer
  set search_path = app, pg_temp
  as $$
  begin
    if new.type = 'transition' and new.data ->> 'kind' = 'reject' and (new.data ? 'from') then
      begin
        perform app.register_reject(new.task_id, new.data ->> 'from');
      exception when others then
        null;  -- a strike-bookkeeping error must never fail the reject
      end;
    end if;
    return new;
  end;
  $$;
revoke execute on function app.on_reject_register_strike() from public;

create trigger events_reflexive_revocation
  after insert on app.events
  for each row
  when (new.type = 'transition')
  execute function app.on_reject_register_strike();

-- D2 — effective_features now ignores EXPIRED denials (create-or-replace; only the
-- denial subquery's freshness predicate is added).
create or replace function api.effective_features() returns text[]
  language plpgsql
  stable
  security definer
  set search_path = app, pg_temp
  as $$
  declare
    claims  jsonb := api.jwt_claims();
    granted text[] := '{}';
    fam_id  uuid;
  begin
    if jsonb_typeof(claims -> 'features') = 'array' then
      select array_agg(elem) into granted
      from jsonb_array_elements_text(claims -> 'features') as elem;
      granted := coalesce(granted, '{}');
    end if;

    select id into fam_id from app.agent_families where key = (claims ->> 'family');

    -- Keep a granted feature unless the family has an ACTIVE denial for it. A denial is
    -- active when permanent (expires_at is null) or not yet expired (M21).
    return array(
      select g.feat
      from unnest(granted) as g(feat)
      where fam_id is null
         or not exists (
           select 1
           from app.feature_denials d
           join app.features ft on ft.id = d.feature_id
           where d.family_id = fam_id and ft.name = g.feat
             and (d.expires_at is null or d.expires_at > now())
         )
    );
  end;
  $$;
revoke execute on function api.effective_features() from public;
grant execute on function api.effective_features() to agent, oversight, reaper;

-- migrate:down
-- Restore the M2 effective_features (permanent-only denials).
create or replace function api.effective_features() returns text[]
  language plpgsql
  stable
  security definer
  set search_path = app, pg_temp
  as $$
  declare
    claims  jsonb := api.jwt_claims();
    granted text[] := '{}';
    fam_id  uuid;
  begin
    if jsonb_typeof(claims -> 'features') = 'array' then
      select array_agg(elem) into granted
      from jsonb_array_elements_text(claims -> 'features') as elem;
      granted := coalesce(granted, '{}');
    end if;
    select id into fam_id from app.agent_families where key = (claims ->> 'family');
    return array(
      select g.feat
      from unnest(granted) as g(feat)
      where fam_id is null
         or not exists (
           select 1
           from app.feature_denials d
           join app.features ft on ft.id = d.feature_id
           where d.family_id = fam_id and ft.name = g.feat
         )
    );
  end;
  $$;
revoke execute on function api.effective_features() from public;
grant execute on function api.effective_features() to agent, oversight, reaper;

drop trigger if exists events_reflexive_revocation on app.events;
drop function if exists app.on_reject_register_strike();
drop function if exists app.register_reject(uuid, text);
drop function if exists app.resolve_governance_policy(text, uuid);
drop table if exists app.governance_policy;
drop table if exists app.governance_strikes;
alter table app.feature_denials drop column if exists expires_at;
