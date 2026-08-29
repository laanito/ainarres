import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { permissionHint } from "../bin/ainarres.mjs";

// v8 step 3 (ADR 0028) — the seat's LAST resort, tested where it actually bites.
//
// `refine` / `operator-log` prefer the credential broker and self-mint when no broker
// answers. That fallback used to be silent: with JWT_SECRET unset, `bin/ainarres.mjs`
// fell back to the dev-only default, minted a perfectly well-formed token, and the
// substrate answered 401 — the one failure a seat cannot diagnose, because the thing
// it is missing is invisible to it. A seat with no broker AND no key must be told so.
//
// SUBSTRATE-FREE ON PURPOSE: every case here refuses (or doesn't) before any HTTP.

const CLI = "bin/ainarres.mjs";
const NO_KEY = "nothing to sign with";

// A seat's environment: no broker key of any kind, and a broker port nothing listens on.
const seatEnv = (over: Record<string, string> = {}) => {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    BROKER_PSK: "",
    BROKER_PSK_FILE: "/nonexistent/broker.psk",
    BROKER_PORT: "3049", // nothing listens here
    ...over,
  };
  return env;
};

const run = (args: string[], env: Record<string, string>) =>
  spawnSync("node", [CLI, ...args], { encoding: "utf8", env });

describe("no broker and no key", () => {
  it("refuses instead of minting an unverifiable token", () => {
    const r = run(["operator-log", "--action", "seat_probe"], seatEnv({ JWT_SECRET: "" }));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(NO_KEY);
    // Both halves named: one of them is the thing to fix.
    expect(r.stderr).toContain("broker");
    expect(r.stderr).toContain("JWT_SECRET");
    expect(r.stdout).toBe(""); // nothing was attempted
  });

  it("says the same for `refine`, which takes the same fallback", () => {
    const r = run(["refine"], seatEnv({ JWT_SECRET: "" }));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(NO_KEY);
  });

  it("does not refuse when a key IS present (the owner's own shell)", () => {
    // Still fails — the substrate port is dead — but never for want of a signing key.
    const r = run(
      ["operator-log", "--action", "seat_probe"],
      seatEnv({ JWT_SECRET: "a-real-key-at-least-32-characters-long", AINARRES_BASE_URL: "http://127.0.0.1:3048" }),
    );
    expect(r.stderr).not.toContain(NO_KEY);
  });
});

describe("`ainarres token` with no key", () => {
  it("still mints (bare checkouts are legitimate) but warns on stderr", () => {
    const r = run(["token", "--family", "agent+operator"], seatEnv({ JWT_SECRET: "" }));
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("JWT_SECRET is unset");
    expect(r.stderr).toContain("seat-token");
    expect(JSON.parse(r.stdout).token.split(".")).toHaveLength(3); // stdout stays clean JSON
  });

  it("is silent when a key is configured", () => {
    const r = run(
      ["token", "--family", "agent+operator"],
      seatEnv({ JWT_SECRET: "a-real-key-at-least-32-characters-long" }),
    );
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
  });
});

// ── The other half of "which credential am I holding" ────────────────────────────
// Found by the first external operator (2026-08-29): `operator-log --token <monitor>`
// answered `42501 permission denied for function record_operator_action`. The refusal is
// CORRECT — the `monitor` coarse role has EXECUTE on nothing since v8 step 0 — but it
// names the function and never the credential, so the caller cannot tell "I may not do
// this" from "I am holding the wrong token for it". Same class as the missing-key trap
// above: a correct failure that costs the agent a round of guessing.

describe("permissionHint", () => {
  const denied = (fn: string) => ({
    code: "42501",
    message: `permission denied for function ${fn}`,
  });

  it("names the read-only credential and the way out", () => {
    const h = permissionHint(denied("record_operator_action"), { role: "monitor" });
    expect(h).toContain("READ-ONLY");
    expect(h).toContain("monitor");
    expect(h).toContain("api.record_operator_action");
    expect(h).toContain("seat-token");
  });

  it("for an agent token, points at the owner-only verbs instead", () => {
    const h = permissionHint(denied("set_permanent_ban"), { role: "agent" });
    expect(h).toContain("agent");
    expect(h).toContain("api.set_permanent_ban");
    expect(h).toContain("stay the owner's");
    expect(h).not.toContain("READ-ONLY");
  });

  it("stays quiet for anything that is not a permission refusal", () => {
    expect(permissionHint({ code: "PGRST202" }, { role: "monitor" })).toBeNull();
    expect(permissionHint(null, { role: "monitor" })).toBeNull();
    expect(permissionHint({ code: "42501" }, null)).toContain("check which credential");
  });

  it("is total — a malformed body or unreadable claims never throws", () => {
    expect(() => permissionHint({ code: "42501", message: null }, {})).not.toThrow();
    expect(() => permissionHint({}, undefined)).not.toThrow();
    expect(permissionHint({ code: "42501", message: "no function named here" }, { role: "monitor" }))
      .toContain("that verb");
  });
});
