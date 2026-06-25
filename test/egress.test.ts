import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { exec, waitForDb } from "./helpers/db";
import { restGet, rpc, waitForReady } from "./helpers/http";
import { mintToken } from "./helpers/mint";

// M8 egress as a capability (ADR 0015). Integration (push + PR) is gated by the
// capability:integrate feature: a family without it is never handed an `integrate`
// task and cannot advance out of the integrate stage; one with it can, and the PR
// reference it records is discoverable on the feed. No new mechanism — this proves
// the existing feature model already expresses egress-gating.
//
// m8-wf: code (initial) → integrate → done (terminal).
//   code → integrate : advance, requires role:implementer
//   integrate → done : advance, requires capability:integrate

const FAMILY = "opencode+qwen"; // exists, so instance registration (FK) resolves

const FIXTURE = `
  insert into app.features (kind, key) values
    ('lane','m8'), ('role','implementer'), ('capability','integrate')
  on conflict (kind, key) do nothing;

  insert into app.workflows (key, description) values ('m8-wf', 'M8 egress test flow')
  on conflict (key) do nothing;

  insert into app.stages (workflow_id, key, ordering, is_initial, is_terminal)
  select w.id, v.key, v.ord, v.ini, v.term
  from app.workflows w
  cross join (values ('code',0,true,false), ('integrate',1,false,false), ('done',2,false,true))
    as v(key, ord, ini, term)
  where w.key = 'm8-wf'
  on conflict (workflow_id, key) do nothing;

  insert into app.transitions (workflow_id, from_stage, to_stage, kind, required_features)
  select w.id, sf.id, st.id, 'advance', array['role:implementer']
  from app.workflows w
  join app.stages sf on sf.workflow_id = w.id and sf.key = 'code'
  join app.stages st on st.workflow_id = w.id and st.key = 'integrate'
  where w.key = 'm8-wf'
    and not exists (select 1 from app.transitions t
      where t.workflow_id = w.id and t.from_stage = sf.id and t.to_stage = st.id and t.kind = 'advance');

  insert into app.transitions (workflow_id, from_stage, to_stage, kind, required_features)
  select w.id, sf.id, st.id, 'advance', array['capability:integrate']
  from app.workflows w
  join app.stages sf on sf.workflow_id = w.id and sf.key = 'integrate'
  join app.stages st on st.workflow_id = w.id and st.key = 'done'
  where w.key = 'm8-wf'
    and not exists (select 1 from app.transitions t
      where t.workflow_id = w.id and t.from_stage = sf.id and t.to_stage = st.id and t.kind = 'advance');

  insert into app.lanes (project_id, key, workflow_id)
  select p.id, 'm8', w.id
  from app.projects p, app.workflows w
  where p.slug = 'ainarres' and w.key = 'm8-wf'
  on conflict (project_id, key) do nothing;
`;

function parkAll() {
  const res = exec(
    "update app.tasks set blocked = true where lane_id = (select id from app.lanes where key = 'm8') and not blocked",
  );
  if (!res.ok) throw new Error(`parkAll failed: ${res.error}`);
}

const json = (r: Response) => r.json();
const implToken = () => mintToken(FAMILY, "agent", { sub: randomUUID(), features: ["lane:m8", "role:implementer"] });
const integratorToken = (sub = randomUUID()) => mintToken(FAMILY, "agent", { sub, features: ["lane:m8", "capability:integrate"] });

// Drive a fresh task to the integrate stage (released, unclaimed there).
async function taskAtIntegrate() {
  const impl = implToken();
  const created = await json(await rpc("create_task", { token: impl, body: { lane_key: "m8" } }));
  const claimed = await json(await rpc("claim_next_task", { token: impl, body: { lane_key: "m8" } }));
  expect(claimed.task.id).toBe(created.task.id);
  const adv = await json(await rpc("advance_task", { token: impl, body: { task_id: created.task.id, to_stage: "integrate" } }));
  expect(adv.code).toBe("ok");
  expect(adv.task.stage_key).toBe("integrate");
  return created.task.id as string;
}

beforeAll(async () => {
  waitForDb();
  const res = exec(FIXTURE);
  if (!res.ok) throw new Error(`fixture failed: ${res.error}`);
  await waitForReady();
});

describe("capability:integrate gates the integrate stage", () => {
  it("never hands an integrate task to a family without capability:integrate", async () => {
    parkAll();
    await taskAtIntegrate();

    // A coder (role:implementer, no capability:integrate) finds nothing claimable:
    // the only candidate sits at `integrate`, whose sole outbound transition needs a
    // capability it lacks.
    const coder = await json(await rpc("claim_next_task", { token: implToken(), body: { lane_key: "m8" } }));
    expect(coder.code).toBe("empty");
  });

  it("lets a family with capability:integrate claim, advance, and record a PR reference", async () => {
    parkAll();
    const taskId = await taskAtIntegrate();

    const integrator = integratorToken();
    const claimed = await json(await rpc("claim_next_task", { token: integrator, body: { lane_key: "m8" } }));
    expect(claimed.code).toBe("ok");
    expect(claimed.task.id).toBe(taskId);

    const prUrl = "https://github.com/laanito/ainarres/pull/999";
    const advanced = await json(await rpc("advance_task", {
      token: integrator,
      body: {
        task_id: taskId,
        to_stage: "done",
        note: "merged",
        artifacts: [
          { type: "pr", url: prUrl },
          { type: "branch", name: "build/m8-egress" },
          { type: "commit", sha: "deadbeef" },
        ],
      },
    }));
    expect(advanced.code).toBe("ok");
    expect(advanced.task.stage_key).toBe("done");

    // Two planes (ADR 0003): the DB holds only a reference, discoverable on the feed.
    const oversight = mintToken(FAMILY, "oversight", { features: [] });
    const feed = await json(await restGet(`feed?task_id=eq.${taskId}`, { token: oversight }));
    const transition = feed.find((e: any) => e.type === "transition" && e.data?.to === "done");
    expect(transition).toBeTruthy();
    const pr = transition.data.artifacts.find((a: any) => a.type === "pr");
    expect(pr.url).toBe(prUrl);
  });

  it("refuses an advance from a holder whose token lacks the capability (not_eligible)", async () => {
    parkAll();
    const taskId = await taskAtIntegrate();

    // Claim as an integrator instance, then attempt the advance with a token for the
    // SAME instance but stripped of capability:integrate. The hold check passes
    // (same sub), but eligibility is recomputed from the (now insufficient) claims.
    const sub = randomUUID();
    const claimed = await json(await rpc("claim_next_task", { token: integratorToken(sub), body: { lane_key: "m8" } }));
    expect(claimed.task.id).toBe(taskId);

    const stripped = mintToken(FAMILY, "agent", { sub, features: ["lane:m8"] });
    const advanced = await json(await rpc("advance_task", { token: stripped, body: { task_id: taskId, to_stage: "done", note: "should fail" } }));
    expect(advanced.ok).toBe(false);
    expect(advanced.code).toBe("not_eligible");
  });
});
