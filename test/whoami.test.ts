import { describe, expect, test } from "vitest";
import { decodeClaims } from "../bin/ainarres.mjs";

describe("decodeClaims", () => {
  test("returns the claims for a hand-built token", () => {
    const payloadObj = {sub:"s1",family:"f1",role:"agent",features:["lane:dev"]};
    const segment = Buffer.from(JSON.stringify(payloadObj)).toString("base64url");
    const token = `header.${segment}.sig`;
    expect(decodeClaims(token)).toEqual(payloadObj);
  });

  test("throws on non-string input", () => {
    expect(() => decodeClaims(null)).toThrow(/malformed token/);
  });

  test("throws on token with fewer than 3 segments", () => {
    expect(() => decodeClaims("not-a-jwt")).toThrow(/malformed token/);
    expect(() => decodeClaims("a.b")).toThrow(/malformed token/);
  });

  test("throws on empty payload segment", () => {
    expect(() => decodeClaims("a..c")).toThrow(/malformed token/);
  });

  test("throws on non-JSON payload", () => {
    const payload = Buffer.from("notjson").toString("base64url");
    expect(() => decodeClaims(`header.${payload}.sig`)).toThrow(/malformed token/);
  });
});
