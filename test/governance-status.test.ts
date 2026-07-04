import { beforeAll, describe, expect, it } from "vitest";
import { exec, waitForDb } from "./helpers/db";
import { restGet, waitForReady } from "./helpers/http";
import { mintToken } from "./helpers/mint";

// M21 Slice B (v5 governance; design/reflexive-revocation.md D7) — api.governance_status
// read-only view exposing ban/heal/trending/singleton-halt state per
// (family, capability). This test seeds fixture data directly into the app.* tables
// (no RPC/workflow needed — this is a read-only display) and asserts the derived
// booleans are correct.

const FAM_A = "m21b-fam-a"; // ACTIVE temporary denial on 'role:implementer'
const FAM_B = "m21b-fam-b"; // strikes=2 (threshold-1), no denial — trending
const FAM_C = "m21b-fam-c"; // EXPIRED denial on 'role:implementer' — self-healed
const FAM_D = "m21b-fam-d"; // ACTIVE denial on 'role:integrator' — singleton_halt

const FIXTURE = `
  insert into app.features (kind, key) values
    ('role', 'implementer'),
    ('role', 'integrator'),
    ('capability', 'integrate')
  on conflict (kind, key) do nothing;

  insert into app.agent_families (key) values
    ('${FAM_A}'), ('${FAM_B}'), ('${FAM_C}'), ('${FAM_D}')
  on conflict (key) do nothing;

  -- Family A: ACTIVE temporary denial on 'role:implementer' + strikes row
  insert into app.governance_strikes (family_id, feature_id, strikes, ban_count, first_strike_at, last_strike_at)
  select af.id, f.id, 5, 1, now() - interval '1 day', now()
  from app.agent_families af, app.features f
  where af.key = '${FAM_A}' and f.name = 'role:implementer'
  on conflict (family_id, feature_id) do nothing;

  insert into app.feature_denials (family_id, feature_id, reason, expires_at)
  select af.id, f.id, 'temp ban', now() + interval '1 hour'
  from app.agent_families af, app.features f
  where af.key = '${FAM_A}' and f.name = 'role:implementer'
  on conflict (family_id, feature_id) do nothing;

  -- Family B: strikes=2 (threshold-1), NO denial row
  insert into app.governance_strikes (family_id, feature_id, strikes, ban_count, first_strike_at, last_strike_at)
  select af.id, f.id, 2, 0, now() - interval '1 day', now()
  from app.agent_families af, app.features f
  where af.key = '${FAM_B}' and f.name = 'role:implementer'
  on conflict (family_id, feature_id) do nothing;

  -- Family C: EXPIRED denial + strikes row
  insert into app.governance_strikes (family_id, feature_id, strikes, ban_count, first_strike_at, last_strike_at)
  select af.id, f.id, 3, 1, now() - interval '2 days', now()
  from app.agent_families af, app.features f
  where af.key = '${FAM_C}' and f.name = 'role:implementer'
  on conflict (family_id, feature_id) do nothing;

  insert into app.feature_denials (family_id, feature_id, reason, expires_at)
  select af.id, f.id, 'expired ban', now() - interval '1 hour'
  from app.agent_families af, app.features f
  where af.key = '${FAM_C}' and f.name = 'role:implementer'
  on conflict (family_id, feature_id) do nothing;

  -- Family D: ACTIVE denial on 'role:integrator' + strikes row
  insert into app.governance_strikes (family_id, feature_id, strikes, ban_count, first_strike_at, last_strike_at)
  select af.id, f.id, 1, 1, now() - interval '1 day', now()
  from app.agent_families af, app.features f
  where af.key = '${FAM_D}' and f.name = 'role:integrator'
  on conflict (family_id, feature_id) do nothing;

  insert into app.feature_denials (family_id, feature_id, reason, expires_at)
  select af.id, f.id, 'temp integ ban', now() + interval '2 hours'
  from app.agent_families af, app.features f
  where af.key = '${FAM_D}' and f.name = 'role:integrator'
  on conflict (family_id, feature_id) do nothing;
`;

const json = (r: Response) => r.json() as Promise<any>;
const oversight = () => mintToken(FAM_A, "oversight", { features: [] });

beforeAll(async () => {
  waitForDb();
  const res = exec(FIXTURE);
  if (!res.ok) throw new Error(`fixture failed: ${res.error}`);
  await waitForReady();
});

describe("api.governance_status", () => {
  it("Family A: ACTIVE temporary denial on role:implementer → banned=true, permanent=false, seconds_to_heal>0, trending=false", async () => {
    const rows = await json(
      await restGet(`governance_status?family=eq.${FAM_A}`, { token: oversight() }),
    );
    expect(rows.length).toBe(1);
    const r = rows[0];
    expect(r.family).toBe(FAM_A);
    expect(r.capability).toBe("role:implementer");
    expect(r.banned).toBe(true);
    expect(r.permanent).toBe(false);
    expect(r.heal_at).not.toBeNull();
    expect(Number(r.seconds_to_heal)).toBeGreaterThan(0);
    expect(r.trending).toBe(false);
    expect(r.singleton_halt).toBe(false);
  });

  it("Family B: strikes=2 (threshold-1), no denial → trending=true, banned=false", async () => {
    const rows = await json(
      await restGet(`governance_status?family=eq.${FAM_B}`, { token: oversight() }),
    );
    expect(rows.length).toBe(1);
    const r = rows[0];
    expect(r.family).toBe(FAM_B);
    expect(r.capability).toBe("role:implementer");
    expect(r.strikes).toBe(2);
    expect(r.threshold).toBe(3);
    expect(r.banned).toBe(false);
    expect(r.permanent).toBe(false);
    expect(r.trending).toBe(true);
    expect(r.heal_at).toBeNull();
    expect(r.seconds_to_heal).toBeNull();
  });

  it("Family C: EXPIRED denial on capability → banned=false (self-healed)", async () => {
    const rows = await json(
      await restGet(`governance_status?family=eq.${FAM_C}`, { token: oversight() }),
    );
    expect(rows.length).toBe(1);
    const r = rows[0];
    expect(r.family).toBe(FAM_C);
    expect(r.capability).toBe("role:implementer");
    expect(r.banned).toBe(false);
    expect(r.permanent).toBe(false);
    expect(r.heal_at).toBeNull();
    expect(r.seconds_to_heal).toBeNull();
  });

  it("Family D: ACTIVE denial on role:integrator → singleton_halt=true, banned=true", async () => {
    const rows = await json(
      await restGet(`governance_status?family=eq.${FAM_D}`, { token: oversight() }),
    );
    expect(rows.length).toBe(1);
    const r = rows[0];
    expect(r.family).toBe(FAM_D);
    expect(r.capability).toBe("role:integrator");
    expect(r.banned).toBe(true);
    expect(r.singleton_halt).toBe(true);
  });

  it("is oversight-only (anonymous read is refused)", async () => {
    const anon = await restGet("governance_status?limit=1");
    expect(anon.status).toBeGreaterThanOrEqual(400);
  });
});
