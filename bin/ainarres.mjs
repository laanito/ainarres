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
// The signing key. The dev default keeps a bare checkout usable, but it is not a key:
// a token signed with it is accepted only by a substrate that is also running without
// one. Remember WHERE the value came from, so the seat's self-mint fallback (v8 step 3)
// can refuse out loud instead of minting an unverifiable token and handing the operator
// an opaque 401 from PostgREST. See seatToken().
const DEV_SECRET = "ainarres-dev-only-secret-change-me-min-32-chars";
const HAVE_SIGNING_KEY = (process.env.JWT_SECRET ?? "").trim() !== "";
const SECRET = HAVE_SIGNING_KEY ? process.env.JWT_SECRET : DEV_SECRET;

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

// `Connection: close` on every request: the CLI has long-lived loops (`heartbeat
// --watch`, `status --watch`) that call this once per interval. Node's global fetch
// (undici) pools keep-alive sockets, but PostgREST closes an idle keep-alive connection
// between our polls — and undici then stalls ~3s reconnecting on the stale socket. That
// stall silently starved `heartbeat --watch` of renewals (a healthy task got falsely
// reclaimed under a short lease). A fresh connection per request is cheap on localhost
// (~15–35ms) and removes the stall entirely.
async function rpc(name, body, token) {
  let res;
  try {
    res = await fetch(`${BASE}/rpc/${name}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Connection: "close", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
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
    res = await fetch(`${BASE}/${path}`, { headers: { Connection: "close", ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
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

// v8 ergonomics — where the intake channel's pre-shared key comes from, in precedence
// order: --psk, then --psk-file (exclusive when given), then INTAKE_PSK, then INTAKE_PSK_FILE, then the key file
// the channel itself writes (loop/run/intake.psk). That last one is what removes the
// copy-paste: start the channel, then post, with the key never passing through a human's
// clipboard. Returns null when no key can be found — the caller decides how loudly to
// complain.
//
// EXPLICIT FLAGS BEAT THE ENVIRONMENT, both of them. The earlier order put INTAKE_PSK
// above --psk-file, so a stale exported key silently won over a path the operator had
// just typed — and the only symptom was a 401 with nothing to point at. An ambient
// variable must never quietly override an argument.
export function resolveIntakePsk(values = {}, env = process.env) {
  if (values.psk) return values.psk;
  // An explicit --psk-file is the ONLY source when given: if the operator named a file,
  // quietly reading a DIFFERENT key (the env, the default file) when it cannot be read is
  // the same silent substitution this ordering exists to stop. Unreadable or empty ⇒ null,
  // and the caller says so out loud.
  if (values["psk-file"]) {
    try {
      return readFileSync(values["psk-file"], "utf8").trim() || null;
    } catch {
      return null;
    }
  }
  if (env.INTAKE_PSK) return env.INTAKE_PSK;
  const path = env.INTAKE_PSK_FILE
    || fileURLToPath(new URL("../loop/run/intake.psk", import.meta.url));
  try {
    const key = readFileSync(path, "utf8").trim();
    return key || null;
  } catch {
    return null;
  }
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
export function formatStatus({ board = [], feed = [], abandoned = [] }, { lane = null, feedLimit = 10, compact = false } = {}) {
  const lines = [];

  // 1. Header.
  lines.push(lane ? `status — lane ${lane} (${board.length} tasks)` : `status — all lanes (${board.length} tasks)`);

  if (compact) {
    // COMPACT THREE-LINE MODE
    // Line 2: stage tally
    if (board.length === 0) {
      lines.push("  (no tasks)");
    } else {
      const byStage = new Map();
      for (const row of board) {
        const stage = row.stage;
        byStage.set(stage, (byStage.get(stage) ?? 0) + 1);
      }
      const parts = [...byStage.keys()].sort().map(stage => `${stage}:${byStage.get(stage)}`);
      lines.push(`  ${parts.join(" ")}`);
    }
    // Line 3: counters
    const blockedCount = board.filter(r => r.blocked === true).length;
    const claimedCount = board.filter(r => r.claimed_by != null).length;
    const activeCount = board.filter(r => r.claimed_by != null && r.abandoned !== true).length;
    const abandonedCount = abandoned.length;
    lines.push(`  blocked:${blockedCount} claimed:${claimedCount} active:${activeCount} abandoned:${abandonedCount}`);
    return lines.join("\n");
  }

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

// Pure, TOTAL shaper that mirrors the --compact slice as a PLAIN OBJECT (no I/O,
// no clock, never throws on empty/partial input). Used by `status --json`.
export function statusJson({ board, feed, abandoned } = {}, { lane = null, feedLimit = 10 } = {}) {
  const brd = board ?? [];
  const f = feed ?? [];
  const abd = abandoned ?? [];
  const stages = {};
  for (const row of brd) {
    const s = row.stage;
    stages[s] = (stages[s] ?? 0) + 1;
  }
  const blocked = brd.filter(r => r.blocked === true).length;
  const claimed = brd.filter(r => r.claimed_by != null).length;
  const active = brd.filter(r => r.claimed_by != null && r.abandoned !== true).length;
  const recentEvents = f.slice(0, feedLimit).map(ev => ({
    at: ev.created_at,
    type: ev.type,
    task: ev.task_id,
    by: ev.family ?? ev.actor ?? null,
  }));
  return {
    lane,
    total: brd.length,
    stages,
    blocked,
    claimed,
    active,
    abandoned: abd.length,
    recentEvents,
  };
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

// Pure, TOTAL formatter for the standing service's LOCAL liveness file
// (loop/run/service.status — one-line JSON). Takes the parsed object or null
// (no file / absent service) and returns a multi-line string. No I/O, no clock,
// never throws — missing numerics → 0, missing strings → "", null → not-running.
export function formatServiceStatus(status) {
  const lines = ["service (v7 \u2014 standing supervisor):"];

  if (status == null || typeof status !== "object") {
    lines.push("  (not running \u2014 no status file)");
    return lines.join("\n");
  }

  const state = status.state ?? "";
  const activation = Number(status.activation) || 0;
  const round = Number(status.round) || 0;
  const active = Number(status.active) || 0;
  const blocked = Number(status.blocked) || 0;
  const poll_secs = Number(status.poll_secs) || 0;
  const pid = Number(status.pid) || 0;
  const note = typeof status.note === "string" ? status.note : "";
  const last_tick = typeof status.last_tick === "string" ? status.last_tick : "";

  lines.push(`  state: ${state}`);
  if (state === "running") {
    lines.push(`  activation #${activation} \u00b7 round ${round}`);
  }
  lines.push(`  board: ${active} active \u00b7 ${blocked} blocked`);
  lines.push(`  poll every ${poll_secs}s \u00b7 pid ${pid}`);
  lines.push(`  last tick: ${last_tick}`);
  if (note !== "") {
    lines.push(`  note: ${note}`);
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

// Newest-first PR reference for a task, dug out of its transition artifacts.
// Module-scope PURE helper reused by formatReport and reportJson.
function prFor(timeline, taskId) {
  for (const ev of timeline) {
    if (ev.task_id !== taskId) continue;
    const arts = ev.data?.artifacts;
    if (Array.isArray(arts)) {
      const pr = arts.find((a) => a && a.type === "pr" && a.url);
      if (pr) return pr.url;
    }
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

// Operational tag for the M23 watch block (design D5): an overspending signal is a
// COST signal, never a ban recommendation -> "cost"; everything else (spinning,
// burned, health, integrity) -> "review". Pure.
function opTag(kind) {
  return kind === "overspending" ? "cost" : "review";
}

// Format seconds-to-heal for a temporary ban (v5 governance). Pure. Returns a
// human string like "1h 30m" or null when the value is absent/invalid.
function fmtHeal(secs) {
  if (secs == null || Number(secs) < 0 || Number.isNaN(Number(secs))) return null;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return `${h}h ${m}m`;
}

// Format a PostgREST interval string (e.g. "00:45:00", "03:20:00",
// "1 day 02:00:00") as a compact human duration like "45m" or "3h 20m".
// Days fold into hours; minutes are TRUNCATED (never rounded); anything
// unparseable (null, undefined, non-string, garbage) reads as "unknown".
// Pure and TOTAL: never throws, never reads the clock.
export function fmtDuration(interval) {
  if (typeof interval !== "string") return "unknown";
  const s = interval.trim();
  if (s.length === 0) return "unknown";
  let days = 0;
  let hms = s;
  const dayMatch = s.match(/^(-?\d+)\s+day/i);
  if (dayMatch) {
    days = Number(dayMatch[1]);
    hms = s.slice(dayMatch[0].length).trim();
  }
  if (hms.startsWith("-")) hms = hms.slice(1);
  const parts = hms.split(":");
  if (parts.length !== 3) return "unknown";
  const h = Number(parts[0]);
  const m = Number(parts[1]);
  const sec = Number(parts[2]);
  if (!Number.isFinite(h) || !Number.isFinite(m) || !Number.isFinite(sec)) return "unknown";
  const totalH = days * 24 + h;
  if (totalH === 0) return `${m}m`;
  return `${totalH}h ${m}m`;
}

export function formatReport({ board = [], timeline = [], trackRecord = [], governance = [], auditFlags = [], governanceActions = [], spendAnomalies = [], operationalFlags = [], openBriefs = [], stuckTasks = [], operatorActions = [], sweepUsage = [] } = {}, { lane = null } = {}) {
  const lines = [lane ? `end-of-run report — lane ${lane}` : "end-of-run report — all lanes"];

  // What shipped: tasks at a terminal stage.
  const shipped = board.filter((r) => r.is_terminal === true);
  lines.push(`shipped (${shipped.length}):`);
  if (shipped.length === 0) lines.push("  (none)");
  for (const row of shipped) {
    lines.push(`  - ${row.task_id}  ${prFor(timeline, row.task_id) ?? "(no PR ref)"}`);
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
  }
  // v8 — empty-sweep spend (api.sweep_usage): tokens burned by sweeps that claimed no
  // task. A separate signal from competence — a family that burned tokens claiming
  // nothing is EXPENSIVE, not failing (D3). Rendered whenever rows exist, INCLUDING
  // when trackRecord is empty. The view is already ordered (tokens DESC) and grouped
  // per family — do NOT re-sort or re-aggregate; its order is the contract.
  if (sweepUsage.length > 0) {
    lines.push("  spend that moved nothing (sweeps that claimed no task):");
    // The total sums tokens across ALL rows passed in (the PRE-CAP sum), coercing
    // each row's tokens with Number() and treating null/undefined/NaN as 0 so the
    // sum never becomes NaN.
    let sweepTotal = 0;
    for (const r of sweepUsage) {
      const tokens = Number(r.tokens);
      sweepTotal += Number.isFinite(tokens) && !Number.isNaN(tokens) ? tokens : 0;
    }
    for (const r of sweepUsage.slice(0, 10)) {
      const fam = r.family == null || r.family === "" ? "\u2014" : r.family;
      lines.push(`  - ${fam}: ${fmtTokens(r.tokens)} over ${r.sweeps} sweep(s)`);
    }
    lines.push(`    total: ${fmtTokens(sweepTotal)} spent claiming nothing`);
  }
  if (trackRecord.length > 0) {
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

  // M22 — Open audit flags (sorted by family then capability).
  if (auditFlags.length > 0) {
    const sorted = [...auditFlags].sort((a, b) =>
      (a.family ?? "").localeCompare(b.family ?? "") || (a.capability ?? "").localeCompare(b.capability ?? ""));
    for (const r of sorted) {
      lines.push(`  - ${r.family} / ${r.capability}: ${r.flag_count} audit flag(s) — ${r.last_gap}`);
    }
  }

  // M22 — Permanent-ban recommendations: deduped by (family, capability), qualifying
  // from EITHER governance ban_count >= recommend_ban_count OR audit flag_count >=
  // recommend_flag_count. When both sources qualify, reasons are joined with "; ".
  const recMap = new Map();
  for (const r of governance) {
    if (r && r.recommend_ban_count != null && r.ban_count != null && r.ban_count >= r.recommend_ban_count) {
      const key = `${r.family}|${r.capability}`;
      const reason = `${r.ban_count} reflexive bans ≥ ${r.recommend_ban_count}`;
      if (!recMap.has(key)) recMap.set(key, { family: r.family, capability: r.capability, reasons: [] });
      recMap.get(key).reasons.push(reason);
    }
  }
  for (const r of auditFlags) {
    if (r && r.recommend_flag_count != null && r.flag_count != null && r.flag_count >= r.recommend_flag_count) {
      const key = `${r.family}|${r.capability}`;
      const reason = `${r.flag_count} audit flags ≥ ${r.recommend_flag_count}`;
      if (!recMap.has(key)) recMap.set(key, { family: r.family, capability: r.capability, reasons: [] });
      recMap.get(key).reasons.push(reason);
    }
  }
  if (recMap.size > 0) {
    const sorted = [...recMap.entries()].sort((a, b) =>
      (a[1].family ?? "").localeCompare(b[1].family ?? "") || (a[1].capability ?? "").localeCompare(b[1].capability ?? ""));
    for (const [, v] of sorted) {
      const reasons = v.reasons.join("; ");
      lines.push(`  ⚑ RECOMMEND PERMANENT BAN — ${v.family} / ${v.capability} (${reasons}); a human must decide.`);
    }
  }

  // M22 — Human action trail (newest-first, capped at 10).
  if (governanceActions.length > 0) {
    lines.push("  governance actions:");
    for (const r of governanceActions.slice(0, 10)) {
      const suffix = r.reason ? ` — ${r.reason}` : "";
      lines.push(`    - ${r.action} ${r.family} / ${r.capability}${suffix}`);
    }
  }

  // M24 Slice B — intake watch (v6 — open briefs): rows from api.open_briefs
  // (read-only, newest-first, one row per intake-lane task). Counts by stage and
  // lists the OPEN briefs (stage !== 'accepted') in the given order, capped at the
  // 10 most recent. Rendered IMMEDIATELY BEFORE the operational block, which stays
  // the LAST section. Pure, null-guarded, never throws.
  lines.push("intake (v6 — open briefs):");
  const proposed = openBriefs.filter(r => r && r.stage === "proposed_brief").length;
  const briefed = openBriefs.filter(r => r && r.stage === "briefed").length;
  const accepted = openBriefs.filter(r => r && r.stage === "accepted").length;
  if (openBriefs.length === 0) {
    lines.push("  (no briefs)");
  } else {
    lines.push(`  ${proposed} proposed · ${briefed} briefed · ${accepted} accepted`);
    const open = openBriefs.filter(r => r && r.stage !== "accepted").slice(0, 10);
    for (const r of open) {
      lines.push(`  - ${r.task_id} — ${r.stage}`);
    }
  }

  // v8 — operator ledger (api.operator_actions): what the operator seat did —
  // including the acts that were refused or failed, which are the operator's own
  // misses and must be visible as such. The ledger is a RECORD, never a verdict:
  // render what the seat reported and nothing more — no scoring, no ban
  // recommendation. Rows arrive newest-first from the view; consume them in the
  // GIVEN order (no re-sort, no re-group, no de-dupe), capping the detail lines
  // at the first 10. Rendered AFTER the intake section and IMMEDIATELY BEFORE
  // the operational block, which stays the LAST section. Pure, null-guarded,
  // never throws.
  lines.push("operator (v8 — what the seat did):");
  if (operatorActions.length === 0) {
    lines.push("  (no operator actions)");
  } else {
    const refusedFailed = operatorActions.filter(r => r && (r.outcome === "refused" || r.outcome === "failed")).length;
    lines.push(`  ${operatorActions.length} action(s) · ${refusedFailed} refused/failed`);
    for (const r of operatorActions.slice(0, 10)) {
      const row = r ?? {};
      const family = row.family ?? "—";
      const action = row.action ?? "";
      let targetPart;
      if (row.target != null && row.target !== "") {
        targetPart = `→ ${row.target}`;
      } else if (row.task_id != null && row.task_id !== "") {
        targetPart = `→ task ${row.task_id}`;
      } else {
        targetPart = "(instance)";
      }
      if (row.outcome === "refused" || row.outcome === "failed") {
        lines.push(`  - ${family} ${action} ${targetPart} — ${row.outcome}: ${row.reason ?? "no reason given"}`);
      } else {
        lines.push(`  - ${family} ${action} ${targetPart}`);
      }
    }
  }

  // M23 Slice B — operational watch (v6 — health & spend): stalled/stranded claims
  // derived from the board (no extra fetch), spend anomalies (api.spend_anomalies)
  // and operational flags (api.operational_flags). Always the LAST section, after
  // the entire governance section. Pure, null-guarded, never throws. Overspending
  // reads as a COST signal ("cost"), never as a ban recommendation; everything else
  // reads as "review".
  // v8 — stuck-alive watch: rows from api.stuck_tasks (a worker ALIVE but stuck,
  // holding a live lease while the task never moves). Rendered AFTER the health
  // rows and BEFORE the spend rows, capped at the first 10 in the view's own order
  // (longest-held first — do NOT re-sort). A stuck row is a CANDIDATE for a human
  // to look at, never a verdict: tagged "(review)", no consequence computed.
  lines.push("operational (v6 — health & spend watch):");
  const healthRows = board
    .filter(r => r && r.abandoned === true)
    .sort((a, b) => (a.task_id ?? "").localeCompare(b.task_id ?? ""));
  const stuckRows = stuckTasks.slice(0, 10);
  const spendRows = [...spendAnomalies].sort((a, b) =>
    (a.family ?? "").localeCompare(b.family ?? "") || (a.capability ?? "").localeCompare(b.capability ?? ""));
  const flagRows = operationalFlags.slice(0, 10);
  if (healthRows.length === 0 && stuckRows.length === 0 && spendRows.length === 0 && flagRows.length === 0) {
    lines.push("  (all clear — no health, spend, or operational-flag anomalies)");
  } else {
    for (const r of healthRows) {
      lines.push(`  - health: ${r.task_id} stalled in ${r.stage}, held by ${r.claimed_by ?? "—"} (review)`);
    }
    for (const r of stuckRows) {
      const family = r.family ?? "—";
      if (r.kind === "heartbeat_treadmill") {
        lines.push(`  - stuck: ${r.task_id} in ${r.stage}, held by ${family} for ${fmtDuration(r.held_for)}, lease renewed +${fmtDuration(r.extended_by)} — alive, not progressing (review)`);
      } else {
        lines.push(`  - stuck: ${r.task_id} in ${r.stage}, held by ${family} for ${fmtDuration(r.held_for)}, silent ${fmtDuration(r.silent_for)} (review)`);
      }
    }
    for (const r of spendRows) {
      if (r.anomaly === "no_delivery_spend") {
        lines.push(`  - ${r.family} / ${r.capability}: burned — ${r.usage_events} usage event(s), 0 delivered (review)`);
      } else {
        lines.push(`  - ${r.family} / ${r.capability}: overspending — ${fmtTokens(r.tokens_per_delivery)}/delivery, ${r.multiple_over_median}× the peer median (cost)`);
      }
    }
    for (const r of flagRows) {
      lines.push(`  - ${r.family} / ${r.capability}: ${r.kind} — ${r.detail} (${opTag(r.kind)})`);
    }
  }

  return lines.join("\n");
}

// Pure, TOTAL JSON shaper for the end-of-run report. Same two-arg signature as
// formatReport: rows in (already fetched), plain object out (no I/O, no clock,
// never throws). Mirrors the same structure report --json will emit.
export function reportJson({ board = [], timeline = [], trackRecord = [], governance = [], auditFlags = [], governanceActions = [], spendAnomalies = [], operationalFlags = [], openBriefs = [], stuckTasks = [], operatorActions = [], sweepUsage = [] } = {}, { lane = null } = {}) {
  const shipped = board
    .filter((r) => r.is_terminal === true)
    .map((row) => {
      const implemented = familyOfTransition(timeline, row.task_id, "implementing", "reviewing");
      const reviewed = familyOfTransition(timeline, row.task_id, "reviewing", "integrating");
      const integrated = familyOfTransition(timeline, row.task_id, "integrating", "validating");
      return {
        task_id: row.task_id,
        pr: prFor(timeline, row.task_id),
        implemented,
        reviewed,
        integrated,
        crossFamilyReview: implemented != null && reviewed != null && reviewed !== implemented,
      };
    });
  return {
    lane,
    shipped,
    trackRecord,
    governance,
    auditFlags,
    governanceActions,
    // M24 Slice B — intake watch (v6 — open briefs): counts by stage and the OPEN
    // briefs (stage !== 'accepted'), ALL of them, UNCAPPED, in the given order.
    intake: {
      proposed: openBriefs.filter(r => r && r.stage === "proposed_brief").length,
      briefed: openBriefs.filter(r => r && r.stage === "briefed").length,
      accepted: openBriefs.filter(r => r && r.stage === "accepted").length,
      open: openBriefs.filter(r => r && r.stage !== "accepted"),
    },
    // v8 — operator ledger (api.operator_actions): what the operator seat did.
    // total/failed count ALL rows passed in (pre-cap); actions pass through
    // UNCHANGED, capped at 10 — the JSON shape stays dumb (no reshaping, no
    // formatting), same discipline as operational.stuck.
    operator: {
      total: operatorActions.length,
      failed: operatorActions.filter(r => r && (r.outcome === "refused" || r.outcome === "failed")).length,
      actions: operatorActions.slice(0, 10),
    },
    // M23 Slice B — operational watch: health derived from the board (family is the
    // JSON null fallback here, NOT the em dash used in the text rendering), spend
    // passed through as given, flags capped at the 10 most recent. v8: stuck rows
    // (api.stuck_tasks) pass through UNCHANGED, capped at 10 — the JSON shape stays
    // dumb (no fmtDuration, no reshaping).
    operational: {
      health: board
        .filter(r => r && r.abandoned === true)
        .map(row => ({ task_id: row.task_id, stage: row.stage, family: row.claimed_by ?? null }))
        .sort((a, b) => (a.task_id ?? "").localeCompare(b.task_id ?? "")),
      spend: spendAnomalies,
      flags: operationalFlags.slice(0, 10),
      stuck: stuckTasks.slice(0, 10),
    },
    // v8 — empty-sweep spend (api.sweep_usage): tokens burned by sweeps that claimed
    // no task. total is the PRE-CAP token sum (a number, coercing each row's tokens
    // with Number() and treating null/undefined/NaN as 0); families is the first 10
    // rows passed through UNCHANGED — the JSON shape stays dumb (no reshaping, no
    // coercion of the row objects).
    sweepSpend: {
      total: sweepUsage.reduce((sum, r) => {
        const tokens = Number(r.tokens);
        return sum + (Number.isFinite(tokens) && !Number.isNaN(tokens) ? tokens : 0);
      }, 0),
      families: sweepUsage.slice(0, 10),
    },
  };
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
  if (typeof token !== "string") {
    throw new Error(`malformed token: expected a string, got ${typeof token}`);
  }
  const parts = token.split(".");
  if (parts.length < 3) {
    throw new Error(`malformed token: expected 3 segments, got ${parts.length}`);
  }
  const payloadB64 = parts[1];
  if (payloadB64 === "") {
    throw new Error("malformed token: empty payload segment");
  }
  let json;
  try {
    json = Buffer.from(payloadB64, "base64url").toString("utf8");
  } catch {
    throw new Error("malformed token: invalid base64url in payload");
  }
  try {
    return JSON.parse(json);
  } catch (e) {
    throw new Error(`malformed token: invalid JSON payload`);
  }
}

// A PostgREST `42501 permission denied for function …` is a correct refusal with an
// unhelpful face: it names the function but never the credential, so the caller cannot
// tell "I may not do this" from "I am holding the wrong token for it". The commonest
// cause by far is a read-only credential: the `monitor` coarse role (v8 step 0) holds
// SELECT on the views and EXECUTE on NOTHING, so every verb refuses it identically.
//
// Pure and total: takes the response body and the token's claims, returns a hint string
// or null. Never throws on a malformed body or unreadable token — a diagnostic that can
// itself fail is worse than none.
export function permissionHint(body, claims) {
  if (!body || body.code !== "42501") return null;
  const fn = /permission denied for function ([a-z_][a-z0-9_]*)/i.exec(body.message || "");
  const what = fn ? `api.${fn[1]}` : "that verb";
  const role = claims && claims.role;
  if (role === "monitor") {
    return `that is a READ-ONLY credential (role: monitor) — it holds SELECT on the views and `
      + `EXECUTE on nothing, so ${what} refuses it. Drop --token and the command brokers an `
      + `agent seat token itself, or get one with \`ainarres seat-token\`.`;
  }
  if (role && role !== "oversight") {
    return `the token's role is \`${role}\`, which has no EXECUTE on ${what}. `
      + `\`ainarres seat-token\` issues an agent credential; the oversight-only verbs `
      + `(set_permanent_ban, lift_ban, raise_audit_flag) stay the owner's.`;
  }
  return `the token's role has no EXECUTE on ${what} — check which credential you passed.`;
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
  if (!family) return null;
  if (/^claude-code\+/.test(family)) return parseClaudeUsage(logText);
  if (/^opencode\+/.test(family)) return parseOpencodeUsage(logText);
  if (/^cursor-agent\+/.test(family)) return parseCursorUsage(logText);
  if (/^grok\+/.test(family)) return parseGrokUsage(logText);
  return null;
}

// claude `--output-format json` prints compact JSON; the final result object has a
// top-level `usage` (snake_case token fields) and a per-model `modelUsage`. Scan
// lines, keep the LAST object carrying a numeric usage.input_tokens.
function parseClaudeUsage(logText) {
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

// opencode harness emits a JSON-event stream, one object per line. Step-finish events
// carry per-step token counts (part.tokens). Scan all lines, sum across every
// step_finish event that has part.tokens, and return aggregated totals.
function parseOpencodeUsage(logText) {
  let input = 0, output = 0, cacheRead = 0, cacheCreation = 0;
  let found = false;
  for (const line of logText.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let obj;
    try { obj = JSON.parse(t); } catch { continue; }
    if (!obj || obj.type !== "step_finish") continue;
    const pt = obj.part?.tokens;
    if (!pt || typeof pt !== "object") continue;
    input += pt.input ?? 0;
    output += (pt.output ?? 0) + (pt.reasoning ?? 0);
    cacheRead += pt.cache?.read ?? 0;
    cacheCreation += pt.cache?.write ?? 0;
    found = true;
  }
  if (!found) return null;
  return { tokens: { input, output, cache_read: cacheRead, cache_creation: cacheCreation }, model: null };
}

// cursor-agent harness (composer-2.5) emits JSON lines; a usage record has a top-level
// `usage` object with a NUMERIC usage.inputTokens (camelCase). Scan lines, skip non-JSON
// / malformed (never throw), keep the LAST usage record found. Missing optional fields
// default to 0; input is required for a record to count. Returns null when no record found.
function parseCursorUsage(logText) {
  let best = null;
  for (const line of logText.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let obj;
    try { obj = JSON.parse(t); } catch { continue; }
    if (obj && obj.usage && typeof obj.usage === "object" && typeof obj.usage.inputTokens === "number") {
      best = obj;
    }
  }
  if (!best) return null;
  const u = best.usage;
  const tokens = {
    input: u.inputTokens,
    output: typeof u.outputTokens === "number" ? u.outputTokens : 0,
    cache_read: typeof u.cacheReadTokens === "number" ? u.cacheReadTokens : 0,
    cache_creation: typeof u.cacheWriteTokens === "number" ? u.cacheWriteTokens : 0,
  };
  return { tokens, model: null };
}

// grok harness logs embed JSON in debug log lines with a prefix before the JSON:
// `2026-07-07T17:16:30Z DEBUG xai_acp_lib::gateway: received "session/prompt" response: {"stopReason":"end_turn","_meta":{"totalTokens":58050,"modelId":"grok-build","inputTokens":57574,"outputTokens":475,"cachedReadTokens":57344,"reasoningTokens":49}}`.
// Scan lines for those containing both "_meta" and "inputTokens"; extract the
// JSON substring from the first { to end of line, parse it, and keep the LAST
// valid record. grok inputTokens INCLUDES cachedReadTokens, so calculate fresh
// input = inputTokens - cachedReadTokens.
function parseGrokUsage(logText) {
  let best = null;
  for (const line of logText.split("\n")) {
    if (!line.includes('"_meta"') || !line.includes('"inputTokens"')) continue;
    const brace = line.indexOf("{");
    if (brace === -1) continue;
    const jsonStr = line.slice(brace);
    let obj;
    try { obj = JSON.parse(jsonStr); } catch { continue; }
    const meta = obj && obj._meta;
    if (meta && typeof meta === "object" && typeof meta.inputTokens === "number") {
      best = meta;
    }
  }
  if (!best) return null;
  const inputTokens = typeof best.inputTokens === "number" ? best.inputTokens : 0;
  const outputTokens = typeof best.outputTokens === "number" ? best.outputTokens : 0;
  const cachedReadTokens = typeof best.cachedReadTokens === "number" ? best.cachedReadTokens : 0;
  const freshInput = Math.max(0, inputTokens - cachedReadTokens);
  return {
    tokens: {
      input: freshInput,
      output: outputTokens,
      cache_read: cachedReadTokens,
      cache_creation: 0,
    },
    model: best.modelId ?? null,
  };
}

// ── v8 step 2 (ADR 0028): the operator seat ─────────────────────────────────
// The operator is an identity, not "whoever holds JWT_SECRET". This family is seeded
// in db/seed.sql with lane:intake + role:intaker + lane:dev + role:designer +
// role:operator — enough to work the intake middle and create dev work under its own
// name, and nothing else. It holds no capability:integrate, no role:auditor.
const OPERATOR_FAMILY = "agent+operator";

// v8 step 3 (ADR 0028) — where the seat's token comes from. PREFER THE BROKER: it asks
// api.issue_operator_credential, so the DATABASE decides what may be in the token (role ∈
// {agent, monitor}, family must hold role:operator, features = the provisioned snapshot,
// TTL capped) and the issuance is recorded. Self-minting is the FALLBACK for a substrate
// with no broker running — it still works, and it is visibly weaker: the token is whatever
// we asked for, and the act shows up in api.unbrokered_operator_acts with no issuance
// behind it. That visibility is the point; the owner chose an audited boundary, not a
// prevented one.
function resolveBrokerPsk(values = {}, env = process.env) {
  if (values["broker-psk"]) return values["broker-psk"];
  if (env.BROKER_PSK) return env.BROKER_PSK;
  const path = env.BROKER_PSK_FILE
    || fileURLToPath(new URL("../loop/run/broker.psk", import.meta.url));
  try {
    return readFileSync(path, "utf8").trim() || null;
  } catch {
    return null;
  }
}

// Ask the broker for a seat credential. Returns the signed token, or null when no broker
// is reachable (no key, not listening, refused) — the caller decides whether to fall back.
// A REFUSAL is not the same as an absence: if the envelope says no, say so loudly rather
// than quietly self-minting the thing it just declined.
export async function brokerToken({ role = "agent", ttl = 300, reason = null, values = {} } = {}) {
  const psk = resolveBrokerPsk(values);
  if (!psk) return null;
  const port = values["broker-port"] ?? process.env.BROKER_PORT ?? "3021";
  const url = values["broker-url"] ?? `http://127.0.0.1:${port}/token`;
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Broker-Key": psk },
      body: JSON.stringify({ role, ttl, reason }),
    });
  } catch {
    return null; // not listening — absence, not refusal
  }
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (res.ok && body && body.ok === true && body.token) return body.token;
  fail(`seat credential refused by the envelope (${(body && body.code) || res.status}: ${(body && body.error) || "no reason given"})`);
  return null;
}

// The seat's token for a command: the broker when one is reachable, a self-minted token
// otherwise. `features` is only used by the fallback — the broker takes its features from
// the family's provisioning, which is the whole point.
async function seatToken({ role = "agent", features = [], ttl = 300, reason = null, values = {}, family = OPERATOR_FAMILY } = {}) {
  const brokered = await brokerToken({ role, ttl, reason, values });
  if (brokered) return { token: brokered, brokered: true };
  // No broker AND no key: there is nothing to sign with. Falling back here would mint
  // with DEV_SECRET and the substrate would answer 401 with no hint as to why — the
  // failure a seat is least equipped to diagnose, because it cannot see the key it
  // does not have. Name both halves instead; one of them is the thing to fix.
  if (!HAVE_SIGNING_KEY) {
    const port = values["broker-port"] ?? process.env.BROKER_PORT ?? "3021";
    fail(
      `no seat credential: no broker answered on 127.0.0.1:${port} (no broker key readable, `
      + "or nothing listening) and JWT_SECRET is unset, so there is nothing to sign with. "
      + "Ask the owner to run `make broker-serve` (it writes loop/run/broker.psk), or point "
      + "BROKER_PSK / BROKER_PSK_FILE at the key. Minting locally is NOT the fix — the seat "
      + "is not meant to hold the signing key.",
    );
  }
  return {
    token: mintJwt({ sub: randomUUID(), family, role, features }, ttl),
    brokered: false,
  };
}

// Write one line to the operator's append-only ledger (api.record_operator_action,
// role:operator-gated). BEST EFFORT ON PURPOSE: the ledger records what the operator
// did; it must never be the reason an operator act fails. A substrate that refuses the
// ledger write (an unseated family, a governance denial) still let the act itself
// through or not on its own merits, and the act's own event remains the harder record.
// Returns the envelope when it landed, null otherwise.
async function logOperatorAction(token, { action, target = null, task = null, outcome = "ok", reason = null, detail = {} }) {
  try {
    const r = await rpc("record_operator_action", {
      p_action: action,
      p_target: target,
      p_task: task,
      p_outcome: outcome,
      p_reason: reason,
      p_detail: detail,
    }, token);
    return r.body && r.body.ok === true ? r.body : null;
  } catch {
    return null;
  }
}

const COMMANDS = {
  // v8 ergonomics — post a request to the LOCAL INTAKE CHANNEL (ADR 0025). No substrate
  // JWT: the channel authenticates with the pre-shared key, so this reads a key, not a
  // token. `--file -` reads the request from stdin.
  async intake(rest, values) {
    let text = values.request ?? null;
    if (!text && values.file) {
      try {
        text = readFileSync(values.file === "-" ? 0 : values.file, "utf8");
      } catch (e) {
        fail(`intake: cannot read ${values.file} (${e.message})`);
      }
    }
    if (!text || !text.trim()) fail("intake: need --request TEXT or --file PATH (--file - for stdin)");
    const psk = resolveIntakePsk(values);
    if (!psk) {
      fail("intake: no pre-shared key — start the channel (`make intake-serve`, which writes loop/run/intake.psk), or pass --psk / set INTAKE_PSK");
    }
    const port = values.port ?? process.env.INTAKE_PORT ?? "3020";
    const url = values.url ?? `http://127.0.0.1:${port}/intake`;
    const body = { request: text.trim(), ...(values.subject ? { subject: values.subject } : {}) };
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Intake-Key": psk, Connection: "close" },
        body: JSON.stringify(body),
      });
    } catch (e) {
      fail(`intake: cannot reach the channel at ${url} (${e.message}) — is \`make intake-serve\` running?`);
    }
    const raw = await res.text();
    let json;
    try { json = raw ? JSON.parse(raw) : null; } catch { json = { raw }; }
    if (values.json) return emit(json, res.ok);
    if (!res.ok) {
      process.stderr.write(`ainarres: intake refused (${res.status}): ${(json && (json.error || json.code)) || raw}\n`);
      process.exit(1);
    }
    process.stdout.write(`brief ${json.brief_id}  stage=${json.stage ?? "?"}\n`);
    process.stdout.write(`next: ainarres refine ${json.brief_id}   (the intaker's refine step — the swarm takes it from there)\n`);
  },

  // v8 ergonomics — the human intaker's REFINE step in one command: claim a brief and
  // advance proposed_brief → briefed, which is what releases it to the standing designer.
  // Self-mints the intaker token (the owner already holds JWT_SECRET; `ainarres token`
  // has always been able to mint this exact one) unless --token is given. No brief id =
  // "whatever is claimable". With an id, a claim that returns a DIFFERENT brief is
  // released and retried — note that a release bumps that task's attempts.
  async refine(rest, values, token, positional) {
    const lane = values.lane ?? "intake";
    const to = values.to ?? "briefed";
    const want = positional ?? values.brief ?? null;
    // v8 step 2 (ADR 0028): refine runs as the OPERATOR SEAT, not as the intake
    // channel's human caller. The act is the operator's, so the event, the track
    // record and the ledger line must all say `agent+operator`. `--family` still
    // overrides for the human doing it by hand.
    const family = values.family ?? OPERATOR_FAMILY;
    // v8 step 3: ask the envelope first. The features below are the FALLBACK's request —
    // a brokered token carries the seat family's provisioned snapshot instead, which is
    // what makes the prohibitions structural rather than polite.
    const seat = token
      ? { token, brokered: false }
      : await seatToken({
          role: "agent",
          family,
          features: [`lane:${lane}`, "role:intaker", "role:operator"],
          ttl: Number(values.ttl ?? 900),
          reason: `refine on lane ${lane}`,
          values,
        });
    const tok = seat.token;
    const tries = Math.max(1, Number(values.tries ?? 5));
    const skipped = [];
    for (let i = 0; i < tries; i++) {
      const c = await rpc("claim_next_task", { lane_key: lane }, tok);
      const env = c.body;
      // An empty claim is ok:true with code "empty" and a NULL task (app.envelope), not a
      // failure — so it has to be checked before reaching for env.task.
      if (!env || env.ok !== true || env.code === "empty" || !env.task) {
        const code = (env && env.code) || c.status;
        if (code === "empty") {
          fail(want
            ? `refine: nothing claimable on lane ${lane} (brief ${want} may already be past ${to}${skipped.length ? `; released ${skipped.length} other brief(s) first` : ""})`
            : `refine: nothing claimable on lane ${lane} — no brief is waiting for the intaker`);
        }
        fail(`refine: claim failed (${code}${env && env.reason ? `: ${env.reason}` : ""})`);
      }
      const id = env.task.id;
      if (want && id !== want) {
        skipped.push(id);
        await rpc("release_task", { task_id: id, reason: "refine: not the requested brief" }, tok);
        continue;
      }
      const a = await rpc("advance_task", {
        task_id: id,
        to_stage: to,
        note: values.note ?? "refined by the operator",
      }, tok);
      if (!a.body || a.body.ok !== true) {
        const why = `${(a.body && a.body.code) || a.status}${a.body && a.body.reason ? `: ${a.body.reason}` : ""}`;
        await logOperatorAction(tok, { action: "refine", target: id, task: id, outcome: "refused", reason: why });
        fail(`refine: advance to ${to} failed (${why})`);
      }
      await logOperatorAction(tok, {
        action: "refine",
        target: id,
        task: id,
        detail: { lane, from: env.task.stage_key, to: a.body.task.stage_key, released: skipped.length },
      });
      if (values.json) return emit(a.body);
      process.stdout.write(`refined ${id}  ${env.task.stage_key} → ${a.body.task.stage_key}\n`);
      if (skipped.length) process.stdout.write(`(released ${skipped.length} other claimable brief(s) to reach it)\n`);
      return;
    }
    fail(`refine: could not claim ${want} in ${tries} tries (saw ${skipped.join(", ") || "nothing"})`);
  },

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
    // Signing with DEV_SECRET is legitimate on a bare checkout whose substrate has no
    // key either. It is a trap everywhere else — the token mints fine and the substrate
    // answers 401 with nothing pointing at the signature. Say so once, on stderr, so the
    // JSON on stdout stays machine-readable.
    if (!HAVE_SIGNING_KEY) {
      process.stderr.write(
        "ainarres: JWT_SECRET is unset — signing with the dev-only default. Any substrate "
        + "configured with a real key will answer 401. If you are the operator seat, ask the "
        + "credential broker instead: `ainarres seat-token`.\n",
      );
    }
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
  // Raw JSON of api.governance_status (v5, M21/M22) — the family/capability revocation
  // state (banned/permanent/heal_at/…). Oversight-only view; needs an oversight token.
  // Used by the standing service to CONSUME governance (loop/driver-lib.sh::skip_if_banned
  // — don't spawn a temp-banned family), and handy for the owner directly.
  // M27 (v7.1 / ADR 0026): pending work in capability terms. The service reads this to
  // spawn only the tiers some waiting task needs; an operator reads it to see whether any
  // demanded bundle has no seated family at all.
  async demand(rest, values, token) {
    const r = await restGet("demand", token);
    emit(r.body, r.httpOk);
  },

  // v8 step 2 (ADR 0028) — WRITE one line to the operator's ledger. The instance-scoped
  // acts (started the service, reconfigured a tier, decided to do nothing) have no task,
  // so they cannot be app.events; this is where they land. Self-mints a seat token when
  // none is supplied, exactly as `refine` does.
  async "operator-log"(rest, values, token) {
    const action = values.action ?? null;
    if (!action) fail("operator-log: --action SLUG is required (lower_snake, e.g. service_start)");
    const outcome = values.outcome ?? "ok";
    if (!["ok", "refused", "failed"].includes(outcome)) {
      fail(`operator-log: --outcome must be ok, refused or failed (got '${outcome}')`);
    }
    let detail = {};
    if (values.detail) {
      try { detail = JSON.parse(values.detail); } catch (e) { fail(`operator-log: --detail is not JSON (${e.message})`); }
    }
    const tok = token || (await seatToken({
      role: "agent",
      family: values.family ?? OPERATOR_FAMILY,
      features: ["role:operator"],
      ttl: Number(values.ttl ?? 900),
      reason: `operator-log ${action}`,
      values,
    })).token;
    const r = await rpc("record_operator_action", {
      p_action: action,
      p_target: values.target ?? null,
      p_task: values.task ?? null,
      p_outcome: outcome,
      p_reason: values.reason ?? null,
      p_detail: detail,
    }, tok);
    if (!r.httpOk) {
      let hint = null;
      try { hint = permissionHint(r.body, decodeClaims(tok)); } catch { /* never fail on a hint */ }
      if (hint) process.stderr.write(`ainarres: operator-log — ${hint}\n`);
    }
    emit(r.body, r.httpOk);
  },

  // READ the ledger (api.operator_actions, newest-first). Oversight or monitor token —
  // a delegated monitor whose job is "read what the operator did" holds `monitor`.
  // v8 step 3 (ADR 0028) — get a seat credential FROM THE ENVELOPE. The database decides
  // what is in it; the broker only signs. Prints the token alone (so it can be captured
  // into a variable) or the full envelope with --json.
  async "seat-token"(rest, values) {
    const role = values.role ?? "agent";
    const tok = await brokerToken({
      role,
      ttl: Number(values.ttl ?? 300),
      reason: values.reason ?? null,
      values,
    });
    if (!tok) {
      fail("seat-token: no broker reachable — start it with `make broker-serve` (it writes loop/run/broker.psk), or pass --broker-psk / set BROKER_PSK");
    }
    if (values.json) return emit({ ok: true, token: tok, claims: decodeClaims(tok) });
    process.stdout.write(`${tok}\n`);
  },

  async "operator-actions"(rest, values, token) {
    const limit = values.limit ? Number(values.limit) : 20;
    const r = await restGet(`operator_actions?limit=${limit}`, token);
    emit(r.body, r.httpOk);
  },

  // The issuance trail (v8 step 3): every credential the envelope handed out. Read it next
  // to api.unbrokered_operator_acts — an operator act with no issuance behind it was signed
  // by something holding the key directly.
  async "operator-credentials"(rest, values, token) {
    const limit = values.limit ? Number(values.limit) : 20;
    const r = await restGet(`operator_credentials?limit=${limit}`, token);
    emit(r.body, r.httpOk);
  },

  async "governance-status"(rest, values, token) {
    const r = await restGet(`governance_status?order=family.asc,capability.asc`, token);
    emit(r.body, r.httpOk);
  },

  // Local liveness readout — reads the process's OWN status file (no token,
  // no network, no DB). Prints formatServiceStatus(parsed) or null-readout
  // when the file is absent / unparseable.
  "service-status"(rest, values) {
    const filePath = values.file ?? "loop/run/service.status";
    let parsed = null;
    try {
      const raw = readFileSync(filePath, "utf8");
      parsed = JSON.parse(raw);
    } catch (_) {
      // file absent or unparseable → not-running
    }
    // --json hands back the raw status file (or `null` when there is none) so a caller
    // that must BRANCH on the state — an operator seat deciding whether to stop the
    // service — is not parsing the human line. Same file, no interpretation.
    if (values.json) return emit(parsed ?? { running: false, pid: null });
    process.stdout.write(formatServiceStatus(parsed) + "\n");
  },

  // One-glance oversight summary: fetch board/feed/abandoned views in parallel and
  // hand the rows to the pure formatStatus(). Prints HUMAN TEXT (not JSON) — or
  // JSON when --json is set. Needs an oversight-capable token at runtime (the views
  // are granted to the oversight role); a non-oversight token gets a PostgREST
  // 401/403 → JSON error envelope + exit 1.
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
      if (values.json) {
        return statusJson({ board: b.body, feed: f.body, abandoned: a.body }, { lane, feedLimit });
      }
      return formatStatus({ board: b.body, feed: f.body, abandoned: a.body }, { lane, feedLimit, compact: values.compact });
    };

    // --json: single print, no watch loop (--json wins over --watch).
    if (values.json) {
      const result = await snapshot();
      if (result != null) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }

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
    // M22: audit_flags and governance_actions are also unfiltered and degrade to [].
    // M23: spend_anomalies and operational_flags are unfiltered and degrade to [] —
    // a substrate without them still yields a full report.
    // M24: open_briefs is unfiltered and degrades to [] — a substrate without the
    // intake view still yields a full report.
    // v8: stuck_tasks is unfiltered with NO order= param (the view's own order is
    // authoritative) and degrades to [] the same way.
    // v8: operator_actions is unfiltered, limit=25, NO order= param (the view is
    // already newest-first) and degrades to [] — a substrate without the view
    // still yields a full report.
    // v8: sweep_usage is unfiltered with NO order= param (the view is already
    // ordered tokens DESC) and degrades to [] — a substrate without the view
    // still yields a full report.
    const [b, t, tr, gov, af, ga, sa, of, ob, st, oa, su] = await Promise.all([
      restGet(`board?${boardQ}`, token),
      restGet(`timeline?${tlQ}`, token),
      restGet(`family_track_record?order=family.asc,capability.asc`, token),
      restGet(`governance_status?order=family.asc,capability.asc`, token),
      restGet(`audit_flags?order=family.asc,capability.asc`, token),
      restGet(`governance_actions?order=created_at.desc`, token),
      restGet(`spend_anomalies?order=family.asc,capability.asc`, token),
      restGet(`operational_flags?order=created_at.desc`, token),
      restGet(`open_briefs?order=created_at.desc`, token),
      restGet(`stuck_tasks`, token),
      restGet(`operator_actions?limit=25`, token),
      restGet(`sweep_usage`, token),
    ]);
    for (const r of [b, t]) {
      if (!r.httpOk) { emit(r.body ?? { ok: false, code: "http_error", status: r.status }, false); return; }
    }
    const trackRecord = tr.httpOk && Array.isArray(tr.body) ? tr.body : [];
    const governance = gov.httpOk && Array.isArray(gov.body) ? gov.body : [];
    const auditFlags = af.httpOk && Array.isArray(af.body) ? af.body : [];
    const governanceActions = ga.httpOk && Array.isArray(ga.body) ? ga.body : [];
    const spendAnomalies = sa.httpOk && Array.isArray(sa.body) ? sa.body : [];
    const operationalFlags = of.httpOk && Array.isArray(of.body) ? of.body : [];
    const openBriefs = ob.httpOk && Array.isArray(ob.body) ? ob.body : [];
    const stuckTasks = st.httpOk && Array.isArray(st.body) ? st.body : [];
    const operatorActions = oa.httpOk && Array.isArray(oa.body) ? oa.body : [];
    const sweepUsage = su.httpOk && Array.isArray(su.body) ? su.body : [];
    if (values.json) {
      process.stdout.write(`${JSON.stringify(reportJson({ board: b.body, timeline: t.body, trackRecord, governance, auditFlags, governanceActions, spendAnomalies, operationalFlags, openBriefs, stuckTasks, operatorActions, sweepUsage }, { lane }), null, 2)}\n`);
    } else {
      process.stdout.write(`${formatReport({ board: b.body, timeline: t.body, trackRecord, governance, auditFlags, governanceActions, spendAnomalies, operationalFlags, openBriefs, stuckTasks, operatorActions, sweepUsage }, { lane })}\n`);
    }
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
    // v8: the family travels to the substrate now, not just to parseUsage. A sweep that
    // claimed nothing has no task to charge and often no agent row either, so the family
    // is the only attribution left — and that spend is real (three empty sweeps cost
    // ~474k tokens in one measured run). Without it the verb can only drop the number.
    if (values.family) body.family = values.family;
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
  demand: { token: { type: "string" } },
  "governance-status": { token: { type: "string" } },
  "operator-log": { action: { type: "string" }, target: { type: "string" }, task: { type: "string" }, outcome: { type: "string" }, reason: { type: "string" }, detail: { type: "string" }, family: { type: "string" }, ttl: { type: "string" }, token: { type: "string" } },
  "operator-actions": { limit: { type: "string" }, token: { type: "string" } },
  "seat-token": { role: { type: "string" }, ttl: { type: "string" }, reason: { type: "string" }, "broker-psk": { type: "string" }, "broker-port": { type: "string" }, "broker-url": { type: "string" }, json: { type: "boolean" } },
  "operator-credentials": { limit: { type: "string" }, token: { type: "string" } },
  "service-status": { file: { type: "string" }, json: { type: "boolean" } },
  status: { lane: { type: "string" }, limit: { type: "string" }, watch: { type: "boolean" }, interval: { type: "string" }, compact: { type: "boolean" }, json: { type: "boolean" }, token: { type: "string" } },
  events: { lane: { type: "string" }, task: { type: "string" }, family: { type: "string" }, type: { type: "string" }, limit: { type: "string" }, json: { type: "boolean" }, token: { type: "string" } },
  report: { lane: { type: "string" }, limit: { type: "string" }, json: { type: "boolean" }, token: { type: "string" } },
  intake: { request: { type: "string" }, file: { type: "string" }, subject: { type: "string" }, url: { type: "string" }, port: { type: "string" }, psk: { type: "string" }, "psk-file": { type: "string" }, json: { type: "boolean" } },
  refine: { brief: { type: "string" }, note: { type: "string" }, lane: { type: "string" }, to: { type: "string" }, family: { type: "string" }, tries: { type: "string" }, ttl: { type: "string" }, json: { type: "boolean" }, token: { type: "string" } },
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
  intake  (--request TEXT | --file PATH) [--subject S] [--port N | --url URL] [--psk K | --psk-file P]
            post a request to the local intake channel (PSK auth, no JWT; key from loop/run/intake.psk)
  refine  [<brief-id>] [--note T] [--lane intake] [--family agent+operator]
            the intaker's step: claim a brief and advance it to 'briefed' (self-mints the OPERATOR SEAT token)
  operator-log  --action SLUG [--target T] [--task UUID] [--outcome ok|refused|failed] [--reason T] [--detail JSON]
            v8 append one line to the operator's ledger — the instance-scoped acts that cannot be events
  operator-actions [--limit N]   read that ledger, newest first (oversight or monitor token)
  seat-token  [--role agent|monitor] [--ttl 300] [--reason T]
            v8 get a seat credential FROM the envelope (the DB decides its contents; the broker only signs)
  operator-credentials [--limit N]   the issuance trail — every credential the envelope handed out
  board | feed | abandoned [--lane L] [--task UUID] [--limit N]
  demand              v7.1 pending work by required-capability bundle (what to wake) — oversight/monitor token
  governance-status   v5 governance state (banned/permanent/heal_at) per (family, capability) — oversight token
  status  [--lane L] [--limit N] [--watch [--interval 2]]   one-glance oversight summary (board + active + abandoned + why-stuck)
  service-status  [--file PATH] [--json]   v7 standing-service liveness readout (reads loop/run/service.status; no token/network)
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
    // `intake` authenticates with the channel's PSK, and `refine` self-mints the intaker
    // token it needs — neither requires an ambient AINARRES_TOKEN.
    const needsToken = !["token", "version", "service-status", "intake", "refine", "operator-log", "seat-token"].includes(cmd);
    if (needsToken && !token) fail(`${cmd}: no token (set AINARRES_TOKEN or pass --token)`);
    await COMMANDS[cmd](rest, values, token, positionals[0]);
  }
}
