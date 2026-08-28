import { beforeAll, describe, expect, it } from "vitest";
import { exec, query, waitForDb } from "./helpers/db";
import { restGet, rpc, waitForReady } from "./helpers/http";
import { familyTokenFeatures, mintToken } from "./helpers/mint";

// v8 step 2 (ADR 0028 — the agent operator seat): the SEAT IDENTITY and its LEDGER.
//
// Two things are under test. First, that `agent+operator` is a real, registered family
// holding exactly the features the seat needs and none of the ones ADR 0028 reserves —
// the prohibitions are asserted here, not merely written down in the seed comment.
// Second, that api.record_operator_action is gated on role:operator, writes the TOKEN'S
// family (never a parameter), and lands in an append-only ledger readable by oversight
// and by a delegated `monitor`.
//
// DB test (validated ASSISTED — a seed + grants + a security-definer verb have no
// substrate-free self-check in a worktree; the board-wipe lesson).

const SEAT = "agent+operator";
const IMPOSTOR = "v8-operator-impostor";

const FIXTURE = `
  insert into app.agent_families (key) values ('${IMPOSTOR}')
  on conflict (key) do nothing;
`;

// A seat token carrying the family's PROVISIONED snapshot (the real thing).
const seatToken = () => mintToken(SEAT, "agent");
// A REGISTERED family that was never provisioned role:operator, minting honestly.
const workerToken = () => mintToken(IMPOSTOR, "agent", { features: ["lane:dev", "role:implementer"] });
// An UNREGISTERED family. ADR 0007: a valid signature is not enough — the substrate
// refuses a family it has no row for, whatever the token claims.
const unknownFamilyToken = () =>
  mintToken("v8-operator-never-seated", "agent", { features: ["role:operator"] });

beforeAll(async () => {
  waitForDb();
  exec(FIXTURE);
  await waitForReady();
});

describe("the seat is a registered family with a bounded feature set", () => {
  it("is registered (an unregistered family is not_eligible for every verb, ADR 0007)", () => {
    const rows = query<{ key: string }>(
      `select key from app.agent_families where key = '${SEAT}'`,
    );
    expect(rows.map((r) => r.key)).toEqual([SEAT]);
  });

  it("holds exactly the five features the operator job needs", () => {
    // lane:intake + role:intaker → work the intake middle without impersonating the
    // channel's human caller. lane:dev + role:designer → the M24 D4 create-gate's
    // minimum for creating dev work. role:operator → the seat marker (ledger writes).
    expect(familyTokenFeatures(SEAT)).toEqual([
      "lane:dev",
      "lane:intake",
      "role:designer",
      "role:intaker",
      "role:operator",
    ]);
  });

  it("can never merge: it does not hold capability:integrate", () => {
    // The single independent grok integrator stays the only family that can merge
    // (ADR 0015/0017, M19 D1/D5). An operator seat that could merge would be the
    // orchestrator this substrate exists to avoid.
    expect(familyTokenFeatures(SEAT)).not.toContain("capability:integrate");
  });

  it("is not the auditor: it does not hold role:auditor", () => {
    // ADR 0028: the operator seat and the auditor seat must be DISTINCT identities and
    // the auditor stays human. An operator that could raise flags against its own work
    // closes the oversight loop on itself.
    expect(familyTokenFeatures(SEAT)).not.toContain("role:auditor");
  });

  it("is not a worker: no role:implementer, role:reviewer, or tier:2", () => {
    const features = familyTokenFeatures(SEAT);
    expect(features).not.toContain("role:implementer");
    expect(features).not.toContain("role:reviewer");
    expect(features).not.toContain("tier:2");
  });
});

describe("api.record_operator_action — the seat's own ledger line", () => {
  it("records under the TOKEN'S family, not a parameter", async () => {
    const action = `probe_${Date.now().toString(36)}`;
    const res = await rpc("record_operator_action", {
      token: seatToken(),
      body: { p_action: action, p_target: "the-standing-service", p_detail: { note: "probe" } },
    });
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.event.action).toBe(action);

    // The family is resolved from the JWT inside the verb; there is no p_family to pass.
    const rows = query<{ family: string; outcome: string }>(`
      select af.key as family, oa.outcome
      from app.operator_actions oa
      join app.agent_families af on af.id = oa.family_id
      where oa.action = '${action}'
    `);
    expect(rows).toEqual([{ family: SEAT, outcome: "ok" }]);
  });

  it("refuses a caller without role:operator", async () => {
    const res = await rpc("record_operator_action", {
      token: workerToken(),
      body: { p_action: "forged_line", p_target: "someone else's ledger" },
    });
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe("not_eligible");
    expect(body.reason).toContain("role:operator");
  });

  it("refuses an UNREGISTERED family even when the token claims role:operator", async () => {
    // The honest statement of this gate: api.effective_features() reads the SIGNED
    // token and subtracts denials — it does not re-check app.family_features, because
    // ADR 0007 puts provisioning at MINT time and has the substrate trust the token.
    // What the substrate still refuses is a family it has never heard of.
    const res = await rpc("record_operator_action", {
      token: unknownFamilyToken(),
      body: { p_action: "ghost_seat" },
    });
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe("not_eligible");
    expect(body.reason).toContain("unknown family");
  });

  it("stops writing the moment governance denies role:operator (M21 reaches the seat)", async () => {
    // v8 success gate 5: the seat is governed like any other family. A denial on
    // role:operator is subtracted by effective_features on the very next read, so a
    // revoked operator cannot keep filing its own ledger lines. Denial inserted and
    // removed directly — this is the mechanism's test, not the ban path's.
    const denied = "v8-operator-denied";
    exec(`
      insert into app.agent_families (key) values ('${denied}') on conflict (key) do nothing;
      insert into app.feature_denials (family_id, feature_id, reason)
      select f.id, ft.id, 'operator-seat test'
      from app.agent_families f, app.features ft
      where f.key = '${denied}' and ft.name = 'role:operator'
      on conflict do nothing;
    `);
    const res = await rpc("record_operator_action", {
      token: mintToken(denied, "agent", { features: ["role:operator"] }),
      body: { p_action: "after_denial" },
    });
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe("not_eligible");
    expect(body.reason).toContain("role:operator");
  });

  it("records a REFUSED or FAILED act as the operator's own", async () => {
    // The point of `outcome`: an operator's misses have to be visible AS the
    // operator's, or governance can never reach the seat (v8 success gate 5).
    const action = `miss_${Date.now().toString(36)}`;
    const res = await rpc("record_operator_action", {
      token: seatToken(),
      body: { p_action: action, p_outcome: "refused", p_reason: "advance to briefed was refused" },
    });
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.event.outcome).toBe("refused");
  });

  it("rejects a malformed action slug and an unknown outcome", async () => {
    const bad = await rpc("record_operator_action", {
      token: seatToken(),
      body: { p_action: "Not A Slug" },
    });
    const badBody = await bad.json();
    expect(badBody.ok).toBe(false);
    expect(badBody.code).toBe("invalid");

    const wrong = await rpc("record_operator_action", {
      token: seatToken(),
      body: { p_action: "fine_slug", p_outcome: "maybe" },
    });
    const wrongBody = await wrong.json();
    expect(wrongBody.ok).toBe(false);
    expect(wrongBody.code).toBe("invalid");
  });

  it("rejects a task_id that does not exist", async () => {
    const res = await rpc("record_operator_action", {
      token: seatToken(),
      body: { p_action: "ghost_task", p_task: "00000000-0000-0000-0000-000000000000" },
    });
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe("not_found");
  });
});

describe("the ledger is append-only and readable by oversight and monitor", () => {
  it("refuses UPDATE and DELETE at the trigger", () => {
    // Belt (trigger) and suspenders (revoked grants) — the app.governance_actions shape.
    const upd = exec("update app.operator_actions set action = 'rewritten'");
    expect(upd.ok).toBe(false);
    expect(upd.error).toMatch(/append-only/i);

    const del = exec("delete from app.operator_actions");
    expect(del.ok).toBe(false);
    expect(del.error).toMatch(/append-only/i);
  });

  it("api.operator_actions answers an oversight token", async () => {
    const res = await restGet("operator_actions?limit=5", { token: mintToken(SEAT, "oversight", { features: [] }) });
    expect(res.status).toBe(200);
    const rows = await res.json();
    expect(Array.isArray(rows)).toBe(true);
  });

  it("api.operator_actions answers a delegated monitor token", async () => {
    // The whole job of a delegated monitor (v8 step 0) is reading what happened. A
    // ledger it cannot read would make the seat unattributable to the very role that
    // exists to watch it.
    const res = await restGet("operator_actions?limit=5", { token: mintToken(SEAT, "monitor", { features: [] }) });
    expect(res.status).toBe(200);
    const rows = await res.json();
    expect(Array.isArray(rows)).toBe(true);
  });

  it("names the acting family and is newest-first", async () => {
    const res = await restGet("operator_actions?limit=3", { token: mintToken(SEAT, "oversight", { features: [] }) });
    const rows = (await res.json()) as Array<{ family: string; created_at: string }>;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(typeof r.family).toBe("string");
    const times = rows.map((r) => Date.parse(r.created_at));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });
});

describe("the seat cannot reach the human's levers", () => {
  it("cannot call api.set_permanent_ban (oversight-only EXECUTE, M22 D4)", async () => {
    const res = await rpc("set_permanent_ban", {
      token: seatToken(),
      body: { p_family: IMPOSTOR, p_capability: "role:implementer", p_reason: "should never land" },
    });
    // PostgREST refuses at the grant boundary, before the function body runs.
    expect([401, 403, 404]).toContain(res.status);
  });

  it("cannot call api.lift_ban either", async () => {
    const res = await rpc("lift_ban", {
      token: seatToken(),
      body: { p_family: IMPOSTOR, p_capability: "role:implementer" },
    });
    expect([401, 403, 404]).toContain(res.status);
  });

  it("cannot raise an audit flag (role:auditor gate, in-verb)", async () => {
    const res = await rpc("raise_audit_flag", {
      token: seatToken(),
      body: {
        p_task: "00000000-0000-0000-0000-000000000000",
        p_subject_family: IMPOSTOR,
        p_capability: "role:implementer",
        p_gap: "an operator judging its own work",
      },
    });
    if (res.status === 200) {
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.code).toBe("not_eligible");
    } else {
      expect([401, 403, 404]).toContain(res.status);
    }
  });
});
