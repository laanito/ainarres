import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { exec, waitForDb } from "./helpers/db";
import { restGet, rpc, waitForReady } from "./helpers/http";
import { mintToken } from "./helpers/mint";

// M23 Slice B — view half (v6; design/auditor-operational.md D3/D7). The oversight WATCH
// views the operational facet reads before a human flags:
//   * api.spend_anomalies    — tokens_per_delivery vs the per-capability PEER MEDIAN over
//     overspend_multiple ('overspending'), plus delivered=0 & usage>0 ('no_delivery_spend').
//   * api.operational_flags  — the auditor's open operational flags, newest-first.
// DB test (validated ASSISTED — a view has no self-check in a worktree). The report
// operational-BLOCK that renders these is the swarm slice.
//
// Per-run-unique roles/lanes so the peer set for each capability is exactly this run's
// families (family_track_record aggregates ALL history in the shared DB).

const RUN = randomUUID().slice(0, 8);
const CAP = `role:m23impl-${RUN}`;    // the peer-group capability (A, B, C hold it)
const REVCAP = `role:m23rev-${RUN}`;  // the reviewer capability (D holds it)
const SOLOCAP = `role:m23solo-${RUN}`; // a single-family capability (S holds it)
const A = `m23-a-${RUN}`, B = `m23-b-${RUN}`, C = `m23-c-${RUN}`;
const D = `m23-d-${RUN}`, S = `m23-s-${RUN}`, AUD = `m23-aud-${RUN}`, SUBJ = `m23-subj-${RUN}`;
const PLANE = `m23p-${RUN}`;  // peer-group lane/workflow
const SLANE = `m23s-${RUN}`;  // solo lane/workflow

const FIXTURE = `
  insert into app.features (kind,key) values
    ('lane','${PLANE}'),('lane','${SLANE}'),
    ('role','m23impl-${RUN}'),('role','m23rev-${RUN}'),('role','m23solo-${RUN}')
  on conflict (kind,key) do nothing;
  insert into app.agent_families (key) values
    ('${A}'),('${B}'),('${C}'),('${D}'),('${S}'),('${AUD}'),('${SUBJ}')
  on conflict (key) do nothing;

  -- Peer-group workflow: implementing -> reviewing -> done, with a reject reviewing->implementing.
  insert into app.workflows (key, description) values ('${PLANE}-wf','M23b peer flow')
  on conflict (key) do nothing;
  insert into app.stages (workflow_id, key, ordering, is_initial, is_terminal)
  select w.id, v.key, v.ord, v.ini, v.term from app.workflows w
  cross join (values ('implementing',0,true,false),('reviewing',1,false,false),('done',2,false,true)) as v(key,ord,ini,term)
  where w.key='${PLANE}-wf' on conflict (workflow_id,key) do nothing;
  insert into app.transitions (workflow_id, from_stage, to_stage, kind, required_features)
  select w.id, sf.id, st.id, 'advance', v.req from app.workflows w
  join (values ('implementing','reviewing',array['${CAP}']),('reviewing','done',array['${REVCAP}'])) as v(f,t,req) on true
  join app.stages sf on sf.workflow_id=w.id and sf.key=v.f
  join app.stages st on st.workflow_id=w.id and st.key=v.t
  where w.key='${PLANE}-wf'
    and not exists (select 1 from app.transitions x where x.from_stage=sf.id and x.to_stage=st.id and x.kind='advance');
  insert into app.transitions (workflow_id, from_stage, to_stage, kind, required_features)
  select w.id, sf.id, st.id, 'reject', array['${REVCAP}'] from app.workflows w
  join app.stages sf on sf.workflow_id=w.id and sf.key='reviewing'
  join app.stages st on st.workflow_id=w.id and st.key='implementing'
  where w.key='${PLANE}-wf'
    and not exists (select 1 from app.transitions x where x.from_stage=sf.id and x.to_stage=st.id and x.kind='reject');
  insert into app.lanes (project_id, key, workflow_id)
  select p.id, '${PLANE}', w.id from app.projects p join app.workflows w on w.key='${PLANE}-wf'
  where p.slug='ainarres' on conflict (project_id,key) do nothing;

  -- Solo workflow: start -> done (a single advance, one capability, one family).
  insert into app.workflows (key, description) values ('${SLANE}-wf','M23b solo flow')
  on conflict (key) do nothing;
  insert into app.stages (workflow_id, key, ordering, is_initial, is_terminal)
  select w.id, v.key, v.ord, v.ini, v.term from app.workflows w
  cross join (values ('start',0,true,false),('done',1,false,true)) as v(key,ord,ini,term)
  where w.key='${SLANE}-wf' on conflict (workflow_id,key) do nothing;
  insert into app.transitions (workflow_id, from_stage, to_stage, kind, required_features)
  select w.id, sf.id, st.id, 'advance', array['${SOLOCAP}'] from app.workflows w
  join app.stages sf on sf.workflow_id=w.id and sf.key='start'
  join app.stages st on st.workflow_id=w.id and st.key='done'
  where w.key='${SLANE}-wf'
    and not exists (select 1 from app.transitions x where x.from_stage=sf.id and x.to_stage=st.id and x.kind='advance');
  insert into app.lanes (project_id, key, workflow_id)
  select p.id, '${SLANE}', w.id from app.projects p join app.workflows w on w.key='${SLANE}-wf'
  where p.slug='ainarres' on conflict (project_id,key) do nothing;
`;

const json = (r: Response) => r.json() as Promise<any>;
const oversight = () => mintToken(AUD, "oversight", { features: [] });
const auditor = (sub: string) => mintToken(AUD, "agent", { sub, features: ["role:auditor"] });
const impl = (fam: string, sub: string) =>
  mintToken(fam, "agent", { sub, features: [`lane:${PLANE}`, CAP] });
const rev = (fam: string, sub: string) =>
  mintToken(fam, "agent", { sub, features: [`lane:${PLANE}`, REVCAP] });
const solo = (fam: string, sub: string) =>
  mintToken(fam, "agent", { sub, features: [`lane:${SLANE}`, SOLOCAP] });

async function ok(p: Promise<Response>) {
  const r = await json(await p);
  expect(r.ok).toBe(true);
  return r;
}

// One implementer family: create -> claim -> advance impl->reviewing (a delivery), then
// record `tokens` input tokens against it. delivered=1, tokens_per_delivery = tokens.
async function deliverWithSpend(fam: string, tokens: number) {
  const sub = randomUUID();
  const created = await ok(rpc("create_task", { token: impl(fam, sub), body: { lane_key: PLANE } }));
  const id = created.task.id;
  await ok(rpc("claim_next_task", { token: impl(fam, sub), body: { lane_key: PLANE } }));
  await ok(rpc("advance_task", { token: impl(fam, sub), body: { task_id: id, to_stage: "reviewing" } }));
  await ok(rpc("record_usage", {
    token: oversight(),
    body: { actor: sub, data: { tokens: { input: tokens, output: 0, cache_read: 0, cache_creation: 0 } } },
  }));
  return id;
}

beforeAll(async () => {
  waitForDb();
  const res = exec(FIXTURE);
  if (!res.ok) throw new Error(`fixture failed: ${res.error}`);
  await waitForReady();

  // Peer group under CAP: A=100, B=120, C=5000 (C is the overspender). median=120,
  // overspend_multiple=5 -> threshold 600; only C's 5000 exceeds it.
  await deliverWithSpend(A, 100);
  await deliverWithSpend(B, 120);
  await deliverWithSpend(C, 5000);

  // D burns tokens but ships nothing: it claims a reviewing task, REJECTS it (a
  // transition — so record_usage can anchor — with no delivery), then records spend.
  // (D, REVCAP): delivered=0, usage>0 -> the 'no_delivery_spend' case.
  const dSub = randomUUID();
  const dClaim = await ok(rpc("claim_next_task", { token: rev(D, dSub), body: { lane_key: PLANE } }));
  await ok(rpc("reject_task", { token: rev(D, dSub), body: { task_id: dClaim.task.id, to_stage: "implementing", reason: "n/a" } }));
  await ok(rpc("record_usage", {
    token: oversight(),
    body: { actor: dSub, data: { tokens: { input: 300, output: 0, cache_read: 0, cache_creation: 0 } } },
  }));

  // S is the ONLY family holding SOLOCAP and delivers expensively — but with no peer to
  // compare to (peer_count=1), it must NOT be flagged.
  const sSub = randomUUID();
  const sTask = await ok(rpc("create_task", { token: solo(S, sSub), body: { lane_key: SLANE } }));
  await ok(rpc("claim_next_task", { token: solo(S, sSub), body: { lane_key: SLANE } }));
  await ok(rpc("advance_task", { token: solo(S, sSub), body: { task_id: sTask.task.id, to_stage: "done" } }));
  await ok(rpc("record_usage", {
    token: oversight(),
    body: { actor: sSub, data: { tokens: { input: 99999, output: 0, cache_read: 0, cache_creation: 0 } } },
  }));
});

describe("M23 api.spend_anomalies (the spend watch)", () => {
  it("flags the overspender (> peer_median * overspend_multiple) but not its normal peers (D3)", async () => {
    const rows = await json(await restGet(
      `spend_anomalies?anomaly=eq.overspending&capability=eq.${encodeURIComponent(CAP)}`, { token: oversight() }));
    const fams = rows.map((r: any) => r.family);
    expect(fams).toContain(C);
    expect(fams).not.toContain(A);
    expect(fams).not.toContain(B);

    const c = rows.find((r: any) => r.family === C);
    expect(Number(c.tokens_per_delivery)).toBe(5000);
    expect(Number(c.peer_median)).toBe(120);
    expect(c.peer_count).toBe(3);
    expect(Number(c.multiple_over_median)).toBeGreaterThan(5);
    expect(Number(c.overspend_multiple)).toBe(5);
  });

  it("surfaces the burned-but-shipped-nothing case: delivered=0 & usage>0 (D3)", async () => {
    const rows = await json(await restGet(
      `spend_anomalies?anomaly=eq.no_delivery_spend&family=eq.${D}`, { token: oversight() }));
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const d = rows.find((r: any) => r.capability === REVCAP);
    expect(d).toBeDefined();
    expect(d.delivered).toBe(0);
    expect(Number(d.usage_events)).toBeGreaterThan(0);
    expect(d.tokens_per_delivery).toBeNull();
  });

  it("does NOT flag a single-family capability (no peer baseline, not a false positive)", async () => {
    const rows = await json(await restGet(
      `spend_anomalies?capability=eq.${encodeURIComponent(SOLOCAP)}`, { token: oversight() }));
    // S delivered once, very expensively, but it is the only holder of SOLOCAP -> no
    // 'overspending' row (peer_count < 2); and delivered>0 -> no 'no_delivery_spend' either.
    expect(rows).toHaveLength(0);
  });

  it("is oversight-only (an unauthenticated read is refused)", async () => {
    const res = await restGet("spend_anomalies");
    expect(res.ok).toBe(false);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe("M23 api.operational_flags (open flags)", () => {
  it("lists the auditor's operational flags newest-first (D7)", async () => {
    const aSub = randomUUID();
    await ok(rpc("raise_operational_flag", { token: auditor(aSub), body: {
      p_subject_family: SUBJ, p_capability: CAP, p_kind: "spinning", p_detail: "older flag" } }));
    await ok(rpc("raise_operational_flag", { token: auditor(aSub), body: {
      p_subject_family: SUBJ, p_capability: CAP, p_kind: "overspending", p_detail: "newer flag (latest)" } }));

    const rows = await json(await restGet(
      `operational_flags?family=eq.${SUBJ}&order=created_at.desc`, { token: oversight() }));
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows[0].detail).toBe("newer flag (latest)");
    expect(rows[0].kind).toBe("overspending");
    expect(rows[0].capability).toBe(CAP);
  });

  it("is oversight-only (an unauthenticated read is refused)", async () => {
    const res = await restGet("operational_flags");
    expect(res.ok).toBe(false);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
