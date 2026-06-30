import { describe, expect, test } from "vitest";
import { pluralize } from "../bin/lib/pluralize.mjs";

describe("pluralize", () => {
  test("n=1 returns singular form", () => {
    expect(pluralize(1, "task")).toBe("1 task");
  });

  test("n=0 returns default plural (singular + 's')", () => {
    expect(pluralize(0, "task")).toBe("0 tasks");
  });

  test("n=2 returns default plural (singular + 's')", () => {
    expect(pluralize(2, "task")).toBe("2 tasks");
  });

  test("explicit plural override is used when provided", () => {
    expect(pluralize(2, "entry", "entries")).toBe("2 entries");
  });

  test("n=1 with explicit plural still uses singular", () => {
    expect(pluralize(1, "entry", "entries")).toBe("1 entry");
  });
});
