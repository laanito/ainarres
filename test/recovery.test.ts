import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { exec, query, waitForDb } from "./helpers/db";
import { restGet, rpc, waitForReady } from "./helpers/http";
import { mintToken } from "./helpers/mint";

// M5: end-to-end lazy reclaim (ADR 0009) and the human read views. A held task
// whose lease expires is reclaimed by the next claimer (attempts++), the original
// holder is locked out (lease_lost), and a task that burns through max_attempts is
// auto-blocked ("poison"). board/feed/abandoned expose state to oversight only.

const FAMILY = "opencode+qwen";

const FIXTURE = `
  insert into app.features (kind, key) values
    ('lane','m5'), ('lane','m5views'), ('role','worker')
  on conflict (kind, key) do nothing;

  -- 2-attempt cap so poison is reachable in two reclaims.
  insert into app.workflows (key, description, default_max_attempts) values ('m5-wf', 'M5 recovery flow', 2)
  on conflict (key) do nothing;
  insert into app.stages (workflow_id, key, ordering, is_initial, is_terminal)
  select w.id, v.key, v.ord, v.ini, v.term from app.workflows w
  cross join (values ('s0',0,true,false),('s1',1,false,true)) as v(key,ord,ini,term)
  where w.key = 'm5-wf' on conflict (workflow_id, key) do nothing;
  insert into app.transitions (workflow_id, from_stage, to_stage, kind, required_features)
  select w.id, sf.id, st.id, 'advance', array['role:worker']
  from app.workflows w
  join app.stages sf on sf.workflow_id = w.id and sf.key = 's0'
  join app.stages st on st.workflow_id = w.id and st.key = 's1'
  where w.key = 'm5-wf' and not exists (select 1 from app.transitions t where t.from_stage = sf.id and t.to_stage = st.id and t.kind = 'advance');

  insert into app.lanes (project_id, key, workflow_id)
  select p.id, v.lane, w.id
  from app.projects p
  join (values ('m5'),('m5views')) as v(lane) on true
  join app.workflows w on w.key = 'm5-wf'
  where p.slug = 'ainarres'
  on conflict (project_id, key) do nothing;
`;

const json = (r: Response) => r.json() as Promise<any>;
const workerFor = (lane: string) =>
  mintToken(FAMILY, "agent", { sub: randomUUID(), features: [`lane:${lane}`, "role:worker"] });
const expireLease = (id: string) =>
  exec(`update app.tasks set lease_expires_at = now() - interval '1 second' where id = '${id}'`);

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

describe("lazy reclaim", () => {
  it("reclaims an expired-lease task (attempts++), locks out the original holder, and auto-blocks poison", async () => {
    park("m5");
    const a = workerFor("m5");
    const created = await json(await rpc("create_task", { token: a, body: { lane_key: "m5" } }));
    const id = created.task.id;

    // A claims (fresh: attempts stays 0), then its lease expires.
    const aClaim = await json(await rpc("claim_next_task", { token: a, body: { lane_key: "m5" } }));
    expect(aClaim.task.id).toBe(id);
    expect(aClaim.task.attempts).toBe(0);
    expireLease(id);

    // B reclaims it → attempts becomes 1.
    const b = workerFor("m5");
    const bClaim = await json(await rpc("claim_next_task", { token: b, body: { lane_key: "m5" } }));
    expect(bClaim.ok).toBe(true);
    expect(bClaim.task.id).toBe(id);
    expect(bClaim.task.attempts).toBe(1);

    // The original holder A is locked out.
    const aLate = await json(await rpc("heartbeat", { token: a, body: { task_id: id } }));
    expect(aLate.code).toBe("lease_lost");

    // B's lease expires too; C's reclaim would be attempt 2 == cap → poison.
    expireLease(id);
    const c = workerFor("m5");
    const cClaim = await json(await rpc("claim_next_task", { token: c, body: { lane_key: "m5" } }));
    expect(cClaim.code).toBe("empty"); // poison is auto-blocked, not handed out

    const [t] = query<{ blocked: boolean; blocked_reason: string; attempts: number }>(
      `select blocked, blocked_reason, attempts from app.tasks where id = '${id}'`,
    );
    expect(t.blocked).toBe(true);
    expect(t.blocked_reason).toBe("max attempts exceeded");
    expect(t.attempts).toBe(2);
  });
});

describe("oversight views", () => {
  const oversight = () => mintToken(FAMILY, "oversight", { features: [] });

  it("board shows a task with readable keys and flags", async () => {
    park("m5views");
    const w = workerFor("m5views");
    const created = await json(await rpc("create_task", { token: w, body: { lane_key: "m5views" } }));
    const id = created.task.id;

    const rows = await json(await restGet(`board?lane=eq.m5views&task_id=eq.${id}`, { token: oversight() }));
    expect(rows).toHaveLength(1);
    expect(rows[0].stage).toBe("s0");
    expect(rows[0].blocked).toBe(false);
    expect(rows[0].abandoned).toBe(false);
    expect(rows[0].project).toBe("ainarres");
  });

  it("feed shows the events for a task", async () => {
    park("m5views");
    const w = workerFor("m5views");
    const created = await json(await rpc("create_task", { token: w, body: { lane_key: "m5views" } }));
    const id = created.task.id;

    const rows = await json(await restGet(`feed?task_id=eq.${id}`, { token: oversight() }));
    expect(rows.map((r: any) => r.type)).toContain("created");
    expect(rows[0].lane).toBe("m5views");
  });

  it("abandoned surfaces an expired-lease task still held", async () => {
    park("m5views");
    const w = workerFor("m5views");
    const created = await json(await rpc("create_task", { token: w, body: { lane_key: "m5views" } }));
    const id = created.task.id;
    await json(await rpc("claim_next_task", { token: w, body: { lane_key: "m5views" } }));
    expireLease(id);

    const rows = await json(await restGet(`abandoned?task_id=eq.${id}`, { token: oversight() }));
    expect(rows).toHaveLength(1);
    expect(rows[0].abandoned).toBe(true);
  });

  it("are readable by oversight but not by anon or agent", async () => {
    const ovr = await restGet("board?limit=1", { token: oversight() });
    expect(ovr.ok).toBe(true);

    const anon = await restGet("board?limit=1");
    expect(anon.ok).toBe(false);

    const agent = await restGet("board?limit=1", {
      token: mintToken(FAMILY, "agent", { sub: randomUUID(), features: [] }),
    });
    expect(agent.ok).toBe(false);
  });
});
