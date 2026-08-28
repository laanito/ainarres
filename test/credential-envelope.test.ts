import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exec, query, waitForDb } from "./helpers/db";
import { restGet, rpc, waitForReady } from "./helpers/http";
import { mintToken } from "./helpers/mint";

// v8 step 3 (ADR 0028) — THE CREDENTIAL ENVELOPE. Step 2 left the seat named and ledgered
// but NOT bounded: api.effective_features() trusts the signed token, so the seat's
// prohibitions held only because the CLI chose not to ask for them.
//
// api.issue_operator_credential is where the asking now happens, and the DATABASE answers:
// role ∈ {agent, monitor}, the family must hold role:operator, features are the provisioned
// snapshot whole and unedited, TTL is capped, and the issuance is recorded in the same
// statement. The broker only signs what it is handed.
//
// The refusals below are the boundary's done-test. What they do NOT claim is prevention:
// on one host a shell-capable seat can read the secret and self-mint, which is why
// api.unbrokered_operator_acts exists and is tested here too — the owner chose an AUDITED
// boundary, so the audit has to actually work.
//
// DB + real broker process (validated ASSISTED — auth has no substrate-free self-check).

const SEAT = "agent+operator";
const NOT_SEAT = `v8-env-notseat-${randomUUID().slice(0, 8)}`;
// Fixed loopback test port, distinct from intake-cli.test.ts's 3098 and
// intake-channel.test.ts's 3099 — these files run in parallel, and a collision makes each
// server answer the other's requests (which is how this comment came to exist).
const PORT = 3097;
const PSK = "test-broker-preshared-key-0123456789";
// The broker persists whatever key it uses; point it at a temp file so a suite run never
// overwrites the operator's real loop/run/broker.psk (the lesson from the intake channel).
const KEY_FILE = join(mkdtempSync(join(tmpdir(), "ainarres-broker-")), "broker.psk");
const base = `http://127.0.0.1:${PORT}`;

let server: ChildProcess;

const FIXTURE = `
  insert into app.agent_families (key) values ('${NOT_SEAT}') on conflict (key) do nothing;
  insert into app.family_features (family_id, feature_id)
  select f.id, ft.id from app.agent_families f
  join app.features ft on ft.name = any (array['lane:dev', 'role:implementer'])
  where f.key = '${NOT_SEAT}' on conflict do nothing;
`;

const reaper = () => mintToken("loop+driver", "reaper", { features: [] });
const oversight = () => mintToken(SEAT, "oversight", { features: [] });
const monitor = () => mintToken(SEAT, "monitor", { features: [] });

const issue = (body: Record<string, unknown>) => rpc("issue_operator_credential", { token: reaper(), body });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const post = async (body: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(`${base}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) as any };
};

beforeAll(async () => {
  waitForDb();
  const res = exec(FIXTURE);
  if (!res.ok) throw new Error(`fixture failed: ${res.error}`);
  await waitForReady();

  server = spawn("node", ["bin/credential-broker.mjs"], {
    env: {
      ...process.env,
      BROKER_PSK: PSK,
      BROKER_PSK_FILE: KEY_FILE,
      BROKER_PORT: String(PORT),
      BROKER_HOST: "127.0.0.1",
    },
    stdio: "ignore",
  });
  const deadline = Date.now() + 10_000;
  for (;;) {
    try { await post({}); break; } catch {
      if (Date.now() >= deadline) throw new Error("credential-broker did not start listening within 10s");
      await sleep(200);
    }
  }
}, 20_000);

afterAll(() => { server?.kill("SIGTERM"); });

describe("the envelope decides what may be in a token", () => {
  it("issues the seat's PROVISIONED features — not what the caller asked for", async () => {
    const body = await (await issue({ family_key: SEAT })).json();
    expect(body.ok).toBe(true);
    expect(body.event.family).toBe(SEAT);
    expect(body.event.role).toBe("agent");
    // There is no parameter to request features with. This is the seed's grant, verbatim.
    expect(body.event.features).toEqual([
      "lane:dev", "lane:intake", "role:designer", "role:intaker", "role:operator",
    ]);
    expect(body.event.features).not.toContain("capability:integrate");
    expect(body.event.features).not.toContain("role:auditor");
  });

  it("refuses `oversight` — that role carries the human's irreversible levers", async () => {
    // set_permanent_ban / lift_ban are oversight-only EXECUTE (M22 D4). An envelope that
    // could issue oversight would hand the seat exactly what v5 reserved for a human.
    const body = await (await issue({ family_key: SEAT, assume_role: "oversight" })).json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe("not_eligible");
    expect(body.reason).toContain("outside the operator envelope");
  });

  it("refuses `reaper` — issuing one would hand over the envelope's own key", async () => {
    const body = await (await issue({ family_key: SEAT, assume_role: "reaper" })).json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe("not_eligible");
  });

  it("allows `monitor` — the least dangerous thing the seat does must go through it too", async () => {
    const body = await (await issue({ family_key: SEAT, assume_role: "monitor" })).json();
    expect(body.ok).toBe(true);
    expect(body.event.role).toBe("monitor");
  });

  it("refuses a family that is not an operator seat", async () => {
    // Data-driven: the seat is whoever the OWNER provisioned role:operator to. A worker
    // family cannot obtain a credential however it asks.
    const body = await (await issue({ family_key: NOT_SEAT })).json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe("not_eligible");
    expect(body.reason).toContain("not an operator seat");
  });

  it("refuses an unknown family", async () => {
    const body = await (await issue({ family_key: "no-such-family" })).json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe("not_eligible");
  });

  it("caps the TTL — a long-lived credential is a key with extra steps", async () => {
    const body = await (await issue({ family_key: SEAT, ttl_seconds: 999_999 })).json();
    expect(body.ok).toBe(true);
    expect(body.event.exp - body.event.iat).toBe(900);
    const floor = await (await issue({ family_key: SEAT, ttl_seconds: 1 })).json();
    expect(floor.event.exp - floor.event.iat).toBe(30);
  });

  it("records every issuance in the same statement — there is no mint without a trail", async () => {
    const reason = `probe-${randomUUID().slice(0, 8)}`;
    const body = await (await issue({ family_key: SEAT, requested_by: reason })).json();
    const rows = query<{ sub: string; role: string; requested_by: string }>(`
      select sub::text, assume_role as role, requested_by
      from app.operator_credentials where requested_by = '${reason}'`);
    expect(rows).toHaveLength(1);
    expect(rows[0].sub).toBe(body.event.sub);
  });

  it("writes nothing when it refuses", async () => {
    const before = query<{ n: string }>("select count(*)::text n from app.operator_credentials")[0].n;
    await issue({ family_key: SEAT, assume_role: "oversight" });
    await issue({ family_key: NOT_SEAT });
    expect(query<{ n: string }>("select count(*)::text n from app.operator_credentials")[0].n).toBe(before);
  });

  it("is reaper-only — an agent or oversight token cannot call it", async () => {
    for (const token of [mintToken(SEAT, "agent"), oversight()]) {
      const res = await rpc("issue_operator_credential", { token, body: { family_key: SEAT } });
      expect([401, 403, 404]).toContain(res.status);
    }
  });

  it("keeps the ledger append-only", () => {
    const upd = exec("update app.operator_credentials set assume_role = 'oversight'");
    expect(upd.ok).toBe(false);
    expect(upd.error).toMatch(/append-only/i);
    const del = exec("delete from app.operator_credentials");
    expect(del.ok).toBe(false);
    expect(del.error).toMatch(/append-only/i);
  });
});

describe("the broker signs what the envelope hands it, and nothing else", () => {
  it("returns a usable token for a valid key", async () => {
    const { status, json } = await post({ role: "agent", reason: "test" }, { "X-Broker-Key": PSK });
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    const claims = JSON.parse(Buffer.from(json.token.split(".")[1], "base64url").toString());
    expect(claims.family).toBe(SEAT);
    expect(claims.features).toContain("role:operator");
    expect(claims.features).not.toContain("capability:integrate");
  });

  it("refuses a wrong or missing key, and issues nothing", async () => {
    const before = query<{ n: string }>("select count(*)::text n from app.operator_credentials")[0].n;
    expect((await post({}, { "X-Broker-Key": "wrong" })).status).toBe(401);
    expect((await post({})).status).toBe(401);
    expect(query<{ n: string }>("select count(*)::text n from app.operator_credentials")[0].n).toBe(before);
  });

  it("passes an out-of-envelope role THROUGH to the envelope, which refuses it", async () => {
    // Defence in depth: the broker does not pre-filter the role. Even if this file were
    // wrong, the database is the wall.
    const { status, json } = await post({ role: "oversight" }, { "X-Broker-Key": PSK });
    expect(status).toBeGreaterThanOrEqual(400);
    expect(json.ok).toBe(false);
    expect(json.error).toContain("outside the operator envelope");
  });

  it("only answers POST /token", async () => {
    const res = await fetch(`${base}/mint`, { method: "POST", headers: { "X-Broker-Key": PSK } });
    expect(res.status).toBe(404);
  });

  it("persists its key 0600 to the file the CLI reads", () => {
    expect(readFileSync(KEY_FILE, "utf8").trim()).toBe(PSK);
  });
});

describe("api.unbrokered_operator_acts — the audit half of an audited boundary", () => {
  it("names an operator act whose actor was never issued a credential", async () => {
    // A SELF-MINTED seat token: exactly what a seat that read JWT_SECRET would produce.
    // The envelope cannot stop this on a single-user host; it must make it visible.
    const sub = randomUUID();
    const res = await (await rpc("record_operator_action", {
      token: mintToken(SEAT, "agent", { sub, features: ["role:operator"] }),
      body: { p_action: "self_minted_probe" },
    })).json();
    expect(res.ok).toBe(true);

    const rows = await (await restGet(`unbrokered_operator_acts?sub=eq.${sub}`, { token: oversight() })).json();
    expect(rows).toHaveLength(1);
    expect(rows[0].family).toBe(SEAT);
    expect(rows[0].acts).toBeGreaterThan(0);
  });

  it("stays quiet about an act made under a BROKERED credential", async () => {
    const { json } = await post({ role: "agent", reason: "brokered act" }, { "X-Broker-Key": PSK });
    const claims = JSON.parse(Buffer.from(json.token.split(".")[1], "base64url").toString());
    const res = await (await rpc("record_operator_action", {
      token: json.token,
      body: { p_action: "brokered_probe" },
    })).json();
    expect(res.ok).toBe(true);

    const rows = await (await restGet(`unbrokered_operator_acts?sub=eq.${claims.sub}`, { token: oversight() })).json();
    expect(rows).toEqual([]);
  });

  it("is readable by a delegated monitor", async () => {
    const res = await restGet("unbrokered_operator_acts?limit=5", { token: monitor() });
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });
});
