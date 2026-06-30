import { describe, expect, test } from "vitest";
import { secondsToExpiry } from "../bin/ainarres.mjs";

describe("secondsToExpiry", () => {
  test("returns the exact positive remaining seconds for future exp", () => {
    const payloadObj = { sub: "s1", exp: 1000 };
    const segment = Buffer.from(JSON.stringify(payloadObj)).toString("base64url");
    const token = `header.${segment}.sig`;
    expect(secondsToExpiry(token, 600)).toBe(400);
  });
  test("returns a negative number for an already-expired token", () => {
    const payloadObj = { sub: "s1", exp: 1000 };
    const segment = Buffer.from(JSON.stringify(payloadObj)).toString("base64url");
    const token = `header.${segment}.sig`;
    expect(secondsToExpiry(token, 1500)).toBe(-500);
  });
});
