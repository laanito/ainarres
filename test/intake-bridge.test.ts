import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { exec, waitForDb } from "./helpers/db";
import { rpc, waitForReady } from "./helpers/http";
import { mintToken } from "./helpers/mint";

// v8 step 1 — the INTAKE BRIDGE contract. The standing designer (loop/roles.sh:
// lane:dev + lane:intake + role:designer, no role:intaker) is what carries a refined brief
// into dev work. These tests pin the three substrate properties its prompt depends on, so
// a future feature change breaks a test rather than the loop:
//
//   1. ONE identity can do the whole hand-off: claim a `briefed` brief, create the dev
//      tasks WHILE STILL HOLDING it, then accept it last (accept = the commit point, so a
//      failure mid-way leaves the brief claimable and re-doable).
//   2. That identity CANNOT touch `proposed_brief` — refining a raw request needs
//      role:intaker, so the human's step stays the human's, enforced by the substrate and
//      not by prompt discipline.
//   3. The intaker identity still cannot create on `dev` — M24's two-tier gate (D4),
//      unchanged by granting the designer lane:intake.

const FAM = "v8-bridge";
// A lane UNIQUE PER RUN. The suite is re-run against a substrate that keeps prior runs'
// rows (tasks cannot be deleted — app.events is append-only), and this file asserts it
// claims ITS OWN brief. A fixed lane key would hand run N+1 run N's leftover
// proposed_brief. Same idempotency trick M22b's surface test used for its capability key.
const LANE = `v8-bridge-${randomUUID().slice(0, 8)}`;

// Own lane, REAL workflow: the brief walks the actual `ainarres-intake` workflow (whose
// transitions encode the role:intaker / role:designer split we are testing), but on a lane
// only this file's tokens hold — so claims never race the other intake tests, in either
// direction. Priority games would; the shared intake lane has several tests driving briefs
// through named stages at once.
const FIXTURE = `
  insert into app.features (kind, key) values ('lane', '${LANE}')
  on conflict (kind, key) do nothing;
  insert into app.agent_families (key) values ('${FAM}') on conflict (key) do nothing;
  insert into app.lanes (project_id, key, workflow_id)
  select p.id, '${LANE}', w.id
  from app.projects p, app.workflows w
  where p.slug = 'ainarres' and w.key = 'ainarres-intake'
  on conflict (project_id, key) do nothing;
`;

const json = (r: Response) => r.json() as Promise<any>;

// The standing designer's exact feature set (loop/roles.sh::role_features designer).
const standingDesigner = (sub = randomUUID()) =>
  mintToken(FAM, "agent", { sub, features: [`lane:${LANE}`, "lane:dev", "role:designer"] });
const intaker = (sub = randomUUID()) =>
  mintToken(FAM, "agent", { sub, features: [`lane:${LANE}`, "role:intaker"] });

async function ok(p: Promise<Response>) {
  const r = await json(await p);
  expect(r.ok, JSON.stringify(r)).toBe(true);
  return r;
}

beforeAll(async () => {
  waitForDb();
  const res = exec(FIXTURE);
  if (!res.ok) throw new Error(`fixture failed: ${res.error}`);
  await waitForReady();
});

describe("the intake bridge: one designer identity carries a brief into dev work", () => {
  it("claims a briefed brief, creates dev tasks while holding it, then accepts it last", async () => {
    const intakerSub = randomUUID();
    const iTok = intaker(intakerSub);

    // A brief arrives (as the channel does it) and the human intaker refines it.
    const created = await ok(
      rpc("create_task", {
        token: iTok,
        body: {
          lane_key: LANE,
          payload: { request: "v8 bridge fixture — decompose me", submitted_via: "test" },
        },
      }),
    );
    const briefId = created.task.id as string;
    await ok(rpc("claim_next_task", { token: iTok, body: { lane_key: LANE } }));
    await ok(rpc("advance_task", { token: iTok, body: { task_id: briefId, to_stage: "briefed" } }));

    // The standing designer takes it from there — one identity, one held claim.
    const dSub = randomUUID();
    const dTok = standingDesigner(dSub);
    const claimed = await ok(rpc("claim_next_task", { token: dTok, body: { lane_key: LANE } }));
    expect(claimed.task.id).toBe(briefId);
    expect(claimed.task.stage_key).toBe("briefed");

    // …creating dev work WHILE holding the brief. One-active-task-per-instance bounds
    // CLAIMS, not creates — this is what lets "create, then accept" be one sweep.
    const childIds: string[] = [];
    for (let i = 1; i <= 2; i++) {
      const child = await ok(
        rpc("create_task", {
          token: dTok,
          body: {
            lane_key: "dev",
            payload: {
              goal: `v8 bridge child #${i}`,
              instructions: "noop",
              validate: "true",
              brief_id: briefId,
            },
          },
        }),
      );
      childIds.push(child.task.id as string);
      expect(child.task.stage_key).toBe("proposed");
    }
    expect(new Set(childIds).size).toBe(2);

    // …and only then accepting: the brief reaches its terminal stage.
    const accepted = await ok(
      rpc("advance_task", { token: dTok, body: { task_id: briefId, to_stage: "accepted" } }),
    );
    expect(accepted.task.stage_key).toBe("accepted");
  });

  it("cannot refine a raw brief: proposed_brief is invisible to a designer's claim", async () => {
    const iTok = intaker();
    const raw = await ok(
      rpc("create_task", {
        token: iTok,
        body: {
          lane_key: LANE,
          payload: { request: "v8 bridge — must stay with the human" },
        },
      }),
    );
    const rawId = raw.task.id as string;

    // A designer claim skips it — no outbound transition from proposed_brief that the
    // designer's features satisfy (proposed_brief→briefed needs role:intaker, M24 D2).
    const claim = await json(
      await rpc("claim_next_task", { token: standingDesigner(), body: { lane_key: LANE } }),
    );
    // Nothing else on this lane is designer-claimable, so the claim comes back empty —
    // the raw brief is simply not eligible work for a designer.
    expect(claim.code === "empty" || claim.task.id !== rawId).toBe(true);

    // …and forcing the transition is refused outright.
    const forced = await json(
      await rpc("advance_task", {
        token: standingDesigner(),
        body: { task_id: rawId, to_stage: "briefed" },
      }),
    );
    expect(forced.ok).toBe(false);
    // Refused for want of the claim/feature — never a silent success.
    expect(["lease_lost", "not_eligible", "illegal_transition"]).toContain(forced.code);
  });

  it("keeps M24's two-tier gate in both directions", async () => {
    // The intaker cannot create dev work…
    const onDev = await json(
      await rpc("create_task", {
        token: intaker(),
        body: { lane_key: "dev", payload: { goal: "v8 bridge — should never exist" } },
      }),
    );
    expect(onDev.ok).toBe(false);
    expect(onDev.code).toBe("not_eligible");

    // …and the designer cannot open a brief (D4: create needs the lane's STARTER role,
    // which on an intake workflow is role:intaker). Granting the designer a lane:intake
    // did not make it an intaker.
    const onIntake = await json(
      await rpc("create_task", {
        token: standingDesigner(),
        body: { lane_key: LANE, payload: { request: "v8 bridge — designer must not open briefs" } },
      }),
    );
    expect(onIntake.ok).toBe(false);
    expect(onIntake.code).toBe("not_eligible");
  });
});
