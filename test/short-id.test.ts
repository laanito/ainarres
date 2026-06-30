import { describe, expect, test } from "vitest";
import { shortId } from "../bin/lib/short-id.mjs";

describe("shortId", () => {
  test("full uuid-like string is truncated to first 8 characters", () => {
    expect(shortId("019f1a40-b823-...")).toBe("019f1a40");
  });

  test("short string (<8 chars) is returned as-is", () => {
    expect(shortId("abc")).toBe("abc");
  });

  test("non-string input returns empty string", () => {
    expect(shortId(null)).toBe("");
    expect(shortId(undefined)).toBe("");
    expect(shortId(123)).toBe("");
    expect(shortId({})).toBe("");
  });

  test("empty string returns empty string", () => {
    expect(shortId("")).toBe("");
  });

  test("exactly 8 characters is returned as-is", () => {
    expect(shortId("12345678")).toBe("12345678");
  });
});
