import { describe, expect, test } from "vitest";
import { truncate } from "../bin/lib/truncate.mjs";

describe("truncate", () => {
  test('"hello" with max 5 -> "hello" (no truncation)', () => {
    expect(truncate("hello", 5)).toBe("hello");
  });
  test('"hello" with max 4 -> "hel…"', () => {
    expect(truncate("hello", 4)).toBe("hel\u2026");
  });
  test('"hi" with max 5 -> "hi"', () => {
    expect(truncate("hi", 5)).toBe("hi");
  });
  test('"hello" with max 1 -> "…"', () => {
    expect(truncate("hello", 1)).toBe("\u2026");
  });
  test('"" with max 3 -> ""', () => {
    expect(truncate("", 3)).toBe("");
  });
});
