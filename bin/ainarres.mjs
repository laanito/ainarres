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

  // 2b. Active holders (M16): claimed-and-not-abandoned tasks, by durable family
  // and age-in-stage — "who's working what, and for how long". Bare uuids if the
  // enriched board columns aren't present (older view). Empty → no lines.
  const active = board.filter(r => r.claimed_by != null && r.abandoned !== true);
  if (active.length > 0) {
    lines.push(`active (${active.length}):`);
    for (const row of active) {
      lines.push(`  - ${row.task_id} [${row.stage}] ${holderOf(row)}${ageOf(row)}`);
    }
  }

  // 3. Abandoned section (stranded work) — now naming the holding family + age.
  lines.push(`abandoned (${abandoned.length}):`);
  if (abandoned.length === 0) {
    lines.push("  (none)");
  } else {
    for (const row of abandoned) {
      lines.push(`  - ${row.task_id} [${row.stage}] claimed_by=${row.claimed_by}${famSuffix(row)}${ageOf(row)}`);
    }
  }

  // 3b. Why-stuck (M16): recent escalations for tasks still on the board — a task
  // that burned the cheap tier and now waits on a higher one (ADR 0019). Derived
  // from the event stream (type 'escalated'); plain-language, deduped by task.
  const liveTasks = new Set(board.filter(r => r.is_terminal !== true).map(r => r.task_id));
  const escalations = [];
  const seenEsc = new Set();
  for (const ev of feed) {
    if (ev.type !== "escalated" || !liveTasks.has(ev.task_id) || seenEsc.has(ev.task_id)) continue;
    seenEsc.add(ev.task_id);
    escalations.push(ev);
  }
  if (escalations.length > 0) {
    lines.push(`escalated (${escalations.length}):`);
    for (const ev of escalations) {
      const to = ev.data?.to_tier;
      lines.push(`  - ${ev.task_id} → tier:${to ?? "?"} (waiting for a higher tier)`);
    }
  }

  // 4. Recent events — feed is already newest-first; take the first feedLimit.
  // Attribute by family when the row carries it (timeline), else the actor uuid.
  lines.push(`recent events (showing up to ${feedLimit}):`);
  if (feed.length === 0) {
    lines.push("  (no events)");
  } else {
    for (const ev of feed.slice(0, feedLimit)) {
      lines.push(`  - ${ev.created_at} ${ev.type} ${ev.task_id} by ${ev.family ?? ev.actor ?? "—"}`);
    }
  }

  return lines.join("\n");
}

// Small pure helpers for the M16 board enrichment (no I/O; tolerate older rows).
function holderOf(row) {
  return row.claimed_by_family ?? row.claimed_by ?? "—";
}
function famSuffix(row) {
  return row.claimed_by_family ? ` family=${row.claimed_by_family}` : "";
}
function ageOf(row) {
  return row.age_in_stage != null ? ` age=${row.age_in_stage}` : "";
}

// Pure, deterministic formatter for the M16 event timeline (api.timeline rows:
// already newest-first, joined to the acting family). One line per event:
// `<created_at>  <type>  <task_id>  <family|actor|—>  ⟨reason⟩`. No I/O, no clock.
export function formatEvents(rows = [], { limit = 50 } = {}) {
  const lines = [`timeline (showing up to ${limit}):`];
  if (rows.length === 0) {
    lines.push("  (no events)");
    return lines.join("\n");
  }
  for (const ev of rows.slice(0, limit)) {
    const who = ev.family ?? ev.actor ?? "—";
    lines.push(`  ${ev.created_at}  ${ev.type}  ${ev.task_id}  ${who}${reasonOf(ev)}`);
  }
  return lines.join("\n");
}

// Pure, deterministic END-OF-RUN report (M16, ADR 0021 D5): a rendering of the
// board + event timeline a drained loop comes back to. Names what shipped (with
// PRs), what failed and why, escalations, and per-family activity. No I/O, no
// clock — the driver fetches the rows and passes them here.
// Scan timeline for the first transition event matching taskId + stage transition.
// Returns the acting family (non-empty string), or null if not found or family absent.
function familyOfTransition(timeline, taskId, from, to) {
  for (const ev of timeline) {
    if (ev.type !== "transition") continue;
    if (ev.task_id !== taskId) continue;
    if (ev.data?.from !== from || ev.data?.to !== to) continue;
    const family = ev.family;
    if (family && typeof family === "string" && family.length > 0) return family;
    return null; // found but family is null/empty → treat as unknown
  }
  return null;
}

// Compact token count for the report (1234 → "1.2k", 1_200_000 → "1.2M"). null/
// undefined → "unknown" — a family we could not measure must read as unknown, NEVER
// as 0 (which would read as free). Pure.
export function fmtTokens(n) {
  if (n == null) return "unknown";
  const v = Number(n);
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return String(v);
}

// Format seconds-to-heal for a temporary ban (v5 governance). Pure. Returns a
// human string like "1h 30m" or null when the value is absent/invalid.
function fmtHeal(secs) {
  if (secs == null || Number(secs) < 0 || Number.isNaN(Number(secs))) return null;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return `${h}h ${m}m`;
}

export function formatReport({ board = [], timeline = [], trackRecord = [], governance = [] } = {}, { lane = null } = {}) {
  const lines = [lane ? `end-of-run report — lane ${lane}` : "end-of-run report — all lanes"];

  // Newest-first PR reference for a task, dug out of its transition artifacts.
  const prFor = (taskId) => {
    for (const ev of timeline) {
      if (ev.task_id !== taskId) continue;
      const arts = ev.data?.artifacts;
      if (Array.isArray(arts)) {
        const pr = arts.find((a) => a && a.type === "pr" && a.url);
        if (pr) return pr.url;
      }
    }
    return null;
  };

  // What shipped: tasks at a terminal stage.
  const shipped = board.filter((r) => r.is_terminal === true);
  lines.push(`shipped (${shipped.length}):`);
  if (shipped.length === 0) lines.push("  (none)");
  for (const row of shipped) {
    lines.push(`  - ${row.task_id}  ${prFor(row.task_id) ?? "(no PR ref)"}`);
    // Per-task stage→family attribution.
    const implBy = familyOfTransition(timeline, row.task_id, "implementing", "reviewing");
    const revBy = familyOfTransition(timeline, row.task_id, "reviewing", "integrating");
    const intBy = familyOfTransition(timeline, row.task_id, "integrating", "validating");
    lines.push(`      by family: implemented=${implBy ?? "\u2014"} reviewed=${revBy ?? "\u2014"} integrated=${intBy ?? "\u2014"}`);
  }

  // Cross-family review summary.
  const reviewedTasks = shipped.filter((row) => {
    const implBy = familyOfTransition(timeline, row.task_id, "implementing", "reviewing");
    const revBy = familyOfTransition(timeline, row.task_id, "reviewing", "integrating");
    return implBy != null && revBy != null;
  });
  const M = reviewedTasks.length;
  const N = reviewedTasks.filter((row) => {
    const implBy = familyOfTransition(timeline, row.task_id, "implementing", "reviewing");
    const revBy = familyOfTransition(timeline, row.task_id, "reviewing", "integrating");
    return revBy !== implBy;
  }).length;
  if (M > 0) {
    lines.push(`      cross-family review: ${N}/${M} shipped tasks reviewed by a different family than implemented`);
  } else {
    lines.push(`      cross-family review: n/a (no reviewed tasks)`);
  }

  // What failed: blocked tasks, with the reason.
  const failed = board.filter((r) => r.blocked === true);
  lines.push(`failed/blocked (${failed.length}):`);
  if (failed.length === 0) lines.push("  (none)");
  for (const row of failed) lines.push(`  - ${row.task_id}: ${row.blocked_reason ?? "?"}`);

  // Escalations: deduped by task, naming the tier it climbed to.
  const escSeen = new Set();
  const escalations = [];
  for (const ev of timeline) {
    if (ev.type !== "escalated" || escSeen.has(ev.task_id)) continue;
    escSeen.add(ev.task_id);
    escalations.push(ev);
  }
  lines.push(`escalations (${escalations.length}):`);
  if (escalations.length === 0) lines.push("  (none)");
  for (const ev of escalations) lines.push(`  - ${ev.task_id} → tier:${ev.data?.to_tier ?? "?"}`);

  // Activity by family: who did how much (which tier carried the work).
  const byFamily = new Map();
  for (const ev of timeline) {
    const fam = ev.family ?? "(human/system)";
    byFamily.set(fam, (byFamily.get(fam) ?? 0) + 1);
  }
  lines.push("activity by family:");
  if (byFamily.size === 0) lines.push("  (none)");
  for (const fam of [...byFamily.keys()].sort()) lines.push(`  - ${fam}: ${byFamily.get(fam)} events`);

  // Family track record (M20, api.family_track_record): the fair, attributable
  // per-(family, capability) record the M21 ban rule will read. Competence (delivered
  // / rejected / reject-rate / cross-family) and token spend are shown SIDE BY SIDE but
  // never blended — spend ≠ competence (D3): a token-heavy family reads as expensive,
  // not failing. Tokens are "unknown" (not 0) for a family whose harness emits no
  // parseable counts (opencode/grok today) — unknown ≠ free.
  lines.push("family track record (competence · spend — kept separate; M20 signal, no consequence yet):");
  if (trackRecord.length === 0) {
    lines.push("  (none)");
  } else {
    const sorted = [...trackRecord].sort((a, b) =>
      (a.family ?? "").localeCompare(b.family ?? "") || (a.capability ?? "").localeCompare(b.capability ?? ""));
    for (const r of sorted) {
      const rate = r.reject_rate == null ? "n/a" : `${Math.round(Number(r.reject_rate) * 100)}%`;
      const perDel = r.tokens_per_delivery == null ? "" : `, ${fmtTokens(r.tokens_per_delivery)}/delivery`;
      lines.push(
        `  - ${r.family} / ${r.capability}: ` +
        `${r.delivered} delivered, ${r.rejected} rejected (${rate}), ${r.cross_family_rejected} cross-family` +
        ` · tokens: ${fmtTokens(r.total_tokens)}${perDel}`,
      );
    }
    lines.push("  (spend is a separate signal — a token-heavy but passing family is expensive, not failing)");
  }

  // Governance section (v5 — substrate-revoked capabilities): rows from
  // api.governance_status. Banned (permanent first, then temp) before trending.
  // Pure, null-guarded, never throws.
  lines.push("governance (v5 — substrate-revoked capabilities):");
  const banned = governance.filter(r => r && r.banned === true);
  const trending = governance.filter(r => r && r.trending === true && r.banned !== true);
  if (banned.length === 0 && trending.length === 0) {
    lines.push("  (all families in good standing)");
  } else {
    const govSort = (a, b) =>
      (a.family ?? "").localeCompare(b.family ?? "") || (a.capability ?? "").localeCompare(b.capability ?? "");
    for (const r of [...banned].sort(govSort)) {
      if (r.permanent === true) {
        lines.push(`  - ${r.family} / ${r.capability}: BANNED (permanent — human)`);
      } else {
        const heal = fmtHeal(r.seconds_to_heal);
        const suffix = heal != null ? `heals in ${heal}` : "healing";
        lines.push(`  - ${r.family} / ${r.capability}: BANNED (${suffix})`);
      }
    }
    for (const r of [...trending].sort(govSort)) {
      lines.push(`  - ${r.family} / ${r.capability}: ${r.strikes}/${r.threshold} strikes — trending toward a ban`);
    }
  }
  // Singleton-halt check: if ANY governance row has singleton_halt, print the
  // unmistakable halt notice once.
  if (governance.some(r => r && r.singleton_halt === true)) {
    lines.push("  ⚠ MERGE QUEUE HALTED — the integrator capability is banned; a human must intervene.");
  }

  return lines.join("\n");
}

// The human-readable gist of an event's structured data — the verdict/reason the
// v3 pollution post-mortem had to dig out of raw jsonb. Best-effort, never throws.
function reasonOf(ev) {
  const d = ev.data;
  if (!d || typeof d !== "object") return "";
  if (ev.type === "transition") {
    const verb = d.kind === "reject" ? "reject" : "advance";
    const why = d.reason ? `: ${d.reason}` : "";
    return `  (${verb} ${d.from}→${d.to}${why})`;
  }
  if (ev.type === "escalated") return `  (tier ${d.from_tier}→${d.to_tier}, attempt ${d.attempts})`;
  if (ev.type === "released") return `  (released${d.reason ? `: ${d.reason}` : ""}, attempt ${d.attempts})`;
  if (ev.type === "blocked") return `  (blocked: ${d.reason ?? "?"})`;
  if (d.reason) return `  (${d.reason})`;
  if (d.note) return `  (${d.note})`;
  return "";
}

// Decode a JWT-ish token's payload without verifying the signature. The token is
// split on "." and the middle segment is base64url-decoded then JSON-parsed.
// Intentionally local-only: no network, no DB, no cryptographic verification.
export function decodeClaims(token) {
  const [, payloadB64] = token.split(".");
  const json = Buffer.from(payloadB64, "base64url").toString("utf8");
  return JSON.parse(json);
}

// Pure, deterministic seconds until expiry given a token and a reference time
// (in epoch seconds). No I/O, no clock — same inputs → same output. May be negative.
export function secondsToExpiry(token, nowSeconds) {
  const claims = decodeClaims(token);
  return claims.exp - nowSeconds;
}

// Extract per-model TOKEN counts from a harness sweep log (M20 Slice A,
// design/track-record.md D1/D3). Pure and per-family: the harnesses report usage in
// different shapes (D3 heterogeneity), so an UNKNOWN shape returns null — never
// zeroes. That distinction is load-bearing: a family we cannot measure must read as
// "unknown" (the track-record view LEFT JOINs → NULL), never as "free", or it could
// dodge the future cost-aware router by emitting counts we can't read. Today only the
// claude families emit a parseable shape; opencode and grok print no token JSON, so
// they degrade to null by design. Tokens only — the harness's total_cost_usd is
// deliberately dropped (USD is a UI-level translation — D3).
export function parseUsage(logText, family) {
  if (!family || !/^claude-code\+/.test(family)) return null; // only the claude shape is parseable today
  // claude `--output-format json` prints compact JSON; the final result object has a
  // top-level `usage` (snake_case token fields) and a per-model `modelUsage`. Scan
  // lines, keep the LAST object carrying a numeric usage.input_tokens.
  let best = null;
  for (const line of logText.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{") || !t.includes('"usage"')) continue;
    let obj;
    try { obj = JSON.parse(t); } catch { continue; }
    if (obj && obj.usage && typeof obj.usage.input_tokens === "number") best = obj;
  }
  if (!best) return null;
  const u = best.usage;
  const tokens = {
    input: u.input_tokens ?? null,
    output: u.output_tokens ?? null,
    cache_read: u.cache_read_input_tokens ?? null,
    cache_creation: u.cache_creation_input_tokens ?? null,
  };
  // model: the dominant modelUsage key by tokens — a human-readable label only (the
  // FAMILY is the identity that matters for governance). Null if absent.
  let model = null, max = -1;
  const mu = best.modelUsage;
  if (mu && typeof mu === "object") {
    for (const [name, m] of Object.entries(mu)) {
      const n = (m?.inputTokens ?? 0) + (m?.outputTokens ?? 0);
      if (n > max) { max = n; model = name; }
    }
  }
  return { tokens, model };
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

  whoami(rest, values, token) {
    const c = decodeClaims(token);
    emit({ sub: c.sub, family: c.family, role: c.role, features: c.features });
  },

  ttl(rest, values, token) {
    const now = Math.floor(Date.now() / 1000);
    const remaining = secondsToExpiry(token, now);
    const exp = decodeClaims(token).exp;
    emit({ exp, seconds_remaining: remaining, expired: remaining <= 0 });
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
    const feedLimit = values.limit ? Number(values.limit) : 10;

    // One snapshot: board + timeline (family-joined, M16) + abandoned → pure format.
    const snapshot = async () => {
      const laneFilter = (q) => { if (lane) q.set("lane", `eq.${lane}`); return q; };
      const boardQ = laneFilter(new URLSearchParams());
      // Pull more timeline rows than we render so why-stuck (escalations) can see
      // past the recent-events window; formatStatus trims display to feedLimit.
      const tlQ = laneFilter(new URLSearchParams()); tlQ.set("limit", String(Math.max(feedLimit, 100)));
      const abandQ = laneFilter(new URLSearchParams());
      const [b, f, a] = await Promise.all([
        restGet(`board?${boardQ}`, token),
        restGet(`timeline?${tlQ}`, token),
        restGet(`abandoned?${abandQ}`, token),
      ]);
      for (const r of [b, f, a]) {
        if (!r.httpOk) { emit(r.body ?? { ok: false, code: "http_error", status: r.status }, false); return null; }
      }
      return formatStatus({ board: b.body, feed: f.body, abandoned: a.body }, { lane, feedLimit });
    };

    // --watch: poll-refresh (ADR 0021 D1 — no LISTEN/NOTIFY, no new infra). Reprint
    // the snapshot every --interval seconds (default 2) until interrupted.
    if (values.watch) {
      const interval = values.interval ? Number(values.interval) : 2;
      for (;;) {
        const summary = await snapshot();
        if (summary == null) return; // an http error already emitted
        process.stdout.write(`\x1b[2J\x1b[H${summary}\n`); // clear screen, home cursor
        await new Promise((res) => setTimeout(res, interval * 1000));
      }
    }

    const summary = await snapshot();
    if (summary != null) process.stdout.write(`${summary}\n`);
  },

  // The M16 event timeline (api.timeline): every event joined to the acting agent's
  // FAMILY, newest-first, filterable by task/family/type. Human text via formatEvents
  // (pass --json for raw rows). The surface the v3 pollution post-mortem needed SQL for.
  async events(rest, values, token) {
    const limit = values.limit ? Number(values.limit) : 50;
    const q = new URLSearchParams();
    if (values.lane) q.set("lane", `eq.${values.lane}`);
    if (values.task) q.set("task_id", `eq.${values.task}`);
    if (values.family) q.set("family", `eq.${values.family}`);
    if (values.type) q.set("type", `eq.${values.type}`);
    q.set("limit", String(limit));
    const r = await restGet(`timeline?${q}`, token);
    if (!r.httpOk) { emit(r.body ?? { ok: false, code: "http_error", status: r.status }, false); return; }
    if (values.json) { emit(r.body, true); return; }
    process.stdout.write(`${formatEvents(r.body, { limit })}\n`);
  },

  // End-of-run report (M16, ADR 0021 D5): what shipped (PRs), what failed, the
  // escalations, and per-family activity. Read-only over board + timeline; the
  // driver calls this on drain. Pure formatReport() does the rendering.
  async report(rest, values, token) {
    const lane = values.lane ?? null;
    const laneFilter = (q) => { if (lane) q.set("lane", `eq.${lane}`); return q; };
    const boardQ = laneFilter(new URLSearchParams());
    const tlQ = laneFilter(new URLSearchParams()); tlQ.set("limit", values.limit ?? "1000");
    // The track record (M20) is per (family, capability), not lane-scoped, so it is
    // fetched unfiltered. Degrade gracefully: a substrate without the view (or an
    // error) leaves the record section empty rather than failing the whole report.
    // The governance view (v5) is similarly unfiltered and degrades to [] on error.
    const [b, t, tr, gov] = await Promise.all([
      restGet(`board?${boardQ}`, token),
      restGet(`timeline?${tlQ}`, token),
      restGet(`family_track_record?order=family.asc,capability.asc`, token),
      restGet(`governance_status?order=family.asc,capability.asc`, token),
    ]);
    for (const r of [b, t]) {
      if (!r.httpOk) { emit(r.body ?? { ok: false, code: "http_error", status: r.status }, false); return; }
    }
    const trackRecord = tr.httpOk && Array.isArray(tr.body) ? tr.body : [];
    const governance = gov.httpOk && Array.isArray(gov.body) ? gov.body : [];
    process.stdout.write(`${formatReport({ board: b.body, timeline: t.body, trackRecord, governance }, { lane })}\n`);
  },

  // record-usage — M20 Slice A: stamp a sweep's TOKEN spend onto the task the actor
  // worked, as a `type='usage'` event (design/track-record.md D1). Driver-invoked with
  // an oversight token (an agent token cannot call it — a family must not write its own
  // scorecard). --from-log parses the sweep log per --family; --data passes a payload
  // directly (tests/direct use). When no tokens can be parsed (unknown harness shape /
  // a non-claude family today), it writes NOTHING and notes the miss on stderr — the
  // track-record view then shows that family as unknown (NULL), never as free.
  async "record-usage"(rest, values, token) {
    if (!values.actor) fail("record-usage: --actor is required");
    let payload;
    if (values.data) {
      payload = JSON.parse(values.data);
    } else if (values["from-log"]) {
      let text;
      try {
        text = readFileSync(values["from-log"], "utf8");
      } catch (e) {
        process.stderr.write(`record-usage: cannot read log ${values["from-log"]} (${e.message}) — recorded nothing\n`);
        return;
      }
      const parsed = parseUsage(text, values.family);
      if (!parsed) {
        process.stderr.write(`record-usage: no parseable token counts for family '${values.family ?? "?"}' in ${values["from-log"]} — recorded nothing (family reads as unknown, not free)\n`);
        return;
      }
      payload = { tokens: parsed.tokens, model: parsed.model };
    } else {
      fail("record-usage: need --from-log PATH (with --family) or --data JSON");
    }
    if (values.sweep) payload.sweep_id = values.sweep;
    const body = { actor: values.actor, data: payload };
    if (values.task) body.task = values.task;
    return callVerb("record_usage", body, token);
  },
};

// Options each verb/view command accepts (token is global).
const OPTS = {
  create: { lane: { type: "string" }, instructions: { type: "string" }, entry: { type: "string" }, validate: { type: "string" }, payload: { type: "string" }, priority: { type: "string" }, subject: { type: "string" }, "depends-on": { type: "string" }, token: { type: "string" } },
  claim: { lane: { type: "string" }, token: { type: "string" } },
  whoami: { token: { type: "string" } },
  ttl: { token: { type: "string" } },
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
  status: { lane: { type: "string" }, limit: { type: "string" }, watch: { type: "boolean" }, interval: { type: "string" }, token: { type: "string" } },
  events: { lane: { type: "string" }, task: { type: "string" }, family: { type: "string" }, type: { type: "string" }, limit: { type: "string" }, json: { type: "boolean" }, token: { type: "string" } },
  report: { lane: { type: "string" }, limit: { type: "string" }, token: { type: "string" } },
  "record-usage": { actor: { type: "string" }, family: { type: "string" }, "from-log": { type: "string" }, data: { type: "string" }, sweep: { type: "string" }, task: { type: "string" }, token: { type: "string" } },
};

const USAGE = `ainarres — agent CLI (verbs over PostgREST)

  token   --family F --role R --features a,b [--sub S] [--ttl 900]
  version   print CLI version (from package.json; no token)
  whoami    print identity in bearer token as {sub,family,role,features} (local decode; no network)
  ttl       print token TTL info as {exp, seconds_remaining, expired} (local decode; no network)
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
  status  [--lane L] [--limit N] [--watch [--interval 2]]   one-glance oversight summary (board + active + abandoned + why-stuck)
  events  [--lane L] [--task UUID] [--family F] [--type X] [--limit N] [--json]   event timeline joined to the acting family
  report  [--lane L] [--limit N]   end-of-run report: shipped (PRs) · failed · escalations · activity by family
  record-usage  --actor SUB (--from-log PATH --family F | --data JSON) [--sweep ID] [--task UUID]   stamp a sweep's token spend (driver/oversight; tokens only, no USD)

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
