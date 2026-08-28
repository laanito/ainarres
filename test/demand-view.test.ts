import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { exec, query, waitForDb } from "./helpers/db";
import { restGet, waitForReady } from "./helpers/http";
import { mintToken } from "./helpers/mint";

// M27 Slice A (v7.1 · ADR 0026 · design/precise-service.md D1) — api.demand: pending work in
// CAPABILITY terms, so a service can start only the workers some waiting task actually needs
// instead of the whole fleet on every wake.
//
// Its predicate is claim_next_task's minus the capability terms, so these tests pin exactly
// that correspondence: what a capable family COULD claim right now is what shows up as
// demand, and everything claim would skip (blocked, terminal, live lease, unmet dependency)
// is absent. DB test, validated ASSISTED — a view has no substrate-free self-check.
//
// Fixture: its own workflow + lane per run, so counts are exact and no other test file's
// rows can drift into them.

const FAM = "v8-demand";
const SUFFIX = randomUUID().slice(0, 8);
const LANE = `v8-demand-${SUFFIX}`;
const WF = `${LANE}-wf`;
const ROLE_A = `role:v8a-${SUFFIX}`;   // moves `open` → `mid`
const ROLE_B = `role:v8b-${SUFFIX}`;   // moves `mid`  → `done`
const ROLE_R = `role:v8r-${SUFFIX}`;   // the SECOND way out of `mid` (a reject path)
const EXTRA = `tier:v8x-${SUFFIX}`;    // a task-level required_feature

const FIXTURE = `
  insert into app.features (kind, key) values
    ('lane', '${LANE}'),
    ('role', 'v8a-${SUFFIX}'), ('role', 'v8b-${SUFFIX}'), ('role', 'v8r-${SUFFIX}'),
    ('tier', 'v8x-${SUFFIX}')
  on conflict (kind, key) do nothing;

  insert into app.agent_families (key) values ('${FAM}') on conflict (key) do nothing;

  insert into app.workflows (key, description, default_lease)
  values ('${WF}', 'M27 demand fixture', interval '1 hour')
  on conflict (key) do nothing;

  insert into app.stages (workflow_id, key, ordering, is_initial, is_terminal)
  select w.id, v.key, v.ord, v.ini, v.term
  from app.workflows w
  cross join (values ('open', 0, true, false), ('mid', 1, false, false), ('done', 2, false, true))
    as v(key, ord, ini, term)
  where w.key = '${WF}'
  on conflict (workflow_id, key) do nothing;

  -- open →[A] mid ; mid →[B] done ; mid →[R] open  (two ways out of 'mid')
  insert into app.transitions (workflow_id, from_stage, to_stage, kind, required_features)
  select w.id, sf.id, st.id, v.kind, v.req
  from app.workflows w
  cross join (values
    ('open', 'mid',  'advance', array['${ROLE_A}']),
    ('mid',  'done', 'advance', array['${ROLE_B}']),
    ('mid',  'open', 'reject',  array['${ROLE_R}'])
  ) as v(from_key, to_key, kind, req)
  join app.stages sf on sf.workflow_id = w.id and sf.key = v.from_key
  join app.stages st on st.workflow_id = w.id and st.key = v.to_key
  where w.key = '${WF}'
    and not exists (select 1 from app.transitions t
      where t.workflow_id = w.id and t.from_stage = sf.id and t.to_stage = st.id and t.kind = v.kind);

  insert into app.lanes (project_id, key, workflow_id)
  select p.id, '${LANE}', w.id from app.projects p, app.workflows w
  where p.slug = 'ainarres' and w.key = '${WF}'
  on conflict (project_id, key) do nothing;

  insert into app.agents (id, family_id)
  select '${"00000000-0000-4000-9000-" + SUFFIX.padEnd(12, "0")}'::uuid, f.id
  from app.agent_families f where f.key = '${FAM}'
  on conflict (id) do nothing;
`;

const AGENT = `00000000-0000-4000-9000-${SUFFIX.padEnd(12, "0")}`;

type Row = { bundle: string[]; lane: string; pending: number };
const demand = (): Row[] =>
  query<Row>(`select bundle, lane, pending from api.demand where lane = '${LANE}'`) as Row[];

// PostgREST/psql hand back a text[] literal; normalise to a sorted JS array for comparison.
const asSet = (bundle: unknown): string[] => {
  const raw = Array.isArray(bundle) ? bundle : String(bundle).replace(/^{|}$/g, "").split(",");
  return raw.map((s) => String(s).replace(/^"|"$/g, "")).filter(Boolean).sort();
};
const bundleFor = (...features: string[]): Row | undefined => {
  const want = [...features].sort().join("|");
  return demand().find((r) => asSet(r.bundle).join("|") === want);
};

// Plant a task on the fixture lane. Defaults: pending at `open`, no lease, not blocked.
function plant(opts: {
  stage?: string;
  required?: string[];
  blocked?: boolean;
  leaseMins?: number | null;
  dependsOn?: string[];
} = {}): string {
  const id = randomUUID();
  const stage = opts.stage ?? "open";
  const required = opts.required ?? [];
  const lease = opts.leaseMins === undefined || opts.leaseMins === null
    ? "null"
    : `now() + interval '${opts.leaseMins} minutes'`;
  const claimed = opts.leaseMins === undefined || opts.leaseMins === null ? "null" : `'${AGENT}'::uuid`;
  const deps = opts.dependsOn?.length
    ? `array[${opts.dependsOn.map((d) => `'${d}'::uuid`).join(",")}]`
    : "'{}'::uuid[]";
  exec(`
    insert into app.tasks (id, lane_id, stage, payload, required_features, blocked, claimed_by, lease_expires_at, depends_on)
    select '${id}'::uuid, l.id, s.id, '{"goal":"m27 demand fixture"}'::jsonb,
           array[${required.map((f) => `'${f}'`).join(",") || ""}]::text[],
           ${opts.blocked ? "true" : "false"}, ${claimed}, ${lease}, ${deps}
    from app.lanes l
    join app.stages s on s.workflow_id = l.workflow_id and s.key = '${stage}'
    where l.key = '${LANE}';
  `);
  return id;
}

beforeAll(async () => {
  waitForDb();
  const res = exec(FIXTURE);
  if (!res.ok) throw new Error(`fixture failed: ${res.error}`);
  await waitForReady();
});

describe("api.demand — pending work in capability terms", () => {
  it("reports the bundle a waiting task needs: lane + the transition's role", () => {
    plant();
    const row = bundleFor(`lane:${LANE}`, ROLE_A);
    expect(row, JSON.stringify(demand())).toBeTruthy();
    expect(row!.pending).toBe(1);
    expect(row!.lane).toBe(LANE);
  });

  it("counts tasks needing the SAME bundle together", () => {
    plant();
    plant();
    expect(bundleFor(`lane:${LANE}`, ROLE_A)!.pending).toBe(3); // the one above + these two
  });

  it("includes the task's own required_features in the bundle (M12 escalation carries them)", () => {
    plant({ required: [EXTRA] });
    const row = bundleFor(`lane:${LANE}`, ROLE_A, EXTRA);
    expect(row).toBeTruthy();
    expect(row!.pending).toBe(1);
    // …and it does NOT inflate the plain bundle's count.
    expect(bundleFor(`lane:${LANE}`, ROLE_A)!.pending).toBe(3);
  });

  it("lists EVERY way out of a stage — one row per outgoing transition, task counted once each", () => {
    plant({ stage: "mid" });
    expect(bundleFor(`lane:${LANE}`, ROLE_B)!.pending).toBe(1); // the advance path
    expect(bundleFor(`lane:${LANE}`, ROLE_R)!.pending).toBe(1); // the reject path
  });

  it("omits what claim_next_task would skip: blocked, live lease, terminal, unmet dependency", () => {
    const before = bundleFor(`lane:${LANE}`, ROLE_A)!.pending;

    plant({ blocked: true });
    plant({ leaseMins: 30 });                       // held, lease still live
    plant({ stage: "done" });                       // terminal stage: no outgoing transition
    const blocker = plant();                        // …itself pending, so it counts
    plant({ dependsOn: [blocker] });                // dependency not terminal ⇒ not yet claimable

    expect(bundleFor(`lane:${LANE}`, ROLE_A)!.pending).toBe(before + 1); // only the blocker
  });

  it("counts a task again once its lease has LAPSED (lazy reclaim makes it pending, ADR 0009)", () => {
    const before = bundleFor(`lane:${LANE}`, ROLE_A)!.pending;
    plant({ leaseMins: -5 });                       // claimed, but the lease expired
    expect(bundleFor(`lane:${LANE}`, ROLE_A)!.pending).toBe(before + 1);
  });

  it("names no task, worker, tier or service — capability terms only (the ADR 0026 line)", () => {
    const cols = query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_schema = 'api' and table_name = 'demand' order by 1`,
    ).map((c) => c.column_name);
    expect(cols).toEqual(["bundle", "lane", "pending"]);
  });

  it("is readable by oversight AND the read-only monitor role", async () => {
    for (const role of ["oversight", "monitor"]) {
      const res = await restGet("demand?limit=1", { token: mintToken(FAM, role, { features: [] }) });
      expect(res.status, `GET /demand as ${role}`).toBe(200);
    }
  });
});
