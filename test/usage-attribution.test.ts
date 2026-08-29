import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { exec, waitForDb } from "./helpers/db";
import { restGet, rpc, waitForReady } from "./helpers/http";
import { mintToken } from "./helpers/mint";

// v8 — a sweep's token spend is charged to the FIRST role-bearing transition it made,
// not the last.
//
// Measured in the first Hermes run (2026-08-29): grok+grok-4.6 merged
// (integrating→validating, role:integrator) and then confirmed the merge green
// (validating→done, role:reviewer) inside ONE harness invocation, and reported usage ONCE
// at the end. Charging the LAST transition put all 52,536 tokens on role:reviewer and left
// role:integrator with no usage row — reading `unknown`, which M20 promises means "not
// measured" rather than "measured and filed next door".
//
// This file reproduces that exact shape and pins both halves of the fix: the first
// transition is charged, AND the sweep window is bounded below by the family's previous
// usage report so a second sweep is not charged to the first sweep's work.

const RUN = randomUUID().slice(0, 8);
// Unique per run (the view aggregates ALL matching history), and one family per test so
// neither test's totals depend on the other having run.
const FAM = `u8a-${RUN}`;        // test 1: one sweep, two stages
const FAM2 = `u8b-${RUN}`;       // test 2: two sweeps, one stage each
const LANE = `u8a-${RUN}`;
const WF = `u8a-${RUN}-wf`;

const FIXTURE = `
  insert into app.features (kind,key) values
    ('lane','${LANE}'),('role','integrator'),('role','reviewer')
  on conflict (kind,key) do nothing;
  insert into app.agent_families (key, description) values
    ('${FAM}', 'test: one family that both integrates and validates'),
    ('${FAM2}', 'test: the same, across two separate sweeps')
  on conflict (key) do nothing;
  insert into app.family_features (family_id, feature_id)
  select f.id, ft.id from app.agent_families f
  join app.features ft on ft.name = any (array['lane:${LANE}','role:integrator','role:reviewer'])
  where f.key in ('${FAM}', '${FAM2}') on conflict (family_id, feature_id) do nothing;
  insert into app.workflows (key, description) values ('${WF}','two capabilities, one sweep')
  on conflict (key) do nothing;
  insert into app.stages (workflow_id, key, ordering, is_initial, is_terminal)
  select w.id, v.key, v.ord, v.ini, v.term from app.workflows w
  cross join (values ('integrating',0,true,false),('validating',1,false,false),('done',2,false,true))
    as v(key,ord,ini,term)
  where w.key='${WF}' on conflict (workflow_id,key) do nothing;
  insert into app.transitions (workflow_id, from_stage, to_stage, kind, required_features)
  select w.id, sf.id, st.id, 'advance', v.req from app.workflows w
  join (values
    ('integrating','validating',array['role:integrator']),
    ('validating','done',array['role:reviewer'])) as v(f,t,req) on true
  join app.stages sf on sf.workflow_id=w.id and sf.key=v.f
  join app.stages st on st.workflow_id=w.id and st.key=v.t
  where w.key='${WF}'
    and not exists (select 1 from app.transitions x where x.from_stage=sf.id and x.to_stage=st.id and x.kind='advance');
  insert into app.lanes (project_id, key, workflow_id)
  select p.id, '${LANE}', w.id from app.projects p join app.workflows w on w.key='${WF}'
  where p.slug='ainarres' on conflict (project_id,key) do nothing;
`;

const json = (r: Response) => r.json() as Promise<any>;
const oversight = () => mintToken(FAM, "oversight", { features: [] });
const seat = (sub: string, family = FAM) =>
  mintToken(family, "agent", { sub, features: [`lane:${LANE}`, "role:integrator", "role:reviewer"] });

async function ok(p: Promise<Response>) {
  const r = await json(await p);
  expect(r.ok).toBe(true);
  return r;
}

const tokens = (n: number) => ({
  tokens: { input: n, output: 0, cache_read: 0, cache_creation: 0 },
  model: "test",
});

// One row of the view for a family of this run.
async function row(capability: string, family = FAM) {
  const rows = await json(await restGet(`family_track_record?family=eq.${family}`, { token: oversight() }));
  return rows.find((r: any) => r.capability === capability);
}

beforeAll(async () => {
  waitForDb();
  const res = exec(FIXTURE);
  if (!res.ok) throw new Error(`fixture failed: ${res.error}`);
  await waitForReady();
});

describe("a sweep that crosses two stages", () => {
  it("charges the FIRST transition's capability, and leaves the second unknown — not zero", async () => {
    const sub = randomUUID(); // ONE actor: one harness invocation, two claims
    const created = await ok(rpc("create_task", { token: seat(sub), body: { lane_key: LANE } }));
    const id = created.task.id;

    // The sweep: merge, then confirm the merge — the Hermes shape, verbatim.
    await ok(rpc("claim_next_task", { token: seat(sub), body: { lane_key: LANE } }));
    await ok(rpc("advance_task", { token: seat(sub), body: { task_id: id, to_stage: "validating" } }));
    await ok(rpc("claim_next_task", { token: seat(sub), body: { lane_key: LANE } }));
    await ok(rpc("advance_task", { token: seat(sub), body: { task_id: id, to_stage: "done" } }));

    // ONE usage report, at the end of the sweep — what every harness wrapper does.
    await ok(rpc("record_usage", { token: oversight(), body: { actor: sub, data: tokens(1000) } }));

    // The work that earned the spend is charged.
    const integ = await row("role:integrator");
    expect(integ).toBeDefined();
    expect(integ.delivered).toBe(1);
    expect(Number(integ.total_tokens)).toBe(1000);
    expect(Number(integ.tokens_per_delivery)).toBe(1000);

    // The stage it went on to finish in still counts as a DELIVERY, but claims none of
    // the spend. `unknown`, not 0 — M20's contract (design/track-record.md D3).
    const rev = await row("role:reviewer");
    expect(rev).toBeDefined();
    expect(rev.delivered).toBe(1);
    expect(rev.total_tokens).toBeNull();
    expect(rev.tokens_per_delivery).toBeNull();
  });

  it("bounds each sweep by the family's previous usage report, so sweep 2 is not charged to sweep 1", async () => {
    const sub = randomUUID();
    const created = await ok(rpc("create_task", { token: seat(sub, FAM2), body: { lane_key: LANE } }));
    const id = created.task.id;

    // Sweep 1: integrate, report.
    await ok(rpc("claim_next_task", { token: seat(sub, FAM2), body: { lane_key: LANE } }));
    await ok(rpc("advance_task", { token: seat(sub, FAM2), body: { task_id: id, to_stage: "validating" } }));
    await ok(rpc("record_usage", { token: oversight(), body: { actor: sub, data: tokens(300) } }));

    // Sweep 2: validate, report. Its window opens at sweep 1's report — so its FIRST
    // transition is validating→done, NOT the integrate it can still see behind it.
    await ok(rpc("claim_next_task", { token: seat(sub, FAM2), body: { lane_key: LANE } }));
    await ok(rpc("advance_task", { token: seat(sub, FAM2), body: { task_id: id, to_stage: "done" } }));
    await ok(rpc("record_usage", { token: oversight(), body: { actor: sub, data: tokens(40) } }));

    // Each sweep found its own first transition. Without the lower bound, sweep 2 would
    // reach back past its own report and charge role:integrator 340.
    expect(Number((await row("role:integrator", FAM2)).total_tokens)).toBe(300);
    expect(Number((await row("role:reviewer", FAM2)).total_tokens)).toBe(40);
  });
});
