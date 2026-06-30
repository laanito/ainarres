import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { exec, query, waitForDb } from "./helpers/db";
import { restGet, rpc, waitForReady } from "./helpers/http";
import { mintToken } from "./helpers/mint";

// M16 observability (ADR 0021; design `.agents/design/observability.md`). The
// read surface a swarm-watcher needs: api.board enriched with the holder's
// FAMILY, age-in-stage and unsatisfied prerequisites; api.timeline = the feed
// joined to the ACTING family (the actor→agents→agent_families join the v3
// pollution post-mortem needed hand-written SQL for). Read-only, oversight-granted.

const FAMILY = "opencode+qwen";

const FIXTURE = `
  insert into app.features (kind, key) values ('lane','m16'), ('role','worker')
  on conflict (kind, key) do nothing;
  insert into app.workflows (key, description) values ('m16-wf', 'M16 observability flow')
  on conflict (key) do nothing;
  insert into app.stages (workflow_id, key, ordering, is_initial, is_terminal)
  select w.id, v.key, v.ord, v.ini, v.term from app.workflows w
  cross join (values ('s0',0,true,false),('s1',1,false,true)) as v(key,ord,ini,term)
  where w.key = 'm16-wf' on conflict (workflow_id, key) do nothing;
  insert into app.transitions (workflow_id, from_stage, to_stage, kind, required_features)
  select w.id, sf.id, st.id, 'advance', array['role:worker']
  from app.workflows w
  join app.stages sf on sf.workflow_id = w.id and sf.key = 's0'
  join app.stages st on st.workflow_id = w.id and st.key = 's1'
  where w.key = 'm16-wf' and not exists (select 1 from app.transitions t where t.from_stage = sf.id and t.to_stage = st.id and t.kind = 'advance');
  insert into app.lanes (project_id, key, workflow_id)
  select p.id, 'm16', w.id from app.projects p
  join app.workflows w on w.key = 'm16-wf'
  where p.slug = 'ainarres' on conflict (project_id, key) do nothing;
`;

const json = (r: Response) => r.json() as Promise<any>;
const oversight = () => mintToken(FAMILY, "oversight", { features: [] });
const worker = () =>
  mintToken(FAMILY, "agent", { sub: randomUUID(), features: ["lane:m16", "role:worker"] });

function park(lane: string): void {
  const r = exec(`update app.tasks set blocked = true
    where lane_id = (select id from app.lanes where key = '${lane}') and not blocked`);
  if (!r.ok) throw new Error(`park ${lane} failed: ${r.error}`);
}

beforeAll(async () => {
  waitForDb();
  const res = exec(FIXTURE);
  if (!res.ok) throw new Error(`fixture failed: ${res.error}`);
  await waitForReady();
});

describe("M16 enriched board", () => {
  it("names the holder's family and reports age-in-stage once a task is claimed", async () => {
    park("m16");
    const w = worker();
    const created = await json(await rpc("create_task", { token: w, body: { lane_key: "m16" } }));
    const id = created.task.id;

    // Unclaimed: no holder family yet.
    let rows = await json(await restGet(`board?task_id=eq.${id}`, { token: oversight() }));
    expect(rows[0].claimed_by_family).toBeNull();
    expect(rows[0].age_in_stage).not.toBeNull();

    // Claim it → the durable family surfaces (not a bare instance uuid).
    await json(await rpc("claim_next_task", { token: w, body: { lane_key: "m16" } }));
    rows = await json(await restGet(`board?task_id=eq.${id}`, { token: oversight() }));
    expect(rows[0].claimed_by_family).toBe(FAMILY);
    expect(rows[0].claimed_by).not.toBeNull();
  });

  it("lists unsatisfied prerequisites in blocked_by, clearing them as they reach a terminal stage", async () => {
    park("m16");
    const w = worker();
    const prereq = await json(await rpc("create_task", { token: w, body: { lane_key: "m16" } }));
    const dep = await json(
      await rpc("create_task", { token: w, body: { lane_key: "m16", depends_on: [prereq.task.id] } }),
    );
    const depId = dep.task.id;

    // Prereq is at the initial (non-terminal) stage → it holds the dependent back.
    let rows = await json(await restGet(`board?task_id=eq.${depId}`, { token: oversight() }));
    expect(rows[0].blocked_by).toContain(prereq.task.id);

    // Drive the prereq to its terminal stage; blocked_by clears.
    exec(`update app.tasks set stage = (
      select s.id from app.stages s join app.workflows wf on wf.id = s.workflow_id
      where wf.key = 'm16-wf' and s.is_terminal) where id = '${prereq.task.id}'`);
    rows = await json(await restGet(`board?task_id=eq.${depId}`, { token: oversight() }));
    expect(rows[0].blocked_by).toEqual([]);
  });
});

describe("M16 timeline", () => {
  it("joins each event to the acting agent's family", async () => {
    park("m16");
    const w = worker();
    const created = await json(await rpc("create_task", { token: w, body: { lane_key: "m16" } }));
    const id = created.task.id;

    const rows = await json(await restGet(`timeline?task_id=eq.${id}`, { token: oversight() }));
    expect(rows.length).toBeGreaterThan(0);
    const createdEvent = rows.find((e: any) => e.type === "created");
    expect(createdEvent.family).toBe(FAMILY);
    expect(createdEvent.lane).toBe("m16");
  });

  it("leaves family null for an actor-less (human/system) event", async () => {
    park("m16");
    const w = worker();
    const created = await json(await rpc("create_task", { token: w, body: { lane_key: "m16" } }));
    const id = created.task.id;
    // A human/system intervention writes an event with no actor.
    exec(`insert into app.events (task_id, actor, type, data)
      values ('${id}', null, 'note', '{"by":"human"}'::jsonb)`);

    const rows = await json(await restGet(`timeline?task_id=eq.${id}&type=eq.note`, { token: oversight() }));
    expect(rows).toHaveLength(1);
    expect(rows[0].actor).toBeNull();
    expect(rows[0].family).toBeNull();
  });

  it("is oversight-only (anonymous is refused)", async () => {
    const anon = await restGet("timeline?limit=1");
    expect(anon.status).toBeGreaterThanOrEqual(400);
  });
});
