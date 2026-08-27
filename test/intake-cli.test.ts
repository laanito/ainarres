import { randomUUID } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exec, scalar, waitForDb } from "./helpers/db";
import { rpc, waitForReady } from "./helpers/http";
import { mintToken } from "./helpers/mint";
import { resolveIntakePsk } from "../bin/ainarres.mjs";

// v8 ergonomics — one command per step of the intake flow, instead of a hand-carried PSK
// and a node|curl incantation:
//   * the channel GENERATES a key when none is supplied and persists it (0600) so the
//     client can read it — same posture (ADR 0025: always a key, no anonymous write), no
//     copy-paste between shells;
//   * `ainarres intake` posts a request (PSK auth, no JWT);
//   * `ainarres refine` does the intaker's claim + advance to `briefed` in one call.
//
// Every key path here is pointed at a TEMP key file via INTAKE_PSK_FILE so the suite can
// never clobber a running channel's real loop/run/intake.psk.

const PORT = 3098; // distinct from intake-channel.test.ts's 3099
const FAMILY = "human+intaker";
const LANE = `v8-cli-${randomUUID().slice(0, 8)}`; // own lane: no claim races with other files
const base = `http://127.0.0.1:${PORT}`;
const CLI = "bin/ainarres.mjs";

const FIXTURE = `
  insert into app.features (kind, key) values ('lane', '${LANE}') on conflict (kind, key) do nothing;
  insert into app.agent_families (key, description) values
    ('${FAMILY}', 'test: the local intake channel caller (human identity)')
  on conflict (key) do nothing;
  insert into app.family_features (family_id, feature_id)
  select f.id, ft.id from app.agent_families f
  join app.features ft on ft.name = any (array['lane:intake', 'role:intaker'])
  where f.key = '${FAMILY}'
  on conflict (family_id, feature_id) do nothing;
  insert into app.lanes (project_id, key, workflow_id)
  select p.id, '${LANE}', w.id from app.projects p, app.workflows w
  where p.slug = 'ainarres' and w.key = 'ainarres-intake'
  on conflict (project_id, key) do nothing;
`;

let server: ChildProcess;
let keyFile = "";
const tmp = mkdtempSync(join(tmpdir(), "ainarres-intake-cli-"));

const cli = (args: string[], env: Record<string, string> = {}) =>
  spawnSync("node", [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, INTAKE_PSK: "", INTAKE_PSK_FILE: keyFile, ...env },
  });

const briefsWithRequest = (marker: string): number =>
  Number(scalar<number>(
    `select count(*) from app.tasks t join app.lanes l on l.id = t.lane_id
     where l.key = 'intake' and t.payload->>'request' = '${marker}'`,
  ));

beforeAll(async () => {
  waitForDb();
  const res = exec(FIXTURE);
  if (!res.ok) throw new Error(`fixture failed: ${res.error}`);
  await waitForReady();

  keyFile = join(tmp, "intake.psk");
  // NOTE: no INTAKE_PSK — the channel must establish its own key.
  server = spawn("node", ["bin/intake-server.mjs"], {
    env: { ...process.env, INTAKE_PSK: "", INTAKE_PORT: String(PORT), INTAKE_PSK_FILE: keyFile },
    stdio: "ignore",
  });
  // Wait for it to be listening AND to have written the key.
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      const r = await fetch(`${base}/intake`, { method: "GET" });
      if (r.status === 404 || r.status === 405 || r.status === 401) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error("intake-server did not start");
    await new Promise((r) => setTimeout(r, 200));
  }
});

afterAll(() => {
  server?.kill("SIGTERM");
});

describe("the channel establishes its own key", () => {
  it("generates a 32-byte key and persists it 0600 when INTAKE_PSK is unset", () => {
    const key = readFileSync(keyFile, "utf8").trim();
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    // Owner-only: the key file is not world- or group-readable.
    expect(statSync(keyFile).mode & 0o077).toBe(0);
  });

  it("still refuses an unauthenticated write (ADR 0025 — generated is not absent)", async () => {
    const res = await fetch(`${base}/intake`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ request: "v8-cli unauthenticated" }),
    });
    expect(res.status).toBe(401);
    expect(briefsWithRequest("v8-cli unauthenticated")).toBe(0);
  });
});

describe("ainarres intake", () => {
  it("posts a request using the key file — no PSK in the environment", () => {
    const marker = `v8-cli intake ${randomUUID()}`;
    const r = cli(["intake", "--request", marker, "--port", String(PORT)]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^brief [0-9a-f-]{36}/);
    expect(r.stdout).toContain("ainarres refine");   // tells you the next step
    expect(briefsWithRequest(marker)).toBe(1);
  });

  it("reads the request from a file, and from stdin with --file -", () => {
    const marker = `v8-cli file ${randomUUID()}`;
    const path = join(tmp, "req.txt");
    writeFileSync(path, `${marker}\n`);
    const r = cli(["intake", "--file", path, "--port", String(PORT), "--subject", "from a file"]);
    expect(r.status, r.stderr).toBe(0);
    expect(briefsWithRequest(marker)).toBe(1);
  });

  it("refuses a wrong key and writes nothing", () => {
    const marker = `v8-cli badkey ${randomUUID()}`;
    const r = cli(["intake", "--request", marker, "--port", String(PORT), "--psk", "not-the-key"]);
    expect(r.status).not.toBe(0);
    expect(briefsWithRequest(marker)).toBe(0);
  });

  it("says what to do when there is no key at all", () => {
    const r = cli(["intake", "--request", "x", "--port", String(PORT)], {
      INTAKE_PSK_FILE: join(tmp, "does-not-exist.psk"),
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("make intake-serve");
  });

  it("needs a request", () => {
    const r = cli(["intake", "--port", String(PORT)]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("--request");
  });
});

describe("ainarres refine — the intaker's step in one command", () => {
  const intaker = () => mintToken(FAMILY, "agent", { features: [`lane:${LANE}`, "role:intaker"] });

  const openBrief = async (request: string): Promise<string> => {
    const res = await rpc("create_task", {
      token: intaker(),
      body: { lane_key: LANE, payload: { request } },
    });
    const env = (await res.json()) as any;
    expect(env.ok, JSON.stringify(env)).toBe(true);
    return env.task.id as string;
  };

  const stageOf = (id: string): string =>
    String(scalar<string>(
      `select s.key from app.tasks t join app.stages s on s.id = t.stage where t.id = '${id}'::uuid`,
    ));

  it("claims a brief and advances proposed_brief → briefed, self-minting its token", async () => {
    const id = await openBrief(`v8-cli refine ${randomUUID()}`);
    const r = cli(["refine", id, "--lane", LANE, "--note", "test refine"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`refined ${id}`);
    expect(r.stdout).toContain("proposed_brief → briefed");
    expect(stageOf(id)).toBe("briefed");
  });

  it("with no id, refines whatever is claimable", async () => {
    const id = await openBrief(`v8-cli refine-any ${randomUUID()}`);
    const r = cli(["refine", "--lane", LANE]);
    expect(r.status, r.stderr).toBe(0);
    expect(stageOf(id)).toBe("briefed");
  });

  it("reports honestly when nothing is claimable", () => {
    const r = cli(["refine", "--lane", LANE]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("nothing claimable");
  });
});

describe("resolveIntakePsk precedence", () => {
  it("--psk beats the environment, which beats the key file", () => {
    const path = join(tmp, "precedence.psk");
    writeFileSync(path, "from-file\n");
    expect(resolveIntakePsk({ psk: "from-flag" }, { INTAKE_PSK: "from-env" })).toBe("from-flag");
    expect(resolveIntakePsk({ "psk-file": path }, { INTAKE_PSK: "from-env" })).toBe("from-env");
    expect(resolveIntakePsk({ "psk-file": path }, {})).toBe("from-file");
    expect(resolveIntakePsk({ "psk-file": join(tmp, "nope.psk") }, {})).toBeNull();
  });
});
