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
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

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

// Artifacts are references, never content (ADR 0003). --artifact carries files;
// --pr/--branch/--commit carry egress references for the integrate stage (ADR 0015).
function artifactsOf(vals) {
  const arts = (vals.artifact ?? []).map((path) => ({ type: "file", path }));
  if (vals.pr) arts.push({ type: "pr", url: vals.pr });
  if (vals.branch) arts.push({ type: "branch", name: vals.branch });
  if (vals.commit) arts.push({ type: "commit", sha: vals.commit });
  return arts;
}

// Send a verb call and print its envelope (exit 1 on ok:false).
async function callVerb(name, body, token) {
  const r = await rpc(name, body, token);
  const ok = r.body && typeof r.body === "object" ? r.body.ok : r.httpOk;
  emit(r.body ?? { ok: false, code: "http_error", status: r.status }, ok);
}

// Pure, deterministic formatter for the oversight `status` view. Takes already-
// fetched view rows (board/feed/abandoned) and returns a one-glance multi-line
// summary string. No I/O, no fetch, no clock — same input → same output. The
// `status` subcommand (a follow-up task) will fetch the views and pass them here.
export function formatStatus({ board = [], feed = [], abandoned = [] }, { lane = null, feedLimit = 10 } = {}) {
  const lines = [];

  // 1. Header.
   lines.push(lane ? `status — lane ${lane} (${board.length} tasks)` : `status — all lanes (${board.length} tasks)`);

  // 2. Per-stage task summary from board.
  if (board.length === 0) {
    lines.push("  (no tasks)");
  } else {
    const byStage = new Map();
    for (const row of board) {
      const stage = row.stage;
      byStage.set(stage, (byStage.get(stage) ?? 0) + 1);
    }
    for (const stage of [...byStage.keys()].sort()) {
      lines.push(`  ${stage}: ${byStage.get(stage)}`);
    }
    lines.push(`  total: ${board.length}`);
  }

  // blocked count (always emitted, even when 0)
  const blockedCount = board.filter(r => r.blocked === true).length;
  lines.push(`  blocked: ${blockedCount}`);
  if (blockedCount > 0) {
    for (const row of board) {
      if (row.blocked === true) {
        lines.push(`  - ${row.task_id}`);
      }
    }
  }

  // claimed count (always emitted, even when 0)
  const claimedCount = board.filter(r => r.claimed_by != null).length;
  lines.push(`  claimed: ${claimedCount}`);

  // 3. Abandoned section.
  lines.push(`abandoned (${abandoned.length}):`);
  if (abandoned.length === 0) {
    lines.push("  (none)");
  } else {
    for (const row of abandoned) {
      lines.push(`  - ${row.task_id} [${row.stage}] claimed_by=${row.claimed_by}`);
    }
  }

  // 4. Recent events — feed is already newest-first; take the first feedLimit.
  lines.push(`recent events (showing up to ${feedLimit}):`);
  if (feed.length === 0) {
    lines.push("  (no events)");
  } else {
    for (const ev of feed.slice(0, feedLimit)) {
      lines.push(`  - ${ev.created_at} ${ev.type} ${ev.task_id} by ${ev.actor}`);
    }
  }

  return lines.join("\n");
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

  // Prints the version from package.json on a single line. No token, no network,
  // no DB. Follows the plain-output style of status (and the no-token style of token).
  version() {
    const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    process.stdout.write(`ainarres ${pkg.version}\n`);
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

  // Single heartbeat, or a BOUNDED auto-heartbeat (--watch): renew the lease every
  // --interval seconds until --max seconds have elapsed, then stop on our own. The
  // bound is the safety: a forgotten/orphaned watcher can't hold a lease forever —
  // once it stops, the lease expires and the task is reclaimable (ADR 0009). Stops
  // immediately if a renewal comes back not-ok (e.g. lease_lost).
  async heartbeat(rest, values, token, id) {
    if (!values.watch) return callVerb("heartbeat", { task_id: id }, token);
    const interval = values.interval ? Number(values.interval) : 60;
    const max = values.max ? Number(values.max) : 3600;
    const started = Date.now();
    let beats = 0;
    for (;;) {
      const r = await rpc("heartbeat", { task_id: id }, token);
      const env = r.body && typeof r.body === "object" ? r.body : { ok: r.httpOk };
      if (env.ok !== true) {
        emit(env, false); // lease_lost / not_found / etc — stop the watcher
        return;
      }
      beats += 1;
      const elapsed = (Date.now() - started) / 1000;
      if (elapsed + interval > max) {
        emit({ ok: true, code: "ok", watched: true, beats, elapsed: Math.round(elapsed) });
        return;
      }
      await new Promise((res) => setTimeout(res, interval * 1000));
    }
  },

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

  // One-glance oversight summary: fetch board/feed/abandoned views in parallel and
  // hand the rows to the pure formatStatus(). Prints HUMAN TEXT (not JSON). Needs an
  // oversight-capable token at runtime (the views are granted to the oversight role);
  // a non-oversight token gets a PostgREST 401/403 → JSON error envelope + exit 1.
  async status(rest, values, token) {
    const lane = values.lane ?? null;
    const laneFilter = (q) => { if (lane) q.set("lane", `eq.${lane}`); return q; };
    const feedLimit = values.limit ? Number(values.limit) : 10;
    const boardQ = laneFilter(new URLSearchParams());
    const feedQ = laneFilter(new URLSearchParams()); feedQ.set("limit", String(feedLimit));
    const abandQ = laneFilter(new URLSearchParams());
    const [b, f, a] = await Promise.all([
      restGet(`board?${boardQ}`, token),
      restGet(`feed?${feedQ}`, token),
      restGet(`abandoned?${abandQ}`, token),
    ]);
    for (const r of [b, f, a]) {
      if (!r.httpOk) { emit(r.body ?? { ok: false, code: "http_error", status: r.status }, false); return; }
    }
    const summary = formatStatus(
      { board: b.body, feed: f.body, abandoned: a.body },
      { lane, feedLimit },
    );
    process.stdout.write(`${summary}\n`);
  },
};

// Options each verb/view command accepts (token is global).
const OPTS = {
  create: { lane: { type: "string" }, instructions: { type: "string" }, entry: { type: "string" }, validate: { type: "string" }, payload: { type: "string" }, priority: { type: "string" }, subject: { type: "string" }, "depends-on": { type: "string" }, token: { type: "string" } },
  claim: { lane: { type: "string" }, token: { type: "string" } },
  progress: { note: { type: "string" }, artifact: { type: "string", multiple: true }, pr: { type: "string" }, branch: { type: "string" }, commit: { type: "string" }, token: { type: "string" } },
  advance: { to: { type: "string" }, note: { type: "string" }, artifact: { type: "string", multiple: true }, pr: { type: "string" }, branch: { type: "string" }, commit: { type: "string" }, token: { type: "string" } },
  reject: { to: { type: "string" }, reason: { type: "string" }, artifact: { type: "string", multiple: true }, pr: { type: "string" }, branch: { type: "string" }, commit: { type: "string" }, token: { type: "string" } },
  release: { reason: { type: "string" }, token: { type: "string" } },
  block: { reason: { type: "string" }, token: { type: "string" } },
  unblock: { note: { type: "string" }, token: { type: "string" } },
  heartbeat: { watch: { type: "boolean" }, interval: { type: "string" }, max: { type: "string" }, token: { type: "string" } },
  board: { lane: { type: "string" }, limit: { type: "string" }, token: { type: "string" } },
  feed: { lane: { type: "string" }, task: { type: "string" }, limit: { type: "string" }, token: { type: "string" } },
  abandoned: { lane: { type: "string" }, token: { type: "string" } },
  status: { lane: { type: "string" }, limit: { type: "string" }, token: { type: "string" } },
};

const USAGE = `ainarres — agent CLI (verbs over PostgREST)

  token   --family F --role R --features a,b [--sub S] [--ttl 900]
  version   print CLI version (from package.json; no token)
  create  --lane L [--instructions T --entry F --validate CMD | --payload JSON] [--priority N] [--subject UUID] [--depends-on ID,ID]
  claim   [--lane L]
  progress  <task-id> [--note T] [--artifact PATH ...] [--pr URL --branch NAME --commit SHA]
  advance   <task-id> --to STAGE [--note T] [--artifact PATH ...] [--pr URL --branch NAME --commit SHA]
  reject    <task-id> --to STAGE --reason T [--artifact PATH ...]
  release   <task-id> [--reason T]
  block     <task-id> --reason T
  unblock   <task-id> [--note T]
  heartbeat <task-id> [--watch --interval 60 --max 3600]
  board | feed | abandoned [--lane L] [--task UUID] [--limit N]
  status  [--lane L] [--limit N]   one-glance oversight summary (board + abandoned + recent feed)

env: AINARRES_BASE_URL, JWT_SECRET (token), AINARRES_TOKEN (bearer; --token overrides)`;

// Only run the CLI when executed directly (`node bin/ainarres.mjs …`), not when
// imported (e.g. by a unit test that exercises the pure helpers above).
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const [, , cmd, ...rest] = process.argv;

  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    process.stdout.write(`${USAGE}\n`);
    process.exit(cmd ? 0 : 1);
  }
  if (!COMMANDS[cmd]) fail(`unknown command '${cmd}'. Try 'ainarres help'.`);

  if (cmd === "token" || cmd === "version") {
    COMMANDS[cmd](rest);
  } else {
    const { values, positionals } = args(rest, OPTS[cmd]);
    const token = bearer(values);
    const needsToken = !["token", "version"].includes(cmd);
    if (needsToken && !token) fail(`${cmd}: no token (set AINARRES_TOKEN or pass --token)`);
    await COMMANDS[cmd](rest, values, token, positionals[0]);
  }
}
