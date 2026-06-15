-- M1 domain schema: the full data model from .agents/design/data-model.md.
--
-- Tables live in a PRIVATE schema `app`, NOT in `api`. PostgREST only exposes
-- `api` (PGRST_DB_SCHEMAS=api), so putting the tables here means agents cannot
-- touch them directly over REST — the only way in is the verb functions added in
-- later milestones (ADR 0001, RPC-only). uuidv7() is native to postgres:18
-- (ADR 0006, ADR 0010): no extensions.

-- migrate:up
create schema if not exists app;

-- --------------------------------------------------------------------------
-- Identity & traits (ADR 0004, ADR 0007)
-- --------------------------------------------------------------------------

-- The trait vocabulary. `name` (= "kind:key", e.g. "lane:api", "role:analyst")
-- is the canonical form carried in tokens and in *_features arrays, so matching
-- is a plain text[] superset with no id translation in the hot path.
create table app.features (
  id         uuid primary key default uuidv7(),
  kind       text not null check (kind in ('capability', 'role', 'work-area', 'lane')),
  key        text not null,
  name       text generated always as (kind || ':' || key) stored,
  created_at timestamptz not null default now(),
  unique (kind, key),
  unique (name)
);

-- Durable competence unit = (harness/tool + model). Grants and denials attach
-- here, not to instances, so they survive respawn (ADR 0007).
create table app.agent_families (
  id          uuid primary key default uuidv7(),
  key         text not null unique,
  description text,
  created_at  timestamptz not null default now()
);

-- Ephemeral instance of a family. id = the token `sub`. Authorization never
-- trusts this table; it exists so claimed_by/created_by/actor/subject resolve.
create table app.agents (
  id            uuid primary key default uuidv7(),
  family_id     uuid not null references app.agent_families(id) on delete cascade,
  first_seen_at timestamptz not null default now()
);

-- Grant (provisioning): what a family is provisioned with. The mint path reads
-- this to stamp the token's features[].
create table app.family_features (
  family_id  uuid not null references app.agent_families(id) on delete cascade,
  feature_id uuid not null references app.features(id) on delete cascade,
  primary key (family_id, feature_id)
);

-- Veto (governance): family-scoped revocations, always fresh. Effective features
-- = token features[] − feature_denials(family). Instant effect (ADR 0007).
create table app.feature_denials (
  id         uuid primary key default uuidv7(),
  family_id  uuid not null references app.agent_families(id) on delete cascade,
  feature_id uuid not null references app.features(id) on delete cascade,
  reason     text,
  created_at timestamptz not null default now(),
  unique (family_id, feature_id)
);

-- --------------------------------------------------------------------------
-- Flow definition (ADR 0001, ADR 0002): the state machine, as data
-- --------------------------------------------------------------------------

create table app.projects (
  id         uuid primary key default uuidv7(),
  slug       text not null unique,
  context    jsonb not null default '{}'::jsonb, -- where the project's work-truth lives
  created_at timestamptz not null default now()
);

-- A named, reusable flow. Two lanes running the same process share one.
-- default_lease/default_max_attempts are the fallbacks for their stages (ADR 0009).
create table app.workflows (
  id                   uuid primary key default uuidv7(),
  key                  text not null unique,
  description          text,
  default_lease        interval not null default '5 minutes'::interval,
  default_max_attempts int not null default 3 check (default_max_attempts > 0),
  created_at           timestamptz not null default now()
);

-- An initiative within a project, pointing at the workflow it runs.
create table app.lanes (
  id          uuid primary key default uuidv7(),
  project_id  uuid not null references app.projects(id) on delete cascade,
  key         text not null,
  context     jsonb not null default '{}'::jsonb, -- repo, rules, requisites
  workflow_id uuid not null references app.workflows(id),
  ordering    int not null default 0,
  created_at  timestamptz not null default now(),
  unique (project_id, key)
);

-- A column on a workflow's board. lease_duration/max_attempts null → fall back to
-- the workflow default → system default (ADR 0009).
create table app.stages (
  id             uuid primary key default uuidv7(),
  workflow_id    uuid not null references app.workflows(id) on delete cascade,
  key            text not null,
  ordering       int not null default 0,
  is_initial     boolean not null default false,
  is_terminal    boolean not null default false,
  lease_duration interval,
  max_attempts   int check (max_attempts is null or max_attempts > 0),
  unique (workflow_id, key)
);

-- At most one initial stage per workflow (where create_task lands).
create unique index stages_one_initial_per_workflow
  on app.stages (workflow_id) where is_initial;

-- A legal move — the single place flow rules are enforced. `kind` selects which
-- verb may execute it (advance|reject). required_features are canonical names
-- (text[]); multiple transitions out of one stage express OR-eligibility.
create table app.transitions (
  id                uuid primary key default uuidv7(),
  workflow_id       uuid not null references app.workflows(id) on delete cascade,
  from_stage        uuid not null references app.stages(id),
  to_stage          uuid not null references app.stages(id),
  kind              text not null check (kind in ('advance', 'reject')),
  required_features text[] not null default '{}',
  effects           jsonb,  -- grant/revoke on the task subject's family
  guard             text,   -- optional SQL predicate, evaluated in M4
  created_at        timestamptz not null default now()
);

create index transitions_by_from_stage on app.transitions (from_stage, kind);

-- --------------------------------------------------------------------------
-- Work (ADR 0006): small structured core, the rest in payload
-- --------------------------------------------------------------------------

create table app.tasks (
  id                uuid primary key default uuidv7(),
  lane_id           uuid not null references app.lanes(id),
  stage             uuid not null references app.stages(id),
  required_features text[] not null default '{}', -- extras on top of the flow
  subject           uuid references app.agents(id),     -- task is *about* this agent (governance)
  claimed_by        uuid references app.agents(id),
  lease_expires_at  timestamptz,
  blocked           boolean not null default false,     -- orthogonal park flag
  blocked_reason    text,
  priority          int not null default 0,
  attempts          int not null default 0,
  payload           jsonb not null default '{}'::jsonb,
  created_by        uuid references app.agents(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- Claim-supporting indexes (ADR 0001 SKIP LOCKED path; exercised in M3).
-- Candidate scan per lane/stage, highest priority then oldest, skipping blocked.
create index tasks_claimable
  on app.tasks (lane_id, stage, priority desc, created_at) where not blocked;
-- One-active-task-per-instance lookup + lease_lost checks.
create index tasks_by_claimed_by on app.tasks (claimed_by) where claimed_by is not null;
-- Abandoned-view / expired-lease scans (ADR 0009).
create index tasks_by_lease on app.tasks (lease_expires_at) where lease_expires_at is not null;

-- Append-only oversight feed + audit trail (ADR 0006). One stream, `type`
-- discriminator + data jsonb (artifacts are references, never content — ADR 0003).
create table app.events (
  id         uuid primary key default uuidv7(),
  task_id    uuid not null references app.tasks(id) on delete cascade,
  actor      uuid references app.agents(id), -- null for human/system interventions
  type       text not null,
  data       jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index events_by_task on app.events (task_id, created_at);
create index events_feed on app.events (created_at);

-- --------------------------------------------------------------------------
-- Triggers
-- --------------------------------------------------------------------------

-- Keep tasks.updated_at honest.
create function app.set_updated_at() returns trigger
  language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger tasks_set_updated_at
  before update on app.tasks
  for each row execute function app.set_updated_at();

-- Append-only enforcement for events (suspenders; the revoked grants are the
-- belt, added in the roles migration). Blocks UPDATE/DELETE for everyone,
-- including table owners and SECURITY DEFINER functions.
create function app.events_append_only() returns trigger
  language plpgsql as $$
begin
  raise exception 'app.events is append-only (% not allowed)', tg_op
    using errcode = 'restrict_violation';
end;
$$;

create trigger events_no_update
  before update on app.events
  for each row execute function app.events_append_only();

create trigger events_no_delete
  before delete on app.events
  for each row execute function app.events_append_only();

-- migrate:down
drop table if exists app.events cascade;
drop function if exists app.events_append_only();
drop table if exists app.tasks cascade;
drop function if exists app.set_updated_at();
drop table if exists app.transitions cascade;
drop table if exists app.stages cascade;
drop table if exists app.lanes cascade;
drop table if exists app.workflows cascade;
drop table if exists app.projects cascade;
drop table if exists app.feature_denials cascade;
drop table if exists app.family_features cascade;
drop table if exists app.agents cascade;
drop table if exists app.agent_families cascade;
drop table if exists app.features cascade;
drop schema if exists app cascade;
