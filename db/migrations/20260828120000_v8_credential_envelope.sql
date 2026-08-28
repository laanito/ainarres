-- v8 step 3 (ADR 0028 — the agent operator seat): THE CREDENTIAL ENVELOPE.
--
-- What step 2 left open, stated plainly in its own amendment: the seat was NAMED and
-- LEDGERED but not BOUNDED. api.effective_features() reads the signed token and subtracts
-- denials; it does not re-intersect app.family_features, because ADR 0007 puts provisioning
-- at MINT time and has the substrate trust the token. So the seat's prohibitions —
-- no capability:integrate, no role:auditor — were honoured by the CLI choosing not to ask
-- for them, and by nothing else. A seat holding JWT_SECRET could mint any family, any role,
-- any feature.
--
-- The mechanism to fix that has existed since M2 and has never been used. api.token_claims
-- (20260616090000) reads a family's PROVISIONED features and returns them as claims for a
-- separate minter to sign — its own header says "the minter signs them". That is exactly an
-- envelope: the database decides what may be in the token, and the thing holding the key
-- only signs what it is handed. Three versions later, this is the caller it was waiting for.
--
-- api.issue_operator_credential is token_claims with the envelope's three rules added and
-- the issuance recorded in the same statement, so there is no path that mints without a
-- trail:
--
--   1. ROLE. Only 'agent' and 'monitor'. Never 'oversight' (it carries EXECUTE on
--      set_permanent_ban / lift_ban — M22 D4, the human's irreversible levers) and never
--      'reaper' (it can call this function, so issuing one would let the seat issue to
--      itself, which is the envelope handing over its own key).
--   2. FAMILY. Only a family holding role:operator. Data-driven, not a hardcoded name or a
--      config table: the seat is whoever the OWNER provisioned as the seat, and changing
--      that is an owner reprovision exactly like every other grant (ADR 0007's asymmetry).
--   3. FEATURES. The family's provisioned snapshot, whole and unedited. The caller does not
--      get to ask for a subset or a superset; asking is not part of the protocol.
--
-- TTL is capped. A long-lived credential is a key with extra steps.
--
-- WHAT THIS DOES NOT DO, and the owner chose this deliberately (2026-08-28). On one host
-- with one OS user, a shell-capable seat can read loop.env and sign whatever it likes. No
-- code in this database can prevent that. So the envelope is a BOUNDARY FOR A COOPERATING
-- SEAT and an AUDIT TRAIL for one that is not — which is why api.unbrokered_operator_acts
-- below is not a nicety but the half that makes the choice worth making: every credential
-- this verb issues records its subject, so an operator act whose actor was never issued a
-- credential is a self-minted token, and it shows. Prevention would need the seat to run as
-- a separate OS user with no read on the secret; that is a deployment, documented in
-- loop/README.md, not something a migration can enforce.

-- migrate:up

-- token_claims gains 'monitor'. A read-only delegated seat (v8 step 0) has to be reachable
-- THROUGH the envelope, or the seat would have to self-mint for the least dangerous thing
-- it does — which is precisely backwards.
create or replace function api.token_claims(family_key text, assume_role text, ttl_seconds int default 900)
  returns jsonb
  language plpgsql
  stable
  security definer
  set search_path = app, pg_temp
  as $$
  declare
    feats text[];
    now_s bigint := floor(extract(epoch from now()))::bigint;
  begin
    if assume_role not in ('agent', 'oversight', 'reaper', 'monitor') then
      raise exception 'invalid role: %', assume_role using errcode = 'check_violation';
    end if;
    if not exists (select 1 from app.agent_families where key = family_key) then
      raise exception 'unknown family: %', family_key using errcode = 'no_data_found';
    end if;

    select coalesce(array_agg(ft.name order by ft.name), '{}') into feats
    from app.family_features ff
    join app.agent_families f on f.id = ff.family_id
    join app.features ft on ft.id = ff.feature_id
    where f.key = family_key;

    return jsonb_build_object(
      'sub',      uuidv7(),
      'family',   family_key,
      'role',     assume_role,
      'features', to_jsonb(feats),
      'iat',      now_s,
      'exp',      now_s + ttl_seconds
    );
  end;
  $$;

-- The issuance ledger. Append-only, like every other v8 trail. `sub` is the claim subject
-- the seat will act under, which is what joins an issuance to the acts it paid for.
create table app.operator_credentials (
  id          uuid primary key default uuidv7(),
  sub         uuid not null unique,
  family_id   uuid not null references app.agent_families(id) on delete cascade,
  assume_role text not null,
  features    text[] not null default '{}',
  ttl_seconds int  not null,
  requested_by text,
  issued_at   timestamptz not null default now(),
  expires_at  timestamptz not null
);
create index operator_credentials_feed on app.operator_credentials (issued_at);
create index operator_credentials_by_sub on app.operator_credentials (sub);
revoke all on app.operator_credentials from public;
grant select on app.operator_credentials to oversight;
grant select on app.operator_credentials to monitor;

create function app.operator_credentials_append_only() returns trigger
  language plpgsql as $$
begin
  raise exception 'app.operator_credentials is append-only (% not allowed)', tg_op
    using errcode = 'restrict_violation';
end;
$$;
create trigger operator_credentials_no_update
  before update on app.operator_credentials
  for each row execute function app.operator_credentials_append_only();
create trigger operator_credentials_no_delete
  before delete on app.operator_credentials
  for each row execute function app.operator_credentials_append_only();

-- The envelope. Returns CLAIMS; the broker signs them. Reaper-only, the same coarse role
-- token_claims already uses for "privileged provisioning path, an agent must never mint its
-- own grant" — restated here because it is now load-bearing rather than theoretical.
create function api.issue_operator_credential(
  family_key   text,
  assume_role  text default 'agent',
  ttl_seconds  int  default 300,
  requested_by text default null
) returns jsonb
  language plpgsql
  security definer
  set search_path = app, pg_temp
  as $$
  declare
    v_fid   uuid;
    feats   text[];
    v_ttl   int;
    v_sub   uuid := uuidv7();
    now_s   bigint := floor(extract(epoch from now()))::bigint;
  begin
    -- Rule 1 — role.
    if assume_role is null or assume_role not in ('agent', 'monitor') then
      return app.envelope(false, 'not_eligible',
        format('role %L is outside the operator envelope (agent or monitor only)',
               coalesce(assume_role, '(null)')));
    end if;

    select f.id into v_fid from app.agent_families f where f.key = family_key;
    if v_fid is null then
      return app.envelope(false, 'not_eligible', format('unknown family %L', coalesce(family_key, '(null)')));
    end if;

    -- Rule 2 — family. Data-driven: the seat is whoever holds role:operator.
    if not exists (
      select 1 from app.family_features ff
      join app.features ft on ft.id = ff.feature_id
      where ff.family_id = v_fid and ft.name = 'role:operator'
    ) then
      return app.envelope(false, 'not_eligible',
        format('family %L is not an operator seat (no provisioned role:operator)', family_key));
    end if;

    -- Rule 3 — features: the provisioned snapshot, whole and unedited.
    select coalesce(array_agg(ft.name order by ft.name), '{}') into feats
    from app.family_features ff
    join app.features ft on ft.id = ff.feature_id
    where ff.family_id = v_fid;

    -- A long-lived credential is a key with extra steps.
    v_ttl := least(greatest(coalesce(ttl_seconds, 300), 30), 900);

    insert into app.operator_credentials (sub, family_id, assume_role, features, ttl_seconds, requested_by, expires_at)
    values (v_sub, v_fid, assume_role, feats, v_ttl, left(requested_by, 200),
            now() + make_interval(secs => v_ttl));

    return app.envelope(true, 'ok', null, null, jsonb_build_object(
      'sub',      v_sub,
      'family',   family_key,
      'role',     assume_role,
      'features', to_jsonb(feats),
      'iat',      now_s,
      'exp',      now_s + v_ttl
    ));
  end;
  $$;

revoke execute on function api.issue_operator_credential(text, text, int, text) from public;
grant execute on function api.issue_operator_credential(text, text, int, text) to reaper;

-- The issuance trail.
create view api.operator_credentials as
select
  af.key as family,
  oc.sub,
  oc.assume_role as role,
  oc.features,
  oc.ttl_seconds,
  oc.requested_by,
  oc.issued_at,
  oc.expires_at
from app.operator_credentials oc
join app.agent_families af on af.id = oc.family_id
order by oc.issued_at desc;

revoke all on api.operator_credentials from public;
grant select on api.operator_credentials to oversight;
grant select on api.operator_credentials to monitor;

-- THE HALF THAT MAKES AN AUDITED BOUNDARY WORTH HAVING.
--
-- Every credential the envelope issues records its subject. An operator-family act whose
-- actor was never issued one was signed by something holding the key directly — the seat
-- bypassing the broker, or a human at the terminal. Both are legitimate to see and neither
-- should be silent.
--
-- It reports, it does not accuse: a row here is a QUESTION ("who signed this?"), never a
-- verdict, and it writes no denial. The owner's own hand-minted acts land here too, which
-- is correct — the point is that nothing acts as the operator without a record somewhere.
-- BOTH places an operator act can land, or the audit has a hole exactly where the seat's
-- own ledger is: task-shaped acts are events, instance-scoped ones are operator_actions
-- (events.task_id is NOT NULL). An earlier draft read only app.events and saw nothing when
-- a self-minted seat wrote a ledger line — which is one of the likelier bypasses.
--
-- role:operator is tested with EXISTS, not a join: joining family_features would multiply
-- every act by the number of features the family holds and report five times the count.
create view api.unbrokered_operator_acts as
with acts as (
  select ag.family_id, e.actor as sub, e.created_at
  from app.events e
  join app.agents ag on ag.id = e.actor
  union all
  select oa.family_id, oa.actor_sub as sub, oa.created_at
  from app.operator_actions oa
  where oa.actor_sub is not null
)
select
  af.key        as family,
  a.sub,
  count(*)::int as acts,
  min(a.created_at) as first_seen,
  max(a.created_at) as last_seen
from acts a
join app.agent_families af on af.id = a.family_id
where exists (
        select 1 from app.family_features ff
        join app.features ft on ft.id = ff.feature_id
        where ff.family_id = a.family_id and ft.name = 'role:operator')
  and not exists (select 1 from app.operator_credentials oc where oc.sub = a.sub)
group by af.key, a.sub
order by max(a.created_at) desc;

revoke all on api.unbrokered_operator_acts from public;
grant select on api.unbrokered_operator_acts to oversight;
grant select on api.unbrokered_operator_acts to monitor;

-- migrate:down
drop view if exists api.unbrokered_operator_acts;
drop view if exists api.operator_credentials;
drop function if exists api.issue_operator_credential(text, text, int, text);
drop trigger if exists operator_credentials_no_delete on app.operator_credentials;
drop trigger if exists operator_credentials_no_update on app.operator_credentials;
drop table if exists app.operator_credentials;
drop function if exists app.operator_credentials_append_only();
create or replace function api.token_claims(family_key text, assume_role text, ttl_seconds int default 900)
  returns jsonb
  language plpgsql
  stable
  security definer
  set search_path = app, pg_temp
  as $$
  declare
    feats text[];
    now_s bigint := floor(extract(epoch from now()))::bigint;
  begin
    if assume_role not in ('agent', 'oversight', 'reaper') then
      raise exception 'invalid role: %', assume_role using errcode = 'check_violation';
    end if;
    if not exists (select 1 from app.agent_families where key = family_key) then
      raise exception 'unknown family: %', family_key using errcode = 'no_data_found';
    end if;
    select coalesce(array_agg(ft.name order by ft.name), '{}') into feats
    from app.family_features ff
    join app.agent_families f on f.id = ff.family_id
    join app.features ft on ft.id = ff.feature_id
    where f.key = family_key;
    return jsonb_build_object(
      'sub',      uuidv7(),
      'family',   family_key,
      'role',     assume_role,
      'features', to_jsonb(feats),
      'iat',      now_s,
      'exp',      now_s + ttl_seconds
    );
  end;
  $$;
