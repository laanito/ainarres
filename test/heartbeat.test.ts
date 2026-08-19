import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { exec, query, waitForDb } from "./helpers/db";
import { rpc, waitForReady } from "./helpers/http";
import { mintToken } from "./helpers/mint";

// M9 worker ergonomics: bounded auto-heartbeat. `ainarres heartbeat --watch` renews
// the lease while a task is worked, so a healthy long-running task is NOT reclaimed;
// when the watcher stops, the lease expires and the task becomes reclaimable again
// (ADR 0009's safety property still holds). Uses a short (4s) stage lease so the
// behaviour is observable in seconds.
//
// This test used to flake. The ROOT CAUSE was a product bug, now fixed in bin/ainarres.mjs:
// the CLI's long-lived `heartbeat --watch` loop reused a keep-alive socket that PostgREST
// had closed between polls, and undici stalled ~3s reconnecting — so every beat after the
// first came ~3s late and a short lease lapsed (`Connection: close` per request fixes it).
// This test is ALSO hardened to be deterministic under load: it asserts against OBSERVABLE
// STATE via polling — it waits for PROOF the watcher renewed the lease (lease_expires_at
// advanced) and PROOF the task became reclaimable after the watcher stopped — rather than
// sleeping a fixed wall-clock and hoping the timing lined up.

const FAMILY = "opencode+qwen"; // exists, so instance registration (FK) resolves

const FIXTURE = `
  insert into app.features (kind, key) values ('lane','hb'), ('role','worker')
  on conflict (kind, key) do nothing;

  insert into app.workflows (key, description, default_lease) values
    ('hb-wf', 'M9 heartbeat test flow', interval '4 seconds')
  on conflict (key) do nothing;

  insert into app.stages (workflow_id, key, ordering, is_initial, is_terminal, lease_duration)
  select w.id, v.key, v.ord, v.ini, v.term, v.lease
  from app.workflows w
  cross join (values ('work',0,true,false, interval '4 seconds'), ('done',1,false,true, null::interval))
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

// The task's current lease expiry as epoch ms (null if unset). Read straight from the
// db so the test observes the actual renewal state, not a wall-clock guess.
function leaseExpiryMs(id: string): number | null {
  const rows = query<{ exp: number | null }>(
    `select extract(epoch from lease_expires_at) * 1000 as exp from app.tasks where id = '${id}'`,
  );
  const v = rows[0]?.exp;
  return v == null ? null : Number(v);
}

// Poll `fn` up to timeoutMs (250ms cadence); resolve true as soon as it holds, else false.
async function pollUntil(fn: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(250);
  }
}

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
    const initialExpiry = leaseExpiryMs(created.task.id);
    expect(initialExpiry).not.toBeNull();

    // Start the bounded watcher (renew every 1s, cap 30s) as a background process.
    const watcher = spawn("node", ["bin/ainarres.mjs", "heartbeat", created.task.id, "--watch", "--interval", "1", "--max", "30"], {
      env: { ...process.env, AINARRES_TOKEN: holder },
      stdio: "ignore",
    });

    try {
      // Held-while-watched: wait for PROOF the watcher renewed — lease_expires_at
      // advances clearly past the original (not a fixed sleep, so subprocess-startup
      // jitter can't flake it). The watcher beats every 1s to now()+4s, so once we see
      // it advance, the lease is comfortably valid.
      const renewed = await pollUntil(() => {
        const e = leaseExpiryMs(created.task.id);
        return e != null && initialExpiry != null && e > initialExpiry + 500;
      }, 15_000);
      expect(renewed).toBe(true);

      // With a live watcher holding a freshly-renewed 4s lease, a competing worker
      // cannot claim the task — it is still held.
      const stillHeld = await json(await rpc("claim_next_task", { token: workerToken(), body: { lane_key: "hb" } }));
      expect(stillHeld.code).toBe("empty");
    } finally {
      watcher.kill("SIGKILL"); // simulate the agent stopping
    }

    // Reclaim-when-stopped: with no more heartbeats the lease lapses and the task
    // becomes reclaimable. Poll for that outcome (the lease is ≤4s) rather than
    // sleeping a fixed time.
    let reclaimed: { code?: string; task?: { id?: string } } = {};
    const gotIt = await pollUntil(async () => {
      reclaimed = await json(await rpc("claim_next_task", { token: workerToken(), body: { lane_key: "hb" } }));
      return reclaimed.code === "ok";
    }, 15_000);
    expect(gotIt).toBe(true);
    expect(reclaimed.task?.id).toBe(created.task.id);
  }, 45_000);
});
