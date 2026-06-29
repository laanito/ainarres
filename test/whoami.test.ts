import { describe, expect, test } from "vitest";
import { decodeClaims } from "../bin/ainarres.mjs";

describe("decodeClaims", () => {
  test("returns the claims for a hand-built token", () => {
    const payloadObj = {sub:"s1",family:"f1",role:"agent",features:["lane:dev"]};
    const segment = Buffer.from(JSON.stringify(payloadObj)).toString("base64url");
    const token = `header.${segment}.sig`;
    expect(decodeClaims(token)).toEqual(payloadObj);
  });
});
