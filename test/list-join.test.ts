import { describe, expect, test } from "vitest";
import { listJoin } from "../bin/lib/list-join.mjs";

describe("listJoin", () => {
  test("empty array returns empty string", () => {
    expect(listJoin([])).toBe("");
  });

  test("single item returns that item", () => {
    expect(listJoin(["a"])).toBe("a");
  });

  test("two items are joined with ' and '", () => {
    expect(listJoin(["a", "b"])).toBe("a and b");
  });

  test("three items are joined with commas and 'and'", () => {
    expect(listJoin(["a", "b", "c"])).toBe("a, b and c");
  });

  test("four items are joined correctly with no Oxford comma", () => {
    expect(listJoin(["a", "b", "c", "d"])).toBe("a, b, c and d");
  });
});
