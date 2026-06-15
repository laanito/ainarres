-- M1 coarse Postgres roles + grants (ADR 0007). These roles gate *which functions
-- you may call*; the functional role (analyst/reviewer/…) is a feature, not a
-- Postgres role. anon + authenticator already exist from the M0 bootstrap.
--
-- Access model: domain tables live in the private `app` schema and are never
-- granted to agents — the agent surface is RPC-only (verbs land in M2–M4 as
-- SECURITY DEFINER functions in `api`). oversight gets read-only visibility now;
-- reaper exists for forward-compat (v1 recovery is lazy reclaim, no process —
-- ADR 0009) and carries no table rights yet.

-- migrate:up
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'agent') then
    create role agent nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'oversight') then
    create role oversight nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'reaper') then
    create role reaper nologin;
  end if;
end
$$;

-- PostgREST authenticates as `authenticator` then SET ROLE to the token's role.
grant agent, oversight, reaper to authenticator;

-- All coarse roles may reach the exposed verb schema (verbs added later).
grant usage on schema api to agent, oversight, reaper;
-- …and the private schema, so SECURITY DEFINER verbs and oversight reads resolve.
-- USAGE alone exposes nothing; table privileges below decide what is visible.
grant usage on schema app to agent, oversight, reaper;

-- Lock the domain tables down: nobody gets table rights via PUBLIC.
revoke all on all tables in schema app from public;

-- oversight: read-only window onto coordination state (the board/audit feed;
-- dedicated views land in M5 but raw read access is harmless and useful now).
grant select on all tables in schema app to oversight;

-- Append-only events — belt to the trigger's suspenders (ADR 0006): never grant
-- UPDATE/DELETE on events to anyone, and revoke explicitly to be defensive.
-- (oversight keeps the SELECT granted above; only mutation is stripped.)
revoke insert, update, delete on app.events from public, agent, oversight, reaper;

-- migrate:down
-- Revoke before dropping roles (roles can't be dropped while they own grants).
revoke select on all tables in schema app from oversight;
revoke usage on schema app from agent, oversight, reaper;
revoke usage on schema api from agent, oversight, reaper;
revoke agent, oversight, reaper from authenticator;
drop role if exists reaper;
drop role if exists oversight;
drop role if exists agent;
