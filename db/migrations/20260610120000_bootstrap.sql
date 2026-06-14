-- M0 bootstrap: the minimum PostgREST needs to boot, plus a harness-only smoke
-- endpoint. Domain tables and the agent/oversight/reaper roles arrive in M1.

-- migrate:up
create schema if not exists api;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    create role authenticator login password 'authenticator_dev_pw' noinherit;
  end if;
end
$$;

grant usage on schema api to anon;
grant anon to authenticator;

-- Harness-only: proves the compose → db → PostgREST → JWT chain. Not domain logic.
create or replace function api.ping() returns text
  language sql
  immutable
  as $$ select 'pong'::text $$;
grant execute on function api.ping() to anon;

-- migrate:down
drop function if exists api.ping();
drop schema if exists api cascade;
revoke anon from authenticator;
drop role if exists anon;
