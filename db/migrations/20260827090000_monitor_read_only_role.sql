-- v8 step 0 (ADR 0028 — the agent operator seat): a READ-ONLY coarse role, so
-- MONITORING can be delegated without delegating the human's levers.
--
-- Why a fourth coarse role. A delegated monitor needs exactly what `oversight`
-- may READ — the M16/M20–M24 oversight views plus raw `app` reads — and none of
-- what `oversight` may CALL. Today `oversight` carries EXECUTE on
-- api.set_permanent_ban / api.lift_ban (M22 D4: the only route to a permanent
-- denial, deliberately human-only) and on api.record_usage (M20, the driver's
-- write). So handing an oversight token to a delegated monitor hands over the two
-- irreversible governance acts ADR 0028 reserves for the human — leaving that
-- boundary as instruction rather than structure. `monitor` makes it structural:
-- SELECT wherever oversight can SELECT, EXECUTE on nothing.
--
-- The ABSENCE of grants is the mechanism, not a new one. Every api function is
-- already `revoke execute … from public` in its own migration, so a role that is
-- never granted EXECUTE can call none of them — PostgREST refuses before the
-- function body runs. That is the same gate M22 used to make set_permanent_ban
-- oversight-only, reused verbatim. No verb changes, no new capability state; ADR
-- 0007's coarse-role model with one more coarse role.
--
-- Feature-gated verbs need no thought here: raise_audit_flag and
-- raise_operational_flag are gated on role:auditor INSIDE the verb via
-- effective_features (M22 D6 / M23 D1), so a monitor token could not flag even if
-- some future migration granted it EXECUTE.
--
-- Mint with:  ainarres token --family <f> --role monitor --features ''
-- The CLI passes --role through unchanged, and loop/roles.sh::role_pg is
-- untouched — a delegated monitor is not a loop tier. The loop's own oversight
-- poller keeps `oversight` (it calls record_usage).
--
-- FOR FUTURE VIEW MIGRATIONS: grant select to `monitor` alongside `oversight`, or
-- re-run the api-wide grant below. A view that only oversight can read is
-- invisible to the delegated monitor.

-- migrate:up
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'monitor') then
    create role monitor nologin;
  end if;
end
$$;

-- PostgREST authenticates as `authenticator`, then SET ROLE to the token's role.
grant monitor to authenticator;

-- Reach the exposed schema (USAGE alone exposes nothing) and the private one, so
-- the api views resolve over app tables.
grant usage on schema api to monitor;
grant usage on schema app to monitor;

-- The read window: every api view, and raw app reads — identical to oversight's
-- SELECT surface (roles_grants M1), and nothing else.
grant select on all tables in schema api to monitor;
grant select on all tables in schema app to monitor;

-- The one EXECUTE a read-only monitor needs: api.governance_status, api.audit_flags
-- and their siblings join `app.resolve_governance_policy` (M21/M22b), so without it
-- those views answer 403 instead of rows. It is `language sql stable` over
-- app.governance_policy — a pure resolver, no writes, no denial.
grant execute on function app.resolve_governance_policy(text, uuid) to monitor;

-- Belt and suspenders: never any mutation. Already true by omission; stated so a
-- future `grant … to public` cannot quietly widen this role, and so the intent is
-- readable at the grant site.
revoke insert, update, delete, truncate on all tables in schema app from monitor;
revoke insert, update, delete, truncate on all tables in schema api from monitor;

-- NOTE, deliberately not "fixed" here: `monitor` also inherits EXECUTE on api.ping
-- from the PUBLIC default the M0 bootstrap left in place (it grants ping to anon and
-- never revokes public). ping returns a constant and is exactly the liveness probe a
-- monitor wants, so it stays. Every OTHER api function was revoked from public in its
-- own migration, which is what makes "no EXECUTE granted" a real boundary rather than
-- a hope — asserted in test/monitor-role.test.ts.

-- migrate:down
-- Revoke before dropping: a role cannot be dropped while it holds grants.
revoke execute on function app.resolve_governance_policy(text, uuid) from monitor;
revoke select on all tables in schema api from monitor;
revoke select on all tables in schema app from monitor;
revoke usage on schema api from monitor;
revoke usage on schema app from monitor;
revoke monitor from authenticator;
drop role if exists monitor;
