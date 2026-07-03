import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { exec, waitForDb } from "./helpers/db";
import { restGet, rpc, waitForReady } from "./helpers/http";
import { mintToken } from "./helpers/mint";

// M20 Slice B (v5 governance; design/track-record.md D2/D4/D5). api.family_track_record
// — the read-only, per-(family, capability) signal M21's ban rule will consume. This
// test drives a hand-auditable scenario and checks the view matches it:
//   * a delivery is an advance by the family exercising a role;
//   * a reject is credited to the PRODUCER (who advanced INTO the rejected stage), at
//     that producer's role — NOT to the reviewer who called it (D4); cross-family when
//     the rejecter is a different family;
//   * token spend sits BESIDE competence (D3) and is NULL — unknown, not 0 — for a
//     family that emitted no usage event (unknown ≠ free).

const IMPL = "m20b-impl";
const REV = "m20b-rev";

const FIXTURE = `
  insert into app.features (kind,key) values ('lane','m20b'),('role','implementer'),('role','reviewer')
  on conflict (kind,key) do nothing;
  insert into app.agent_families (key) values ('${IMPL}'),('${REV}') on conflict (key) do nothing;
  insert into app.workflows (key, description) values ('m20b-wf','M20 track-record flow')
  on conflict (key) do nothing;
  insert into app.stages (workflow_id, key, ordering, is_initial, is_terminal)
  select w.id, v.key, v.ord, v.ini, v.term from app.workflows w
  cross join (values ('implementing',0,true,false),('reviewing',1,false,false),('done',2,false,true)) as v(key,ord,ini,term)
  where w.key='m20b-wf' on conflict (workflow_id,key) do nothing;
  insert into app.transitions (workflow_id, from_stage, to_stage, kind, required_features)
  select w.id, sf.id, st.id, 'advance', v.req from app.workflows w
  join (values ('implementing','reviewing',array['role:implementer']), ('reviewing','done',array['role:reviewer'])) as v(f,t,req) on true
  join app.stages sf on sf.workflow_id=w.id and sf.key=v.f
  join app.stages st on st.workflow_id=w.id and st.key=v.t
  where w.key='m20b-wf' and not exists (select 1 from app.transitions x where x.from_stage=sf.id and x.to_stage=st.id and x.kind='advance');
  insert into app.transitions (workflow_id, from_stage, to_stage, kind, required_features)
  select w.id, sf.id, st.id, 'reject', array['role:reviewer'] from app.workflows w
  join app.stages sf on sf.workflow_id=w.id and sf.key='reviewing'
  join app.stages st on st.workflow_id=w.id and st.key='implementing'
  where w.key='m20b-wf' and not exists (select 1 from app.transitions x where x.from_stage=sf.id and x.to_stage=st.id and x.kind='reject');
  insert into app.lanes (project_id, key, workflow_id)
  select p.id, 'm20b', w.id from app.projects p join app.workflows w on w.key='m20b-wf'
  where p.slug='ainarres' on conflict (project_id,key) do nothing;
`;

const json = (r: Response) => r.json() as Promise<any>;
const oversight = () => mintToken(IMPL, "oversight", { features: [] });
const impl = (sub: string) => mintToken(IMPL, "agent", { sub, features: ["lane:m20b", "role:implementer"] });
const rev = (sub: string) => mintToken(REV, "agent", { sub, features: ["lane:m20b", "role:reviewer"] });

async function ok(p: Promise<Response>) {
  const r = await json(await p);
  expect(r.ok).toBe(true);
  return r;
}

beforeAll(async () => {
  waitForDb();
  const res = exec(FIXTURE);
  if (!res.ok) throw new Error(`fixture failed: ${res.error}`);
  await waitForReady();
});

describe("api.family_track_record", () => {
  it("attributes deliveries, producer-credited rejects, cross-family, and separate token spend", async () => {
    const iSub = randomUUID();
    const rSub = randomUUID();

    // Implementer creates (starter role) and delivers impl→review (delivery #1).
    const created = await ok(rpc("create_task", { token: impl(iSub), body: { lane_key: "m20b" } }));
    const id = created.task.id;
    await ok(rpc("claim_next_task", { token: impl(iSub), body: { lane_key: "m20b" } }));
    await ok(rpc("advance_task", { token: impl(iSub), body: { task_id: id, to_stage: "reviewing" } }));

    // Reviewer (a DIFFERENT family) rejects review→impl — credited to the PRODUCER
    // (the implementer who advanced into review), cross-family.
    await ok(rpc("claim_next_task", { token: rev(rSub), body: { lane_key: "m20b" } }));
    await ok(rpc("reject_task", { token: rev(rSub), body: { task_id: id, to_stage: "implementing", reason: "not yet" } }));

    // Implementer re-delivers impl→review (delivery #2).
    await ok(rpc("claim_next_task", { token: impl(iSub), body: { lane_key: "m20b" } }));
    await ok(rpc("advance_task", { token: impl(iSub), body: { task_id: id, to_stage: "reviewing" } }));

    // Record the implementer's token spend for this task (claude-shaped; oversight).
    await ok(rpc("record_usage", {
      token: oversight(),
      body: { actor: iSub, data: { tokens: { input: 100, output: 50, cache_read: 0, cache_creation: 0 }, model: "x" } },
    }));

    // Reviewer accepts review→done (delivery for the reviewer role).
    await ok(rpc("claim_next_task", { token: rev(rSub), body: { lane_key: "m20b" } }));
    await ok(rpc("advance_task", { token: rev(rSub), body: { task_id: id, to_stage: "done" } }));

    // Read the view (oversight-only) for just our two families.
    const rows = await json(await restGet(`family_track_record?family=in.(${IMPL},${REV})`, { token: oversight() }));
    const byKey = (fam: string, cap: string) => rows.find((r: any) => r.family === fam && r.capability === cap);

    // Implementer: 2 deliveries, 1 producer-credited reject (from reviewing),
    // cross-family, reject_rate 0.5 — and its token spend, kept separate.
    const fi = byKey(IMPL, "role:implementer");
    expect(fi).toBeDefined();
    expect(fi.delivered).toBe(2);
    expect(fi.rejected).toBe(1);
    expect(fi.review_rejected).toBe(1);
    expect(fi.cross_family_rejected).toBe(1);
    expect(Number(fi.reject_rate)).toBe(0.5);
    expect(Number(fi.total_tokens)).toBe(150); // 100 + 50 + 0 + 0
    expect(Number(fi.tokens_per_delivery)).toBe(75); // 150 / 2

    // Reviewer: 1 delivery (review→done), no rejects against it, and NO usage event →
    // tokens NULL (unknown), never 0 (which would read as free).
    const fr = byKey(REV, "role:reviewer");
    expect(fr).toBeDefined();
    expect(fr.delivered).toBe(1);
    expect(fr.rejected).toBe(0);
    expect(fr.total_tokens).toBeNull(); // unknown ≠ free
    expect(fr.tokens_per_delivery).toBeNull();
  });

  it("shows no phantom score for a family that never worked a capability", async () => {
    const rows = await json(await restGet(`family_track_record?family=in.(${IMPL},${REV})`, { token: oversight() }));
    // The implementer family never acted as a reviewer, and vice-versa.
    expect(rows.find((r: any) => r.family === IMPL && r.capability === "role:reviewer")).toBeUndefined();
    expect(rows.find((r: any) => r.family === REV && r.capability === "role:implementer")).toBeUndefined();
  });

  it("is oversight-only (anonymous is refused)", async () => {
    const anon = await restGet("family_track_record?limit=1");
    expect(anon.status).toBeGreaterThanOrEqual(400);
  });
});
