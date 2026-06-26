import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { exec, waitForDb } from "./helpers/db";
import { rpc, waitForReady } from "./helpers/http";
import { mintToken } from "./helpers/mint";

// M9 worker ergonomics: bounded auto-heartbeat. `ainarres heartbeat --watch` renews
// the lease while a task is worked, so a healthy long-running task is NOT reclaimed;
// when the watcher stops, the lease expires and the task becomes reclaimable again
// (ADR 0009's safety property still holds). Uses a deliberately short (2s) stage
// lease so the behaviour is observable in seconds.

const FAMILY = "opencode+qwen"; // exists, so instance registration (FK) resolves

const FIXTURE = `
  insert into app.features (kind, key) values ('lane','hb'), ('role','worker')
  on conflict (kind, key) do nothing;

  insert into app.workflows (key, description, default_lease) values
    ('hb-wf', 'M9 heartbeat test flow', interval '2 seconds')
  on conflict (key) do nothing;

  insert into app.stages (workflow_id, key, ordering, is_initial, is_terminal, lease_duration)
  select w.id, v.key, v.ord, v.ini, v.term, v.lease
  from app.workflows w
  cross join (values ('work',0,true,false, interval '2 seconds'), ('done',1,false,true, null::interval))
    as v(key, ord, ini, term, lease)
  where w.key = 'hb-wf'
  on conflict (workflow_id, key) do nothing;

  insert into app.transitions (workflow_id, from_stage, to_stage, kind, required_features)
  select w.id, sf.id, st.id, 'advance', array['role:worker']
  from app.workflows w
  join app.stages sf on sf.workflow_id = w.id and sf.key = 'work'
  join app.stages st on st.workflow_id = w.id and st.key = 'done'
  where w.key = 'hb-wf'
    and not exists (select 1 from app.transitions t
      where t.workflow_id = w.id and t.from_stage = sf.id and t.to_stage = st.id and t.kind = 'advance');

  insert into app.lanes (project_id, key, workflow_id)
  select p.id, 'hb', w.id from app.projects p, app.workflows w
  where p.slug = 'ainarres' and w.key = 'hb-wf'
  on conflict (project_id, key) do nothing;
`;

const json = (r: Response) => r.json();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const workerToken = (sub = randomUUID()) => mintToken(FAMILY, "agent", { sub, features: ["lane:hb", "role:worker"] });

beforeAll(async () => {
  waitForDb();
  const res = exec(FIXTURE);
  if (!res.ok) throw new Error(`fixture failed: ${res.error}`);
  await waitForReady();
});

describe("bounded auto-heartbeat (--watch)", () => {
  it("keeps a healthy task held; once the watcher stops, the task is reclaimed", async () => {
    exec("update app.tasks set blocked = true where lane_id = (select id from app.lanes where key = 'hb') and not blocked");

    const holder = workerToken();
    const created = await json(await rpc("create_task", { token: holder, body: { lane_key: "hb" } }));
    const claimed = await json(await rpc("claim_next_task", { token: holder, body: { lane_key: "hb" } }));
    expect(claimed.task.id).toBe(created.task.id);

    // Start the bounded watcher (renew every 1s, cap 30s) as a background process.
    const watcher = spawn("node", ["bin/ainarres.mjs", "heartbeat", created.task.id, "--watch", "--interval", "1", "--max", "30"], {
      env: { ...process.env, AINARRES_TOKEN: holder },
      stdio: "ignore",
    });

    try {
      // Past the 2s lease, the task is still held — the watcher renewed it.
      await sleep(3500);
      const stillHeld = await json(await rpc("claim_next_task", { token: workerToken(), body: { lane_key: "hb" } }));
      expect(stillHeld.code).toBe("empty");
    } finally {
      watcher.kill("SIGKILL"); // simulate the agent stopping
    }

    // With no more heartbeats, the lease lapses and the task is reclaimable.
    await sleep(3500);
    const reclaimed = await json(await rpc("claim_next_task", { token: workerToken(), body: { lane_key: "hb" } }));
    expect(reclaimed.code).toBe("ok");
    expect(reclaimed.task.id).toBe(created.task.id);
  }, 30_000);
});
