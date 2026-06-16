import { beforeAll, describe, expect, it } from "vitest";
import { exec, query, scalar, waitForDb } from "./helpers/db";
import { waitForReady, rpc } from "./helpers/http";
import { familyTokenFeatures, mintToken } from "./helpers/mint";

// M2: tokens carry the grant; the DB computes effective features (grant − veto)
// and PostgREST role-switching works. Tests drive the real PostgREST surface
// (what an agent sees), with psql for setup/teardown of denials.

const FAMILY = "opencode+qwen"; // provisioned: capability:plan, lane:api, role:analyst

beforeAll(async () => {
  waitForDb();
  await waitForReady();
});

async function jsonOf(res: Response): Promise<any> {
  return res.json();
}

describe("authentication & role switching", () => {
  it("a minted token authenticates and PostgREST SET ROLEs to the role claim", async () => {
    const token = mintToken(FAMILY, "agent");
    const res = await rpc("whoami", { token });
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.role).toBe("agent"); // SET ROLE applied
    expect(body.session_role).toBe("authenticator"); // underlying connection role
    expect(body.family).toBe(FAMILY);
    expect(typeof body.sub).toBe("string");
  });

  it("an unauthenticated caller cannot reach an agent-only function", async () => {
    const res = await rpc("whoami"); // no token → anon, which lacks EXECUTE
    expect(res.ok).toBe(false);
    expect([401, 403]).toContain(res.status);
  });
});

describe("effective_features = grant − veto", () => {
  it("equals the token grant when there are no denials", async () => {
    const token = mintToken(FAMILY, "agent");
    const res = await rpc("effective_features", { token });
    expect(res.status).toBe(200);
    const features = (await jsonOf(res)) as string[];
    expect([...features].sort()).toEqual(familyTokenFeatures(FAMILY)); // already sorted
    expect(features).toContain("role:analyst");
  });

  it("a freshly inserted denial takes effect on the next call (instant revocation)", async () => {
    const token = mintToken(FAMILY, "agent"); // minted BEFORE the denial exists

    const before = (await jsonOf(await rpc("effective_features", { token }))) as string[];
    expect(before).toContain("role:analyst");

    // Governance vetoes role:analyst for the family — server-side, mid-token.
    const ins = exec(`
      insert into app.feature_denials (family_id, feature_id, reason)
      select f.id, ft.id, 'm2 test'
      from app.agent_families f, app.features ft
      where f.key = '${FAMILY}' and ft.name = 'role:analyst'
      on conflict (family_id, feature_id) do nothing
    `);
    expect(ins.ok, ins.error).toBe(true);

    try {
      const after = (await jsonOf(await rpc("effective_features", { token }))) as string[];
      expect(after).not.toContain("role:analyst"); // gone, on the SAME token
      expect(after).toContain("lane:api"); // others untouched
    } finally {
      // Clean up so the suite stays idempotent under reset.
      exec(`
        delete from app.feature_denials d
        using app.agent_families f, app.features ft
        where d.family_id = f.id and d.feature_id = ft.id
          and f.key = '${FAMILY}' and ft.name = 'role:analyst'
      `);
    }

    // Restored after the denial is removed.
    const restored = (await jsonOf(await rpc("effective_features", { token }))) as string[];
    expect(restored).toContain("role:analyst");
  });

  it("features cannot be injected via arguments", async () => {
    // Definitive: the function takes zero parameters, so there is no arg path in.
    const nargs = scalar<number>(`
      select pronargs::int from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'api' and p.proname = 'effective_features'
    `);
    expect(nargs).toBe(0);

    // Behavioral: passing a bogus features body changes nothing (token is the source).
    const token = mintToken(FAMILY, "agent");
    const res = await rpc("effective_features", { token, body: { features: ["role:admin"] } });
    const features = (await jsonOf(res)) as string[] | { code?: string };
    if (Array.isArray(features)) {
      expect(features).not.toContain("role:admin");
    } else {
      // PostgREST rejects the unknown-arg call outright — also proves no arg path.
      expect(res.ok).toBe(false);
    }
  });
});

describe("token_claims — privileged provisioning path", () => {
  it("is reaper-only (an agent cannot mint a grant)", async () => {
    const agentToken = mintToken(FAMILY, "agent");
    const res = await rpc("token_claims", {
      token: agentToken,
      body: { family_key: FAMILY, assume_role: "agent" },
    });
    expect(res.ok).toBe(false);
    expect([401, 403]).toContain(res.status);
  });

  it("snapshots family_features and matches the TS mirror (no drift)", async () => {
    const reaperToken = mintToken(FAMILY, "reaper", { features: [] });
    const res = await rpc("token_claims", {
      token: reaperToken,
      body: { family_key: FAMILY, assume_role: "agent" },
    });
    expect(res.status).toBe(200);
    const claims = await jsonOf(res);

    expect(claims.family).toBe(FAMILY);
    expect(claims.role).toBe("agent");
    expect(typeof claims.sub).toBe("string");
    expect(claims.exp).toBeGreaterThan(claims.iat);
    // The DB snapshot equals what the TS minter would read — they can't drift.
    expect([...claims.features].sort()).toEqual(familyTokenFeatures(FAMILY));
  });

  it("rejects an unknown family", async () => {
    const reaperToken = mintToken(FAMILY, "reaper", { features: [] });
    const res = await rpc("token_claims", {
      token: reaperToken,
      body: { family_key: "no-such-family", assume_role: "agent" },
    });
    // A raised exception surfaces as a DB error (non-200) per ADR 0008 (only
    // genuine faults do; this is a provisioning misuse, not an agent verb).
    expect(res.ok).toBe(false);
  });
});
