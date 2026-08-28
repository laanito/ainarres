-- M27 Slice A (v7.1 · ADR 0026 · design/precise-service.md D1): api.demand — the substrate
-- reports PENDING WORK IN CAPABILITY TERMS, so a service can wake only the workers whose
-- capabilities some waiting task actually needs.
--
-- The cost this exists to remove: v7's demand gate asks one question — "is active > 0?" —
-- and any claimable task at all triggers a FULL activation, spawning every configured tier.
-- One task sitting at `reviewing` boots the whole implementer pool: a process start and a
-- model session each, for workers that will find nothing to claim. Every one of those is
-- paid for in tokens.
--
-- What the view is. One row per distinct REQUIRED-FEATURE BUNDLE among the board's pending,
-- claimable-modulo-capability tasks, with a count. A bundle is what a family must hold to
-- move such a task, so "which of my workers should I start" becomes a subset test the
-- service can do itself, against capabilities it already declares (roles.sh::role_features).
--
-- The predicate is claim_next_task's, verbatim minus the capability terms (M12's version,
-- 20260628090000): unblocked, non-terminal stage, no live lease, dependencies satisfied, and
-- at least one outgoing transition. Those are exactly the tasks a suitably-capable family
-- COULD claim right now — hence "claimable modulo capability".
--
-- The bundle = task.required_features ∪ the transition's required_features ∪ lane:<lane>.
-- The design note (D1) writes the first two; the LANE feature belongs too, because
-- claim_next_task also requires `eff @> array['lane:' || l.key]`. Without it a dev-only tier
-- would test as able to serve an intake bundle — wrong the moment a second lane exists, which
-- it now does (M24). The bundle is the honest answer to "what must a family hold", so it
-- carries every term the claim actually checks.
--
-- A stage with several outgoing transitions (advance vs reject, or two roles) yields SEVERAL
-- bundles for the same task — each a real way that task could be moved. The view lists them
-- all; a task is counted once per bundle, never double-counted within one.
--
-- WHAT IT DOES NOT SAY (the bright line, ADR 0026 / vision). No task id, no priority, no
-- payload, no worker, no tier, no service. It reports "this many pending tasks need a family
-- with ⊇ {these features}" and nothing else. The substrate still has no concept of a tier or
-- of which service is asking; matching demand to workers is the service's own business, done
-- against its own config. A view that named tasks or ranked families would be the first step
-- back toward the orchestrator this project exists to abolish.
--
-- Read-only, oversight + monitor. Built ASSISTED (DB code is never swarm-self-validated in a
-- worktree — the board-wipe briefing rule). The report/status SURFACE for unserviceable
-- demand is the swarm half.

-- migrate:up
create view api.demand as
with pending as (
  -- claim_next_task's candidate predicate, minus `eff @>` (the capability terms are what we
  -- are REPORTING, not filtering by) and minus the lane argument (all lanes at once).
  select
    t.id,
    l.key   as lane,
    t.stage,
    t.required_features
  from app.tasks t
  join app.lanes  l on l.id = t.lane_id
  join app.stages s on s.id = t.stage
  where not t.blocked
    and not s.is_terminal
    and (t.claimed_by is null or t.lease_expires_at < now())
    and not exists (
      select 1
      from unnest(t.depends_on) as dep(id)
      join app.tasks  p  on p.id = dep.id
      join app.stages ps on ps.id = p.stage
      where not ps.is_terminal
    )
),
bundles as (
  select
    p.lane,
    p.id,
    (
      select coalesce(array_agg(distinct f order by f), '{}')
      from unnest(
        p.required_features
        || tr.required_features
        || array['lane:' || p.lane]
      ) as u(f)
    ) as bundle
  from pending p
  join app.transitions tr on tr.from_stage = p.stage
)
select
  bundle,
  lane,
  count(distinct id)::int as pending
from bundles
group by bundle, lane
order by pending desc, bundle;

comment on view api.demand is
  'v7.1 (M27/ADR 0026): pending work in CAPABILITY terms — one row per required-feature '
  'bundle a waiting task needs, with a count. Names no task, worker, tier or service; a '
  'service matches these bundles against its own workers to spawn only what is needed.';

revoke all on api.demand from public;
grant select on api.demand to oversight, monitor;

-- migrate:down
drop view if exists api.demand;
