import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { exec, query, waitForDb } from "./helpers/db";
import { restGet, rpc, waitForReady } from "./helpers/http";
import { mintToken } from "./helpers/mint";

// v8 — the spend M20 could not see. api.record_usage resolved the charged task from the
// actor's last transition and, finding none, returned `no_work` and wrote NOTHING. In one
// measured run that silently dropped ~474k tokens: three implementer tiers woke after the
// pool had claimed the only pending task, found nothing, and each still paid for a model
// load. An empty sweep does not cost nothing.
//
// These tests pin both halves: the task-anchored path is UNCHANGED (it is the competence
// signal and must not drift), and the task-less path now lands in its own append-only
// ledger — app.events.task_id is NOT NULL, so task-less spend can never be an event.
//
// DB test (validated ASSISTED — a security-definer verb plus grants has no substrate-free
// self-check in a worktree).

const LANE = `v8-sweep-${randomUUID().slice(0, 8)}`; // own lane: no claim races
const FAM = `v8-sweep-fam-${randomUUID().slice(0, 8)}`;
const IDLE = `v8-sweep-idle-${randomUUID().slice(0, 8)}`; // never claims anything

const FIXTURE = `
  insert into app.features (kind, key) values ('lane', '${LANE}') on conflict (kind, key) do nothing;
  insert into app.agent_families (key) values ('${FAM}'), ('${IDLE}') on conflict (key) do nothing;
  insert into app.family_features (family_id, feature_id)
  select f.id, ft.id from app.agent_families f
  join app.features ft on ft.name = any (array['lane:${LANE}', 'role:implementer'])
  where f.key in ('${FAM}', '${IDLE}') on conflict do nothing;
  insert into app.lanes (project_id, key, workflow_id)
  select p.id, '${LANE}', w.id from app.projects p, app.workflows w
  where p.slug = 'ainarres' and w.key = 'ainarres-dev'
  on conflict (project_id, key) do nothing;
`;

const oversight = () => mintToken(FAM, "oversight", { features: [] });
const monitor = () => mintToken(FAM, "monitor", { features: [] });
const worker = (sub: string) =>
  mintToken(FAM, "agent", { sub, features: [`lane:${LANE}`, "role:implementer"] });

const TOKENS = { input: 9000, output: 500, cache_read: 130000, cache_creation: 0 };
const payload = (sweep: string) => ({ tokens: TOKENS, model: "test-model", sweep_id: sweep });

const sweepRows = (family: string) =>
  query<{ n: string }>(`
    select count(*)::text n from app.sweep_usage su
    join app.agent_families f on f.id = su.family_id
    where f.key = '${family}'`)[0].n;

beforeAll(async () => {
  waitForDb();
  const res = exec(FIXTURE);
  if (!res.ok) throw new Error(`fixture failed: ${res.error}`);
  await waitForReady();
});

// Create a task on this file's own lane and return its id. Creating in a lane needs the
// STARTER role of that lane's initial stage (the M24 D4 gate) — for the dev workflow,
// role:designer on proposed → designing.
async function makeTask(sub = randomUUID()): Promise<string> {
  const created = await (await rpc("create_task", {
    token: mintToken(FAM, "agent", { sub, features: [`lane:${LANE}`, "role:designer", "role:implementer"] }),
    body: { lane_key: LANE, payload: { instructions: "sweep-usage fixture" } },
  })).json();
  if (created.ok !== true) throw new Error(`create_task failed: ${created.code} ${created.reason ?? ""}`);
  return created.task.id;
}

describe("the task-anchored path is unchanged (the competence signal must not drift)", () => {
  it("still writes a usage EVENT for an actor that moved a task, and no ledger row", async () => {
    const sub = randomUUID();
    const task = await makeTask(sub);

    const before = sweepRows(FAM);
    const res = await (await rpc("record_usage", {
      token: oversight(),
      body: { actor: sub, data: payload(randomUUID()), task },
    })).json();

    expect(res.ok).toBe(true);
    expect(res.code).toBe("ok");
    expect(res.event.type).toBe("usage");
    expect(res.event.task_id).toBe(task);
    // Nothing leaked into the new ledger — task-anchored spend stays in app.events.
    expect(sweepRows(FAM)).toBe(before);
  });

  it("still refuses an unknown actor when a task IS named", async () => {
    const task = await makeTask();
    const res = await (await rpc("record_usage", {
      token: oversight(),
      body: { actor: randomUUID(), data: payload(randomUUID()), task },
    })).json();
    expect(res.ok).toBe(false);
    expect(res.code).toBe("unknown_actor");
  });
});

describe("a sweep that moved nothing still spent", () => {
  it("records against the NAMED family instead of dropping it", async () => {
    // The exact shape the driver produces for a tier that woke, found the board already
    // claimed, and stopped: a real actor uuid that never became an agent, no task.
    const before = Number(sweepRows(IDLE));
    const res = await (await rpc("record_usage", {
      token: oversight(),
      body: { actor: randomUUID(), data: payload(randomUUID()), family: IDLE },
    })).json();

    expect(res.ok).toBe(true);
    expect(res.code).toBe("no_task_spend");
    expect(res.event.tokens).toEqual(TOKENS);
    expect(res.event.model).toBe("test-model");
    expect(Number(sweepRows(IDLE))).toBe(before + 1);
  });

  it("writes no event — task-less spend cannot be one (events.task_id is NOT NULL)", async () => {
    const sweep = randomUUID();
    await rpc("record_usage", {
      token: oversight(),
      body: { actor: randomUUID(), data: payload(sweep), family: IDLE },
    });
    const n = query<{ n: string }>(`
      select count(*)::text n from app.events
      where type = 'usage' and data ->> 'sweep_id' = '${sweep}'`)[0].n;
    expect(n).toBe("0");
  });

  it("falls back to the actor's own family when none is named", async () => {
    // A worker that claimed earlier in the run but moved nothing in THIS sweep: the agent
    // row exists, so its family is known without the driver saying so.
    const sub = randomUUID();
    await rpc("claim_next_task", { token: worker(sub), body: { lane_key: LANE } });
    const before = Number(sweepRows(FAM));
    const res = await (await rpc("record_usage", {
      token: oversight(),
      body: { actor: sub, data: payload(randomUUID()) },
    })).json();
    expect(res.ok).toBe(true);
    expect(res.code).toBe("no_task_spend");
    expect(Number(sweepRows(FAM))).toBe(before + 1);
  });

  it("REFUSES rather than orphans it when neither actor nor family resolves", async () => {
    // An unattributable number is worse than a missing one: it reads as somebody's.
    const res = await (await rpc("record_usage", {
      token: oversight(),
      body: { actor: randomUUID(), data: payload(randomUUID()), family: "no-such-family-here" },
    })).json();
    expect(res.ok).toBe(false);
    expect(res.code).toBe("unknown_family");
  });

  it("is append-only", () => {
    const upd = exec("update app.sweep_usage set model = 'rewritten'");
    expect(upd.ok).toBe(false);
    expect(upd.error).toMatch(/append-only/i);
    const del = exec("delete from app.sweep_usage");
    expect(del.ok).toBe(false);
    expect(del.error).toMatch(/append-only/i);
  });
});

describe("api.sweep_usage — the surface", () => {
  it("sums the token total per family and counts the sweeps", async () => {
    const fam = `v8-sweep-sum-${randomUUID().slice(0, 8)}`;
    exec(`insert into app.agent_families (key) values ('${fam}') on conflict (key) do nothing;`);
    for (let i = 0; i < 3; i++) {
      await rpc("record_usage", {
        token: oversight(),
        body: { actor: randomUUID(), data: payload(randomUUID()), family: fam },
      });
    }
    const rows = await (await restGet(`sweep_usage?family=eq.${fam}`, { token: oversight() })).json();
    expect(rows).toHaveLength(1);
    expect(rows[0].sweeps).toBe(3);
    // 9000 + 500 + 130000 + 0, three times — cache reads counted, because they were paid.
    expect(Number(rows[0].tokens)).toBe(3 * 139500);
  });

  it("is readable by a delegated monitor", async () => {
    const res = await restGet("sweep_usage?limit=5", { token: monitor() });
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  it("does not blend into api.family_track_record (competence stays separate from cost)", async () => {
    // D3: spend and competence are shown side by side and never merged. A family whose
    // ONLY spend was empty sweeps has delivered nothing, so it must not appear there.
    const rows = await (await restGet(`family_track_record?family=eq.${IDLE}`, { token: oversight() })).json();
    expect(rows).toEqual([]);
  });
});
