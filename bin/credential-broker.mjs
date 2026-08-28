#!/usr/bin/env node
// bin/credential-broker.mjs — THE CREDENTIAL ENVELOPE (v8 step 3; ADR 0028).
//
// The operator seat's problem, stated by step 2's own amendment: the seat was NAMED and
// LEDGERED but not BOUNDED. api.effective_features() trusts the signed token (ADR 0007 puts
// provisioning at mint time), so the seat's prohibitions — no capability:integrate, no
// role:auditor — held only because the CLI chose not to ask for them.
//
// This is the thing that asks instead. The seat no longer signs; it REQUESTS:
//
//   seat → POST 127.0.0.1:PORT/token  (X-Broker-Key: <pre-shared key>)
//            │  1. auth: constant-time PSK compare              (else 401, nothing issued)
//            │  2. api.issue_operator_credential(family, role)  ← THE ENVELOPE, in the DB:
//            │       role ∈ {agent, monitor} · family must hold role:operator ·
//            │       features = the PROVISIONED snapshot, whole and unedited · TTL capped
//            │     …which records the issuance in app.operator_credentials in the SAME
//            │     statement, so there is no path that mints without a trail
//            ▼  3. sign the returned claims with JWT_SECRET
//          200 { token, claims, expires_at }
//
// The broker holds the key; the DATABASE decides what may be in the token. That split is
// the whole design, and api.token_claims has said so since M2 ("the minter signs them") —
// this is the caller it was waiting for.
//
// WHAT THIS IS NOT (the owner chose this deliberately, 2026-08-28). On one host with one OS
// user, a shell-capable seat can read loop.env and sign whatever it likes; no code here can
// stop it. So this is a BOUNDARY FOR A COOPERATING SEAT and an AUDIT TRAIL for one that is
// not: every issued credential records its subject, so an operator act whose actor was never
// issued one shows up in api.unbrokered_operator_acts. Detection, not prevention.
// Prevention needs the seat to run as a separate OS user with no read on the secret — a
// deployment (loop/README.md), not something this file can enforce.
//
// Posture matches the intake channel (ADR 0025): loopback-only, PSK always, single-owner,
// no TLS. Standalone, zero-dep, like bin/intake-server.mjs.

import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = (process.env.AINARRES_BASE_URL || "http://localhost:3010").replace(/\/$/, "");
const SECRET = process.env.JWT_SECRET || "ainarres-dev-only-secret-change-me-min-32-chars";
const HOST = process.env.BROKER_HOST || "127.0.0.1";
const PORT = Number(process.env.BROKER_PORT || 3021);
const SEAT = process.env.BROKER_SEAT_FAMILY || "agent+operator";
const MAX_BODY = 8 * 1024;

// The pre-shared key, same no-ceremony resolution the intake channel uses (v8): supplied,
// else the existing key file, else generated — always persisted 0600 so the seat reads it
// rather than the owner carrying it between shells. There is ALWAYS a key.
const PSK_FILE = process.env.BROKER_PSK_FILE
  || fileURLToPath(new URL("../loop/run/broker.psk", import.meta.url));
let PSK = process.env.BROKER_PSK || "";
let PSK_SOURCE = PSK ? "BROKER_PSK" : "";
if (!PSK) {
  try {
    PSK = readFileSync(PSK_FILE, "utf8").trim();
    if (PSK) PSK_SOURCE = "key file";
  } catch { /* no file yet */ }
}
if (!PSK) {
  PSK = randomBytes(32).toString("hex");
  PSK_SOURCE = "generated";
}
try {
  mkdirSync(dirname(PSK_FILE), { recursive: true });
  writeFileSync(PSK_FILE, `${PSK}\n`, { mode: 0o600 });
} catch (e) {
  console.error(`credential-broker: could not write the key file ${PSK_FILE} (${e.message}) — clients must use BROKER_PSK.`);
}
if (!PSK) {
  console.error("credential-broker: no pre-shared key could be established (no PSK = no auth). Refusing to start.");
  process.exit(2);
}
if (!/^(127\.|::1$|localhost$)/.test(HOST)) {
  console.error(`credential-broker: refusing to bind non-loopback host ${HOST} (ADR 0025 — local, single-owner).`);
  process.exit(2);
}

const b64url = (s) => Buffer.from(s).toString("base64url");

// Sign claims the DATABASE produced. Note what is missing: this function does not build
// claims. It has no opinion about family, role, or features, and cannot acquire one — that
// is what makes it a signer rather than a minter.
function signClaims(claims) {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify(claims));
  const data = `${header}.${payload}`;
  const sig = createHmac("sha256", SECRET).update(data).digest("base64url");
  return `${data}.${sig}`;
}

// The broker's OWN credential for calling the envelope: role `reaper`, which is the coarse
// role api.issue_operator_credential is granted to. Short-lived and never handed out.
function reaperToken() {
  const now = Math.floor(Date.now() / 1000);
  return signClaims({ sub: randomUUID(), family: "loop+driver", role: "reaper", features: [], iat: now, exp: now + 60 });
}

function pskOk(presented) {
  if (typeof presented !== "string" || presented.length === 0) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(PSK);
  if (a.length !== b.length) {
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), Connection: "close" });
  res.end(body);
}

// Read the request. The ONLY caller-controlled inputs are a role and a TTL, and both are
// re-checked in the database — the envelope does not trust this file either.
function toRequest(raw) {
  let parsed;
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    return { error: "body is not valid JSON" };
  }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: "body must be a JSON object" };
  }
  const role = typeof parsed.role === "string" && parsed.role ? parsed.role.trim() : "agent";
  const ttl = Number.isFinite(Number(parsed.ttl)) ? Math.trunc(Number(parsed.ttl)) : 300;
  const reason = typeof parsed.reason === "string" ? parsed.reason.trim().slice(0, 200) : null;
  return { req: { role, ttl, reason } };
}

async function issue({ role, ttl, reason }) {
  const res = await fetch(`${BASE}/rpc/issue_operator_credential`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Connection: "close", Authorization: `Bearer ${reaperToken()}` },
    body: JSON.stringify({ family_key: SEAT, assume_role: role, ttl_seconds: ttl, requested_by: reason }),
  });
  const text = await res.text();
  let env;
  try { env = text ? JSON.parse(text) : null; } catch { env = { raw: text }; }
  return { httpStatus: res.status, env };
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${HOST}`);
  if (url.pathname !== "/token") return send(res, 404, { ok: false, code: "not_found", error: "POST /token only" });
  if (req.method !== "POST") return send(res, 405, { ok: false, code: "method_not_allowed", error: "POST /token only" });

  // Auth FIRST — a wrong or absent key never reaches the envelope, and issues nothing.
  if (!pskOk(req.headers["x-broker-key"])) {
    req.resume();
    return send(res, 401, { ok: false, code: "unauthorized", error: "missing or invalid X-Broker-Key" });
  }

  let body = "";
  let tooBig = false;
  req.on("data", (chunk) => {
    if (tooBig) return;
    body += chunk;
    if (body.length > MAX_BODY) { tooBig = true; send(res, 413, { ok: false, code: "too_large", error: `body exceeds ${MAX_BODY} bytes` }); req.destroy(); }
  });
  req.on("end", async () => {
    if (tooBig) return;
    const { req: parsed, error } = toRequest(body);
    if (error) return send(res, 400, { ok: false, code: "bad_request", error });
    try {
      const { httpStatus, env } = await issue(parsed);
      if (env && env.ok === true && env.event) {
        const claims = env.event;
        console.log(`credential-broker: issued ${claims.role} credential ${claims.sub} to ${claims.family} (ttl ${claims.exp - claims.iat}s)${parsed.reason ? ` — ${parsed.reason}` : ""}`);
        return send(res, 200, {
          ok: true,
          token: signClaims(claims),
          claims,
          expires_at: new Date(claims.exp * 1000).toISOString(),
        });
      }
      // The envelope refused. Surface its reason verbatim — a refusal the seat cannot read
      // is a refusal it will retry forever.
      const status = httpStatus >= 400 ? httpStatus : 422;
      console.log(`credential-broker: envelope refused (${(env && env.code) || httpStatus}): ${(env && env.reason) || "no reason given"}`);
      return send(res, status, {
        ok: false,
        code: (env && env.code) || "substrate_error",
        error: (env && env.reason) || "the envelope refused this credential",
      });
    } catch (e) {
      console.error(`credential-broker: cannot reach substrate at ${BASE}: ${e.message}`);
      return send(res, 502, { ok: false, code: "upstream_unreachable", error: `cannot reach the substrate at ${BASE}` });
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`credential-broker: listening on http://${HOST}:${PORT}/token → substrate ${BASE} (seat=${SEAT})`);
  console.log(`credential-broker: auth = X-Broker-Key (pre-shared, ${PSK_SOURCE}); key file ${PSK_FILE}; loopback-only, single-owner (ADR 0025). Stop with SIGINT/SIGTERM.`);
  console.log("credential-broker: the DATABASE decides what may be in a token (api.issue_operator_credential); this process only signs.");
  if (PSK_SOURCE === "generated") {
    console.log(`credential-broker: generated key ${PSK}`);
  }
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.log(`credential-broker: ${sig} — closing.`);
    server.close(() => process.exit(0));
  });
}
