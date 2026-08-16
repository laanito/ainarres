import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { exec, query, waitForDb } from "./helpers/db";
import { rpc, waitForReady } from "./helpers/http";
import { mintToken } from "./helpers/mint";

// M24 Slice A (v6 — seat the bookends; design/intake.md · ADR 0023) — the intaker &
// two-tier creation. The headline: two-tier creation needs NO create_task change — it
// falls out of the existing, unmodified D4 create-gate (a caller may create in a lane
// only if it holds the role that advances OUT of that lane's initial stage). We seed a
// second `intake` lane whose starter is role:intaker; the same gate then keeps the
// intaker out of dev and the designer out of intake.
//
// The tests are sharp about WHY a create is refused: each actor is a member of BOTH
// lanes and differs only by role, so a refusal is the STARTER-ROLE gate (D4), not mere
// lane membership. Families exist only so ensure_agent resolves them; the authoritative
// features are the token's (ADR 0007), overridden per actor here.

const INTAKER = "m24-intaker";
const DESIGNER = "m24-designer";
const BOTH = "m24-both";

const FIXTURE = `
  insert into app.agent_families (key) values ('${INTAKER}'),('${DESIGNER}'),('${BOTH}')
  on conflict (key) do nothing;
`;

const json = (r: Response) => r.json() as Promise<any>;

// Member of both lanes; role differs. So a create refusal is D4 (missing starter role),
// not a lane-membership failure — the distinction the design turns on.
const intaker = (sub = randomUUID()) =>
  mintToken(INTAKER, "agent", { sub, features: ["lane:intake", "lane:dev", "role:intaker"] });
const designer = (sub = randomUUID()) =>
  mintToken(DESIGNER, "agent", { sub, features: ["lane:intake", "lane:dev", "role:designer"] });
const both = (sub = randomUUID()) =>
  mintToken(BOTH, "agent", { sub, features: ["lane:intake", "lane:dev", "role:intaker", "role:designer"] });

const create = (token: string, lane_key: string) =>
  rpc("create_task", { token, body: { lane_key, payload: { goal: "m24 brief" } } }).then(json);

beforeAll(async () => {
  waitForDb();
  const res = exec(FIXTURE);
  if (!res.ok) throw new Error(`fixture failed: ${res.error}`);
  await waitForReady();
});

describe("M24 the intaker — two-tier creation via the unmodified D4 gate", () => {
  it("seeds the ainarres-intake workflow: proposed_brief (initial) → briefed → accepted (terminal), two role-gated advances", () => {
    const stages = query<{ key: string; is_initial: boolean; is_terminal: boolean; ordering: number }>(`
      select s.key, s.is_initial, s.is_terminal, s.ordering
      from app.stages s join app.workflows w on w.id = s.workflow_id
      where w.key = 'ainarres-intake' order by s.ordering
    `);
    expect(stages.map((s) => s.key)).toEqual(["proposed_brief", "briefed", "accepted"]);
    expect(stages.filter((s) => s.is_initial).map((s) => s.key)).toEqual(["proposed_brief"]);
    expect(stages.filter((s) => s.is_terminal).map((s) => s.key)).toEqual(["accepted"]);

    const trs = query<{ from_key: string; to_key: string; req: string }>(`
      select sf.key as from_key, st.key as to_key, array_to_string(t.required_features, ',') as req
      from app.transitions t
      join app.workflows w on w.id = t.workflow_id
      join app.stages sf on sf.id = t.from_stage
      join app.stages st on st.id = t.to_stage
      where w.key = 'ainarres-intake' and t.kind = 'advance'
      order by sf.ordering
    `);
    expect(trs).toEqual([
      { from_key: "proposed_brief", to_key: "briefed", req: "role:intaker" },
      { from_key: "briefed", to_key: "accepted", req: "role:designer" },
    ]);
    // No reject/rework transitions in v1 (D2).
    const rejects = query<{ n: number }>(`
      select count(*)::int as n from app.transitions t
      join app.workflows w on w.id = t.workflow_id
      where w.key = 'ainarres-intake' and t.kind = 'reject'
    `)[0].n;
    expect(rejects).toBe(0);
  });

  it("role:intaker creates in intake, but is refused in dev — the missing STARTER role, not the lane", async () => {
    const tok = intaker();
    const inIntake = await create(tok, "intake");
    expect(inIntake.ok, JSON.stringify(inIntake)).toBe(true);
    expect(inIntake.task.stage_key).toBe("proposed_brief");

    const inDev = await create(tok, "dev");
    expect(inDev.ok).toBe(false);
    expect(inDev.code).toBe("not_eligible");
    // It holds lane:dev — so the refusal is the D4 starter gate (needs role:designer).
    expect(inDev.reason).toMatch(/starter role/);
  });

  it("role:designer creates in dev, but is refused in intake — again the STARTER role, not the lane", async () => {
    const tok = designer();
    const inDev = await create(tok, "dev");
    expect(inDev.ok, JSON.stringify(inDev)).toBe(true);
    expect(inDev.task.stage_key).toBe("proposed");

    const inIntake = await create(tok, "intake");
    expect(inIntake.ok).toBe(false);
    expect(inIntake.code).toBe("not_eligible");
    expect(inIntake.reason).toMatch(/starter role/);
  });

  it("a family holding BOTH roles creates in both lanes (the owner-wears-both-hats case, D6)", async () => {
    const tok = both();
    expect((await create(tok, "intake")).ok).toBe(true);
    expect((await create(tok, "dev")).ok).toBe(true);
  });

  it("a brief walks proposed_brief →[intaker] briefed →[designer] accepted — the two-tier handoff", async () => {
    // Intaker starts and refines the brief.
    const iTok = intaker();
    const created = await create(iTok, "intake");
    expect(created.ok).toBe(true);
    const claim = await json(await rpc("claim_next_task", { token: iTok, body: { lane_key: "intake" } }));
    expect(claim.code).toBe("ok");
    expect(claim.task.stage_key).toBe("proposed_brief");
    const briefed = await json(
      await rpc("advance_task", { token: iTok, body: { task_id: claim.task.id, to_stage: "briefed" } }),
    );
    expect(briefed.code).toBe("ok");
    expect(briefed.task.stage_key).toBe("briefed");

    // The designer accepts the ready brief for decomposition. Only briefed tasks are
    // claimable by the designer (it cannot advance proposed_brief — that needs intaker),
    // so this claim deterministically lands on the brief just handed off.
    const dTok = designer();
    const dClaim = await json(await rpc("claim_next_task", { token: dTok, body: { lane_key: "intake" } }));
    expect(dClaim.code).toBe("ok");
    expect(dClaim.task.id).toBe(briefed.task.id);
    const accepted = await json(
      await rpc("advance_task", { token: dTok, body: { task_id: dClaim.task.id, to_stage: "accepted" } }),
    );
    expect(accepted.code).toBe("ok");
    expect(accepted.task.stage_key).toBe("accepted");
  });
});
