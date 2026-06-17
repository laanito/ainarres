import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { PG_DB, PG_USER } from "../config";
import { scalar } from "./db";

// Deterministic concurrency harness (ADR 0010): open N real connections, park
// them all on a shared advisory lock that a coordinator holds exclusively, then
// release together so every worker fires its statement in a tight window. We
// assert invariants (no double-claim; successes = min(N,K)) that must hold under
// any interleaving — so the test is deterministic even though timing isn't.
//
// All connections are `psql` inside the db container — zero local deps (the
// owner's containerize-everything steer).

const PSQL = ["compose", "exec", "-T", "db", "psql", "-U", PG_USER, "-d", PG_DB];

function spawnPsql(extraArgs: string[]): ChildProcessWithoutNullStreams {
  return spawn("docker", [...PSQL, ...extraArgs]);
}

// Build the per-worker script: park on the shared lock, then run one statement.
// Output of the setup statements is sent to /dev/null so stdout carries only the
// final statement's result (one line, with -tAq).
export function workerScript(
  lockKey: number,
  claims: Record<string, unknown>,
  statement: string,
): string {
  const claimsJson = JSON.stringify(claims);
  return [
    "\\o /dev/null",
    "begin;",
    `select set_config('request.jwt.claims', $claims$${claimsJson}$claims$, true);`,
    `select pg_advisory_xact_lock_shared(${lockKey});`,
    "\\o",
    statement,
    "commit;",
  ].join("\n");
}

function runWorker(script: string): Promise<string> {
  return new Promise((resolve) => {
    const p = spawnPsql(["-tAq"]);
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("close", () => resolve(out));
    p.stdin.write(script);
    p.stdin.end();
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Run `scripts` concurrently against a release barrier. Returns each worker's
// stdout (the final statement's result line). lockKey must be unique per call.
export async function runBarrier(scripts: string[], lockKey: number): Promise<string[]> {
  const n = scripts.length;

  // 1. Coordinator: a long-lived session that grabs the exclusive advisory lock.
  const coord = spawnPsql([]);
  let coordOut = "";
  const lockedSentinel = new Promise<void>((resolve) => {
    coord.stdout.on("data", (d) => {
      coordOut += d;
      if (coordOut.includes("__LOCKED__")) resolve();
    });
  });
  coord.stdin.write(`select pg_advisory_lock(${lockKey});\n\\echo __LOCKED__\n`);
  await lockedSentinel;

  // 2. Launch the workers; they block on the shared lock.
  const workers = scripts.map(runWorker);

  // 3. Wait until all N are parked (not-granted advisory locks), then release.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const waiting = scalar<number>(
      "select count(*)::int from pg_locks where locktype = 'advisory' and not granted",
    );
    if (waiting >= n) break;
    await sleep(50);
  }
  coord.stdin.write(`select pg_advisory_unlock(${lockKey});\n`);

  // 4. Collect, then close the coordinator (releases its session lock).
  const results = await Promise.all(workers);
  coord.stdin.write("\\q\n");
  coord.stdin.end();
  await new Promise<void>((resolve) => coord.on("close", () => resolve()));

  return results;
}

// Last non-empty line of a worker's stdout, parsed as the envelope JSON.
export function parseEnvelope(stdout: string): any {
  const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  const last = lines.at(-1);
  if (!last) throw new Error(`no output from worker (stdout: ${JSON.stringify(stdout)})`);
  return JSON.parse(last);
}
