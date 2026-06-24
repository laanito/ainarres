#!/usr/bin/env node
// ainarres — the agent-facing CLI. Self-contained: only node: built-ins, no npm
// install, no transpile, no bundler. Talks ONLY the PostgREST HTTP surface (the
// same surface agents see), so it needs no DB driver. Runs anywhere Node >= 18.
//
// Config (env): AINARRES_BASE_URL (default http://localhost:3010), JWT_SECRET
// (for `token`), AINARRES_TOKEN (bearer for the verb/view calls; --token overrides).
//
// Output: the verb envelope (or view rows) as JSON on stdout. Exit code is 1 when
// an envelope comes back ok:false, so a shell-driven worker can branch on success.

import { createHmac, randomUUID } from "node:crypto";
import { parseArgs } from "node:util";

const BASE = (process.env.AINARRES_BASE_URL || "http://localhost:3010").replace(/\/$/, "");
const SECRET = process.env.JWT_SECRET || "ainarres-dev-only-secret-change-me-min-32-chars";

const b64url = (s) => Buffer.from(s).toString("base64url");

function mintJwt(claims, ttlSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat: now, exp: now + ttlSeconds, ...claims }));
  const data = `${header}.${payload}`;
  const sig = createHmac("sha256", SECRET).update(data).digest("base64url");
  return `${data}.${sig}`;
}

function emit(obj, ok) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
  if (ok === false) process.exit(1);
}

function fail(msg) {
  process.stderr.write(`ainarres: ${msg}\n`);
  process.exit(2);
}

const bearer = (v) => v.token || process.env.AINARRES_TOKEN;

async function rpc(name, body, token) {
  let res;
  try {
    res = await fetch(`${BASE}/rpc/${name}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body ?? {}),
    });
  } catch (e) {
    fail(`cannot reach ${BASE} (${e.message})`);
  }
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, httpOk: res.ok, body: json };
}

async function restGet(path, token) {
  let res;
  try {
    res = await fetch(`${BASE}/${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  } catch (e) {
    fail(`cannot reach ${BASE} (${e.message})`);
  }
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, httpOk: res.ok, body: json };
}

// Parse flags + positionals for a subcommand.
function args(rest, options) {
  return parseArgs({ args: rest, options, allowPositionals: true });
}

const artifactsOf = (vals) => (vals.artifact ?? []).map((path) => ({ type: "file", path }));

// Send a verb call and print its envelope (exit 1 on ok:false).
async function callVerb(name, body, token) {
  const r = await rpc(name, body, token);
  const ok = r.body && typeof r.body === "object" ? r.body.ok : r.httpOk;
  emit(r.body ?? { ok: false, code: "http_error", status: r.status }, ok);
}

const COMMANDS = {
  // Mint an HS256 token locally (operator holds the secret; signing lives outside
  // the DB per M2). Features are explicit; this never reads the DB.
  token(rest) {
    const { values } = args(rest, {
      family: { type: "string" },
      role: { type: "string" },
      features: { type: "string" },
      sub: { type: "string" },
      ttl: { type: "string" },
    });
    if (!values.family) fail("token: --family is required");
    const features = (values.features ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const claims = {
      sub: values.sub ?? randomUUID(),
      family: values.family,
      role: values.role ?? "agent",
      features,
    };
    emit({ token: mintJwt(claims, values.ttl ? Number(values.ttl) : 900), claims });
  },

  create(rest, values, token) {
    const payload = values.payload ? JSON.parse(values.payload) : {};
    if (values.instructions) payload.instructions = values.instructions;
    if (values.entry) payload.entry = values.entry;
    if (values.validate) payload.validate = values.validate;
    const body = { lane_key: values.lane, payload, priority: values.priority ? Number(values.priority) : 0 };
    if (values.subject) body.subject = values.subject;
    if (values["depends-on"]) {
      body.depends_on = values["depends-on"].split(",").map((s) => s.trim()).filter(Boolean);
    }
    return callVerb("create_task", body, token);
  },

  claim: (rest, values, token) => callVerb("claim_next_task", { lane_key: values.lane ?? null }, token),

  progress: (rest, values, token, id) =>
    callVerb("report_progress", { task_id: id, note: values.note ?? "", artifacts: artifactsOf(values) }, token),

  advance: (rest, values, token, id) =>
    callVerb("advance_task", { task_id: id, to_stage: values.to, note: values.note ?? null, artifacts: artifactsOf(values) }, token),

  reject: (rest, values, token, id) =>
    callVerb("reject_task", { task_id: id, to_stage: values.to, reason: values.reason ?? "", artifacts: artifactsOf(values) }, token),

  release: (rest, values, token, id) => callVerb("release_task", { task_id: id, reason: values.reason ?? null }, token),
  block: (rest, values, token, id) => callVerb("block_task", { task_id: id, reason: values.reason ?? "" }, token),
  unblock: (rest, values, token, id) => callVerb("unblock_task", { task_id: id, note: values.note ?? null }, token),
  heartbeat: (rest, values, token, id) => callVerb("heartbeat", { task_id: id }, token),

  async board(rest, values, token) {
    const q = new URLSearchParams();
    if (values.lane) q.set("lane", `eq.${values.lane}`);
    if (values.limit) q.set("limit", values.limit);
    const r = await restGet(`board?${q}`, token);
    emit(r.body, r.httpOk);
  },
  async feed(rest, values, token) {
    const q = new URLSearchParams();
    if (values.lane) q.set("lane", `eq.${values.lane}`);
    if (values.task) q.set("task_id", `eq.${values.task}`);
    q.set("limit", values.limit ?? "50");
    const r = await restGet(`feed?${q}`, token);
    emit(r.body, r.httpOk);
  },
  async abandoned(rest, values, token) {
    const q = new URLSearchParams();
    if (values.lane) q.set("lane", `eq.${values.lane}`);
    const r = await restGet(`abandoned?${q}`, token);
    emit(r.body, r.httpOk);
  },
};

// Options each verb/view command accepts (token is global).
const OPTS = {
  create: { lane: { type: "string" }, instructions: { type: "string" }, entry: { type: "string" }, validate: { type: "string" }, payload: { type: "string" }, priority: { type: "string" }, subject: { type: "string" }, "depends-on": { type: "string" }, token: { type: "string" } },
  claim: { lane: { type: "string" }, token: { type: "string" } },
  progress: { note: { type: "string" }, artifact: { type: "string", multiple: true }, token: { type: "string" } },
  advance: { to: { type: "string" }, note: { type: "string" }, artifact: { type: "string", multiple: true }, token: { type: "string" } },
  reject: { to: { type: "string" }, reason: { type: "string" }, artifact: { type: "string", multiple: true }, token: { type: "string" } },
  release: { reason: { type: "string" }, token: { type: "string" } },
  block: { reason: { type: "string" }, token: { type: "string" } },
  unblock: { note: { type: "string" }, token: { type: "string" } },
  heartbeat: { token: { type: "string" } },
  board: { lane: { type: "string" }, limit: { type: "string" }, token: { type: "string" } },
  feed: { lane: { type: "string" }, task: { type: "string" }, limit: { type: "string" }, token: { type: "string" } },
  abandoned: { lane: { type: "string" }, token: { type: "string" } },
};

const USAGE = `ainarres — agent CLI (verbs over PostgREST)

  token   --family F --role R --features a,b [--sub S] [--ttl 900]
  create  --lane L [--instructions T --entry F --validate CMD | --payload JSON] [--priority N] [--subject UUID] [--depends-on ID,ID]
  claim   [--lane L]
  progress  <task-id> [--note T] [--artifact PATH ...]
  advance   <task-id> --to STAGE [--note T] [--artifact PATH ...]
  reject    <task-id> --to STAGE --reason T [--artifact PATH ...]
  release   <task-id> [--reason T]
  block     <task-id> --reason T
  unblock   <task-id> [--note T]
  heartbeat <task-id>
  board | feed | abandoned [--lane L] [--task UUID] [--limit N]

env: AINARRES_BASE_URL, JWT_SECRET (token), AINARRES_TOKEN (bearer; --token overrides)`;

const [, , cmd, ...rest] = process.argv;

if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
  process.stdout.write(`${USAGE}\n`);
  process.exit(cmd ? 0 : 1);
}
if (!COMMANDS[cmd]) fail(`unknown command '${cmd}'. Try 'ainarres help'.`);

if (cmd === "token") {
  COMMANDS.token(rest);
} else {
  const { values, positionals } = args(rest, OPTS[cmd]);
  const token = bearer(values);
  const needsToken = !["token"].includes(cmd);
  if (needsToken && !token) fail(`${cmd}: no token (set AINARRES_TOKEN or pass --token)`);
  await COMMANDS[cmd](rest, values, token, positionals[0]);
}
