#!/usr/bin/env bash
# M13 done-test (ADR 0020 § pollution-proofing): prove the autonomous-loop
# substrate and the test substrate are isolated.
#
# The M11 incident: a per-task `validate` ran the full suite against the SHARED
# dev substrate, so the suite's dev-lane fixtures landed in the live board and
# blocked real tasks. v3 fixes this by giving the loop its own instance. This
# script proves the fix mechanically:
#
#   1. plant a sentinel task in the LOOP substrate's `dev` lane;
#   2. run a full `make reset` against the TEST substrate — which tears its
#      volume down (`down -v`) AND runs the vitest suite, itself creating
#      dev-lane fixtures in the test substrate;
#   3. assert the loop's board is byte-for-byte untouched (sentinel present,
#      same stage, and no new dev tasks injected).
#
# Run deliberately (it's heavy — a full reset + suite): `make verify-isolation`.
set -euo pipefail

cd "$(dirname "$0")/.."

COMPOSE_LOOP=(docker compose -p ainarres-loop --env-file loop.env)
SENTINEL="M13-ISOLATION-SENTINEL"

# Run a scalar query against the LOOP substrate's db, trimmed.
loop_q() {
  "${COMPOSE_LOOP[@]}" exec -T db \
    psql -v ON_ERROR_STOP=1 -U postgres -d ainarres -A -t -X -q -c "$1" | tr -d '[:space:]'
}

fail() { echo "✗ ISOLATION FAILED: $*" >&2; exit 1; }

echo "→ bringing up + seeding the loop substrate (ainarres-loop, ports 5434/3011)…"
"${COMPOSE_LOOP[@]}" up -d >/dev/null
# Wait for the loop db to answer before seeding.
for _ in $(seq 1 30); do
  if "${COMPOSE_LOOP[@]}" exec -T db pg_isready -U postgres -d ainarres >/dev/null 2>&1; then break; fi
  sleep 1
done
"${COMPOSE_LOOP[@]}" exec -T db \
  psql -v ON_ERROR_STOP=1 -U postgres -d ainarres < db/seed.sql >/dev/null
echo "  ✓ loop substrate ready"

echo "→ planting a sentinel task in the loop's dev lane…"
loop_q "
  insert into app.tasks (lane_id, stage, payload)
  select l.id, s.id, '{\"goal\":\"${SENTINEL}\"}'::jsonb
  from app.lanes l
  join app.projects p on p.id = l.project_id and p.slug = 'ainarres'
  join app.stages s on s.workflow_id = l.workflow_id and s.is_initial
  where l.key = 'dev'
    and not exists (select 1 from app.tasks t where t.payload->>'goal' = '${SENTINEL}');
" >/dev/null

# Total dev-lane tasks in the loop before, and the sentinel's stage key.
before_dev=$(loop_q "
  select count(*) from app.tasks t
  join app.lanes l on l.id = t.lane_id
  join app.projects p on p.id = l.project_id and p.slug = 'ainarres'
  where l.key = 'dev';")
before_stage=$(loop_q "
  select s.key from app.tasks t join app.stages s on s.id = t.stage
  where t.payload->>'goal' = '${SENTINEL}';")
[[ "$before_stage" == "proposed" ]] || fail "sentinel did not land at the initial stage (got '${before_stage}')"
echo "  ✓ sentinel at stage '${before_stage}'; loop dev-lane task count = ${before_dev}"

echo "→ running a FULL reset of the TEST substrate (down -v + up + seed + suite)…"
echo "  (this is the action that polluted the shared board in M11)"
make reset >/dev/null
echo "  ✓ test substrate reset + suite complete"

echo "→ re-checking the loop substrate is untouched…"
after_dev=$(loop_q "
  select count(*) from app.tasks t
  join app.lanes l on l.id = t.lane_id
  join app.projects p on p.id = l.project_id and p.slug = 'ainarres'
  where l.key = 'dev';")
after_stage=$(loop_q "
  select coalesce(max(s.key), '<gone>') from app.tasks t join app.stages s on s.id = t.stage
  where t.payload->>'goal' = '${SENTINEL}';")

[[ "$after_stage" == "proposed" ]] || fail "sentinel changed/vanished after test reset (stage now '${after_stage}')"
[[ "$after_dev" == "$before_dev" ]] || fail "loop dev-lane task count changed ${before_dev} → ${after_dev} (test substrate leaked in)"

echo
echo "✓ ISOLATION HOLDS: loop dev lane unchanged (${after_dev} tasks, sentinel still at '${after_stage}')"
echo "  the full test reset + suite did not touch the loop's board."
