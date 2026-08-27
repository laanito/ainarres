-- M1 seed fixture: a minimal but complete instance of the model so the schema is
-- exercised end to end (a project, a lane, a reusable workflow with stages and
-- both advance + reject transitions, the trait vocabulary, and two agent families
-- with grants). This is NOT the real self-hosting dev workflow — that arrives in
-- M6; this is a generic fixture for M1's schema/seed tests.
--
-- Idempotent by construction: every statement keys on a natural unique constraint
-- (ON CONFLICT DO NOTHING) or guards with NOT EXISTS, so `make seed` is safe to
-- run on every `reset` and re-running it changes no row counts.

begin;

-- Trait vocabulary (canonical name = kind:key).
insert into app.features (kind, key) values
  ('lane',       'api'),
  ('role',       'analyst'),
  ('role',       'reviewer'),
  ('capability', 'plan')
on conflict (kind, key) do nothing;

-- A reusable flow encoding a tiny review loop.
insert into app.workflows (key, description) values
  ('dev-loop', 'Generic build → review → done loop with rework (M1 fixture).')
on conflict (key) do nothing;

-- Its stages. Exactly one is_initial (backlog), one is_terminal (done).
insert into app.stages (workflow_id, key, ordering, is_initial, is_terminal)
select w.id, v.key, v.ordering, v.is_initial, v.is_terminal
from app.workflows w
cross join (values
  ('backlog',     0, true,  false),
  ('in-progress', 1, false, false),
  ('review',      2, false, false),
  ('done',        3, false, true)
) as v(key, ordering, is_initial, is_terminal)
where w.key = 'dev-loop'
on conflict (workflow_id, key) do nothing;

-- A project and a lane that runs the flow.
insert into app.projects (slug, context) values
  ('ainarres', '{"repo": "https://github.com/laanito/ainarres"}'::jsonb)
on conflict (slug) do nothing;

insert into app.lanes (project_id, key, workflow_id, ordering, context)
select p.id, 'api', w.id, 0, '{"area": "business-logic"}'::jsonb
from app.projects p, app.workflows w
where p.slug = 'ainarres' and w.key = 'dev-loop'
on conflict (project_id, key) do nothing;

-- Transitions: who may move work where. required_features are canonical names.
-- No natural unique key on transitions (multiple OR-paths are allowed), so guard
-- each with NOT EXISTS on (workflow, from, to, kind).
insert into app.transitions (workflow_id, from_stage, to_stage, kind, required_features)
select w.id, sf.id, st.id, 'advance', array['lane:api', 'role:analyst']
from app.workflows w
join app.stages sf on sf.workflow_id = w.id and sf.key = 'backlog'
join app.stages st on st.workflow_id = w.id and st.key = 'in-progress'
where w.key = 'dev-loop'
  and not exists (
    select 1 from app.transitions t
    where t.workflow_id = w.id and t.from_stage = sf.id and t.to_stage = st.id and t.kind = 'advance'
  );

insert into app.transitions (workflow_id, from_stage, to_stage, kind, required_features)
select w.id, sf.id, st.id, 'advance', array['lane:api', 'role:analyst']
from app.workflows w
join app.stages sf on sf.workflow_id = w.id and sf.key = 'in-progress'
join app.stages st on st.workflow_id = w.id and st.key = 'review'
where w.key = 'dev-loop'
  and not exists (
    select 1 from app.transitions t
    where t.workflow_id = w.id and t.from_stage = sf.id and t.to_stage = st.id and t.kind = 'advance'
  );

insert into app.transitions (workflow_id, from_stage, to_stage, kind, required_features)
select w.id, sf.id, st.id, 'advance', array['lane:api', 'role:reviewer']
from app.workflows w
join app.stages sf on sf.workflow_id = w.id and sf.key = 'review'
join app.stages st on st.workflow_id = w.id and st.key = 'done'
where w.key = 'dev-loop'
  and not exists (
    select 1 from app.transitions t
    where t.workflow_id = w.id and t.from_stage = sf.id and t.to_stage = st.id and t.kind = 'advance'
  );

-- Rework: a reviewer can reject back to in-progress (kind = reject, separately gated).
insert into app.transitions (workflow_id, from_stage, to_stage, kind, required_features)
select w.id, sf.id, st.id, 'reject', array['lane:api', 'role:reviewer']
from app.workflows w
join app.stages sf on sf.workflow_id = w.id and sf.key = 'review'
join app.stages st on st.workflow_id = w.id and st.key = 'in-progress'
where w.key = 'dev-loop'
  and not exists (
    select 1 from app.transitions t
    where t.workflow_id = w.id and t.from_stage = sf.id and t.to_stage = st.id and t.kind = 'reject'
  );

-- Two agent families (durable competence units).
insert into app.agent_families (key, description) values
  ('opencode+qwen',    'opencode harness, qwen model'),
  ('claude-code+opus', 'Claude Code harness, Opus model')
on conflict (key) do nothing;

-- Provisioning grants. opencode+qwen can analyst on the api lane and plan;
-- claude-code+opus can do everything including review.
insert into app.family_features (family_id, feature_id)
select f.id, ft.id
from app.agent_families f
join app.features ft on ft.name = any (array['lane:api', 'role:analyst', 'capability:plan'])
where f.key = 'opencode+qwen'
on conflict (family_id, feature_id) do nothing;

insert into app.family_features (family_id, feature_id)
select f.id, ft.id
from app.agent_families f
join app.features ft on ft.name = any (array['lane:api', 'role:analyst', 'role:reviewer', 'capability:plan'])
where f.key = 'claude-code+opus'
on conflict (family_id, feature_id) do nothing;

-- ── M6: the snippet-factory self-hosting pipeline ────────────────────────────
-- The real pipeline exercised end-to-end by opencode+qwen3.6 workers and a
-- Claude reviewer (ADR 0012 / .agents/plans/m6-self-hosting.md). Short coding
-- tasks: a worker writes a solution file + self-validates, a reviewer verifies.

insert into app.features (kind, key) values
  ('lane', 'snippets'), ('role', 'worker'), ('role', 'reviewer')
on conflict (kind, key) do nothing;

insert into app.workflows (key, description) values
  ('snippet-factory', 'Tiny coding tasks: worker writes + self-validates, reviewer verifies.')
on conflict (key) do nothing;

-- todo (worker writes the solution) → review (reviewer verifies) → done.
insert into app.stages (workflow_id, key, ordering, is_initial, is_terminal)
select w.id, v.key, v.ordering, v.is_initial, v.is_terminal
from app.workflows w
cross join (values
  ('todo',   0, true,  false),
  ('review', 1, false, false),
  ('done',   2, false, true)
) as v(key, ordering, is_initial, is_terminal)
where w.key = 'snippet-factory'
on conflict (workflow_id, key) do nothing;

-- worker advances todo→review; reviewer advances review→done or rejects review→todo.
insert into app.transitions (workflow_id, from_stage, to_stage, kind, required_features)
select w.id, sf.id, st.id, 'advance', array['lane:snippets', 'role:worker']
from app.workflows w
join app.stages sf on sf.workflow_id = w.id and sf.key = 'todo'
join app.stages st on st.workflow_id = w.id and st.key = 'review'
where w.key = 'snippet-factory'
  and not exists (select 1 from app.transitions t where t.workflow_id = w.id and t.from_stage = sf.id and t.to_stage = st.id and t.kind = 'advance');

insert into app.transitions (workflow_id, from_stage, to_stage, kind, required_features)
select w.id, sf.id, st.id, 'advance', array['lane:snippets', 'role:reviewer']
from app.workflows w
join app.stages sf on sf.workflow_id = w.id and sf.key = 'review'
join app.stages st on st.workflow_id = w.id and st.key = 'done'
where w.key = 'snippet-factory'
  and not exists (select 1 from app.transitions t where t.workflow_id = w.id and t.from_stage = sf.id and t.to_stage = st.id and t.kind = 'advance');

insert into app.transitions (workflow_id, from_stage, to_stage, kind, required_features)
select w.id, sf.id, st.id, 'reject', array['lane:snippets', 'role:reviewer']
from app.workflows w
join app.stages sf on sf.workflow_id = w.id and sf.key = 'review'
join app.stages st on st.workflow_id = w.id and st.key = 'todo'
where w.key = 'snippet-factory'
  and not exists (select 1 from app.transitions t where t.workflow_id = w.id and t.from_stage = sf.id and t.to_stage = st.id and t.kind = 'reject');

insert into app.lanes (project_id, key, workflow_id, context)
select p.id, 'snippets', w.id, '{"work_dir": "work/"}'::jsonb
from app.projects p, app.workflows w
where p.slug = 'ainarres' and w.key = 'snippet-factory'
on conflict (project_id, key) do nothing;

-- The worker family (durable competence unit, ADR 0007): opencode harness + qwen3.6.
insert into app.agent_families (key, description) values
  ('opencode+qwen3.6', 'opencode harness, qwen3.6 model — snippet worker')
on conflict (key) do nothing;

insert into app.family_features (family_id, feature_id)
select f.id, ft.id
from app.agent_families f
join app.features ft on ft.name = any (array['lane:snippets', 'role:worker'])
where f.key = 'opencode+qwen3.6'
on conflict (family_id, feature_id) do nothing;

-- ── M8: egress capability (ADR 0015) ─────────────────────────────────────────
-- Pushing to git / opening a PR is a GATED feature, not an ambient power: a family
-- can be allowed to code but not push, which makes it ineligible for an `integrate`
-- transition (the substrate decides who may touch the outside world). The feature
-- is seeded here; it is GRANTED only to the push-trusted integrator family, which
-- is the grok harness (M11) — the only runtime that can actually merge. (M10's
-- rehearsal showed the frontier orchestrator can't perform the company-deny-gated
-- merge, so capability:integrate must NOT sit on claude-code+opus.)
insert into app.features (kind, key) values ('capability', 'integrate')
on conflict (kind, key) do nothing;

-- ── M9: the AINARRES development workflow (ADR 0016) ──────────────────────────
-- The real loop, as data: change → test → integrate → validate, with rework. This
-- is the workflow AINARRES's own development runs on (ADR 0013). A feature is a set
-- of dev-lane tasks linked by depends_on (M7/ADR 0014); each task traverses these
-- stages. Functional roles are features on the transitions out of each stage; lane
-- membership (lane:dev) is enforced separately by the verbs.

-- The dev lane membership feature + the role vocabulary the workflow routes by
-- (role:reviewer and capability:integrate already exist).
insert into app.features (kind, key) values
  ('lane', 'dev'),
  ('role', 'designer'), ('role', 'implementer'), ('role', 'integrator')
on conflict (kind, key) do nothing;

-- Generous, stage-appropriate leases (real work runs minutes-to-hours, not ms);
-- bounded auto-heartbeat keeps a healthy long task from being reclaimed (ADR 0009).
insert into app.workflows (key, description, default_lease, default_max_attempts) values
  ('ainarres-dev', 'AINARRES self-development: change → test → integrate → validate, with rework.',
   interval '30 minutes', 3)
on conflict (key) do nothing;

-- proposed (initial) → designing → implementing → reviewing → integrating →
-- validating → done (the single terminal stage; failures rework, never go terminal).
insert into app.stages (workflow_id, key, ordering, is_initial, is_terminal, lease_duration)
select w.id, v.key, v.ord, v.ini, v.term, v.lease
from app.workflows w
cross join (values
  ('proposed',    0, true,  false, null::interval),
  ('designing',   1, false, false, interval '1 hour'),
  ('implementing',2, false, false, interval '2 hours'),
  ('reviewing',   3, false, false, interval '1 hour'),
  ('integrating', 4, false, false, interval '30 minutes'),
  ('validating',  5, false, false, interval '30 minutes'),
  ('done',        6, false, true,  null::interval)
) as v(key, ord, ini, term, lease)
where w.key = 'ainarres-dev'
on conflict (workflow_id, key) do nothing;

-- Advance transitions, each gated by the role that owns that step. The
-- integrate step additionally requires capability:integrate (ADR 0015): only a
-- push-trusted family can open/merge the PR.
insert into app.transitions (workflow_id, from_stage, to_stage, kind, required_features)
select w.id, sf.id, st.id, 'advance', v.req
from app.workflows w
cross join (values
  ('proposed',    'designing',   array['role:designer']),
  ('designing',   'implementing',array['role:designer']),
  ('implementing','reviewing',   array['role:implementer']),
  ('reviewing',   'integrating', array['role:reviewer']),
  ('integrating', 'validating',  array['role:integrator','capability:integrate']),
  ('validating',  'done',        array['role:reviewer'])
) as v(from_key, to_key, req)
join app.stages sf on sf.workflow_id = w.id and sf.key = v.from_key
join app.stages st on st.workflow_id = w.id and st.key = v.to_key
where w.key = 'ainarres-dev'
  and not exists (select 1 from app.transitions t
    where t.workflow_id = w.id and t.from_stage = sf.id and t.to_stage = st.id and t.kind = 'advance');

-- Reject (rework) transitions: send work back to implementing. Separately gated.
insert into app.transitions (workflow_id, from_stage, to_stage, kind, required_features)
select w.id, sf.id, st.id, 'reject', v.req
from app.workflows w
cross join (values
  ('reviewing',  'implementing', array['role:reviewer']),
  ('validating', 'implementing', array['role:reviewer']),
  ('integrating','implementing', array['role:integrator','capability:integrate'])
) as v(from_key, to_key, req)
join app.stages sf on sf.workflow_id = w.id and sf.key = v.from_key
join app.stages st on st.workflow_id = w.id and st.key = v.to_key
where w.key = 'ainarres-dev'
  and not exists (select 1 from app.transitions t
    where t.workflow_id = w.id and t.from_stage = sf.id and t.to_stage = st.id and t.kind = 'reject');

insert into app.lanes (project_id, key, workflow_id, context)
select p.id, 'dev', w.id, '{"repo": "https://github.com/laanito/ainarres"}'::jsonb
from app.projects p, app.workflows w
where p.slug = 'ainarres' and w.key = 'ainarres-dev'
on conflict (project_id, key) do nothing;

-- Real families on the dev lane. Roles map to the harness that can perform them:
--   claude-code+opus (frontier, Claude Code) → designer + reviewer. NOT integrator:
--     Claude Code is under the company merge-deny and cannot perform the merge.
--   opencode+qwen3.6 (local worker) → implementer.
--   grok+grok-4.6 (xAI harness, M11) → integrator (holds capability:integrate;
--     see the M11 block below).
-- lane:intake alongside lane:dev (v8 step 1): the STANDING designer accepts a brief the
-- human intaker has refined (briefed→accepted is role:designer's transition, M24 D2) and
-- decomposes it into dev work. role:intaker is deliberately NOT granted — refining a raw
-- request stays the human's step, and without it `proposed_brief` has no outbound
-- transition the designer is eligible for, so the substrate keeps it out. This mirrors
-- loop/roles.sh::role_features(designer); the roster record and the signed token must
-- agree (the substrate trusts the token, ADR 0007 — this row is the provisioning truth).
insert into app.family_features (family_id, feature_id)
select f.id, ft.id
from app.agent_families f
join app.features ft on ft.name = any (array['lane:dev', 'lane:intake', 'role:designer'])
where f.key = 'claude-code+opus'
on conflict (family_id, feature_id) do nothing;

insert into app.family_features (family_id, feature_id)
select f.id, ft.id
from app.agent_families f
join app.features ft on ft.name = any (array['lane:dev', 'role:implementer'])
where f.key = 'opencode+qwen3.6'
on conflict (family_id, feature_id) do nothing;

-- ── M11: the grok integrator family (ADR 0015/0017) ──────────────────────────
-- Integration (push + PR + merge) runs on the grok harness — outside the company-
-- managed merge policy, and invoked INDEPENDENTLY of the frontier orchestrator
-- (M10's rehearsal proved Claude Code cannot spawn another harness to perform a
-- deny-gated merge — that would launder the denial). So capability:integrate lives
-- with the grok family, the only runtime that can actually merge.
insert into app.agent_families (key, description) values
  ('grok+grok-4.6', 'grok harness, grok-4.6 model — push-trusted independent integrator')
on conflict (key) do nothing;

insert into app.family_features (family_id, feature_id)
select f.id, ft.id
from app.agent_families f
join app.features ft on ft.name = any (array['lane:dev', 'role:integrator', 'capability:integrate'])
where f.key = 'grok+grok-4.6'
on conflict (family_id, feature_id) do nothing;

-- ── M19: the claude frontier review peer (federation, ADR 0021 · design/federation.md) ──
-- Federate the non-privileged frontier roles across MAKERS. claude-code+opus already
-- exists (seeded above with role:designer — the design peer). Add claude-code+sonnet as
-- the REVIEW peer: split by model per role (design/federation.md D2 — opus for design
-- judgment, sonnet for review), two DISTINCT families, the same split we run with
-- opencode+zen / opencode+qwen. NEITHER claude family holds capability:integrate — the
-- single grok integrator stays the only family that can merge (D1/D5). Sharing REVIEW is
-- what buys uncorrelated failure: a claude reviewer catches what grok's blind spots miss.
insert into app.agent_families (key, description) values
  ('claude-code+sonnet', 'Claude Code harness, Sonnet model — M19 frontier review peer (no capability:integrate)')
on conflict (key) do nothing;

insert into app.family_features (family_id, feature_id)
select f.id, ft.id
from app.agent_families f
join app.features ft on ft.name = any (array['lane:dev', 'role:reviewer'])
where f.key = 'claude-code+sonnet'
on conflict (family_id, feature_id) do nothing;

-- ── Roster: opencode + big-pickle (cheap implementer) ────────────────────────
-- An API-driven model available through opencode (free, rate-limited). A second
-- CHEAP implementer alongside opencode+qwen3.6: holds role:implementer on lane:dev
-- but NOT capability:frontier, so v3's escalation (ADR 0019) routes a task it can't
-- finish on to a frontier family. Invoke with the existing ainarres-implementer
-- agent and `-m opencode/big-pickle`.
insert into app.agent_families (key, description) values
  ('opencode+big-pickle', 'opencode harness, big-pickle model — API-driven cheap implementer (free, rate-limited)')
on conflict (key) do nothing;

insert into app.family_features (family_id, feature_id)
select f.id, ft.id
from app.agent_families f
join app.features ft on ft.name = any (array['lane:dev', 'role:implementer'])
where f.key = 'opencode+big-pickle'
on conflict (family_id, feature_id) do nothing;

-- ── Roster: openrouter nemotron-3 models via opencode (cheap implementers) ────
-- Two more free, rate-limited API implementers reachable through opencode/openrouter,
-- expanding the cheap-tier swarm. Both hold role:implementer on lane:dev, NOT
-- capability:frontier (so v3 escalation, ADR 0019, routes their stalls onward).
-- Invoke with the ainarres-implementer agent and the matching `-m` model id:
--   opencode+nemotron-3-ultra → -m openrouter/nvidia/nemotron-3-ultra-550b-a55b:free
--   opencode+nemotron-3-super → -m openrouter/nvidia/nemotron-3-super-120b-a12b:free
-- NB: nemotron-3-ultra is 550B (frontier-scale) yet free — a candidate to hold
-- capability:frontier when that feature lands (M12), i.e. a free escalation target.
insert into app.agent_families (key, description) values
  ('opencode+nemotron-3-ultra', 'opencode/openrouter, nvidia nemotron-3-ultra-550b-a55b:free — cheap implementer (free, rate-limited)'),
  ('opencode+nemotron-3-super', 'opencode/openrouter, nvidia nemotron-3-super-120b-a12b:free — cheap implementer (free, rate-limited)')
on conflict (key) do nothing;

insert into app.family_features (family_id, feature_id)
select f.id, ft.id
from app.agent_families f
join app.features ft on ft.name = any (array['lane:dev', 'role:implementer'])
where f.key in ('opencode+nemotron-3-ultra', 'opencode+nemotron-3-super')
on conflict (family_id, feature_id) do nothing;

-- ── Roster: opencode + nemotron-3-nano (tier-0 cheapest implementer) ──────────
-- The cheapest implementer, reached through opencode's ollama provider (Ollama's
-- cloud passthrough): `-m ollama/nemotron-3-nano:30b-cloud`. Holds role:implementer
-- on lane:dev, NOT capability:frontier/tier:2. The loop runs it as a tier-0 SERIAL
-- pre-pass ahead of big-pickle's pool (loop/roles.sh::LOOP_PRE_TIERS): its backend
-- allows only ONE concurrent session, so it must never be fanned out into the pool.
-- A family must be registered here to be eligible to claim ("unknown family" ⇒
-- not_eligible) — a valid token's features alone are not enough (ADR 0007).
insert into app.agent_families (key, description) values
  ('opencode+nemotron-3-nano', 'opencode/ollama, nemotron-3-nano:30b-cloud — tier-0 cheapest implementer (1 concurrent session)')
on conflict (key) do nothing;

insert into app.family_features (family_id, feature_id)
select f.id, ft.id
from app.agent_families f
join app.features ft on ft.name = any (array['lane:dev', 'role:implementer'])
where f.key = 'opencode+nemotron-3-nano'
on conflict (family_id, feature_id) do nothing;

-- ── Roster: opencode + qwen3-coder-next (cheap serial implementer) ───────────
-- An 80B cheap implementer at big-pickle's level, reached through opencode's ollama
-- provider (Ollama cloud passthrough): `-m ollama/qwen3-coder-next:cloud`. Holds
-- role:implementer on lane:dev, NOT capability:frontier/tier:2. The loop runs it as the
-- FIRST serial tier after the pool (loop/roles.sh::LOOP_SERIAL_TIERS) — a single serial
-- sweep, since its :cloud backend allows only ONE concurrent session, so it can't join
-- big-pickle's ×N pool. Reuses the opencode implementer wrapper (no new harness). A family
-- must be registered here to be claim-eligible ("unknown family" ⇒ not_eligible, ADR 0007).
insert into app.agent_families (key, description) values
  ('opencode+qwen3-coder-next', 'opencode/ollama, qwen3-coder-next:cloud (80B) — cheap serial implementer, big-pickle par (1 concurrent session)')
on conflict (key) do nothing;

insert into app.family_features (family_id, feature_id)
select f.id, ft.id
from app.agent_families f
join app.features ft on ft.name = any (array['lane:dev', 'role:implementer'])
where f.key = 'opencode+qwen3-coder-next'
on conflict (family_id, feature_id) do nothing;

-- ── Roster: opencode + muse-glimmer (cheap serial implementer, local MLX) ────
-- A 30B local MLX model, reached through opencode's ollama provider:
-- `-m ollama/muse-glimmer:30b-mlx`. Holds role:implementer on lane:dev, NOT
-- capability:frontier/tier:2. The loop runs it as a serial sweep AFTER qwen3-coder-next
-- (loop/roles.sh::LOOP_SERIAL_TIERS) — a single serial sweep, since a local MLX model
-- loads one at a time (one concurrent session), so it can't join big-pickle's ×N pool.
-- Reuses the opencode implementer wrapper (no new harness). Vetted against opencode's
-- actual toolset (read/edit/write, no hallucinated tools) before seating. A family must
-- be registered here to be claim-eligible ("unknown family" ⇒ not_eligible, ADR 0007).
insert into app.agent_families (key, description) values
  ('opencode+muse-glimmer', 'opencode/ollama, muse-glimmer:30b-mlx (30B local MLX) — cheap serial implementer (1 concurrent session)')
on conflict (key) do nothing;

insert into app.family_features (family_id, feature_id)
select f.id, ft.id
from app.agent_families f
join app.features ft on ft.name = any (array['lane:dev', 'role:implementer'])
where f.key = 'opencode+muse-glimmer'
on conflict (family_id, feature_id) do nothing;

-- ── Roster: cursor-agent + composer-2.5 (fallback implementer) ───────────────
-- A higher-quality implementer than the cheap opencode tiers, below the grok frontier:
-- Cursor's headless coding agent (`cursor-agent -p … --model composer-2.5 --force`).
-- Holds role:implementer on lane:dev, NOT capability:frontier/tier:2. The loop runs it
-- as the FIRST serial fallback, ahead of nemotron-3-ultra (loop/roles.sh::
-- LOOP_SERIAL_TIERS) — a single serial sweep, its own harness wrapper
-- (loop/cursor-implementer.sh). A family must be registered here to be eligible to
-- claim ("unknown family" ⇒ not_eligible) — a valid token's features alone are not
-- enough (ADR 0007).
insert into app.agent_families (key, description) values
  ('cursor-agent+composer-2.5', 'cursor-agent harness, composer-2.5 model — fallback implementer (higher quality than the cheap tiers, not frontier)')
on conflict (key) do nothing;

insert into app.family_features (family_id, feature_id)
select f.id, ft.id
from app.agent_families f
join app.features ft on ft.name = any (array['lane:dev', 'role:implementer'])
where f.key = 'cursor-agent+composer-2.5'
on conflict (family_id, feature_id) do nothing;

-- ── v7 / M26: the human/external intake identity (the local channel's caller) ─
-- The intake channel (bin/intake-server.mjs, ADR 0025) authenticates an external
-- Customer with a pre-shared key and then acts AS this identity to open a proposed_brief
-- in the intake lane. It is a HUMAN identity, DISTINCT from the worker (agent) families
-- above: it holds ONLY lane:intake + role:intaker — the M24 two-tier create-gate lets it
-- create the request-root, and NOTHING else (no lane:dev, so it cannot create dev work;
-- no capability:integrate, so it can never merge — the substrate's D4 gate is the inner
-- wall behind the channel's PSK, defence in depth). The features it is granted here match
-- what M24 seeded (lane:intake, role:intaker). A family must be registered to be usable
-- ("unknown family" ⇒ not_eligible, ADR 0007) — that is why the channel's identity lives
-- here in the roster, even though it is a human, not a harness.
insert into app.agent_families (key, description) values
  ('human+intaker', 'the local intake channel''s caller (ADR 0025) — a human/external identity that opens proposed briefs via role:intaker; NOT a worker (no lane:dev, no capability:integrate)')
on conflict (key) do nothing;

insert into app.family_features (family_id, feature_id)
select f.id, ft.id
from app.agent_families f
join app.features ft on ft.name = any (array['lane:intake', 'role:intaker'])
where f.key = 'human+intaker'
on conflict (family_id, feature_id) do nothing;

-- ── M12: capability escalation (ADR 0019, ordered tiers) ─────────────────────
-- tier:2 is the frontier rung (base implementer work needs no tier feature). The
-- frontier implementer / escalation target is grok+grok-4.6: it already integrates;
-- now it also claims escalated `implementing` tasks (role:implementer + tier:2). The
-- cheap implementers (qwen3.6, big-pickle, nemotron-*) hold no tier:2, so a task
-- escalated to require tier:2 routes to grok. Implementing tasks escalate after the
-- SECOND failed attempt (escalate_after = 2 < max_attempts = 3): the loop runs two
-- cheap tiers (qwen, then a fallback opencode implementer), so each gets one attempt
-- before the task escalates to the frontier — cheap tiers first, grok as the ceiling.
-- NB: nemotron-3-ultra (550B, free) is a candidate to ALSO hold tier:2 as a free
-- escalation target — a one-line grant when we choose to trust it (roadmap / v3-plan).
insert into app.features (kind, key) values ('tier', '2')
on conflict (kind, key) do nothing;

insert into app.family_features (family_id, feature_id)
select f.id, ft.id
from app.agent_families f
join app.features ft on ft.name = any (array['role:implementer', 'tier:2'])
where f.key = 'grok+grok-4.6'
on conflict (family_id, feature_id) do nothing;

update app.stages set escalate_after = 2
where key = 'implementing'
  and workflow_id = (select id from app.workflows where key = 'ainarres-dev');

commit;
