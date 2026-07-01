import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { exec, query, waitForDb } from "./helpers/db";
import { rpc, waitForReady } from "./helpers/http";
import { mintToken } from "./helpers/mint";

// M9: the seeded AINARRES development workflow (ADR 0016). Asserts the stage shape
// and that every transition admits exactly the intended role/capability features,
// then spot-checks the gating through the verbs. This is the workflow AINARRES's
// own development runs on (ADR 0013).

const FAMILY = "claude-code+opus"; // exists; used for synthetic explicit-feature tokens

const json = (r: Response) => r.json();
const tok = (features: string[], sub = randomUUID()) => mintToken(FAMILY, "agent", { sub, features });

function parkDev() {
  const r = exec("update app.tasks set blocked = true where lane_id = (select id from app.lanes where key = 'dev') and not blocked");
  if (!r.ok) throw new Error(`parkDev failed: ${r.error}`);
}

beforeAll(async () => {
  waitForDb();
  await waitForReady();
});

describe("ainarres-dev workflow shape", () => {
  it("has the seven stages with a single initial and single terminal", () => {
    const stages = query<{ key: string; is_initial: boolean; is_terminal: boolean }>(`
      select s.key, s.is_initial, s.is_terminal
      from app.stages s join app.workflows w on w.id = s.workflow_id
      where w.key = 'ainarres-dev' order by s.ordering`);
    expect(stages.map((s) => s.key)).toEqual([
      "proposed", "designing", "implementing", "reviewing", "integrating", "validating", "done",
    ]);
    expect(stages.filter((s) => s.is_initial).map((s) => s.key)).toEqual(["proposed"]);
    expect(stages.filter((s) => s.is_terminal).map((s) => s.key)).toEqual(["done"]);
  });

  it("gates every transition by exactly the intended features (ADR 0016)", () => {
    const rows = query<{ from: string; to: string; kind: string; required_features: string[] }>(`
      select sf.key as from, st.key as to, t.kind, t.required_features
      from app.transitions t
      join app.workflows w on w.id = t.workflow_id
      join app.stages sf on sf.id = t.from_stage
      join app.stages st on st.id = t.to_stage
      where w.key = 'ainarres-dev'`);

    const got = Object.fromEntries(
      rows.map((r) => [`${r.kind}:${r.from}->${r.to}`, [...r.required_features].sort()]),
    );
    expect(got).toEqual({
      "advance:proposed->designing": ["role:designer"],
      "advance:designing->implementing": ["role:designer"],
      "advance:implementing->reviewing": ["role:implementer"],
      "advance:reviewing->integrating": ["role:reviewer"],
      "advance:integrating->validating": ["capability:integrate", "role:integrator"],
      "advance:validating->done": ["role:reviewer"],
      "reject:reviewing->implementing": ["role:reviewer"],
      "reject:validating->implementing": ["role:reviewer"],
      "reject:integrating->implementing": ["capability:integrate", "role:integrator"],
    });
  });
});

describe("ainarres-dev gating through the verbs", () => {
  it("won't hand a proposed task to a non-designer", async () => {
    parkDev();
    const designer = tok(["lane:dev", "role:designer"]);
    await json(await rpc("create_task", { token: designer, body: { lane_key: "dev", payload: { goal: "x" } } }));

    // An implementer (no role:designer) finds nothing: the only outbound transition
    // from `proposed` needs role:designer.
    const impl = await json(await rpc("claim_next_task", { token: tok(["lane:dev", "role:implementer"]), body: { lane_key: "dev" } }));
    expect(impl.code).toBe("empty");
  });

  it("won't let a non-designer CREATE a dev task (M19 D4: create-vs-advance)", async () => {
    // Creating a task is a starter act — it lands at `proposed`, whose only outbound
    // advance needs role:designer. A cheap implementer (lane member, but no
    // role:designer) must be refused, so it can't freelance-create work off-script.
    const impl = await json(await rpc("create_task", {
      token: tok(["lane:dev", "role:implementer"]),
      body: { lane_key: "dev", payload: { goal: "freelance" } },
    }));
    expect(impl.ok).toBe(false);
    expect(impl.code).toBe("not_eligible");

    // A designer (holds the starter role) still creates fine.
    const ok = await json(await rpc("create_task", {
      token: tok(["lane:dev", "role:designer"]),
      body: { lane_key: "dev", payload: { goal: "legit" } },
    }));
    expect(ok.ok).toBe(true);
  });

  it("lets a designer advance proposed→designing, and refuses a non-designer that step", async () => {
    parkDev();
    const designer = tok(["lane:dev", "role:designer"]);
    const created = await json(await rpc("create_task", { token: designer, body: { lane_key: "dev" } }));

    const claimed = await json(await rpc("claim_next_task", { token: designer, body: { lane_key: "dev" } }));
    expect(claimed.task.id).toBe(created.task.id);
    const adv = await json(await rpc("advance_task", { token: designer, body: { task_id: created.task.id, to_stage: "designing" } }));
    expect(adv.code).toBe("ok");
    expect(adv.task.stage_key).toBe("designing");

    // Re-claim at `designing` as one instance, then attempt the next step with that
    // same instance stripped to role:implementer → not_eligible (designing→implementing
    // needs role:designer).
    const sub = randomUUID();
    const reclaim = await json(await rpc("claim_next_task", { token: tok(["lane:dev", "role:designer"], sub), body: { lane_key: "dev" } }));
    expect(reclaim.task.id).toBe(created.task.id);
    const refused = await json(await rpc("advance_task", { token: tok(["lane:dev", "role:implementer"], sub), body: { task_id: created.task.id, to_stage: "implementing" } }));
    expect(refused.ok).toBe(false);
    expect(refused.code).toBe("not_eligible");
  });
});
