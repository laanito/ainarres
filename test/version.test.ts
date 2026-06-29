import { describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

describe("ainarres version", () => {
  test("prints package.json version on one line and exits 0", () => {
    const out = execFileSync("node", ["bin/ainarres.mjs", "version"], { encoding: "utf8" });
    expect(out.trim()).toBe(`ainarres ${pkg.version}`);
  });
});
