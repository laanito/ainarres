import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { exec, waitForDb } from "./helpers/db";
import { waitForReady } from "./helpers/http";

// M6a — self-hosting pipeline, end to end through the `ainarres` CLI with a
// SCRIPTED worker (deterministic; the real opencode+qwen3.6 run is M6b). Drives
// the full snippet-factory loop: create → claim → write file → self-validate →
// advance → review → verify → done, plus a reject→rework cycle. Exercises the CLI
// (the agent surface), the verbs, and the file/validate two-plane seam together.

// Solutions use a .cjs entry: this repo is "type":"module", so a .js under work/
// would be treated as ESM and break the CommonJS require below.
const ENTRY = "solution.cjs";
const VALIDATE = `node -e "const m=require('./${ENTRY}'); process.exit(m.add(2,3)===5 && m.add(-1,1)===0 ? 0 : 1)"`;
const CORRECT = "module.exports = { add: (a, b) => a + b };\n";
const WRONG = "module.exports = { add: (a, b) => a - b };\n"; // fails validate

// Run the CLI as a subprocess (the real agent surface). Returns the parsed JSON
// envelope whether the CLI exits 0 (ok) or 1 (not ok).
function cli(args: string[], token?: string): any {
  const env = { ...process.env, ...(token ? { AINARRES_TOKEN: token } : {}) };
  try {
    const out = execFileSync("node", ["bin/ainarres.mjs", ...args], { encoding: "utf8", env });
    return JSON.parse(out.trim().split("\n").pop() as string);
  } catch (e: any) {
    if (e.stdout) return JSON.parse(String(e.stdout).trim().split("\n").pop() as string);
    throw e;
  }
}

function mintToken(family: string, role: string, features: string[]): string {
  return cli(["token", "--family", family, "--role", role, "--features", features.join(",")]).token;
}

// What a worker does while holding a task: write the file, then run the task's
// own validate command from the work dir.
function writeSolution(taskId: string, entry: string, code: string): string {
  const dir = `work/${taskId}`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/${entry}`, code);
  return `${dir}/${entry}`;
}
function runValidate(taskId: string, validate: string): boolean {
  try {
    execFileSync("sh", ["-c", validate], { cwd: `work/${taskId}`, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function park(): void {
  const r = exec(`update app.tasks set blocked = true
    where lane_id = (select id from app.lanes where key = 'snippets') and not blocked`);
  if (!r.ok) throw new Error(`park failed: ${r.error}`);
}

let WORKER: string;
let REVIEWER: string;
let OVERSIGHT: string;

beforeAll(async () => {
  waitForDb();
  await waitForReady();
  // The token's role is the POSTGRES role (agent/oversight); worker vs reviewer is
  // a FEATURE (role:worker / role:reviewer), not a Postgres role.
  WORKER = mintToken("opencode+qwen3.6", "agent", ["lane:snippets", "role:worker"]);
  REVIEWER = mintToken("claude-code+opus", "agent", ["lane:snippets", "role:reviewer"]);
  OVERSIGHT = mintToken("claude-code+opus", "oversight", []);
  rmSync("work", { recursive: true, force: true });
});

describe("snippet-factory end to end (scripted worker via the CLI)", () => {
  it("create → worker solves & self-validates → reviewer verifies → done", async () => {
    park();
    const created = cli(
      ["create", "--lane", "snippets", "--instructions", "export add(a,b)", "--entry", ENTRY, "--validate", VALIDATE],
      REVIEWER,
    );
    expect(created.ok).toBe(true);
    const id = created.task.id;
    expect(created.task.stage_key).toBe("todo");

    // Worker claims the task it created (only unblocked one), solves, self-validates.
    const claim = cli(["claim", "--lane", "snippets"], WORKER);
    expect(claim.ok).toBe(true);
    expect(claim.task.id).toBe(id);
    const file = writeSolution(id, claim.task.payload.entry, CORRECT);
    expect(runValidate(id, claim.task.payload.validate)).toBe(true); // worker self-validates

    cli(["progress", id, "--note", "validate passed", "--artifact", file], WORKER);
    const adv = cli(["advance", id, "--to", "review", "--note", "ready", "--artifact", file], WORKER);
    expect(adv.ok).toBe(true);
    expect(adv.task.stage_key).toBe("review");
    expect(adv.task.claimed_by).toBeNull(); // hold released

    // Reviewer claims at review, re-runs validate independently, accepts.
    const rclaim = cli(["claim", "--lane", "snippets"], REVIEWER);
    expect(rclaim.ok).toBe(true);
    expect(rclaim.task.id).toBe(id);
    expect(runValidate(id, rclaim.task.payload.validate)).toBe(true); // independent verification
    const done = cli(["advance", id, "--to", "done", "--note", "verified"], REVIEWER);
    expect(done.ok).toBe(true);
    expect(done.task.stage_key).toBe("done");

    // The deliverable is on disk; the DB carried only a reference.
    expect(existsSync(file)).toBe(true);

    // Oversight sees the journey on the board and the feed.
    const board = cli(["board", "--lane", "snippets"], OVERSIGHT);
    const row = board.find((r: any) => r.task_id === id);
    expect(row.stage).toBe("done");

    const feed = cli(["feed", "--task", id], OVERSIGHT);
    const types = feed.map((e: any) => e.type);
    expect(types).toContain("created");
    expect(types).toContain("claimed");
    expect(types).toContain("transition");
  });

  it("reviewer rejects a bad solution; worker reworks it to done", async () => {
    park();
    const id = cli(
      ["create", "--lane", "snippets", "--instructions", "export add(a,b)", "--entry", ENTRY, "--validate", VALIDATE],
      REVIEWER,
    ).task.id;

    // Worker submits a WRONG solution (skips the self-check), advances to review.
    const c1 = cli(["claim", "--lane", "snippets"], WORKER);
    expect(c1.task.id).toBe(id);
    const file = writeSolution(id, c1.task.payload.entry, WRONG);
    cli(["advance", id, "--to", "review", "--artifact", file], WORKER);

    // Reviewer's independent validate fails → reject back to todo.
    const r1 = cli(["claim", "--lane", "snippets"], REVIEWER);
    expect(r1.task.id).toBe(id);
    expect(runValidate(id, r1.task.payload.validate)).toBe(false);
    const rej = cli(["reject", id, "--to", "todo", "--reason", "add is wrong"], REVIEWER);
    expect(rej.ok).toBe(true);
    expect(rej.task.stage_key).toBe("todo");

    // Worker reclaims, fixes the file, advances again.
    const c2 = cli(["claim", "--lane", "snippets"], WORKER);
    expect(c2.task.id).toBe(id);
    writeSolution(id, c2.task.payload.entry, CORRECT);
    expect(runValidate(id, c2.task.payload.validate)).toBe(true);
    cli(["advance", id, "--to", "review", "--artifact", file], WORKER);

    // Reviewer verifies and accepts.
    const r2 = cli(["claim", "--lane", "snippets"], REVIEWER);
    expect(r2.task.id).toBe(id);
    expect(runValidate(id, r2.task.payload.validate)).toBe(true);
    const done = cli(["advance", id, "--to", "done", "--note", "fixed"], REVIEWER);
    expect(done.ok).toBe(true);
    expect(done.task.stage_key).toBe("done");

    // The feed records the rework (a reject transition happened).
    const feed = cli(["feed", "--task", id], OVERSIGHT);
    const rejectEvents = feed.filter((e: any) => e.type === "transition" && e.data.kind === "reject");
    expect(rejectEvents.length).toBe(1);
  });
});
