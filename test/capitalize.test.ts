import { describe, expect, test } from "vitest";
import { capitalize } from "../bin/lib/capitalize.mjs";

describe("capitalize", () => {
  test('"hello" -> "Hello"', () => { expect(capitalize("hello")).toBe("Hello"); });
  test('"Hello" -> "Hello"', () => { expect(capitalize("Hello")).toBe("Hello"); });
  test('"hi there" -> "Hi there"', () => { expect(capitalize("hi there")).toBe("Hi there"); });
  test('"a" -> "A"', () => { expect(capitalize("a")).toBe("A"); });
  test('"123" -> "123"', () => { expect(capitalize("123")).toBe("123"); });
  test('"" -> ""', () => { expect(capitalize("")).toBe(""); });
});
