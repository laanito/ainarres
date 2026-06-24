import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { exec, waitForDb } from "./helpers/db";
import { rpc, waitForReady } from "./helpers/http";
import { mintToken } from "./helpers/mint";

// M7 task dependencies (ADR 0014). A task with an unsatisfied prerequisite (a
// prereq not yet at a terminal stage) must not be handed out by claim_next_task;
// once the prereq reaches a terminal stage it becomes claimable. Driven entirely
// through the verbs, on a test-owned workflow/lane so it's repeatable.
//
// m7-wf is a two-stage flow: todo (initial) → done (terminal), advance gated by
// role:worker. lane:m7 membership is enforced separately by the verb.

const FAMILY = "opencode+qwen"; // exists, so instance registration (FK) resolves

const FIXTURE = `
  insert into app.features (kind, key) values
    ('lane','m7'), ('role','worker')
  on conflict (kind, key) do nothing;

  insert into app.workflows (key, description) values ('m7-wf', 'M7 dependency test flow')
  on conflict (key) do nothing;

  insert into app.stages (workflow_id, key, ordering, is_initial, is_terminal)
  select w.id, v.key, v.ord, v.ini, v.term
  from app.workflows w
  cross join (values ('todo',0,true,false), ('done',1,false,true))
    as v(key, ord, ini, term)
  where w.key = 'm7-wf'
  on conflict (workflow_id, key) do nothing;

  insert into app.transitions (workflow_id, from_stage, to_stage, kind, required_features)
  select w.id, sf.id, st.id, 'advance', array['role:worker']
  from app.workflows w
  join app.stages sf on sf.workflow_id = w.id and sf.key = 'todo'
  join app.stages st on st.workflow_id = w.id and st.key = 'done'
  where w.key = 'm7-wf'
    and not exists (
      select 1 from app.transitions t
      where t.workflow_id = w.id and t.from_stage = sf.id and t.to_stage = st.id and t.kind = 'advance'
    );

  insert into app.lanes (project_id, key, workflow_id)
  select p.id, 'm7', w.id
  from app.projects p, app.workflows w
  where p.slug = 'ainarres' and w.key = 'm7-wf'
  on conflict (project_id, key) do nothing;
`;

// Park every existing m7 task so a fresh test claims only what it creates.
function parkAll() {
  const res = exec(
    "update app.tasks set blocked = true where lane_id = (select id from app.lanes where key = 'm7') and not blocked",
  );
  if (!res.ok) throw new Error(`parkAll failed: ${res.error}`);
}

const json = (r: Response) => r.json();
const workerToken = () =>
  mintToken(FAMILY, "agent", { sub: randomUUID(), features: ["lane:m7", "role:worker"] });

beforeAll(async () => {
  waitForDb();
  const res = exec(FIXTURE);
  if (!res.ok) throw new Error(`fixture failed: ${res.error}`);
  await waitForReady();
});

describe("create_task with prerequisites", () => {
  it("rejects an unknown prerequisite with not_found", async () => {
    const token = workerToken();
    const res = await json(
      await rpc("create_task", { token, body: { lane_key: "m7", depends_on: [randomUUID()] } }),
    );
    expect(res.ok).toBe(false);
    expect(res.code).toBe("not_found");
  });

  it("stores depends_on on the created task", async () => {
    const token = workerToken();
    const prereq = await json(await rpc("create_task", { token, body: { lane_key: "m7" } }));
    const dependent = await json(
      await rpc("create_task", { token, body: { lane_key: "m7", depends_on: [prereq.task.id] } }),
    );
    expect(dependent.ok).toBe(true);
    expect(dependent.task.depends_on).toContain(prereq.task.id);
  });
});

describe("claim_next_task respects dependencies", () => {
  it("does not hand out a dependent until its prerequisite is satisfied", async () => {
    parkAll();
    const creator = workerToken();
    const prereq = await json(await rpc("create_task", { token: creator, body: { lane_key: "m7", payload: { role: "prereq" } } }));
    const dependent = await json(
      await rpc("create_task", { token: creator, body: { lane_key: "m7", payload: { role: "dependent" }, depends_on: [prereq.task.id] } }),
    );
    expect(prereq.ok && dependent.ok).toBe(true);

    // Worker 1 claims: it can only get the prereq — the dependent is held back.
    const w1 = workerToken();
    const claim1 = await json(await rpc("claim_next_task", { token: w1, body: { lane_key: "m7" } }));
    expect(claim1.code).toBe("ok");
    expect(claim1.task.id).toBe(prereq.task.id);

    // Worker 2 claims while the prereq is still in flight: nothing claimable
    // (prereq is held, dependent is blocked by its unsatisfied prerequisite).
    const w2 = workerToken();
    const claim2 = await json(await rpc("claim_next_task", { token: w2, body: { lane_key: "m7" } }));
    expect(claim2.code).toBe("empty");

    // Worker 1 advances the prereq to the terminal stage → prerequisite satisfied.
    const advanced = await json(await rpc("advance_task", { token: w1, body: { task_id: prereq.task.id, to_stage: "done" } }));
    expect(advanced.code).toBe("ok");
    expect(advanced.task.stage_key).toBe("done");

    // Now worker 2 can claim the dependent.
    const claim3 = await json(await rpc("claim_next_task", { token: w2, body: { lane_key: "m7" } }));
    expect(claim3.code).toBe("ok");
    expect(claim3.task.id).toBe(dependent.task.id);
  });

  it("keeps a dependent unclaimable while its prerequisite is blocked", async () => {
    parkAll();
    const creator = workerToken();
    const prereq = await json(await rpc("create_task", { token: creator, body: { lane_key: "m7" } }));
    await json(await rpc("create_task", { token: creator, body: { lane_key: "m7", depends_on: [prereq.task.id] } }));

    // Claim the prereq, then block it (parked, still non-terminal).
    const w1 = workerToken();
    const claimed = await json(await rpc("claim_next_task", { token: w1, body: { lane_key: "m7" } }));
    expect(claimed.task.id).toBe(prereq.task.id);
    const blocked = await json(await rpc("block_task", { token: w1, body: { task_id: prereq.task.id, reason: "test park" } }));
    expect(blocked.code).toBe("ok");

    // The dependent stays unclaimable: its prerequisite is not terminal.
    const w2 = workerToken();
    const claim = await json(await rpc("claim_next_task", { token: w2, body: { lane_key: "m7" } }));
    expect(claim.code).toBe("empty");
  });

  it("leaves tasks without prerequisites unaffected", async () => {
    parkAll();
    const creator = workerToken();
    const plain = await json(await rpc("create_task", { token: creator, body: { lane_key: "m7", payload: { role: "plain" } } }));
    const claim = await json(await rpc("claim_next_task", { token: workerToken(), body: { lane_key: "m7" } }));
    expect(claim.code).toBe("ok");
    expect(claim.task.id).toBe(plain.task.id);
  });
});
