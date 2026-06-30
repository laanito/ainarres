import { describe, expect, test } from "vitest";
import { ordinal } from "../bin/lib/ordinal.mjs";

describe("ordinal", () => {
  test("1 -> 1st", () => { expect(ordinal(1)).toBe("1st"); });
  test("2 -> 2nd", () => { expect(ordinal(2)).toBe("2nd"); });
  test("3 -> 3rd", () => { expect(ordinal(3)).toBe("3rd"); });
  test("4 -> 4th", () => { expect(ordinal(4)).toBe("4th"); });
  test("11 -> 11th (teen)", () => { expect(ordinal(11)).toBe("11th"); });
  test("12 -> 12th", () => { expect(ordinal(12)).toBe("12th"); });
  test("13 -> 13th", () => { expect(ordinal(13)).toBe("13th"); });
  test("21 -> 21st", () => { expect(ordinal(21)).toBe("21st"); });
  test("22 -> 22nd", () => { expect(ordinal(22)).toBe("22nd"); });
  test("113 -> 113th", () => { expect(ordinal(113)).toBe("113th"); });
});
