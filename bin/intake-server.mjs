#!/usr/bin/env node
// bin/intake-server.mjs — the LOCAL INTAKE CHANNEL (v7 / M26; ADR 0024 Stage 2, gated by
// ADR 0025). The first external ingress this project takes — kept LOCAL and LIGHT.
//
// A tiny loopback-bound HTTP endpoint an external Customer POSTs a request to. It is the
// inbound mirror of the integrator's guarded egress (ADR 0015): just as no untrusted agent
// may push, no untrusted caller may write. The flow (design/service.md D7):
//
//   Customer → POST 127.0.0.1:PORT/intake  (X-Intake-Key: <pre-shared key>)
//                │  1. auth: constant-time PSK compare        (else 401, no row)
//                │  2. validate / sanitize the body to a brief shape (else 400)
//                ▼  3. mint a HUMAN identity token (family=human+intaker, role=agent,
//                      features=[lane:intake, role:intaker]) — NOT the agent workers,
//                      NEVER capability:integrate, NEVER lane:dev
//              create_task(lane_key='intake', payload)  ← the UNCHANGED M24 two-tier gate
//                │      is the INNER WALL: a create in intake needs role:intaker, a create
//                │      in dev needs role:designer — so a channel bug cannot grant what the
//                ▼      substrate withholds (defence in depth).
//              201 { brief_id }  → the standing service (loop/service.sh) drains it hands-off.
//
// Security posture (ADR 0025 — deliberately light, first stage):
//   - binds LOOPBACK only (127.0.0.1); refuses to start on a non-loopback host.
//   - PSK REQUIRED (INTAKE_PSK); refuses to start without one — no PSK = no auth.
//   - single-owner, local; no TLS, no multi-tenant, no rate-limiting (all deferred with a
//     written widening contract in ADR 0025). Runs as the owner, holding JWT_SECRET.
//
// Standalone (no coupling to bin/ainarres.mjs): its own zero-dep HS256 minter + fetch,
// matching the CLI's JWT shape so the substrate accepts the token.

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const BASE = (process.env.AINARRES_BASE_URL || "http://localhost:3010").replace(/\/$/, "");
const SECRET = process.env.JWT_SECRET || "ainarres-dev-only-secret-change-me-min-32-chars";
const HOST = process.env.INTAKE_HOST || "127.0.0.1";
const PORT = Number(process.env.INTAKE_PORT || 3020);
const PSK = process.env.INTAKE_PSK || "";
const FAMILY = process.env.INTAKE_FAMILY || "human+intaker";
const TOKEN_TTL = Number(process.env.INTAKE_TOKEN_TTL || 300);
const MAX_BODY = 64 * 1024; // 64 KiB — a brief is small; cap unbounded input.

// ── Refuse to run without a safe posture (ADR 0025) ───────────────────────────
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);
if (!LOOPBACK.has(HOST)) {
  console.error(`intake-server: refusing to bind non-loopback host '${HOST}'. v7 is local-only (ADR 0025); set INTAKE_HOST to 127.0.0.1/localhost/::1 (or leave unset).`);
  process.exit(2);
}
if (!PSK) {
  console.error("intake-server: INTAKE_PSK is required (no pre-shared key = no auth). Refusing to start.");
  process.exit(2);
}

const b64url = (s) => Buffer.from(s).toString("base64url");
function mintJwt(claims, ttlSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat: now, exp: now + ttlSeconds, ...claims }));
  const data = `${header}.${payload}`;
  const sig = createHmac("sha256", SECRET).update(data).digest("base64url");
  return `${data}.${sig}`;
}

// Constant-time PSK compare that never leaks length via early return.
function pskOk(presented) {
  if (typeof presented !== "string" || presented.length === 0) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(PSK);
  if (a.length !== b.length) {
    // Still do a compare against a same-length buffer to keep timing flat, then fail.
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

// Sanitize the request body into a brief payload. Returns { payload } or { error }.
function toBriefPayload(raw) {
  let parsed;
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    return { error: "body is not valid JSON" };
  }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: "body must be a JSON object" };
  }
  // The request text: accept `request` (preferred) or `goal`. Required, non-empty.
  const request = typeof parsed.request === "string" ? parsed.request.trim()
    : typeof parsed.goal === "string" ? parsed.goal.trim() : "";
  if (!request) return { error: "a non-empty 'request' (or 'goal') string is required" };
  if (request.length > 8000) return { error: "'request' too long (max 8000 chars)" };
  const subject = typeof parsed.subject === "string" ? parsed.subject.trim().slice(0, 200) : null;
  // Store the request as the brief's payload — the intaker/designer read it downstream.
  const payload = { request, submitted_via: "intake-channel" };
  if (subject) payload.subject = subject;
  return { payload };
}

async function createBrief(payload) {
  const token = mintJwt({ sub: randomUUID(), family: FAMILY, role: "agent", features: ["lane:intake", "role:intaker"] }, TOKEN_TTL);
  const res = await fetch(`${BASE}/rpc/create_task`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Connection: "close", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ lane_key: "intake", payload }),
  });
  const text = await res.text();
  let env;
  try { env = text ? JSON.parse(text) : null; } catch { env = { raw: text }; }
  return { httpStatus: res.status, env };
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${HOST}`);
  // Only POST /intake is a real route.
  if (url.pathname !== "/intake") return send(res, 404, { ok: false, code: "not_found", error: "POST /intake only" });
  if (req.method !== "POST") return send(res, 405, { ok: false, code: "method_not_allowed", error: "POST /intake only" });

  // Auth FIRST — a wrong/absent key never reaches the substrate (nor writes a row).
  if (!pskOk(req.headers["x-intake-key"])) {
    // Drain the request so the socket closes cleanly, then 401.
    req.resume();
    return send(res, 401, { ok: false, code: "unauthorized", error: "missing or invalid X-Intake-Key" });
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
    const { payload, error } = toBriefPayload(body);
    if (error) return send(res, 400, { ok: false, code: "bad_request", error });
    try {
      const { httpStatus, env } = await createBrief(payload);
      if (env && env.ok === true && env.task) {
        console.log(`intake-server: created brief ${env.task.id} (${payload.request.slice(0, 60)}${payload.request.length > 60 ? "…" : ""})`);
        return send(res, 201, { ok: true, brief_id: env.task.id, stage: env.task.stage_key ?? null });
      }
      // The substrate refused (e.g. gate) — surface its envelope, mapping to 4xx.
      const status = httpStatus >= 400 ? httpStatus : 422;
      console.log(`intake-server: substrate refused a brief (${env && env.code ? env.code : httpStatus})`);
      return send(res, status, { ok: false, code: (env && env.code) || "substrate_error", error: (env && env.reason) || "substrate refused the brief", detail: env });
    } catch (e) {
      console.error(`intake-server: cannot reach substrate at ${BASE}: ${e.message}`);
      return send(res, 502, { ok: false, code: "upstream_unreachable", error: `cannot reach the substrate at ${BASE}` });
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`intake-server: listening on http://${HOST}:${PORT}/intake → substrate ${BASE} (identity=${FAMILY})`);
  console.log("intake-server: auth = X-Intake-Key (pre-shared); loopback-only, single-owner (ADR 0025). Stop with SIGINT/SIGTERM.");
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { console.log(`\nintake-server: ${sig} — stopping.`); server.close(() => process.exit(0)); });
