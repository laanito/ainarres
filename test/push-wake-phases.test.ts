import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Structural pin of ADR 0027's success-gate phases in loop/service-selftest.sh.
// The phases' SHAPE is pinned here; the owner runs `make service-selftest` at the
// validating stage for the behaviour. This file cannot prove a wake beat a tick
// — only that the phase is written so it can only pass if one did.

const root = process.cwd();
const selftest = readFileSync(join(root, "loop", "service-selftest.sh"), "utf8");

function bashN(rel: string): number {
  try {
    execFileSync("bash", ["-n", join(root, rel)], { stdio: "pipe" });
    return 0;
  } catch (e: unknown) {
    const err = e as { status?: number };
    return err.status ?? 1;
  }
}

function phaseBlock(n: number): string {
  // From this phase's header through the next phase header, or the final echo.
  const start = new RegExp(`# ── Phase ${n}:`);
  const m = start.exec(selftest);
  expect(m, `Phase ${n} header missing`).not.toBeNull();
  const from = m!.index;
  const rest = selftest.slice(from + 1);
  const next = rest.search(/# ── Phase \d+:|echo "✓ service-selftest/);
  return selftest.slice(from, next === -1 ? undefined : from + 1 + next);
}

describe("push-wake phases (ADR 0027 success gate)", () => {
  // 1. the file declares phases 8, 9 and 10, and the header's numbered list
  //    mentions all three.
  it("declares phases 8, 9 and 10 in the body and the header list", () => {
    expect(selftest).toMatch(/# ── Phase 8:/);
    expect(selftest).toMatch(/# ── Phase 9:/);
    expect(selftest).toMatch(/# ── Phase 10:/);

    const header = selftest.slice(0, selftest.indexOf("set -euo pipefail"));
    expect(header).toMatch(/\b8\b/);
    expect(header).toMatch(/\b9\b/);
    expect(header).toMatch(/\b10\b/);
    expect(header).toMatch(/PUSH-WAKE|push-wake/i);
    expect(header).toMatch(/LISTEN OFF|LOOP_PUSH_WAKE=0/i);
    expect(header).toMatch(/LEASE-EXPIRY|lease/i);
  });

  // 2. PHASE 8 starts a supervisor with a LONG poll (≥20) and asserts a measured
  //    wake latency strictly below it (an elapsed-time comparison). The phase
  //    can only pass if the wake beat the tick.
  it("phase 8 uses a long poll and asserts elapsed < the tick", () => {
    const p8 = phaseBlock(8);
    const poll = p8.match(/LOOP_IDLE_POLL_SECS=(\d+)/);
    expect(poll, "Phase 8 must assign LOOP_IDLE_POLL_SECS").not.toBeNull();
    expect(parseInt(poll![1], 10)).toBeGreaterThanOrEqual(20);
    expect(p8).toMatch(/-lt\s+10/);
    expect(p8).toMatch(/wait_until\s+10/);
    expect(p8).toMatch(/date \+%s/);
  });

  // 3. PHASE 9 sets LOOP_PUSH_WAKE=0, still asserts the board drains, and greps
  //    the service log for the disabled-state line.
  it("phase 9 disables push-wake, drains, and greps the disabled-state log line", () => {
    const p9 = phaseBlock(9);
    expect(p9).toMatch(/LOOP_PUSH_WAKE=0/);
    expect(p9).toMatch(/board_all_done/);
    expect(p9).toMatch(/grep -q/);
    expect(p9).toMatch(/push-wake disabled/);
  });

  // 4. PHASE 10 writes a PAST lease_expires_at via loop_psql and asserts drain.
  it("phase 10 stamps a past lease_expires_at via loop_psql and still drains", () => {
    const p10 = phaseBlock(10);
    expect(p10).toMatch(/loop_psql/);
    expect(p10).toMatch(/lease_expires_at/);
    expect(p10).toMatch(/interval '1 hour'|now\(\)\s*-\s*interval/);
    expect(p10).toMatch(/board_all_done/);
  });

  // 5. phases 1-7 are still present and in order (additive), plus bash -n.
  it("phases 1-7 remain in order and service-selftest.sh parses", () => {
    const idxs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => {
      const i = selftest.indexOf(`# ── Phase ${n}:`);
      expect(i, `Phase ${n} missing`).toBeGreaterThanOrEqual(0);
      return i;
    });
    for (let i = 1; i < idxs.length; i++) {
      expect(idxs[i], `Phase ${i + 1} is not after Phase ${i}`).toBeGreaterThan(idxs[i - 1]);
    }
    expect(bashN("loop/service-selftest.sh")).toBe(0);
  });

  // 6. bash -n on the supervisor and the wake primitives.
  it("service.sh and push-wake.sh parse (bash -n)", () => {
    expect(bashN("loop/service.sh")).toBe(0);
    expect(bashN("loop/push-wake.sh")).toBe(0);
  });

  // 7. mock mode only, loop substrate never the test one.
  it("selftest is LOOP_MODE=mock and targets the loop substrate", () => {
    expect(selftest).toMatch(/export LOOP_MODE=mock/);
    expect(selftest).toMatch(/ainarres-loop/);
    expect(selftest).toMatch(/never the test one/);
  });
});
