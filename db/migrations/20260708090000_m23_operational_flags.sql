-- M23 Slice A (v6 — seat the bookends) — the auditor's OPERATIONAL facet: the flag verb.
-- design/auditor-operational.md · ADR 0023. Grows v5's auditor from delivery QUALITY (M22)
-- to operational HEALTH: a family-scoped, human-decided signal for a worker that SPINS or
-- OVERSPENDS. Like M22's qualitative path it writes NO denial and adds NO new revocation
-- mechanism (ADR 0023 invariant) — it is signal + surface only. This migration adds:
--   1. governance_policy.overspend_multiple — the spend-watch threshold data (D3)
--   2. app.operational_flags — an append-only ledger of the auditor's operational flags (D1/D7)
--   3. api.raise_operational_flag — role:auditor; writes a ledger row, NO denial (D1/D2)
--
-- Why a SIBLING verb + ledger, not M22's raise_audit_flag (D1): M22's flag is task-anchored
-- by construction (app.events.task_id NOT NULL, D8). An operational flag has NO single task —
-- a spinner never advanced (no task to point at), an overspend is a trend across many tasks.
-- Forcing it onto raise_audit_flag would mean nulling events.task_id — the exact invariant
-- M22 D7 refused to weaken (which is why the human ban/lift trail became its own ledger,
-- governance_actions, not events). So M23 mirrors that reconciliation: task-anchored quality
-- -> an event; family-scoped operational conduct -> a ledger row. Same shape, same discipline.

-- migrate:up

-- D3 — the spend-watch threshold. tokens_per_delivery vs. the per-capability peer median is
-- an anomaly past this multiple. Data on the existing policy table so it is tunable
-- capability->workflow->system without a migration (the M21/M22 D5 pattern), NULL = "no
-- spend anomaly from this input"; seeded conservatively on the system row. Slice B's
-- api.spend_anomalies reads it; this slice only lands the datum.
alter table app.governance_policy
  add column overspend_multiple numeric;
update app.governance_policy
  set overspend_multiple = 5
  where scope_kind = 'system';

-- D1/D7 — the operational-flag ledger. Append-only (belt: the block trigger below). Rows are
-- FAMILY/CAPABILITY-scoped (a spinner/overspender is a family at a capability, not a task), so
-- they live here, NOT in app.events (whose task_id is NOT NULL). capability is free text (a
-- recorded judgment, like M22's audit_flag data — not an FK; a flag never gates, so it need
-- not resolve to a registered feature). kind partitions the operational failure modes.
-- actor_sub = the auditor's token subject. NO feature_denials is ever written from here (D2).
create table app.operational_flags (
  id         uuid primary key default uuidv7(),
  family_id  uuid not null references app.agent_families(id) on delete cascade,
  capability text not null,
  kind       text not null check (kind in ('spinning', 'overspending', 'health', 'integrity')),
  detail     text not null,
  severity   text not null default 'warning',
  actor_sub  uuid,
  created_at timestamptz not null default now()
);
create index operational_flags_feed on app.operational_flags (created_at);
revoke all on app.operational_flags from public;
grant select on app.operational_flags to oversight;

create function app.operational_flags_append_only() returns trigger
  language plpgsql as $$
begin
  raise exception 'app.operational_flags is append-only (% not allowed)', tg_op
    using errcode = 'restrict_violation';
end;
$$;
create trigger operational_flags_no_update
  before update on app.operational_flags
  for each row execute function app.operational_flags_append_only();
create trigger operational_flags_no_delete
  before delete on app.operational_flags
  for each row execute function app.operational_flags_append_only();

-- D1/D2 — the operational flag. A QUALITATIVE, family-scoped signal: it records that a family
-- SPINS or OVERSPENDS (or a health/integrity concern) at a capability, and writes NO
-- feature_denials (the operational path never auto-penalizes — ADR 0023; spinning MAY later
-- be escalated to a ban by a human through M22's oversight-only RPC, overspending NEVER). It
-- is gated on role:auditor via effective_features (the same gate M22's raise_audit_flag uses,
-- D6). The subject family must exist (never flag a phantom); kind and detail are required.
create function api.raise_operational_flag(
  p_subject_family text,
  p_capability     text,
  p_kind           text,
  p_detail         text,
  p_severity       text default 'warning'
) returns jsonb
  language plpgsql
  security definer
  set search_path = app, pg_temp
  as $$
  declare
    claims        jsonb  := api.jwt_claims();
    sub           uuid   := nullif(claims ->> 'sub', '')::uuid;
    eff           text[] := api.effective_features();
    v_fid         uuid;
    v_subject_fid uuid;
    v_flag        app.operational_flags;
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

    -- The flag must name a real subject family, a valid kind, a capability, and a detail.
    select id into v_subject_fid from app.agent_families where key = p_subject_family;
    if v_subject_fid is null then
      return app.envelope(false, 'not_found', format('no family %L', p_subject_family));
    end if;
    if p_kind is null or p_kind not in ('spinning', 'overspending', 'health', 'integrity') then
      return app.envelope(false, 'not_eligible',
        'kind must be one of spinning|overspending|health|integrity');
    end if;
    if p_capability is null or btrim(p_capability) = '' then
      return app.envelope(false, 'not_eligible', 'a flag must name the capability');
    end if;
    if p_detail is null or btrim(p_detail) = '' then
      return app.envelope(false, 'not_eligible', 'a flag must state the detail');
    end if;

    -- Record the qualitative signal as a ledger row. NO denial written (D2).
    insert into app.operational_flags (family_id, capability, kind, detail, severity, actor_sub)
    values (v_subject_fid, p_capability, p_kind, p_detail, coalesce(p_severity, 'warning'), sub)
    returning * into v_flag;

    return app.envelope(true, 'ok', null, null, to_jsonb(v_flag));
  end;
  $$;
revoke execute on function api.raise_operational_flag(text, text, text, text, text) from public;
-- role:auditor is enforced INSIDE the verb (effective_features); execute is open to any
-- authenticated agent so the gate — not table grants — decides. An anon/agent token with no
-- role:auditor is refused with a value envelope (mirrors M22's raise_audit_flag).
grant execute on function api.raise_operational_flag(text, text, text, text, text) to agent, oversight;

-- migrate:down
drop function if exists api.raise_operational_flag(text, text, text, text, text);
drop trigger if exists operational_flags_no_delete on app.operational_flags;
drop trigger if exists operational_flags_no_update on app.operational_flags;
drop function if exists app.operational_flags_append_only();
drop table if exists app.operational_flags;
alter table app.governance_policy
  drop column if exists overspend_multiple;
