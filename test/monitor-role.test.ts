import { beforeAll, describe, expect, it } from "vitest";
import { exec, query, waitForDb } from "./helpers/db";
import { restGet, rpc, waitForReady } from "./helpers/http";
import { mintToken } from "./helpers/mint";

// v8 step 0 (ADR 0028 — the agent operator seat): the READ-ONLY `monitor` coarse
// role. A delegated monitor must read everything oversight reads and CALL nothing —
// most pointedly not api.set_permanent_ban / api.lift_ban, the human-only route to a
// permanent denial (M22 D4). These tests are the boundary's done-test: the refusals
// are asserted, not assumed. DB test (validated ASSISTED — grants have no
// substrate-free self-check in a worktree).

const FAM = "v8-monitor-fixture";
const SUBJ = "v8-monitor-subject";

const FIXTURE = `
  insert into app.agent_families (key) values ('${FAM}'),('${SUBJ}')
  on conflict (key) do nothing;
`;

const monitorToken = () => mintToken(FAM, "monitor", { features: [] });
const oversightToken = () => mintToken(FAM, "oversight", { features: [] });

beforeAll(async () => {
  waitForDb();
  exec(FIXTURE);
  await waitForReady();
});

describe("the monitor role exists and is reachable (ADR 0007 coarse-role model)", () => {
  it("exists, nologin", () => {
    const rows = query<{ rolname: string; rolcanlogin: boolean }>(
      "select rolname, rolcanlogin from pg_roles where rolname = 'monitor'",
    );
    expect(rows).toEqual([{ rolname: "monitor", rolcanlogin: false }]);
  });

  it("authenticator can SET ROLE to it", () => {
    const rows = query<{ member: string }>(`
      select r.rolname as member
      from pg_auth_members m
      join pg_roles r on r.oid = m.roleid
      join pg_roles a on a.oid = m.member
      where a.rolname = 'authenticator' and r.rolname = 'monitor'
    `);
    expect(rows.map((r) => r.member)).toEqual(["monitor"]);
  });

  it("holds EXECUTE on no api function but the health probe", () => {
    // api.ping only, inherited from the PUBLIC default the M0 bootstrap left on it
    // (granted to anon, never revoked from public). It returns a constant and is the
    // liveness probe a monitor wants. Every OTHER api function is revoked from public
    // in its own migration, so "never granted EXECUTE" is a boundary, not a hope —
    // and this assertion is what would catch a future function that forgets to revoke.
    const rows = query<{ name: string }>(`
      select p.proname as name
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'api'
        and has_function_privilege('monitor', p.oid, 'EXECUTE')
      order by 1
    `);
    expect(rows.map((r) => r.name)).toEqual(["ping"]);
  });

  it("holds EXECUTE on exactly one app function: the read-only policy resolver", () => {
    // api.governance_status / api.audit_flags join app.resolve_governance_policy, so a
    // monitor needs it to read them at all. It is `language sql stable` over
    // app.governance_policy. The others below are trigger functions, unreachable over
    // HTTP (PGRST_DB_SCHEMAS=api) and inert when called directly.
    const rows = query<{ name: string }>(`
      select p.proname as name
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'app'
        and has_function_privilege('monitor', p.oid, 'EXECUTE')
        and p.prorettype <> 'trigger'::regtype
      order by 1
    `);
    expect(rows.map((r) => r.name)).toEqual(["resolve_governance_policy"]);
  });
});

describe("a monitor token READS the oversight surface", () => {
  it("reads the board and the governance/track-record/intake views", async () => {
    const token = monitorToken();
    for (const view of [
      "board",
      "abandoned",
      "feed",
      "timeline",
      "governance_status",
      "governance_actions",
      "audit_flags",
      "family_track_record",
      "spend_anomalies",
      "operational_flags",
      "open_briefs",
    ]) {
      const res = await restGet(`${view}?limit=1`, { token });
      expect(res.status, `GET /${view} as monitor`).toBe(200);
    }
  });
});

describe("a monitor token CANNOT govern (the human boundary, ADR 0028)", () => {
  it("is refused set_permanent_ban — the human-only permanent denial (M22 D4)", async () => {
    const res = await rpc("set_permanent_ban", {
      token: monitorToken(),
      body: { p_family: SUBJ, p_capability: "role:implementer", p_reason: "should never apply" },
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(403);
    // …and nothing was written: no denial for the subject family.
    const denials = query<{ n: number }>(`
      select count(*)::int as n
      from app.feature_denials d
      join app.agent_families f on f.id = d.family_id
      where f.key = '${SUBJ}'
    `);
    expect(denials[0].n).toBe(0);
  });

  it("is refused lift_ban", async () => {
    const res = await rpc("lift_ban", {
      token: monitorToken(),
      body: { p_family: SUBJ, p_capability: "role:implementer", p_reason: "nope" },
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(403);
  });

  it("is refused record_usage (the driver's write, M20)", async () => {
    const res = await rpc("record_usage", {
      token: monitorToken(),
      body: { p_actor: "00000000-0000-0000-0000-000000000000", p_usage: {} },
    });
    expect(res.ok).toBe(false);
  });
});

describe("a monitor token CANNOT do agent work either", () => {
  it("is refused claim_next_task and create_task", async () => {
    const token = monitorToken();
    const claim = await rpc("claim_next_task", { token, body: { lane_key: "dev" } });
    expect(claim.ok).toBe(false);
    expect(claim.status).toBe(403);
    const create = await rpc("create_task", { token, body: { lane_key: "dev", payload: {} } });
    expect(create.ok).toBe(false);
    expect(create.status).toBe(403);
  });

  it("is refused the flag verbs (which oversight may call)", async () => {
    const res = await rpc("raise_operational_flag", {
      token: monitorToken(),
      body: {
        p_subject_family: SUBJ,
        p_capability: "role:implementer",
        p_kind: "spend",
        p_detail: "should never land",
      },
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(403);
  });
});

describe("the boundary is the ROLE, not the token's features", () => {
  // The same family, the same (empty) features — only the role claim differs. This is
  // what makes the delegation bounded: a monitor cannot widen itself by asking for
  // features, because the powers it lacks are gated by the Postgres role.
  it("oversight reaches set_permanent_ban's function body where monitor is refused at the door", async () => {
    const asOversight = await rpc("set_permanent_ban", {
      token: oversightToken(),
      body: { p_family: "no-such-family-v8-monitor-test", p_capability: "role:implementer" },
    });
    // Reached the body: it answers with the verb's own envelope (a refusal about the
    // unknown family), not a 403 from the grant layer.
    expect(asOversight.status).toBe(200);
    const body = (await asOversight.json()) as any;
    expect(body.ok).toBe(false);

    const asMonitor = await rpc("set_permanent_ban", {
      token: monitorToken(),
      body: { p_family: "no-such-family-v8-monitor-test", p_capability: "role:implementer" },
    });
    expect(asMonitor.status).toBe(403);
  });
});
