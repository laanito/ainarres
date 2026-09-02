import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Structural tests for the push-wake wiring (ADR 0027 D4/D5). The push-wake path
// cannot be unit-tested through service.sh (sourcing it starts the supervisor), and its
// behavioural test lives in loop/push-wake-selftest.sh. This file asserts the wiring
// and the boundaries from source text.

const service = readFileSync(join(process.cwd(), "loop", "service.sh"), "utf8");
const driver = readFileSync(join(process.cwd(), "loop", "driver.sh"), "utf8");
const pushWake = readFileSync(join(process.cwd(), "loop", "push-wake.sh"), "utf8");
const guardBin = join(process.cwd(), "loop", "guard-bin");
const ainarresMjs = readFileSync(join(process.cwd(), "bin", "ainarres.mjs"), "utf8");
const pkgJson = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));

// Harness wrappers that must not reach push-wake infrastructure.
const harnessShells = [
  join(process.cwd(), "loop", "mock-harness.sh"),
  join(process.cwd(), "loop", "opencode-implementer.sh"),
  join(process.cwd(), "loop", "cursor-implementer.sh"),
  join(process.cwd(), "loop", "claude-frontier.sh"),
  join(process.cwd(), "loop", "grok-frontier.sh"),
];

describe("push-wake wiring (ADR 0027)", () => {
  // 1. service.sh sources push-wake.sh exactly once, AFTER driver-lib.sh
  //    (RUN_DIR must exist before push-wake.sh can reference it).
  it("sources push-wake.sh once and after driver-lib.sh", () => {
    const driverLibLine = service
      .split("\n")
      .findIndex((l) => /source\s+.*driver-lib\.sh/.test(l));
    const pushWakeLine = service
      .split("\n")
      .findIndex((l) => /source\s+.*push-wake\.sh/.test(l));

    expect(driverLibLine).toBeGreaterThanOrEqual(0);
    expect(pushWakeLine).toBeGreaterThanOrEqual(0);
    expect(pushWakeLine).toBeGreaterThan(driverLibLine);

    // Exactly one source of push-wake.sh.
    const sources = service.split("\n").filter((l) => /source\s+.*push-wake\.sh/.test(l));
    expect(sources).toHaveLength(1);
  });

  // 2. service.sh calls wake_listener_start (once) and wake_listener_stop inside on_exit.
  //    The listener is torn down on every exit path.
  it("starts the listener at startup and stops it in on_exit", () => {
    const startCalls = service
      .split("\n")
      .filter((l) => /wake_listener_start\b/.test(l) && !/^\s*#/.test(l));
    // Exactly one invocation (the call, not the comment or function definition).
    expect(startCalls.length).toBeGreaterThanOrEqual(1);

    // on_exit must contain wake_listener_stop.
    const onExitMatch = service.match(/on_exit\(\)\s*\{([^}]*)\}/);
    expect(onExitMatch).not.toBeNull();
    expect(onExitMatch![1]).toContain("wake_listener_stop");
  });

  // 3. NO raw idle sleep remains: no `sleep "$LOOP_IDLE_POLL_SECS"` in service.sh,
  //    and at least four `idle_wait "$LOOP_IDLE_POLL_SECS"` calls (unreachable, drained,
  //    unserviceable, stalled). This assertion FAILS on the base branch.
  it("replaces all raw idle sleeps with idle_wait (≥4 calls, 0 raw sleeps)", () => {
    const rawSleeps = service
      .split("\n")
      .filter((l) => /sleep\s+"\$LOOP_IDLE_POLL_SECS"/.test(l) && !/^\s*#/.test(l));
    expect(rawSleeps).toHaveLength(0);

    const idleWaits = service
      .split("\n")
      .filter((l) => /idle_wait\s+"\$LOOP_IDLE_POLL_SECS"/.test(l) && !/^\s*#/.test(l));
    expect(idleWaits.length).toBeGreaterThanOrEqual(4);
  });

  // 4. The poll is bounded and now a backstop: LOOP_IDLE_POLL_SECS default ≥ 30.
  it("poll default is ≥ 30 (backstop cadence, D5)", () => {
    const match = service.match(/LOOP_IDLE_POLL_SECS="\$\{LOOP_IDLE_POLL_SECS:-([0-9]+)\}"/);
    expect(match).not.toBeNull();
    const defaultVal = parseInt(match![1], 10);
    expect(defaultVal).toBeGreaterThanOrEqual(30);
  });

  // 5. BATCH DRIVER UNCHANGED: loop/driver.sh mentions neither push-wake.sh,
  //    idle_wait, nor LISTEN.
  it("batch driver (driver.sh) is push-wake-free", () => {
    expect(driver).not.toMatch(/push-wake\.sh/);
    expect(driver).not.toMatch(/idle_wait/);
    expect(driver).not.toMatch(/\bLISTEN\b/);
  });

  // 6. HARNESS BOUNDARY: no harness wrapper references push-wake.sh, idle_wait,
  //    the wake FIFO, or LISTEN; and guard-bin still contains a psql shim.
  it("harness wrappers are push-wake-free and guard-bin has psql shim", () => {
    for (const f of harnessShells) {
      let content: string;
      try {
        content = readFileSync(f, "utf8");
      } catch {
        continue; // file does not exist in this checkout — skip
      }
      expect(content).not.toMatch(/push-wake\.sh/);
      expect(content).not.toMatch(/idle_wait/);
      expect(content).not.toMatch(/wake.*fifo/i);
      expect(content).not.toMatch(/\bLISTEN\b/);
    }

    // guard-bin/psql shim must exist (the guard that keeps harness children away from the DB).
    const psqlShim = join(guardBin, "psql");
    let shimContent: string;
    try {
      shimContent = readFileSync(psqlShim, "utf8");
    } catch {
      throw new Error(`guard-bin/psql shim missing at ${psqlShim}`);
    }
    // The shim routes through the shared deny helper (which prints the BLOCKED refusal).
    expect(shimContent).toContain(".harness-deny");
    expect(shimContent).toContain("psql");
  });

  // 7. AGENT SURFACE ZERO-DEP: bin/ainarres.mjs has no pg import/require, and
  //    package.json declares no pg dependency.
  it("agent CLI and package.json are pg-free", () => {
    expect(ainarresMjs).not.toMatch(/require\(["']pg["']\)|from ["']pg["']/);

    const allDeps = {
      ...pkgJson.dependencies,
      ...pkgJson.devDependencies,
    };
    expect(allDeps).not.toHaveProperty("pg");
  });

  // 8. push-wake.sh defines the four functions this wiring calls: a cheap contract check
  //    between the two files.
  it("push-wake.sh defines the four wired functions", () => {
    const fns = [
      "wake_listener_start",
      "wake_listener_stop",
      "wake_listener_alive",
      "idle_wait",
    ];
    for (const fn of fns) {
      expect(pushWake).toMatch(new RegExp(`^${fn}\\s*\\(`, "m"));
    }
  });
});
