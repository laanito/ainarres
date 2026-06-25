import { beforeAll, describe, expect, it } from "vitest";
import { execFile, query, scalar, waitForDb } from "./helpers/db";

// M1: the seed fixture loaded a complete, coherent instance of the model, and it
// is idempotent — re-applying it changes no row counts (so `make reset` is
// deterministic).

beforeAll(() => waitForDb());

// Scoped to the seed's own entities — other test files add their own fixtures
// (m3, race) in parallel, so global counts would be polluted. We verify the seed
// loaded correctly, not that the DB contains nothing else.
const SEED_FAMILIES = "('opencode+qwen','claude-code+opus')";
const counts = () => ({
  features: scalar<number>(
    "select count(*)::int from app.features where name = any(array['lane:api','role:analyst','role:reviewer','capability:plan'])",
  ),
  workflows: scalar<number>("select count(*)::int from app.workflows where key = 'dev-loop'"),
  stages: scalar<number>(
    "select count(*)::int from app.stages s join app.workflows w on w.id = s.workflow_id where w.key = 'dev-loop'",
  ),
  lanes: scalar<number>("select count(*)::int from app.lanes where key = 'api'"),
  transitions: scalar<number>(
    "select count(*)::int from app.transitions t join app.workflows w on w.id = t.workflow_id where w.key = 'dev-loop'",
  ),
  families: scalar<number>(
    `select count(*)::int from app.agent_families where key in ${SEED_FAMILIES}`,
  ),
  family_features: scalar<number>(
    `select count(*)::int from app.family_features ff
     join app.agent_families f on f.id = ff.family_id where f.key in ${SEED_FAMILIES}`,
  ),
});

describe("seed fixture", () => {
  it("loaded the expected rows", () => {
    const c = counts();
    expect(c.features).toBe(4); // lane:api, role:analyst, role:reviewer, capability:plan
    expect(c.workflows).toBe(1);
    expect(c.stages).toBe(4); // backlog, in-progress, review, done
    expect(c.lanes).toBe(1);
    expect(c.transitions).toBe(4); // 3 advance + 1 reject
    expect(c.families).toBe(2);
    expect(c.family_features).toBe(8); // 3 for opencode+qwen, 5 for claude-code+opus (+capability:integrate, M8)
  });

  it("the dev-loop workflow has exactly one initial and one terminal stage", () => {
    const [row] = query<{ initial: number; terminal: number }>(`
      select
        count(*) filter (where s.is_initial)::int  as initial,
        count(*) filter (where s.is_terminal)::int as terminal
      from app.stages s join app.workflows w on w.id = s.workflow_id
      where w.key = 'dev-loop'
    `);
    expect(row.initial).toBe(1);
    expect(row.terminal).toBe(1);
  });

  it("transitions reference canonical feature names that all exist", () => {
    // Every name used in any transition.required_features must be a real feature.
    const orphans = query<{ name: string }>(`
      select distinct rf as name
      from app.transitions t, unnest(t.required_features) as rf
      where rf not in (select name from app.features)
    `);
    expect(orphans).toEqual([]);
  });

  it("is idempotent — re-applying the seed changes no row counts", () => {
    const before = counts();
    const res = execFile("db/seed.sql");
    expect(res.ok, res.error).toBe(true);
    const after = counts();
    expect(after).toEqual(before);
  });
});
