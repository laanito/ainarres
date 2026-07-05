-- M22 Slice A (v5 governance) — the auditor role & the human boundary.
-- design/auditor.md · ADR 0022. Completes the v5 envelope with the failures a rule must
-- NOT decide alone: the QUALITATIVE flag (raised to a human, no auto-denial) and the
-- PERMANENT ban (human-only, audited). No new revocation mechanism — permanent = a
-- feature_denials row with a NULL expiry (M21's temporal column, ADR 0007 apply_effects
-- shape). This migration adds:
--   1. role:auditor — a plain role feature, human-held (D6)
--   2. governance_policy recommend thresholds — data for the D5 permanent recommendation
--   3. app.governance_actions — an append-only ledger of human ban/lift acts (D4/D7*)
--   4. api.raise_audit_flag  — role:auditor; emits an event, writes NO denial (D2)
--   5. api.set_permanent_ban / api.lift_ban — oversight-only, audited (D4)
--
-- (*) D7 reconciliation, found during the build: the design said "governance actions are
-- events," but app.events.task_id is NOT NULL and a permanent ban is family/capability-
-- scoped, not task-scoped. So the human-action trail is its own append-only ledger
-- (governance_actions); the AUDIT FLAG stays an event because it IS task-anchored (D8).
-- The design note is amended to match.

-- migrate:up

-- D6 — the auditor role. A plain feature (name = 'role:auditor'), human-held this version,
-- federatable later. Existence is all this migration seeds; GRANTING it to a family is an
-- owner reprovision (ADR 0007 asymmetry), exactly like the other role features.
insert into app.features (kind, key) values ('role', 'auditor')
  on conflict (kind, key) do nothing;

-- D5 — thresholds for the PERMANENT-BAN RECOMMENDATION (a read-only signal built in
-- Slice B). Recommend when reflexive bans recur (ban_count) or an auditor flags a
-- (family, capability) repeatedly (flag count). Data on the existing policy table, so it
-- is tunable capability→workflow→system without a migration (the M21 D5 pattern). NULL =
-- "no recommendation from this input"; seeded conservatively on the system row.
alter table app.governance_policy
  add column recommend_ban_count  int,
  add column recommend_flag_count int;
update app.governance_policy
  set recommend_ban_count = 3, recommend_flag_count = 2
  where scope_kind = 'system';

-- D4/D7 — the human-action ledger. Append-only (belt: the block trigger below; suspenders:
-- the revoked grants). Governance actions are family/capability-scoped, not task-scoped, so
-- they live here, NOT in app.events. actor_sub = the oversight caller's token subject when
-- present, NULL for a human/system act.
create table app.governance_actions (
  id         uuid primary key default uuidv7(),
  family_id  uuid not null references app.agent_families(id) on delete cascade,
  feature_id uuid not null references app.features(id) on delete cascade,
  action     text not null check (action in ('ban_permanent', 'lift')),
  reason     text,
  actor_sub  uuid,
  created_at timestamptz not null default now()
);
create index governance_actions_feed on app.governance_actions (created_at);
revoke all on app.governance_actions from public;
grant select on app.governance_actions to oversight;

create function app.governance_actions_append_only() returns trigger
  language plpgsql as $$
begin
  raise exception 'app.governance_actions is append-only (% not allowed)', tg_op
    using errcode = 'restrict_violation';
end;
$$;
create trigger governance_actions_no_update
  before update on app.governance_actions
  for each row execute function app.governance_actions_append_only();
create trigger governance_actions_no_delete
  before delete on app.governance_actions
  for each row execute function app.governance_actions_append_only();

-- D2 — the auditor's flag. A QUALITATIVE signal: it records a delivery-vs-request/design
-- gap against the producing (designer/integrator) family and writes NO feature_denials
-- (the qualitative path never auto-penalizes — ADR 0022). Gated on role:auditor via
-- effective_features (the same gate the workflow verbs use). Task-anchored (D8): the flag
-- attaches to the shipped task that embodies the gap, satisfying events.task_id NOT NULL.
create function api.raise_audit_flag(
  p_task           uuid,
  p_subject_family text,
  p_capability     text,
  p_gap            text,
  p_severity       text default 'warning'
) returns jsonb
  language plpgsql
  security definer
  set search_path = app, pg_temp
  as $$
  declare
    claims  jsonb  := api.jwt_claims();
    sub     uuid   := nullif(claims ->> 'sub', '')::uuid;
    eff     text[] := api.effective_features();
    v_fid   uuid;
    v_subject_fid uuid;
    v_task  app.tasks;
    v_event app.events;
  begin
    if sub is null then
      return app.envelope(false, 'not_eligible', 'no subject in token');
    end if;
    -- Gate: only role:auditor may flag (D6). A non-auditor is refused, never silently.
    if not (eff @> array['role:auditor']) then
      return app.envelope(false, 'not_eligible', 'missing feature role:auditor');
    end if;

    v_fid := app.ensure_agent(sub, claims ->> 'family');
    if v_fid is null then
      return app.envelope(false, 'not_eligible', 'unknown family');
    end if;

    -- The flag must name a real task and a real subject family (never flag a phantom).
    select * into v_task from app.tasks where id = p_task;
    if not found then
      return app.envelope(false, 'not_found', 'no such task');
    end if;
    select id into v_subject_fid from app.agent_families where key = p_subject_family;
    if v_subject_fid is null then
      return app.envelope(false, 'not_found', format('no family %L', p_subject_family));
    end if;
    if p_gap is null or btrim(p_gap) = '' then
      return app.envelope(false, 'not_eligible', 'a flag must state the gap');
    end if;

    -- Record the qualitative signal as an event on the shipped task. NO denial written.
    insert into app.events (task_id, actor, type, data)
    values (p_task, sub, 'audit_flag',
            jsonb_build_object(
              'subject_family', p_subject_family,
              'capability',     p_capability,
              'gap',            p_gap,
              'severity',       coalesce(p_severity, 'warning')))
    returning * into v_event;

    return app.envelope(true, 'ok', null, null, to_jsonb(v_event));
  end;
  $$;
revoke execute on function api.raise_audit_flag(uuid, text, text, text, text) from public;
-- role:auditor is enforced INSIDE the verb (effective_features); execute is open to any
-- authenticated agent so the gate — not table grants — decides. An anon token has no
-- role:auditor and is refused with a value envelope.
grant execute on function api.raise_audit_flag(uuid, text, text, text, text) to agent, oversight;

-- D4 — make a ban PERMANENT. Oversight-only (the belt is the EXECUTE grant: an agent role
-- has none → PostgREST refuses before entry). Writes a NULL-expiry feature_denials row
-- (permanent), converting any temporary M21 ban in place, and records the act in the
-- ledger. This is the ONLY route to a permanent denial outside a human apply_effects.
create function api.set_permanent_ban(
  p_family     text,
  p_capability text,
  p_reason     text default null
) returns jsonb
  language plpgsql
  security definer
  set search_path = app, pg_temp
  as $$
  declare
    claims   jsonb := api.jwt_claims();
    sub      uuid  := nullif(claims ->> 'sub', '')::uuid;
    v_fid    uuid;
    v_feat   uuid;
  begin
    select id into v_fid from app.agent_families where key = p_family;
    if v_fid is null then
      return app.envelope(false, 'not_found', format('no family %L', p_family));
    end if;
    select id into v_feat from app.features where name = p_capability;
    if v_feat is null then
      return app.envelope(false, 'not_found', format('no capability %L', p_capability));
    end if;

    -- Permanent = NULL expiry (D2). Convert a temporary ban in place if one exists.
    insert into app.feature_denials (family_id, feature_id, reason, expires_at)
    values (v_fid, v_feat, coalesce(p_reason, 'permanent ban (human)'), null)
    on conflict (family_id, feature_id) do update
      set expires_at = null, reason = coalesce(excluded.reason, app.feature_denials.reason);

    insert into app.governance_actions (family_id, feature_id, action, reason, actor_sub)
    values (v_fid, v_feat, 'ban_permanent', p_reason, sub);

    return app.envelope(true, 'ok', null, null,
      jsonb_build_object('family', p_family, 'capability', p_capability, 'permanent', true));
  end;
  $$;
revoke execute on function api.set_permanent_ban(text, text, text) from public;
grant execute on function api.set_permanent_ban(text, text, text) to oversight;

-- D4 — LIFT a ban (temporary or permanent). Oversight-only. Removes the denial so the
-- capability returns on the family's next claim (ADR 0009 lazy restore), and records it.
create function api.lift_ban(
  p_family     text,
  p_capability text,
  p_reason     text default null
) returns jsonb
  language plpgsql
  security definer
  set search_path = app, pg_temp
  as $$
  declare
    claims   jsonb := api.jwt_claims();
    sub      uuid  := nullif(claims ->> 'sub', '')::uuid;
    v_fid    uuid;
    v_feat   uuid;
    v_gone   int;
  begin
    select id into v_fid from app.agent_families where key = p_family;
    if v_fid is null then
      return app.envelope(false, 'not_found', format('no family %L', p_family));
    end if;
    select id into v_feat from app.features where name = p_capability;
    if v_feat is null then
      return app.envelope(false, 'not_found', format('no capability %L', p_capability));
    end if;

    delete from app.feature_denials where family_id = v_fid and feature_id = v_feat;
    get diagnostics v_gone = row_count;

    insert into app.governance_actions (family_id, feature_id, action, reason, actor_sub)
    values (v_fid, v_feat, 'lift', p_reason, sub);

    return app.envelope(true, 'ok', null, null,
      jsonb_build_object('family', p_family, 'capability', p_capability, 'lifted', v_gone > 0));
  end;
  $$;
revoke execute on function api.lift_ban(text, text, text) from public;
grant execute on function api.lift_ban(text, text, text) to oversight;

-- migrate:down
drop function if exists api.lift_ban(text, text, text);
drop function if exists api.set_permanent_ban(text, text, text);
drop function if exists api.raise_audit_flag(uuid, text, text, text, text);
drop trigger if exists governance_actions_no_delete on app.governance_actions;
drop trigger if exists governance_actions_no_update on app.governance_actions;
drop function if exists app.governance_actions_append_only();
drop table if exists app.governance_actions;
alter table app.governance_policy
  drop column if exists recommend_flag_count,
  drop column if exists recommend_ban_count;
delete from app.features where kind = 'role' and key = 'auditor';
