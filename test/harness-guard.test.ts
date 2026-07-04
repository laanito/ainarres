import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The harness command guard (loop/guard-bin, 2026-07-04 board-wipe). A loop harness gets
// this dir prepended to PATH so it CANNOT run commands that mutate the shared substrates
// (make reset / docker compose down / psql truncate / dbmate down). Substrate-free: we just
// resolve commands against the guard dir the way a harness does and check they are refused.

const guardBin = join(process.cwd(), "loop", "guard-bin");

// Run a command line with the guard dir prepended to PATH (exactly as the harness wrappers
// do), capturing exit code + stderr.
function run(cmdline: string): { code: number; stderr: string } {
  try {
    execFileSync("bash", ["-c", `export PATH="${guardBin}:$PATH"; ${cmdline}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stderr: "" };
  } catch (e: unknown) {
    const err = e as { status?: number; stderr?: Buffer | string };
    return { code: err.status ?? -1, stderr: (err.stderr ?? "").toString() };
  }
}

describe("harness command guard (loop/guard-bin)", () => {
  const risky: Array<[string, string]> = [
    ["make", "make reset"],
    ["make", "make loop-reset"],
    ["docker", "docker compose down -v"],
    ["psql", "psql -c 'truncate app.tasks'"],
    ["dbmate", "dbmate down"],
  ];

  for (const [name, cmdline] of risky) {
    it(`blocks '${cmdline}' with a clear refusal (exit 97)`, () => {
      const r = run(cmdline);
      expect(r.code).toBe(97);
      expect(r.stderr).toContain("BLOCKED inside the loop harness");
      expect(r.stderr).toContain(name);
    });
  }

  it("does NOT shadow the tools a worker legitimately needs (node passes through)", () => {
    const r = run(`node -e 'process.exit(0)'`);
    expect(r.code).toBe(0);
  });

  it("resolves the guard shim ahead of any real binary on PATH", () => {
    // `which make` under the guarded PATH must point inside loop/guard-bin.
    const out = execFileSync("bash", ["-c", `export PATH="${guardBin}:$PATH"; command -v make`], {
      encoding: "utf8",
    }).trim();
    expect(out).toBe(join(guardBin, "make"));
  });
});
