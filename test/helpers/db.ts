import { execFileSync } from "node:child_process";
import { PG_DB, PG_USER } from "../config";

// Zero-dep Postgres access for schema/grant assertions: shell out to `psql`
// inside the running `db` container (the same stack `make up` brought up), rather
// than pulling in a client library. Consistent with M0's zero-dep JWT minter.
// `docker compose exec` runs from the repo root (vitest's cwd), where the compose
// file lives. `-T` disables the TTY so stdin/stdout pipe cleanly.

const PSQL_BASE = ["compose", "exec", "-T", "db", "psql", "-U", PG_USER, "-d", PG_DB];

// Run a query and return its rows as parsed JSON. The query is wrapped in a
// json_agg so multi-row, multi-column results come back as a clean array of
// objects regardless of types. Throws if psql exits non-zero.
export function query<T = Record<string, unknown>>(sql: string): T[] {
  const wrapped = `select coalesce(json_agg(t), '[]'::json)::text from (${sql}) t`;
  const out = execFileSync(
    "docker",
    [...PSQL_BASE, "-A", "-t", "-X", "-q", "-c", wrapped],
    { encoding: "utf8" },
  );
  return JSON.parse(out.trim() || "[]") as T[];
}

// Convenience for a single scalar (first column of first row).
export function scalar<T = unknown>(sql: string): T {
  const rows = query<Record<string, T>>(sql);
  if (rows.length === 0) throw new Error(`scalar query returned no rows: ${sql}`);
  return Object.values(rows[0])[0];
}

type ExecResult = { ok: boolean; error: string };

// Run a statement (or batch) for its effect, with ON_ERROR_STOP so any error
// aborts. Returns {ok:false, error} instead of throwing, so tests can assert
// that an operation is *rejected* (e.g. the events append-only trigger).
export function exec(sql: string): ExecResult {
  try {
    execFileSync("docker", [...PSQL_BASE, "-v", "ON_ERROR_STOP=1", "-X", "-q", "-c", sql], {
      encoding: "utf8",
      stdio: ["ignore", "ignore", "pipe"],
    });
    return { ok: true, error: "" };
  } catch (e: unknown) {
    const err = e as { stderr?: Buffer | string; message?: string };
    const stderr = err.stderr ? err.stderr.toString() : "";
    return { ok: false, error: stderr || err.message || "unknown error" };
  }
}

// Pipe a whole SQL file (e.g. db/seed.sql) into psql via stdin. Used to prove
// the seed is idempotent by re-applying it from the test.
export function execFile(path: string): ExecResult {
  try {
    execFileSync(
      "bash",
      ["-c", `docker ${[...PSQL_BASE, "-v", "ON_ERROR_STOP=1", "-X", "-q"].join(" ")} < ${path}`],
      { encoding: "utf8", stdio: ["ignore", "ignore", "pipe"] },
    );
    return { ok: true, error: "" };
  } catch (e: unknown) {
    const err = e as { stderr?: Buffer | string; message?: string };
    const stderr = err.stderr ? err.stderr.toString() : "";
    return { ok: false, error: stderr || err.message || "unknown error" };
  }
}

// Synchronous sleep (no busy-wait) — Atomics.wait blocks the thread cheaply.
// Needed because all our psql calls are synchronous (execFileSync).
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Wait until the db answers, so db-backed suites tolerate a still-warming stack
// (mirrors waitForReady for PostgREST). The stack's `db` is healthy before
// PostgREST starts, so this is usually instant under `make test`.
export function waitForDb(timeoutMs = 60_000): void {
  const start = Date.now();
  let lastErr = "";
  while (Date.now() - start < timeoutMs) {
    try {
      scalar<number>("select 1");
      return;
    } catch (e: unknown) {
      lastErr = (e as { message?: string }).message ?? String(e);
    }
    sleepSync(1000);
  }
  throw new Error(`db not ready within ${timeoutMs}ms: ${lastErr}`);
}
