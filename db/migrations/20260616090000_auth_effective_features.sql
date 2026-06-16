-- M2 auth & effective features (ADR 0007). PostgREST verifies the JWT, SET ROLEs
-- to the token's `role` claim, and exposes the remaining claims to SQL via the
-- `request.jwt.claims` GUC. These functions read from there.
--
-- Signing note: in-DB HMAC would need the pgcrypto extension, which ADR 0010
-- forbids (stock postgres:18, no extensions). So the DB authoritatively *builds*
-- the token claims (token_claims, from family_features) but does NOT sign them —
-- HS256 signing happens in the privileged minter (the TS helper now, a service
-- later). This is consistent with ADR 0007's "a privileged mint path that reads a
-- family's provisioned features and signs" (it never said sign in the DB).

-- migrate:up

-- Verified claims as jsonb (empty object when there's no token, e.g. anon).
-- SECURITY INVOKER: only reads a GUC, so it's safe for any role to call.
create function api.jwt_claims() returns jsonb
  language sql
  stable
  as $$
    select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb;
  $$;

-- Postgres grants EXECUTE to PUBLIC by default; revoke it so only the explicit
-- grants below decide who may call (critical for the SECURITY DEFINER functions).
revoke execute on function api.jwt_claims() from public;
grant execute on function api.jwt_claims() to anon, agent, oversight, reaper;

-- Effective features = token features[] − feature_denials(family). The single
-- source of truth for matching (ADR 0004/0007). Takes NO arguments: eligibility
-- derives only from verified claims, never from caller-supplied values (risk R3).
-- SECURITY DEFINER so it can read app.* even though `agent` cannot touch tables.
create function api.effective_features() returns text[]
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

    -- Keep a granted feature unless the family has a fresh denial for it.
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

-- Introspection / debug surface (and a test vehicle for "SET ROLE works").
-- SECURITY INVOKER on purpose: current_user must reflect the role PostgREST
-- switched into, not a definer. It delegates feature computation to the
-- (definer) effective_features, which the caller is also granted to execute.
create function api.whoami() returns jsonb
  language sql
  stable
  as $$
    select jsonb_build_object(
      'role',               current_user,
      'session_role',       session_user,
      'sub',                api.jwt_claims() ->> 'sub',
      'family',             api.jwt_claims() ->> 'family',
      'token_features',     coalesce(api.jwt_claims() -> 'features', '[]'::jsonb),
      'effective_features', to_jsonb(api.effective_features())
    );
  $$;

revoke execute on function api.whoami() from public;
grant execute on function api.whoami() to agent, oversight, reaper;

-- Privileged provisioning path: snapshot a family's provisioned features into a
-- set of token claims. Returns CLAIMS (the minter signs them — see header note).
-- reaper-only: an agent must never mint its own grant. SECURITY DEFINER to read
-- the provisioning tables.
create function api.token_claims(family_key text, assume_role text, ttl_seconds int default 900)
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
      'sub',      uuidv7(),     -- a fresh instance id; the agents row is created lazily at first claim (M3)
      'family',   family_key,
      'role',     assume_role,
      'features', to_jsonb(feats),
      'iat',      now_s,
      'exp',      now_s + ttl_seconds
    );
  end;
  $$;

revoke execute on function api.token_claims(text, text, int) from public;
grant execute on function api.token_claims(text, text, int) to reaper;

-- migrate:down
drop function if exists api.token_claims(text, text, int);
drop function if exists api.whoami();
drop function if exists api.effective_features();
drop function if exists api.jwt_claims();
