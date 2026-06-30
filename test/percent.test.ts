import { describe, expect, test } from "vitest";
import { percent } from "../bin/lib/percent.mjs";

describe("percent", () => {
  test("1/4 -> 25%", () => { expect(percent(1,4)).toBe("25%"); });
  test("1/3 -> 33% (round)", () => { expect(percent(1,3)).toBe("33%"); });
  test("0/5 -> 0%", () => { expect(percent(0,5)).toBe("0%"); });
  test("5/5 -> 100%", () => { expect(percent(5,5)).toBe("100%"); });
  test("whole=0 -> 0% (no div0)", () => { expect(percent(5,0)).toBe("0%"); });
});
