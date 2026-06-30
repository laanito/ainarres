import { describe, expect, test } from "vitest";
import { humanizeSeconds } from "../bin/lib/humanize-seconds.mjs";

describe("humanizeSeconds", () => {
  test("0 -> '0s'", () => {
    expect(humanizeSeconds(0)).toBe("0s");
  });

  test("45 -> '45s'", () => {
    expect(humanizeSeconds(45)).toBe("45s");
  });

  test("90 -> '1m 30s'", () => {
    expect(humanizeSeconds(90)).toBe("1m 30s");
  });

  test("3661 -> '1h 1m 1s'", () => {
    expect(humanizeSeconds(3661)).toBe("1h 1m 1s");
  });

  test("90000 -> '1d 1h'", () => {
    expect(humanizeSeconds(90000)).toBe("1d 1h");
  });

  test("negative input is prefixed with '-'", () => {
    expect(humanizeSeconds(-3661)).toBe("-1h 1m 1s");
  });

  test("negative zero still returns '0s'", () => {
    expect(humanizeSeconds(-0)).toBe("0s");
  });

  test("drops zero components but keeps first three non-zero units", () => {
    // 90061 = 1d 1h 1m 1s → four non-zero units; clipped to three
    expect(humanizeSeconds(90061)).toBe("1d 1h 1m");
  });

  test("handles a large value with many units, clipped to three", () => {
    // 200000 = 2d 7h 33m 20s → clipped to "2d 7h 33m"
    expect(humanizeSeconds(200000)).toBe("2d 7h 33m");
  });
});
