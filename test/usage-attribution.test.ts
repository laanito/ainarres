import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
const FAM3 = `u9a-${RUN}`;       // v9: anchored reports, verb-level
const FAM4 = `grok+u9b-${RUN}`;  // v9: anchored reports, through the CLI's stream cutter
const LANE = `u8a-${RUN}`;
const WF = `u8a-${RUN}-wf`;

const FIXTURE = `
  insert into app.features (kind,key) values
    ('lane','${LANE}'),('role','integrator'),('role','reviewer')
  on conflict (kind,key) do nothing;
  insert into app.agent_families (key, description) values
    ('${FAM}', 'test: one family that both integrates and validates'),
    ('${FAM2}', 'test: the same, across two separate sweeps'),
    ('${FAM3}', 'test: anchored per-transition reports'),
    ('${FAM4}', 'test: a streamed grok log cut by the CLI')
  on conflict (key) do nothing;
  insert into app.family_features (family_id, feature_id)
  select f.id, ft.id from app.agent_families f
  join app.features ft on ft.name = any (array['lane:${LANE}','role:integrator','role:reviewer'])
  where f.key in ('${FAM}', '${FAM2}', '${FAM3}', '${FAM4}') on conflict (family_id, feature_id) do nothing;
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
  const rows = await json(await restGet(`family_track_record?family=eq.${encodeURIComponent(family)}`, { token: oversight() }));
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

// v9 Slice 0 (design/customer-seat.md D7) — the WRITER names the transition. A streamed
// sweep log is cut at each transition the sweep made, and each piece is recorded with
// data.transition = that transition's event id. The view then charges it exactly, with no
// window to guess. Same Hermes shape as above: one sweep, integrate then validate.
describe("anchored usage — the writer names the transition (v9 D7)", () => {
  async function hermesSweep(sub: string, family: string) {
    const created = await ok(rpc("create_task", { token: seat(sub, family), body: { lane_key: LANE } }));
    const id = created.task.id;
    await ok(rpc("claim_next_task", { token: seat(sub, family), body: { lane_key: LANE } }));
    const merge = await ok(rpc("advance_task", { token: seat(sub, family), body: { task_id: id, to_stage: "validating" } }));
    await ok(rpc("claim_next_task", { token: seat(sub, family), body: { lane_key: LANE } }));
    const green = await ok(rpc("advance_task", { token: seat(sub, family), body: { task_id: id, to_stage: "done" } }));
    return { id, merge, green };
  }

  it("charges each anchored report to exactly the transition it names", async () => {
    const sub = randomUUID();
    const { id, merge, green } = await hermesSweep(sub, FAM3);
    // Both reports land AFTER both transitions — the old readers' worst case.
    await ok(rpc("record_usage", { token: oversight(), body: { actor: sub, task: id, data: { ...tokens(700), transition: merge.event.id } } }));
    await ok(rpc("record_usage", { token: oversight(), body: { actor: sub, data: { ...tokens(300), transition: green.event.id } } }));
    expect(Number((await row("role:integrator", FAM3)).total_tokens)).toBe(700);
    expect(Number((await row("role:reviewer", FAM3)).total_tokens)).toBe(300);
  });

  it("refuses an anchor that is not a transition this actor made on this task", async () => {
    const sub = randomUUID();
    const other = randomUUID();
    const { merge } = await hermesSweep(sub, FAM3);
    const theirs = await hermesSweep(other, FAM3);
    const refused = async (body: object) => {
      const r = await json(await rpc("record_usage", { token: oversight(), body }));
      expect(r.ok).toBe(false);
      expect(r.code).toBe("bad_anchor");
    };
    // Someone else's transition: filing spend under it would launder cost across actors.
    await refused({ actor: sub, data: { ...tokens(1), transition: theirs.merge.event.id } });
    // The actor's own transition, but a different task named alongside it.
    await refused({ actor: sub, task: theirs.id, data: { ...tokens(1), transition: merge.event.id } });
    // Not an event at all.
    await refused({ actor: sub, data: { ...tokens(1), transition: randomUUID() } });
  });

  it("the CLI cuts a streamed grok log at each transition and records one anchored row each", async () => {
    const sub = randomUUID();
    const { merge, green } = await hermesSweep(sub, FAM4);
    // A grok `streaming-json` sweep, reduced to what matters: each turn's `usage` line
    // arrives BEFORE that turn's tool results; the CLI envelope of each advance is inside
    // the tool output (stringified twice, as grok does), and grok re-sends it per update.
    const usage = (input: number) => JSON.stringify({ type: "usage", usage: { input_tokens: input, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
    const toolOut = (env: object) => JSON.stringify({ type: "tool_call_update", status: "completed", rawOutput: JSON.stringify({ type: "Bash", output_for_prompt: `exit: 0\n${JSON.stringify(env)}\n` }) });
    const log = [
      "Preparing worktree (detached HEAD abc123)",
      usage(500), toolOut(merge), toolOut(merge),     // merge turn (+ a repeated update)
      usage(200), toolOut(green),                     // validate turn
      usage(30),                                      // sign-off: joins the last piece
      JSON.stringify({ type: "end", usage: {}, modelUsage: { "grok-test": {} } }),
    ].join("\n");
    const dir = mkdtempSync(join(tmpdir(), "usage-"));
    const prior = "x".repeat(64) + "\n" + usage(99999) + "\n"; // an EARLIER sweep's bytes
    writeFileSync(join(dir, "frontier.log"), prior + log);
    const out = execFileSync("node", ["bin/ainarres.mjs", "record-usage",
      "--actor", sub, "--family", FAM4, "--from-log", join(dir, "frontier.log"),
      "--from-offset", String(Buffer.byteLength(prior)), "--sweep", sub, "--token", oversight()],
      { encoding: "utf8" });
    const r = JSON.parse(out.trim().split("\n").pop() as string);
    expect(r.ok).toBe(true);
    expect(r.recorded).toBe(2);
    expect(Number((await row("role:integrator", FAM4)).total_tokens)).toBe(500);
    expect(Number((await row("role:reviewer", FAM4)).total_tokens)).toBe(230);
  });
});
