import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exec, query, scalar, waitForDb } from "./helpers/db";
import { rpc, waitForReady } from "./helpers/http";
import { mintToken } from "./helpers/mint";

// M26 — the LOCAL INTAKE CHANNEL (v7 Stage 2; ADR 0024 / ADR 0025). The first external
// ingress: a loopback HTTP endpoint an external Customer POSTs a request to, authenticated
// by a pre-shared key, which opens a proposed_brief in the intake lane AS a distinct human
// identity (family 'human+intaker', role:intaker only). Verified assisted, before live:
//   - auth: correct PSK → 201 + a brief row; missing/wrong PSK → 401 + NO row;
//   - validation: empty/bad body → 400;
//   - routing: only POST /intake;
//   - DEFENCE IN DEPTH (the substrate inner wall): the channel's identity can open a brief
//     in intake but is REFUSED creating in dev and holds no capability:integrate — a channel
//     bug cannot grant what the M24 D4 gate withholds.

const PORT = 3099; // fixed loopback test port
const PSK = "test-intake-preshared-key-0123456789";
const FAMILY = "human+intaker";
const base = `http://127.0.0.1:${PORT}`;

// The channel's human identity must be registered (ADR 0007) with lane:intake + role:intaker.
// Seed it idempotently here so the test is self-contained (matches db/seed.sql's M26 block).
const FIXTURE = `
  insert into app.agent_families (key, description) values
    ('${FAMILY}', 'test: the local intake channel caller (human identity)')
  on conflict (key) do nothing;
  insert into app.family_features (family_id, feature_id)
  select f.id, ft.id from app.agent_families f
  join app.features ft on ft.name = any (array['lane:intake', 'role:intaker'])
  where f.key = '${FAMILY}'
  on conflict (family_id, feature_id) do nothing;
`;

let server: ChildProcess;

// Count intake-lane briefs carrying a SPECIFIC request marker — isolation-safe under
// concurrent test files (which all share the intake lane), unlike a total count.
const intakeWithRequest = (marker: string): number =>
  Number(scalar<number>(
    `select count(*) from app.tasks t join app.lanes l on l.id = t.lane_id where l.key = 'intake' and t.payload->>'request' = '${marker}'`,
  ));

async function post(bodyObj: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}/intake`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Connection: "close", ...headers },
    body: JSON.stringify(bodyObj),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  waitForDb();
  const res = exec(FIXTURE);
  if (!res.ok) throw new Error(`fixture failed: ${res.error}`);
  await waitForReady();

  server = spawn("node", ["bin/intake-server.mjs"], {
    env: { ...process.env, INTAKE_PSK: PSK, INTAKE_PORT: String(PORT), INTAKE_HOST: "127.0.0.1" },
    stdio: "ignore",
  });
  // Wait until it accepts connections (an unauthenticated POST returning 401 proves it is up).
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      await post({ request: "ping" });
      break; // any HTTP response (even 401) means it's listening
    } catch {
      if (Date.now() >= deadline) throw new Error("intake-server did not start listening within 10s");
      await sleep(200);
    }
  }
}, 20_000);

afterAll(() => {
  if (server && !server.killed) server.kill("SIGKILL");
});

describe("M26 intake channel (loopback + PSK)", () => {
  it("opens a proposed_brief with a valid PSK", async () => {
    const marker = `req-${randomUUID()}`;
    const { status, json } = await post({ request: marker, subject: "widget-req" }, { "X-Intake-Key": PSK });
    expect(status).toBe(201);
    expect(json.ok).toBe(true);
    expect(typeof json.brief_id).toBe("string");
    // The brief exists in the intake lane at the initial stage, carrying the request payload.
    const rows = query<{ stage: string; payload: any }>(
      `select s.key as stage, t.payload from app.tasks t join app.stages s on s.id = t.stage where t.id = '${json.brief_id}'`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0].stage).toBe("proposed_brief");
    expect(rows[0].payload.request).toBe(marker);
    expect(rows[0].payload.submitted_via).toBe("intake-channel");
  });

  it("refuses a request with NO pre-shared key (401, no row)", async () => {
    const marker = `nopsk-${randomUUID()}`;
    const { status, json } = await post({ request: marker });
    expect(status).toBe(401);
    expect(json.ok).toBe(false);
    expect(json.code).toBe("unauthorized");
    expect(intakeWithRequest(marker)).toBe(0); // the 401 path never reaches the substrate
  });

  it("refuses a request with the WRONG key (401, no row)", async () => {
    const marker = `wrongpsk-${randomUUID()}`;
    const { status, json } = await post({ request: marker }, { "X-Intake-Key": "wrong-key" });
    expect(status).toBe(401);
    expect(json.ok).toBe(false);
    expect(intakeWithRequest(marker)).toBe(0);
  });

  it("rejects an empty / request-less body (400, no row)", async () => {
    // No request text → the server 400s BEFORE calling create_task, so no row is possible.
    const { status, json } = await post({ subject: "no request text" }, { "X-Intake-Key": PSK });
    expect(status).toBe(400);
    expect(json.ok).toBe(false);
    expect(json.code).toBe("bad_request");
  });

  it("serves only POST /intake", async () => {
    const get = await fetch(`${base}/intake`, { headers: { Connection: "close" } });
    expect(get.status).toBe(405);
    const other = await fetch(`${base}/nope`, { method: "POST", headers: { Connection: "close" } });
    expect(other.status).toBe(404);
  });

  it("defence in depth: the channel identity can open a brief but CANNOT create dev work or integrate", async () => {
    const human = mintToken(FAMILY, "agent", { features: ["lane:intake", "role:intaker"] });
    // It CAN create in intake (what the channel does).
    const okIntake = await (await rpc("create_task", { token: human, body: { lane_key: "intake", payload: { request: "direct" } } })).json();
    expect(okIntake.ok).toBe(true);
    // It CANNOT create in dev — no lane:dev / not the dev starter role (the M24 D4 inner wall).
    const denyDev = await (await rpc("create_task", { token: human, body: { lane_key: "dev", payload: {} } })).json();
    expect(denyDev.ok).toBe(false);
    expect(denyDev.code).toBe("not_eligible");
    // It holds no capability:integrate — the granted feature set is exactly [lane:intake, role:intaker].
    const feats = query<{ name: string }>(
      `select ft.name from app.family_features ff
         join app.agent_families f on f.id = ff.family_id
         join app.features ft on ft.id = ff.feature_id
        where f.key = '${FAMILY}' order by ft.name`,
    ).map((r) => r.name);
    expect(feats).toContain("lane:intake");
    expect(feats).toContain("role:intaker");
    expect(feats).not.toContain("capability:integrate");
    expect(feats).not.toContain("lane:dev");
  });
});
