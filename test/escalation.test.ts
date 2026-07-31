import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { exec, query, waitForDb } from "./helpers/db";
import { rpc, waitForReady } from "./helpers/http";
import { mintToken } from "./helpers/mint";

// M12 dynamic capability escalation (ADR 0019). A task a cheap family keeps failing
// is auto-raised to require the next tier (tier:2), so only a frontier family can
// claim it — no human re-routing. Triggered on the failure paths (release + reclaim)
// once attempts >= the stage's escalate_after.
//
// Two test workflows: m12a-wf (escalate_after=1) and m12b-wf (escalate_after=2), each
// impl (initial) → done. The tier:2 feature is seeded by db/seed.sql.

const CHEAP = "opencode+qwen3.6"; // exists; cheap implementer family (no tier:2)
const FRONTIER = "grok+grok-4.5"; // exists; holds tier:2 in the real seed

const FIXTURE = `
  insert into app.features (kind, key) values ('lane','m12a'), ('lane','m12b'), ('role','implementer')
  on conflict (kind, key) do nothing;

  insert into app.workflows (key, description) values
    ('m12a-wf', 'M12 escalate_after=1'), ('m12b-wf', 'M12 escalate_after=2')
  on conflict (key) do nothing;

  insert into app.stages (workflow_id, key, ordering, is_initial, is_terminal, escalate_after)
  select w.id, v.key, v.ord, v.ini, v.term, v.esc
  from app.workflows w
  cross join (values ('impl',0,true,false,1::int), ('done',1,false,true,null::int)) as v(key,ord,ini,term,esc)
  where w.key = 'm12a-wf' on conflict (workflow_id, key) do nothing;

  insert into app.stages (workflow_id, key, ordering, is_initial, is_terminal, escalate_after)
  select w.id, v.key, v.ord, v.ini, v.term, v.esc
  from app.workflows w
  cross join (values ('impl',0,true,false,2::int), ('done',1,false,true,null::int)) as v(key,ord,ini,term,esc)
  where w.key = 'm12b-wf' on conflict (workflow_id, key) do nothing;

  insert into app.transitions (workflow_id, from_stage, to_stage, kind, required_features)
  select w.id, sf.id, st.id, 'advance', array['role:implementer']
  from app.workflows w
  join app.stages sf on sf.workflow_id = w.id and sf.key = 'impl'
  join app.stages st on st.workflow_id = w.id and st.key = 'done'
  where w.key in ('m12a-wf','m12b-wf')
    and not exists (select 1 from app.transitions t where t.workflow_id = w.id and t.from_stage = sf.id and t.to_stage = st.id and t.kind = 'advance');

  insert into app.lanes (project_id, key, workflow_id)
  select p.id, v.k, w.id
  from app.projects p, app.workflows w, (values ('m12a','m12a-wf'), ('m12b','m12b-wf')) as v(k, wf)
  where p.slug = 'ainarres' and w.key = v.wf
  on conflict (project_id, key) do nothing;
`;

const json = (r: Response) => r.json();
const cheap = (lane: string, sub = randomUUID()) => mintToken(CHEAP, "agent", { sub, features: [`lane:${lane}`, "role:implementer"] });
const frontier = (lane: string, sub = randomUUID()) => mintToken(FRONTIER, "agent", { sub, features: [`lane:${lane}`, "role:implementer", "tier:2"] });
const reqFeatures = (taskId: string): string[] =>
  (query<{ required_features: string[] }>(`select required_features from app.tasks where id = '${taskId}'`)[0]?.required_features) ?? [];

beforeAll(async () => {
  waitForDb();
  const res = exec(FIXTURE);
  if (!res.ok) throw new Error(`fixture failed: ${res.error}`);
  await waitForReady();
});

describe("capability escalation", () => {
  it("escalates on release at the threshold, then only a frontier family can claim", async () => {
    const c = cheap("m12a");
    const created = await json(await rpc("create_task", { token: c, body: { lane_key: "m12a" } }));
    const id = created.task.id;

    await json(await rpc("claim_next_task", { token: c, body: { lane_key: "m12a" } }));
    const released = await json(await rpc("release_task", { token: c, body: { task_id: id, reason: "cannot finish" } }));
    expect(released.code).toBe("ok");

    // attempts=1 >= escalate_after=1 → task now requires tier:2 + an 'escalated' event.
    expect(reqFeatures(id)).toContain("tier:2");
    const escalatedEvents = query<{ n: number }>(`select count(*)::int as n from app.events where task_id = '${id}' and type = 'escalated'`)[0].n;
    expect(escalatedEvents).toBe(1);

    // The cheap family can no longer claim it; a frontier (tier:2) family can.
    const cheapClaim = await json(await rpc("claim_next_task", { token: cheap("m12a"), body: { lane_key: "m12a" } }));
    expect(cheapClaim.code).toBe("empty");
    const frontierClaim = await json(await rpc("claim_next_task", { token: frontier("m12a"), body: { lane_key: "m12a" } }));
    expect(frontierClaim.code).toBe("ok");
    expect(frontierClaim.task.id).toBe(id);
  });

  it("does not escalate below the threshold", async () => {
    const c = cheap("m12b");
    const created = await json(await rpc("create_task", { token: c, body: { lane_key: "m12b" } }));
    const id = created.task.id;
    await json(await rpc("claim_next_task", { token: c, body: { lane_key: "m12b" } }));
    await json(await rpc("release_task", { token: c, body: { task_id: id, reason: "first try" } }));
    // attempts=1 < escalate_after=2 → no tier bump, no escalated event.
    expect(reqFeatures(id)).not.toContain("tier:2");
    const n = query<{ n: number }>(`select count(*)::int as n from app.events where task_id = '${id}' and type = 'escalated'`)[0].n;
    expect(n).toBe(0);
  });

  it("escalates on lazy reclaim too (expired lease), skipping the under-tier claimer", async () => {
    const c = cheap("m12a");
    const created = await json(await rpc("create_task", { token: c, body: { lane_key: "m12a" } }));
    const id = created.task.id;
    await json(await rpc("claim_next_task", { token: c, body: { lane_key: "m12a" } }));
    // Expire the lease in place (simulate a crashed cheap worker), attempts still 0.
    const e = exec(`update app.tasks set lease_expires_at = now() - interval '1 minute' where id = '${id}'`);
    expect(e.ok, e.error).toBe(true);

    // A cheap reclaim bumps attempts to 1 (>=1) → escalate + skip → empty for cheap.
    const reclaim = await json(await rpc("claim_next_task", { token: cheap("m12a"), body: { lane_key: "m12a" } }));
    expect(reclaim.code).toBe("empty");
    expect(reqFeatures(id)).toContain("tier:2");

    // A frontier family then claims the reclaimed, escalated task.
    const fc = await json(await rpc("claim_next_task", { token: frontier("m12a"), body: { lane_key: "m12a" } }));
    expect(fc.code).toBe("ok");
    expect(fc.task.id).toBe(id);
  });
});
