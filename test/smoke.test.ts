import { beforeAll, describe, expect, test } from "vitest";
import { JWT_SECRET } from "./config";
import { mintJwt } from "./helpers/jwt";
import { rpc, waitForReady } from "./helpers/http";

// M0 smoke: proves the whole chain stands up from zero — compose → postgres →
// dbmate migrate → PostgREST → JWT. No domain logic is exercised here.
beforeAll(async () => {
  await waitForReady();
}, 70_000);

describe("M0 smoke", () => {
  test("ping RPC returns pong (anonymous)", async () => {
    const res = await rpc("ping");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("pong");
  });

  test("a JWT signed with the configured secret is accepted", async () => {
    const token = mintJwt({ role: "anon" }, JWT_SECRET);
    const res = await rpc("ping", { token });
    expect(res.status).toBe(200);
  });

  test("a JWT signed with the wrong secret is rejected", async () => {
    const token = mintJwt({ role: "anon" }, "wrong-secret-wrong-secret-wrong-32xx");
    const res = await rpc("ping", { token });
    expect(res.status).toBe(401);
  });
});
