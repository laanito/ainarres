-- v8 step 2 (ADR 0028 — the agent operator seat): the SEAT IDENTITY and its LEDGER.
--
-- The problem this closes. Until now "the operator" was not an identity — it was
-- whoever held JWT_SECRET, minting as whichever family the act happened to need:
-- `human+intaker` to refine a brief, `claude-code+opus` to create the dev work,
-- `loop+driver` to unblock. Every one of those acts landed in the impersonated
-- family's history and, through M20, in its TRACK RECORD. An operator that refines
-- ten briefs makes `human+intaker` look like a prolific worker; an operator whose
-- create fails credits the failure to a designer family that was never involved.
-- Attribution was borrowed, so governance measured the wrong family.
--
-- The fix is the smallest one available: REGISTER THE SEAT AS A FAMILY (db/seed.sql,
-- `agent+operator`) and give it a feature that says what it is (`role:operator`).
-- No new mechanism — ADR 0007's family+features model, one more family, exactly as
-- M26 seated `human+intaker` for the intake channel's caller. From here on, an
-- operator act carries the operator's name in app.events like any other actor, and
-- api.family_track_record scores `agent+operator` for what the operator did.
--
-- The ledger, and why it is not app.events. Most of what an operator does is
-- task-shaped and therefore ALREADY an event (created / claimed / advanced, joined to
-- the acting family). But the operator also acts on the INSTANCE: it starts and stops
-- the standing service, it reconfigures a tier, it reads a report and decides to do
-- nothing. app.events.task_id is NOT NULL, so those acts have nowhere to land. They
-- get their own append-only ledger — the same reconciliation M22 D7 hit for human
-- ban/lift acts (app.governance_actions), reached for the same reason.
--
-- What this ledger is NOT. It is written BY THE SEAT, so it is a good-faith trail,
-- not proof: a seat that omits a write leaves no row. That is tolerable precisely
-- because it is not the only record — everything task-shaped is independently in
-- app.events under the operator's own family key, and the events table is append-only
-- by trigger. The ledger's unique load is the instance-scoped acts nothing else can
-- hold. Read them together; trust the events more.
--
-- Slice split (ADR 0028 § bootstrap discipline): this migration + the seed + the verb
-- are ASSISTED (auth-adjacent DDL cannot self-validate in a worktree — the board-wipe
-- lesson). The report line over api.operator_actions goes to the SWARM as a pure
-- formatter brief, the split that has held since #87.

-- migrate:up

-- The seat marker. A plain feature, like role:auditor (M22 D6): existence is all this
-- migration seeds — GRANTING it to a family is an owner reprovision (ADR 0007's
-- grant/deny asymmetry). It gates exactly one thing, api.record_operator_action below.
-- It grants no lane, no capability, and no workflow transition anywhere: holding
-- role:operator lets you SAY what you did, never DO more.
insert into app.features (kind, key) values ('role', 'operator')
  on conflict (kind, key) do nothing;

-- The ledger. Append-only (belt: the trigger below; suspenders: the revoked grants),
-- newest read through api.operator_actions.
--
-- `task_id` is NULLABLE and that is the entire point of the table: an instance-scoped
-- act (service start, reconfigure) has no task, and a task-shaped act carries the id so
-- the ledger line can be read next to the task's own events.
--
-- `action` is deliberately NOT enumerated. M22's ledger could enumerate ('ban_permanent',
-- 'lift') because the human's levers are two and fixed; the operator's verb set grows
-- with each v8 step (step 3 adds service lifecycle). A shape check keeps it a stable
-- machine-readable slug without freezing the vocabulary into a migration.
--
-- `outcome` is what makes the ledger governable rather than decorative: a REFUSED act
-- (the envelope said no) and a FAILED act (it broke) are the operator's own misses, and
-- they must be visible as the operator's — v8's success gate asks for exactly this.
create table app.operator_actions (
  id         uuid primary key default uuidv7(),
  family_id  uuid not null references app.agent_families(id) on delete cascade,
  action     text not null check (action ~ '^[a-z][a-z0-9_]{0,62}$'),
  target     text check (target is null or length(target) <= 200),
  task_id    uuid references app.tasks(id) on delete set null,
  outcome    text not null default 'ok' check (outcome in ('ok', 'refused', 'failed')),
  reason     text check (reason is null or length(reason) <= 500),
  detail     jsonb not null default '{}'::jsonb,
  actor_sub  uuid,
  created_at timestamptz not null default now()
);
create index operator_actions_feed on app.operator_actions (created_at);
revoke all on app.operator_actions from public;
grant select on app.operator_actions to oversight;
grant select on app.operator_actions to monitor;

create function app.operator_actions_append_only() returns trigger
  language plpgsql as $$
begin
  raise exception 'app.operator_actions is append-only (% not allowed)', tg_op
    using errcode = 'restrict_violation';
end;
$$;
create trigger operator_actions_no_update
  before update on app.operator_actions
  for each row execute function app.operator_actions_append_only();
create trigger operator_actions_no_delete
  before delete on app.operator_actions
  for each row execute function app.operator_actions_append_only();

-- The write path. Gated on role:operator through api.effective_features() — the same
-- in-verb gate M22 D6 used for role:auditor, so a REVOKED seat (a feature_denial from
-- M21's reflexive revocation, or a human's permanent ban) stops being able to write its
-- own ledger the moment the denial lands. Governance reaches the operator like anyone.
--
-- The family written is the TOKEN'S family, never a parameter: the seat cannot file an
-- action under another family's name, which is the whole reason the seat got a name.
-- Unknown family ⇒ not_eligible, as everywhere else (ADR 0007).
--
-- BE HONEST ABOUT WHAT THIS GATE IS. api.effective_features() reads the SIGNED TOKEN's
-- features and subtracts active denials; it does NOT re-intersect against
-- app.family_features. That is ADR 0007 on purpose — the substrate trusts the token, and
-- provisioning is enforced when the token is MINTED. So this gate stops (a) an
-- unregistered family, (b) a token that never claimed role:operator, and (c) a seat
-- whose role:operator has been denied by governance. It does NOT stop anyone holding
-- JWT_SECRET from minting a seat token, because nothing in the database can. Closing
-- that is precisely the v8 credential-envelope step (ADR 0028 § in scope), not this one.
create function api.record_operator_action(
  p_action  text,
  p_target  text default null,
  p_task    uuid default null,
  p_outcome text default 'ok',
  p_reason  text default null,
  p_detail  jsonb default '{}'::jsonb
) returns jsonb
  language plpgsql
  security definer
  set search_path = app, pg_temp
  as $$
  declare
    claims jsonb  := api.jwt_claims();
    sub    uuid   := nullif(claims ->> 'sub', '')::uuid;
    eff    text[] := api.effective_features();
    v_fid  uuid;
    v_row  app.operator_actions;
  begin
    if sub is null then
      return app.envelope(false, 'not_eligible', 'no subject in token');
    end if;

    if not (eff @> array['role:operator']) then
      return app.envelope(false, 'not_eligible', 'missing feature role:operator');
    end if;

    if p_action is null or p_action !~ '^[a-z][a-z0-9_]{0,62}$' then
      return app.envelope(false, 'invalid', 'action must be a lower_snake slug (1-63 chars)');
    end if;

    if coalesce(p_outcome, 'ok') not in ('ok', 'refused', 'failed') then
      return app.envelope(false, 'invalid', 'outcome must be ok, refused or failed');
    end if;

    if p_task is not null and not exists (select 1 from app.tasks t where t.id = p_task) then
      return app.envelope(false, 'not_found', 'unknown task');
    end if;

    v_fid := app.ensure_agent(sub, claims ->> 'family');
    if v_fid is null then
      return app.envelope(false, 'not_eligible', 'unknown family');
    end if;

    insert into app.operator_actions (family_id, action, target, task_id, outcome, reason, detail, actor_sub)
    values (v_fid, p_action, left(p_target, 200), p_task, coalesce(p_outcome, 'ok'),
            left(p_reason, 500), coalesce(p_detail, '{}'::jsonb), sub)
    returning * into v_row;

    -- The ledger row rides in the envelope's `event` slot, the same shape M22's
    -- raise_audit_flag and M23's raise_operational_flag use for "here is the record
    -- I just wrote" (the `task` slot is reserved for actual tasks).
    return app.envelope(true, 'ok', null, null, to_jsonb(v_row));
  end;
  $$;

revoke execute on function api.record_operator_action(text, text, uuid, text, text, jsonb) from public;
grant execute on function api.record_operator_action(text, text, uuid, text, text, jsonb) to agent;

-- The surface. Newest-first, family key resolved — the shape the report line reads.
-- Granted to oversight AND monitor: a delegated monitor whose whole job is "read what
-- the operator did" would be blind without it (the note the monitor-role migration
-- leaves for exactly this case).
create view api.operator_actions as
select
  af.key     as family,
  oa.action,
  oa.target,
  oa.task_id,
  oa.outcome,
  oa.reason,
  oa.detail,
  oa.actor_sub,
  oa.created_at
from app.operator_actions oa
join app.agent_families af on af.id = oa.family_id
order by oa.created_at desc;

revoke all on api.operator_actions from public;
grant select on api.operator_actions to oversight;
grant select on api.operator_actions to monitor;

-- migrate:down
drop view if exists api.operator_actions;
drop function if exists api.record_operator_action(text, text, uuid, text, text, jsonb);
drop trigger if exists operator_actions_no_delete on app.operator_actions;
drop trigger if exists operator_actions_no_update on app.operator_actions;
drop table if exists app.operator_actions;
drop function if exists app.operator_actions_append_only();
-- The feature row is left in place on purpose: dropping it would cascade
-- app.family_features and silently unseat a provisioned operator. Same reasoning as
-- every other feature seed — features are additive vocabulary, not schema.
