import { describe, expect, test } from "vitest";
import { clamp } from "../bin/lib/clamp.mjs";

describe("clamp", () => {
  test("returns n when in [lo, hi]", () => {
    expect(clamp(5,0,10)).toBe(5);
  });
  test("clamps below lo", () => {
    expect(clamp(-3,0,10)).toBe(0);
  });
  test("clamps above hi", () => {
    expect(clamp(99,0,10)).toBe(10);
  });
  test("handles lo===hi", () => {
    expect(clamp(7,7,7)).toBe(7);
  });
});
