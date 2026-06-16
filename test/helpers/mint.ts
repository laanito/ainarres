import { randomUUID } from "node:crypto";
import { JWT_SECRET } from "../config";
import { query } from "./db";
import { mintJwt } from "./jwt";

// The TS mirror of api.token_claims (ADR 0007): read a family's provisioned
// features, then sign HS256. The DB owns the authoritative snapshot logic; this
// mirrors it so tests can mint tokens without a two-step privileged round-trip.
// A test asserts the two stay in sync (no drift).

// Provisioned feature names for a family (canonical "kind:key" form), sorted.
export function familyTokenFeatures(familyKey: string): string[] {
  const safe = familyKey.replace(/'/g, "''"); // test-only input, but be tidy
  return query<{ name: string }>(`
    select ft.name
    from app.family_features ff
    join app.agent_families f on f.id = ff.family_id
    join app.features ft on ft.id = ff.feature_id
    where f.key = '${safe}'
    order by ft.name
  `).map((r) => r.name);
}

type MintOpts = {
  ttlSeconds?: number;
  sub?: string;
  features?: string[]; // override the snapshot (e.g. to mint a roleless reaper token)
};

// Mint a signed agent/oversight/reaper token for a family. By default the
// features[] is the family's provisioned snapshot.
export function mintToken(familyKey: string, role: string, opts: MintOpts = {}): string {
  const features = opts.features ?? familyTokenFeatures(familyKey);
  const sub = opts.sub ?? randomUUID();
  return mintJwt(
    { sub, family: familyKey, role, features },
    JWT_SECRET,
    { ttlSeconds: opts.ttlSeconds ?? 900 },
  );
}
