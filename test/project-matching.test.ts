import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { exec, query, waitForDb } from "./helpers/db";
import { rpc, waitForReady } from "./helpers/http";
import { mintToken } from "./helpers/mint";

// v9 Slice A (design/customer-seat.md D1 · ADR 0029) — a worker is STAFFED ON A PROJECT
// (`project:<slug>`), not seated in a lane. The four membership sites (create, claim,
// unblock, api.demand) all ask app.staffed_on(eff, lane).
//
// The failure D1 warns about is a test that passes because it grants BOTH features. So the
// staffed tokens here carry `project:` and NO `lane:`; the transitional `lane:`-only path is
// pinned separately (it must still work until Slice C, and Slice C flips that assertion);
// and a token staffed on a DIFFERENT project proves the check is per project, not "any
// project feature at all".
//
// Fixture: two projects of its own per run, so no other file's tasks can be claimed here.

const RUN = randomUUID().slice(0, 8);
const P1 = `pm1-${RUN}`;
const P2 = `pm2-${RUN}`;
const L1 = `pm1a-${RUN}`;   // in P1
const L1B = `pm1b-${RUN}`;  // also in P1 — the lane_key filter picks between these
const L2 = `pm2a-${RUN}`;   // in P2
const WF = `pm-${RUN}-wf`;
const ROLE = `role:pm-${RUN}`;
const FAM = `pm-${RUN}`;

const FIXTURE = `
  insert into app.projects (slug) values ('${P1}'), ('${P2}') on conflict (slug) do nothing;
  insert into app.features (kind, key) values
    ('project','${P1}'), ('project','${P2}'), ('role','pm-${RUN}')
  on conflict (kind, key) do nothing;
  insert into app.agent_families (key) values ('${FAM}') on conflict (key) do nothing;
  insert into app.workflows (key, description) values ('${WF}', 'project matching')
  on conflict (key) do nothing;
  insert into app.stages (workflow_id, key, ordering, is_initial, is_terminal)
  select w.id, v.key, v.ord, v.ini, v.term from app.workflows w
  cross join (values ('todo',0,true,false),('done',1,false,true)) as v(key,ord,ini,term)
  where w.key='${WF}' on conflict (workflow_id,key) do nothing;
  insert into app.transitions (workflow_id, from_stage, to_stage, kind, required_features)
  select w.id, sf.id, st.id, 'advance', array['${ROLE}'] from app.workflows w
  join app.stages sf on sf.workflow_id=w.id and sf.key='todo'
  join app.stages st on st.workflow_id=w.id and st.key='done'
  where w.key='${WF}'
    and not exists (select 1 from app.transitions x where x.from_stage=sf.id and x.to_stage=st.id);
  insert into app.lanes (project_id, key, workflow_id)
  select p.id, v.lane, w.id
  from (values ('${P1}','${L1}'), ('${P1}','${L1B}'), ('${P2}','${L2}')) as v(slug, lane)
  join app.projects p on p.slug = v.slug
  join app.workflows w on w.key = '${WF}'
  on conflict (project_id, key) do nothing;
`;

const json = (r: Response) => r.json() as Promise<any>;
const token = (features: string[], sub = randomUUID()) => mintToken(FAM, "agent", { sub, features });
const staffedP1 = (sub?: string) => token([`project:${P1}`, ROLE], sub);
const staffedP2 = (sub?: string) => token([`project:${P2}`, ROLE], sub);
const laneOnly = (lane: string, sub?: string) => token([`lane:${lane}`, ROLE], sub);

const create = async (tok: string, lane: string) =>
  json(await rpc("create_task", { token: tok, body: { lane_key: lane } }));
const claim = async (tok: string, lane?: string) =>
  json(await rpc("claim_next_task", { token: tok, body: lane ? { lane_key: lane } : {} }));

// Tasks this run left claimable get in the way of the next claim; finish what we claim.
async function finish(tok: string, id: string) {
  const r = await json(await rpc("advance_task", { token: tok, body: { task_id: id, to_stage: "done" } }));
  expect(r.ok, JSON.stringify(r)).toBe(true);
}

beforeAll(async () => {
  waitForDb();
  const res = exec(FIXTURE);
  if (!res.ok) throw new Error(`fixture failed: ${res.error}`);
  await waitForReady();
});

describe("staffed on a project (project:<slug>, no lane: feature)", () => {
  it("creates and claims in any lane of its project", async () => {
    const sub = randomUUID();
    const made = await create(staffedP1(sub), L1);
    expect(made.ok, JSON.stringify(made)).toBe(true);
    const got = await claim(staffedP1(sub));
    expect(got.code).toBe("ok");
    expect(got.task.id).toBe(made.task.id);
    await finish(staffedP1(sub), got.task.id);
  });

  it("unblocks work in its project", async () => {
    const holder = randomUUID();
    const made = await create(staffedP1(holder), L1);
    await claim(staffedP1(holder));
    const blocked = await json(await rpc("block_task", { token: staffedP1(holder), body: { task_id: made.task.id, reason: "waiting" } }));
    expect(blocked.ok, JSON.stringify(blocked)).toBe(true);
    // A DIFFERENT member of the project unblocks it — one that has never acted before, which
    // unblock_task must register itself (it used to hit the events.actor foreign key).
    const un = await json(await rpc("unblock_task", { token: staffedP1(), body: { task_id: made.task.id } }));
    expect(un.ok, JSON.stringify(un)).toBe(true);
    expect(un.task.blocked).toBe(false);
    const sub = randomUUID();
    const again = await claim(staffedP1(sub), L1);
    expect(again.task.id).toBe(made.task.id);
    await finish(staffedP1(sub), made.task.id);
  });

  it("treats lane_key as a FILTER within the project, not a gate", async () => {
    const a = await create(staffedP1(), L1);
    const b = await create(staffedP1(), L1B);
    const sub = randomUUID();
    const got = await claim(staffedP1(sub), L1B);
    expect(got.task.id).toBe(b.task.id);
    await finish(staffedP1(sub), b.task.id);
    const sub2 = randomUUID();
    const rest = await claim(staffedP1(sub2), L1);
    expect(rest.task.id).toBe(a.task.id);
    await finish(staffedP1(sub2), a.task.id);
  });
});

describe("staffed on ANOTHER project", () => {
  it("cannot create, claim, or unblock outside its project — and the refusal names the project", async () => {
    const refused = await create(staffedP2(), L1);
    expect(refused.ok).toBe(false);
    expect(refused.code).toBe("not_eligible");
    expect(refused.reason).toContain(`project:${P1}`);

    const holder = randomUUID();
    const made = await create(staffedP1(holder), L1);
    expect((await claim(staffedP2(), L1)).code).toBe("empty");
    expect((await claim(staffedP2())).code).toBe("empty");

    await claim(staffedP1(holder));
    await json(await rpc("block_task", { token: staffedP1(holder), body: { task_id: made.task.id, reason: "x" } }));
    const un = await json(await rpc("unblock_task", { token: staffedP2(), body: { task_id: made.task.id } }));
    expect(un.ok).toBe(false);
    expect(un.code).toBe("not_eligible");

    // Tidy: unblock and finish it as a member, so it is not left claimable.
    await json(await rpc("unblock_task", { token: staffedP1(), body: { task_id: made.task.id } }));
    const sub = randomUUID();
    await claim(staffedP1(sub), L1);
    await finish(staffedP1(sub), made.task.id);
  });

  it("an unregistered family cannot unblock, however it is staffed (ADR 0007)", async () => {
    const holder = randomUUID();
    const made = await create(staffedP1(holder), L1);
    await claim(staffedP1(holder));
    await json(await rpc("block_task", { token: staffedP1(holder), body: { task_id: made.task.id, reason: "x" } }));
    const stranger = mintToken(`pm-never-seated-${RUN}`, "agent", { features: [`project:${P1}`, ROLE] });
    const un = await json(await rpc("unblock_task", { token: stranger, body: { task_id: made.task.id } }));
    expect(un.ok).toBe(false);
    expect(un.code).toBe("not_eligible");
    expect(un.reason).toBe("unknown family");
    // Tidy, as a member.
    await json(await rpc("unblock_task", { token: staffedP1(), body: { task_id: made.task.id } }));
    const sub = randomUUID();
    await claim(staffedP1(sub), L1);
    await finish(staffedP1(sub), made.task.id);
  });

  it("a role alone, with no membership at all, is refused", async () => {
    const r = await create(token([ROLE]), L1);
    expect(r.ok).toBe(false);
    expect(r.code).toBe("not_eligible");
  });
});

// TRANSITIONAL — Slice C deletes the lane: half of app.staffed_on. When it does, these two
// assertions flip to `not_eligible` / `empty`, which is how that slice proves it landed.
describe("transitional: a lane:-only token is still admitted (until v9 Slice C)", () => {
  it("creates and claims with lane:<key> and no project:", async () => {
    const sub = randomUUID();
    const made = await create(laneOnly(L2, sub), L2);
    expect(made.ok, JSON.stringify(made)).toBe(true);
    const got = await claim(laneOnly(L2, sub));
    expect(got.task.id).toBe(made.task.id);
    await finish(laneOnly(L2, sub), made.task.id);
  });

  it("a lane: grant admits only THAT lane, not the rest of its project", async () => {
    const made = await create(staffedP1(), L1B);
    expect((await claim(laneOnly(L1))).code).toBe("empty");
    const sub = randomUUID();
    await claim(staffedP1(sub), L1B);
    await finish(staffedP1(sub), made.task.id);
  });
});

describe("api.demand reports membership as the project", () => {
  it("bundles name project:<slug>, never lane:<key>", async () => {
    const made = await create(staffedP1(), L1);
    const rows = query<{ bundle: string[] | string }>(`select bundle from api.demand where lane = '${L1}'`);
    const bundles = rows.map((r) => (Array.isArray(r.bundle) ? r.bundle : String(r.bundle).replace(/^{|}$/g, "").split(",")));
    expect(bundles).toContainEqual([`project:${P1}`, ROLE].sort());
    expect(bundles.flat().some((f) => f.startsWith("lane:"))).toBe(false);
    const sub = randomUUID();
    await claim(staffedP1(sub), L1);
    await finish(staffedP1(sub), made.task.id);
  });
});
