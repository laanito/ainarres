import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { exec, waitForDb } from "./helpers/db";
import { rpc, waitForReady } from "./helpers/http";
import { mintToken } from "./helpers/mint";

// M3 verbs over the real PostgREST surface (ADR 0008): create_task and
// claim_next_task, asserting the uniform envelope and its codes. Uses a
// test-owned workflow/lanes so it's repeatable: existing m3 tasks are parked
// (blocked) on entry, so the happy flow claims only the task it just created.
//
// Feature design: the m3-wf advance transition requires only role:worker; lane
// membership (lane:m3 / lane:m3empty) is enforced separately by the verb, so the
// two lanes can share one workflow.

const FAMILY = "opencode+qwen"; // exists, so instance registration (FK) resolves

const FIXTURE = `
  insert into app.features (kind, key) values
    ('lane','m3'), ('lane','m3empty'), ('role','worker')
  on conflict (kind, key) do nothing;

  insert into app.workflows (key, description) values ('m3-wf', 'M3 verb test flow')
  on conflict (key) do nothing;

  insert into app.stages (workflow_id, key, ordering, is_initial, is_terminal)
  select w.id, v.key, v.ord, v.ini, v.term
  from app.workflows w
  cross join (values ('todo',0,true,false), ('doing',1,false,false), ('done',2,false,true))
    as v(key, ord, ini, term)
  where w.key = 'm3-wf'
  on conflict (workflow_id, key) do nothing;

  insert into app.transitions (workflow_id, from_stage, to_stage, kind, required_features)
  select w.id, sf.id, st.id, 'advance', array['role:worker']
  from app.workflows w
  join app.stages sf on sf.workflow_id = w.id and sf.key = 'todo'
  join app.stages st on st.workflow_id = w.id and st.key = 'doing'
  where w.key = 'm3-wf'
    and not exists (
      select 1 from app.transitions t
      where t.workflow_id = w.id and t.from_stage = sf.id and t.to_stage = st.id and t.kind = 'advance'
    );

  insert into app.lanes (project_id, key, workflow_id)
  select p.id, v.k, w.id
  from app.projects p, app.workflows w, (values ('m3'), ('m3empty')) as v(k)
  where p.slug = 'ainarres' and w.key = 'm3-wf'
  on conflict (project_id, key) do nothing;

  -- Park any pre-existing m3 tasks so a fresh run claims only what it creates.
  update app.tasks set blocked = true
  where lane_id = (select id from app.lanes where key = 'm3') and not blocked;
`;

beforeAll(async () => {
  waitForDb();
  const res = exec(FIXTURE);
  if (!res.ok) throw new Error(`fixture failed: ${res.error}`);
  await waitForReady();
});

const json = (r: Response) => r.json();

describe("create_task / claim_next_task happy flow", () => {
  it("creates at the initial stage, claims it, then rejects a second claim (one per instance)", async () => {
    const sub = randomUUID();
    const token = mintToken(FAMILY, "agent", { sub, features: ["lane:m3", "role:worker"] });
    const marker = `m3-${Date.now()}`;

    // create
    const created = await json(await rpc("create_task", {
      token,
      body: { lane_key: "m3", payload: { marker } },
    }));
    expect(created.ok).toBe(true);
    expect(created.code).toBe("ok");
    expect(created.task.stage_key).toBe("todo");
    expect(created.task.lane_key).toBe("m3");
    expect(created.task.created_by).toBe(sub);
    expect(created.task.payload.marker).toBe(marker);

    // claim — must be the task we just created (others are parked)
    const claimed = await json(await rpc("claim_next_task", { token, body: { lane_key: "m3" } }));
    expect(claimed.ok).toBe(true);
    expect(claimed.code).toBe("ok");
    expect(claimed.task.payload.marker).toBe(marker);
    expect(claimed.task.claimed_by).toBe(sub);
    expect(claimed.task.lease_expires_at).toBeTruthy();

    // second claim with the SAME instance → already_holding
    const again = await json(await rpc("claim_next_task", { token, body: { lane_key: "m3" } }));
    expect(again.ok).toBe(false);
    expect(again.code).toBe("already_holding");
    expect(again.task).not.toBeNull();
  });
});

describe("envelope codes", () => {
  it("empty when the lane has nothing claimable", async () => {
    const token = mintToken(FAMILY, "agent", {
      sub: randomUUID(),
      features: ["lane:m3empty", "role:worker"],
    });
    const res = await json(await rpc("claim_next_task", { token, body: { lane_key: "m3empty" } }));
    expect(res.ok).toBe(true);
    expect(res.code).toBe("empty");
    expect(res.task).toBeNull();
  });

  it("not_eligible when the caller lacks the lane feature", async () => {
    const token = mintToken(FAMILY, "agent", { sub: randomUUID(), features: [] });
    const res = await json(await rpc("create_task", { token, body: { lane_key: "m3" } }));
    expect(res.ok).toBe(false);
    expect(res.code).toBe("not_eligible");
  });

  it("not_found for an unknown lane", async () => {
    const token = mintToken(FAMILY, "agent", {
      sub: randomUUID(),
      features: ["lane:m3", "role:worker"],
    });
    const res = await json(await rpc("create_task", { token, body: { lane_key: "no-such-lane" } }));
    expect(res.ok).toBe(false);
    expect(res.code).toBe("not_found");
  });

  it("the envelope always has the five keys", async () => {
    const token = mintToken(FAMILY, "agent", { sub: randomUUID(), features: ["lane:m3empty"] });
    const res = await json(await rpc("claim_next_task", { token, body: { lane_key: "m3empty" } }));
    expect(Object.keys(res).sort()).toEqual(["code", "event", "ok", "reason", "task"]);
  });
});
