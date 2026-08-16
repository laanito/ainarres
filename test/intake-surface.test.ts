import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { exec, waitForDb } from "./helpers/db";
import { restGet, rpc, waitForReady } from "./helpers/http";
import { mintToken } from "./helpers/mint";

// M24 Slice B — the open-briefs surface (view half; design/intake.md D7 · ADR 0023).
// api.open_briefs exposes every intake-lane task by stage, newest-first, oversight-only,
// reusing api.board. The report INTAKE LINE (pending/briefed/accepted counts) is the
// swarm slice; this only validates the dumb view.
//
// Determinism vs. the shared intake lane (the Slice A test uses it too): this test's
// briefs are created at a HIGH priority, and claim orders by priority desc, so its own
// tasks are always claimed before any default-priority pollution — letting us drive one
// brief into each stage precisely.

const FAM = "m24-surface";
const PRI = 500; // beats the Slice A test's default-priority (0) intake tasks

const FIXTURE = `
  insert into app.agent_families (key) values ('${FAM}') on conflict (key) do nothing;
`;

const json = (r: Response) => r.json() as Promise<any>;
const intaker = (sub = randomUUID()) =>
  mintToken(FAM, "agent", { sub, features: ["lane:intake", "role:intaker"] });
const designer = (sub = randomUUID()) =>
  mintToken(FAM, "agent", { sub, features: ["lane:intake", "role:designer"] });
const oversight = () => mintToken(FAM, "oversight", { features: [] });

async function ok(p: Promise<Response>) {
  const r = await json(await p);
  expect(r.ok, JSON.stringify(r)).toBe(true);
  return r;
}

let b1 = ""; // → driven to accepted
let b2 = ""; // → driven to briefed
let b3 = ""; // → left at proposed_brief

beforeAll(async () => {
  waitForDb();
  const res = exec(FIXTURE);
  if (!res.ok) throw new Error(`fixture failed: ${res.error}`);
  await waitForReady();

  const iSub = randomUUID();
  const iTok = intaker(iSub);
  // Create three briefs oldest→newest (b1 < b2 < b3 by created_at), all high-priority.
  b1 = (await ok(rpc("create_task", { token: iTok, body: { lane_key: "intake", priority: PRI } }))).task.id;
  b2 = (await ok(rpc("create_task", { token: iTok, body: { lane_key: "intake", priority: PRI } }))).task.id;
  b3 = (await ok(rpc("create_task", { token: iTok, body: { lane_key: "intake", priority: PRI } }))).task.id;

  // Intaker advances the two oldest proposed_briefs to briefed (claim returns highest
  // priority, oldest-first → b1 then b2; an intaker can only claim proposed_brief tasks).
  for (let i = 0; i < 2; i++) {
    const c = await ok(rpc("claim_next_task", { token: iTok, body: { lane_key: "intake" } }));
    await ok(rpc("advance_task", { token: iTok, body: { task_id: c.task.id, to_stage: "briefed" } }));
  }

  // Designer accepts the oldest briefed (b1) — a designer can only claim briefed tasks.
  const dTok = designer();
  const dc = await ok(rpc("claim_next_task", { token: dTok, body: { lane_key: "intake" } }));
  await ok(rpc("advance_task", { token: dTok, body: { task_id: dc.task.id, to_stage: "accepted" } }));
});

describe("M24 api.open_briefs (the intake board surface)", () => {
  it("shows this run's briefs one-per-stage: proposed_brief / briefed / accepted", async () => {
    const rows = await json(
      await restGet(`open_briefs?task_id=in.(${b1},${b2},${b3})`, { token: oversight() }),
    );
    expect(rows).toHaveLength(3);
    const byId = Object.fromEntries(rows.map((r: any) => [r.task_id, r]));
    expect(byId[b1].stage).toBe("accepted");
    expect(byId[b1].is_terminal).toBe(true);
    expect(byId[b2].stage).toBe("briefed");
    expect(byId[b3].stage).toBe("proposed_brief");
    for (const id of [b1, b2, b3]) expect(byId[id].lane).toBe("intake");
  });

  it("is newest-first (created_at descending) — the view's own ordering", async () => {
    const rows = await json(
      await restGet(`open_briefs?task_id=in.(${b1},${b2},${b3})`, { token: oversight() }),
    );
    expect(rows.map((r: any) => r.task_id)).toEqual([b3, b2, b1]);
    const ts = rows.map((r: any) => new Date(r.created_at).getTime());
    expect(ts[0]).toBeGreaterThanOrEqual(ts[1]);
    expect(ts[1]).toBeGreaterThanOrEqual(ts[2]);
  });

  it("is scoped to the intake lane only (never dev/other lanes)", async () => {
    const rows = await json(await restGet("open_briefs", { token: oversight() }));
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const r of rows) expect(r.lane).toBe("intake");
  });

  it("is oversight-only (an unauthenticated read is refused)", async () => {
    const res = await restGet("open_briefs");
    expect(res.ok).toBe(false);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
