import { createHmac } from "node:crypto";

// Minimal HS256 JWT signer — no dependency. Enough for tests and, later, the thin
// agent client. Token-claim shape follows ADR 0007 (sub, family, role, features, exp).
const b64url = (input: string): string => Buffer.from(input).toString("base64url");

export function mintJwt(
  claims: Record<string, unknown>,
  secret: string,
  { ttlSeconds = 300 }: { ttlSeconds?: number } = {},
): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({ iat: now, exp: now + ttlSeconds, ...claims }),
  );
  const data = `${header}.${payload}`;
  const sig = createHmac("sha256", secret).update(data).digest("base64url");
  return `${data}.${sig}`;
}
