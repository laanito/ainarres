import { describe, expect, test } from "vitest";
import { formatStatus, statusJson, formatEvents, formatReport, reportJson, fmtTokens, fmtDuration, formatServiceStatus } from "../bin/ainarres.mjs";

// Pure unit test: no substrate, no network, no DB, no token. We import the
// formatter directly from the CLI module — which must NOT run the CLI on import
// (guarded by isMain). All rows are built inline.

describe("formatStatus", () => {
  test("per-stage counts and total from board", () => {
    const board = [
      { task_id: "t1", stage: "implementing" },
      { task_id: "t2", stage: "implementing" },
      { task_id: "t3", stage: "reviewing" },
    ];
    const out = formatStatus({ board });
    expect(out).toContain("  implementing: 2");
    expect(out).toContain("  reviewing: 1");
    expect(out).toContain("  total: 3");
  });

  test("abandoned rows show task_id, stage and claimed_by", () => {
    const abandoned = [
      { task_id: "dead-1", stage: "implementing", claimed_by: "worker-7" },
    ];
    const out = formatStatus({ board: [{ task_id: "x", stage: "ready" }], abandoned });
    expect(out).toContain("abandoned (1):");
    expect(out).toContain("dead-1");
    expect(out).toContain("claimed_by=worker-7");
  });

  test("feed is truncated to feedLimit, newest-first preserved", () => {
    // Build 5 events newest-first (the view already sorts this way).
    const feed = [
      { created_at: "2026-06-27T05:00:00Z", type: "claimed", task_id: "e5", actor: "a5" },
      { created_at: "2026-06-27T04:00:00Z", type: "advanced", task_id: "e4", actor: "a4" },
      { created_at: "2026-06-27T03:00:00Z", type: "created", task_id: "e3", actor: "a3" },
      { created_at: "2026-06-27T02:00:00Z", type: "created", task_id: "e2", actor: "a2" },
      { created_at: "2026-06-27T01:00:00Z", type: "created", task_id: "e1", actor: "a1" },
    ];
    const out = formatStatus({ feed }, { feedLimit: 3 });
    expect(out).toContain("recent events (showing up to 3):");
    // newest (first) present
    expect(out).toContain("e5");
    expect(out).toContain("claimed");
    // third still present
    expect(out).toContain("e3");
    // fourth onward (beyond feedLimit) absent
    expect(out).not.toContain("e2");
    expect(out).not.toContain("e1");
  });

  test("empty inputs produce placeholders", () => {
    const out = formatStatus({});
    expect(out).toContain("  (no tasks)");
    expect(out).toContain("  (none)");
    expect(out).toContain("  (no events)");
    expect(out).toContain("abandoned (0):");
    expect(out).toContain("recent events (showing up to 10):");
  });

  test("lane header vs all-lanes header includes task count", () => {
    const board3 = [
      { task_id: "t1", stage: "implementing" },
      { task_id: "t2", stage: "implementing" },
      { task_id: "t3", stage: "reviewing" },
    ];
    expect(formatStatus({ board: board3 }, { lane: "dev" })).toContain("status — lane dev (3 tasks)");
    expect(formatStatus({})).toContain("status — all lanes (0 tasks)");
  });

  test("blocked count line is emitted after totals and counts rows with blocked===true", () => {
    const board = [
      { task_id: "t1", stage: "implementing", blocked: true },
      { task_id: "t2", stage: "implementing", blocked: false },
      { task_id: "t3", stage: "reviewing", blocked: true },
      { task_id: "t4", stage: "reviewing" }, // absent blocked should not count
    ];
    const out = formatStatus({ board });
    expect(out).toContain("  blocked: 2");
  });

  test("lists blocked task ids indented after the blocked: N line, in board order; no list when zero", () => {
    const boardWithBlocked = [
      { task_id: "a1", stage: "implementing", blocked: false },
      { task_id: "b2", stage: "reviewing", blocked: true },
      { task_id: "c3", stage: "integrating", blocked: true },
      { task_id: "d4", stage: "done", blocked: false },
    ];
    const outWith = formatStatus({ board: boardWithBlocked });
    expect(outWith).toContain("  blocked: 2");
    // must be immediately after the blocked line, in board appearance order
    const blockedIdx = outWith.indexOf("  blocked: 2");
    const b2Idx = outWith.indexOf("  - b2");
    const c3Idx = outWith.indexOf("  - c3");
    expect(b2Idx).toBeGreaterThan(blockedIdx);
    expect(c3Idx).toBeGreaterThan(b2Idx);
    // d4 and a1 must not appear under blocked
    expect(outWith).not.toContain("  - a1");
    expect(outWith).not.toContain("  - d4");

    const boardNoBlocked = [
      { task_id: "x1", stage: "implementing", blocked: false },
      { task_id: "x2", stage: "reviewing" },
    ];
    const outNo = formatStatus({ board: boardNoBlocked });
    expect(outNo).toContain("  blocked: 0");
    expect(outNo).not.toContain("  - ");
  });

  test("claimed count line is emitted after the blocked section and before abandoned; counts non-null claimed_by; always emitted even at 0", () => {
    const boardWithClaimed = [
      { task_id: "t1", stage: "implementing", claimed_by: "agent-1" },
      { task_id: "t2", stage: "implementing", claimed_by: null },
      { task_id: "t3", stage: "reviewing", claimed_by: "agent-2" },
      { task_id: "t4", stage: "reviewing" },
    ];
    const out = formatStatus({ board: boardWithClaimed });
    expect(out).toContain("  claimed: 2");
    // must appear after blocked section, before abandoned
    const blockedIdx = out.indexOf("  blocked:");
    const claimedIdx = out.indexOf("  claimed: 2");
    const abandonedIdx = out.indexOf("abandoned (");
    expect(claimedIdx).toBeGreaterThan(blockedIdx);
    expect(abandonedIdx).toBeGreaterThan(claimedIdx);

    const boardNoClaimed = [
      { task_id: "x1", stage: "implementing" },
      { task_id: "x2", stage: "reviewing", claimed_by: null },
    ];
    const outNo = formatStatus({ board: boardNoClaimed });
    expect(outNo).toContain("  claimed: 0");
  });

  // ── M16 enrichments ────────────────────────────────────────────────────────

  test("active section names the holder family and age-in-stage for claimed-not-abandoned tasks", () => {
    const board = [
      { task_id: "t1", stage: "implementing", claimed_by: "sub-1", claimed_by_family: "opencode+qwen", age_in_stage: "00:02:13" },
      { task_id: "t2", stage: "reviewing", claimed_by: null },
    ];
    const out = formatStatus({ board });
    expect(out).toContain("active (1):");
    expect(out).toContain("  - t1 [implementing] opencode+qwen age=00:02:13");
  });

  test("stranded (abandoned) rows name the family and age too", () => {
    const abandoned = [
      { task_id: "dead-1", stage: "implementing", claimed_by: "sub-9", claimed_by_family: "grok+grok-build", age_in_stage: "00:10:00" },
    ];
    const out = formatStatus({ board: [{ task_id: "x", stage: "ready" }], abandoned });
    expect(out).toContain("  - dead-1 [implementing] claimed_by=sub-9 family=grok+grok-build age=00:10:00");
  });

  test("why-stuck escalated section lists live escalated tasks by target tier, deduped, terminal excluded", () => {
    const board = [
      { task_id: "esc-1", stage: "implementing", is_terminal: false },
      { task_id: "shipped", stage: "done", is_terminal: true },
    ];
    const feed = [
      { type: "escalated", task_id: "esc-1", data: { from_tier: 1, to_tier: 2 } },
      { type: "escalated", task_id: "esc-1", data: { from_tier: 1, to_tier: 2 } }, // dup → once
      { type: "escalated", task_id: "shipped", data: { from_tier: 1, to_tier: 2 } }, // terminal → excluded
    ];
    const out = formatStatus({ board, feed });
    expect(out).toContain("escalated (1):");
    expect(out).toContain("  - esc-1 → tier:2 (waiting for a higher tier)");
    expect(out).not.toContain("  - shipped");
  });

  test("recent events attribute by family when present, else actor", () => {
    const feed = [
      { created_at: "t5", type: "transition", task_id: "e5", actor: "a5", family: "grok+grok-build" },
      { created_at: "t4", type: "claimed", task_id: "e4", actor: "a4" },
    ];
    const out = formatStatus({ feed });
    expect(out).toContain("by grok+grok-build");
    expect(out).toContain("by a4");
  });

  // ── Compact mode (acceptance criteria 1-4) ─────────────────────────────────

  test("compact mode: exact output for mixed board with claimed, no blocked, no abandoned", () => {
    const board = [
      { task_id: "t1", stage: "designing" },
      { task_id: "t2", stage: "done" },
      { task_id: "t3", stage: "done" },
      { task_id: "t4", stage: "implementing", claimed_by: "agent-1", abandoned: false },
    ];
    const out = formatStatus({ board, feed: [], abandoned: [] }, { lane: "dev", compact: true });
    expect(out).toBe("status — lane dev (4 tasks)\n  designing:1 done:2 implementing:1\n  blocked:0 claimed:1 active:1 abandoned:0");
    expect(out).not.toContain("recent events");
    expect(out).not.toContain("abandoned (");
    expect(out).not.toContain("total:");
  });

  test("compact mode: empty board and empty feed/abandoned", () => {
    const out = formatStatus({}, { compact: true });
    expect(out).toBe("status — all lanes (0 tasks)\n  (no tasks)\n  blocked:0 claimed:0 active:0 abandoned:0");
  });

  test("compact mode: blocked and abandoned counters are reflected", () => {
    const board = [
      { task_id: "t1", stage: "implementing", blocked: true },
      { task_id: "t2", stage: "reviewing" },
    ];
    const abandoned = [
      { task_id: "a1", stage: "implementing", claimed_by: "w-1" },
      { task_id: "a2", stage: "designing", claimed_by: "w-2" },
    ];
    const out = formatStatus({ board, abandoned }, { compact: true });
    expect(out).toContain("blocked:1");
    expect(out).toContain("abandoned:2");
    expect(out).toContain("claimed:0");
    expect(out).toContain("active:0");
  });

  test("compact mode: no compact option still renders every existing section (regression guard)", () => {
    const board = [
      { task_id: "t1", stage: "implementing", claimed_by: "agent-1" },
    ];
    const feed = [
      { created_at: "t5", type: "claimed", task_id: "e5", actor: "a5" },
    ];
    const out = formatStatus({ board, feed, abandoned: [] });
    expect(out).toContain("recent events (showing up to 10):");
    expect(out).toContain("abandoned (0):");
    // No compact marker lines appear
    expect(out).not.toMatch(/^  blocked:\d+ claimed:\d+ active:\d+ abandoned:\d+$/m);
  });
});

describe("statusJson", () => {
  test("(1) board of one designing, two done, one implementing (claimed, not abandoned) — full shape", () => {
    const board = [
      { task_id: "t1", stage: "designing" },
      { task_id: "t2", stage: "done" },
      { task_id: "t3", stage: "done" },
      { task_id: "t4", stage: "implementing", claimed_by: "agent-1" },
    ];
    expect(statusJson({ board }, { lane: "dev" })).toEqual({
      lane: "dev",
      total: 4,
      stages: { designing: 1, done: 2, implementing: 1 },
      blocked: 0,
      claimed: 1,
      active: 1,
      abandoned: 0,
      recentEvents: [],
    });
  });

  test("(2) no args returns empty shape", () => {
    expect(statusJson()).toEqual({
      lane: null,
      total: 0,
      stages: {},
      blocked: 0,
      claimed: 0,
      active: 0,
      abandoned: 0,
      recentEvents: [],
    });
  });

  test("(3) blocked and abandoned counts from inputs", () => {
    const board = [
      { task_id: "t1", stage: "implementing", blocked: true },
      { task_id: "t2", stage: "reviewing" },
    ];
    const abandoned = [
      { task_id: "a1", stage: "implementing", claimed_by: "w-1" },
      { task_id: "a2", stage: "designing", claimed_by: "w-2" },
    ];
    expect(statusJson({ board, abandoned })).toMatchObject({
      blocked: 1,
      abandoned: 2,
    });
  });

  test("(4) feed truncated to feedLimit, first item mapped correctly", () => {
    const feed = Array.from({ length: 12 }, (_, i) => ({
      created_at: `2026-07-0${(i % 9) + 1}T00:00:00Z`,
      type: i === 0 ? "claimed" : "created",
      task_id: `t${12 - i}`,
      family: i === 0 ? "grok+grok-build" : null,
      actor: i === 0 ? "sub-1" : `sub-${i + 1}`,
    }));
    const result = statusJson({ feed }, { feedLimit: 10 });
    expect(result.recentEvents).toHaveLength(10);
    expect(result.recentEvents[0]).toEqual({
      at: feed[0].created_at,
      type: feed[0].type,
      task: feed[0].task_id,
      by: feed[0].family ?? feed[0].actor ?? null,
    });
  });

  test("(5) JSON.stringify(statusJson({})) round-trips to empty shape (no undefined, no functions)", () => {
    const parsed = JSON.parse(JSON.stringify(statusJson({})));
    expect(parsed).toEqual({
      lane: null,
      total: 0,
      stages: {},
      blocked: 0,
      claimed: 0,
      active: 0,
      abandoned: 0,
      recentEvents: [],
    });
  });

  test("statusJson never throws on empty/partial input", () => {
    expect(() => statusJson()).not.toThrow();
    expect(() => statusJson({ board: null })).not.toThrow();
    expect(() => statusJson({ board: undefined, feed: null })).not.toThrow();
    expect(() => statusJson({ board: [], feed: [], abandoned: [] })).not.toThrow();
  });
});

describe("formatEvents", () => {
  test("renders the verdict/reason gist for transition, escalated, released", () => {
    const rows = [
      { created_at: "t3", type: "transition", task_id: "x", family: "f", data: { kind: "reject", from: "reviewing", to: "implementing", reason: "tests fail" } },
      { created_at: "t2", type: "escalated", task_id: "x", family: "f", data: { from_tier: 1, to_tier: 2, attempts: 2 } },
      { created_at: "t1", type: "released", task_id: "x", actor: "a", data: { reason: "stuck", attempts: 1 } },
    ];
    const out = formatEvents(rows, { limit: 50 });
    expect(out).toContain("timeline (showing up to 50):");
    expect(out).toContain("reject reviewing→implementing: tests fail");
    expect(out).toContain("tier 1→2, attempt 2");
    expect(out).toContain("released: stuck, attempt 1");
    expect(out).toContain(" f"); // family attribution
  });

  test("empty rows produce a placeholder; limit truncates newest-first", () => {
    expect(formatEvents([], { limit: 10 })).toContain("  (no events)");
    const rows = [
      { created_at: "t3", type: "created", task_id: "c", family: "f" },
      { created_at: "t2", type: "created", task_id: "b", family: "f" },
      { created_at: "t1", type: "created", task_id: "a", family: "f" },
    ];
    const out = formatEvents(rows, { limit: 2 });
    expect(out).toContain("c");
    expect(out).toContain("b");
    expect(out).not.toContain(" a "); // beyond limit
  });
});

describe("formatReport", () => {
  test("names shipped tasks with their PR, failures with reason, escalations, and per-family activity", () => {
    const board = [
      { task_id: "ship-1", is_terminal: true },
      { task_id: "fail-1", blocked: true, blocked_reason: "max attempts exceeded" },
      { task_id: "wip-1", is_terminal: false },
    ];
    const timeline = [
      { task_id: "ship-1", type: "transition", family: "grok+grok-build", data: { artifacts: [{ type: "pr", url: "https://gh/pr/7" }] } },
      { task_id: "ship-1", type: "claimed", family: "opencode+qwen", data: {} },
      { task_id: "wip-1", type: "escalated", family: "opencode+qwen3.6", data: { from_tier: 1, to_tier: 2 } },
      { task_id: "fail-1", type: "blocked", family: null, data: { reason: "max attempts exceeded" } },
    ];
    const out = formatReport({ board, timeline }, { lane: "dev" });
    expect(out).toContain("end-of-run report — lane dev");
    expect(out).toContain("shipped (1):");
    expect(out).toContain("  - ship-1  https://gh/pr/7");
    expect(out).toContain("failed/blocked (1):");
    expect(out).toContain("  - fail-1: max attempts exceeded");
    expect(out).toContain("escalations (1):");
    expect(out).toContain("  - wip-1 → tier:2");
    expect(out).toContain("activity by family:");
    expect(out).toContain("  - grok+grok-build: 1 events");
    expect(out).toContain("  - (human/system): 1 events");
  });

  test("empty board/timeline yields all-zero sections with placeholders", () => {
    const out = formatReport({});
    expect(out).toContain("shipped (0):");
    expect(out).toContain("failed/blocked (0):");
    expect(out).toContain("escalations (0):");
    expect(out.match(/\(none\)/g)?.length).toBeGreaterThanOrEqual(3);
  });

  test("a shipped task with no PR ref says so", () => {
    const out = formatReport({ board: [{ task_id: "s", is_terminal: true }], timeline: [] });
    expect(out).toContain("  - s  (no PR ref)");
  });

  // ── Per-task family attribution & cross-family summary ──────────────────

  test("shipped task attribution shows families for each stage, em-dash when absent", () => {
    // T1: implementing→reviewing family "opencode+big-pickle", reviewing→integrating family "claude-code+sonnet"
    const board = [
      { task_id: "T1", is_terminal: true },
    ];
    const timeline = [
      { task_id: "T1", type: "transition", family: "opencode+big-pickle", data: { from: "implementing", to: "reviewing" } },
      { task_id: "T1", type: "transition", family: "claude-code+sonnet", data: { from: "reviewing", to: "integrating" } },
    ];
    const out = formatReport({ board, timeline });
    expect(out).toContain("  - T1");
    expect(out).toContain("      by family: implemented=opencode+big-pickle reviewed=claude-code+sonnet integrated=\u2014");
    // Cross-family: reviewed-by != implemented-by → counted
    expect(out).toContain("      cross-family review: 1/1 shipped tasks reviewed by a different family than implemented");
  });

  test("same family for implementing and reviewing is not cross-family", () => {
    const board = [
      { task_id: "T1", is_terminal: true },
    ];
    const timeline = [
      { task_id: "T1", type: "transition", family: "same-family", data: { from: "implementing", to: "reviewing" } },
      { task_id: "T1", type: "transition", family: "same-family", data: { from: "reviewing", to: "integrating" } },
    ];
    const out = formatReport({ board, timeline });
    // Task is in M (has both families) but NOT in N (same family)
    expect(out).toContain("      cross-family review: 0/1 shipped tasks reviewed by a different family than implemented");
  });

  test("shipped task with no reviewing transition shows em-dash and does not crash", () => {
    const board = [
      { task_id: "T1", is_terminal: true },
    ];
    const timeline = [
      { task_id: "T1", type: "transition", family: "opencode+qwen", data: { from: "implementing", to: "reviewing" } },
      // No reviewing→integrating transition
    ];
    const out = formatReport({ board, timeline });
    expect(out).toContain("      by family: implemented=opencode+qwen reviewed=\u2014 integrated=\u2014");
    // No task has both implemented-by and reviewed-by → M=0
    expect(out).toContain("      cross-family review: n/a (no reviewed tasks)");
  });

  test("cross-family review shows n/a when no shipped task has both families", () => {
    const board = [
      { task_id: "T1", is_terminal: true },
    ];
    // No transitions at all
    const out = formatReport({ board, timeline: [] });
    expect(out).toContain("      by family: implemented=\u2014 reviewed=\u2014 integrated=\u2014");
    expect(out).toContain("      cross-family review: n/a (no reviewed tasks)");
  });

  test("empty/partial timeline does not throw", () => {
    const out = formatReport({});
    expect(out).toContain("shipped (0):");
    expect(out).toContain("cross-family review: n/a (no reviewed tasks)");
  });

  // ── M20 track record section (competence · spend, kept separate) ─────────
  test("renders the per-(family, capability) track record with spend as its own column", () => {
    const trackRecord = [
      {
        family: "opencode+big-pickle", capability: "role:implementer",
        delivered: 5, rejected: 2, cross_family_rejected: 2, reject_rate: 0.4,
        total_tokens: null, tokens_per_delivery: null, // opencode emits no tokens → unknown
      },
      {
        family: "claude-code+sonnet", capability: "role:reviewer",
        delivered: 3, rejected: 0, cross_family_rejected: 0, reject_rate: 0,
        total_tokens: 1_200_000, tokens_per_delivery: 400_000,
      },
    ];
    const out = formatReport({ board: [], timeline: [], trackRecord });
    expect(out).toContain("family track record");
    // Competence + spend on one line; tokens UNKNOWN (not 0) for the unmeasured family.
    expect(out).toContain("  - opencode+big-pickle / role:implementer: 5 delivered, 2 rejected (40%), 2 cross-family · tokens: unknown");
    expect(out).toContain("  - claude-code+sonnet / role:reviewer: 3 delivered, 0 rejected (0%), 0 cross-family · tokens: 1.2M, 400.0k/delivery");
    // The separation is stated in the report itself.
    expect(out).toContain("expensive, not failing");
  });

  test("track record: no rows → placeholder; reject_rate null → n/a", () => {
    expect(formatReport({}).match(/family track record[^\n]*\n\s+\(none\)/)).not.toBeNull();
    const out = formatReport({ trackRecord: [{ family: "f", capability: "role:x", delivered: 0, rejected: 0, cross_family_rejected: 0, reject_rate: null, total_tokens: null }] });
    expect(out).toContain("0 rejected (n/a)");
  });

  // ── v8 — empty-sweep spend (api.sweep_usage) ──────────────────────────────

  test("sweep spend: formatReport({}) renders no sweep block, still renders every section, does not throw", () => {
    const out = formatReport({});
    expect(out).not.toContain("spend that moved nothing");
    expect(out).toContain("shipped (");
    expect(out).toContain("family track record");
    expect(out).toContain("governance");
    // The existing assertion that "  (none)" immediately follows the header still holds.
    expect(out.match(/family track record[^\n]*\n\s+\(none\)/)).not.toBeNull();
  });

  test("sweep spend: single row renders header, row, and total", () => {
    const out = formatReport({
      sweepUsage: [{ family: "opencode+nemotron-3-ultra", sweeps: 41, tokens: 304210 }],
    });
    expect(out).toContain("spend that moved nothing (sweeps that claimed no task):");
    expect(out).toContain("- opencode+nemotron-3-ultra: 304.2k over 41 sweep(s)");
    expect(out).toContain("total: 304.2k spent claiming nothing");
  });

  test("sweep spend: two rows sum the total line", () => {
    const out = formatReport({
      sweepUsage: [
        { family: "a", sweeps: 41, tokens: 304210 },
        { family: "b", sweeps: 20, tokens: 140323 },
      ],
    });
    expect(out).toContain("total: 444.5k spent claiming nothing");
  });

  test("sweep spend: tokens arriving as a STRING render identically to the number", () => {
    const asNumber = formatReport({ sweepUsage: [{ family: "f", sweeps: 1, tokens: 304210 }] });
    const asString = formatReport({ sweepUsage: [{ family: "f", sweeps: 1, tokens: "304210" }] });
    expect(asString).toContain("- f: 304.2k over 1 sweep(s)");
    expect(asString).toContain("total: 304.2k spent claiming nothing");
    expect(asString).toBe(asNumber);
  });

  test("sweep spend: a row with family null renders the em dash", () => {
    const out = formatReport({ sweepUsage: [{ family: null, sweeps: 2, tokens: 100 }] });
    expect(out).toContain("- \u2014: 100 over 2 sweep(s)");
  });

  test("sweep spend: 12 rows render exactly 10 detail lines, total still covers all 12", () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ family: `f${i}`, sweeps: 1, tokens: 1000 }));
    const out = formatReport({ sweepUsage: rows });
    const detailLines = out.split("\n").filter(l => /^  - f\d+: 1.0k over 1 sweep\(s\)$/.test(l));
    expect(detailLines.length).toBe(10);
    expect(out).toContain("total: 12.0k spent claiming nothing");
  });

  test("sweep spend: with a non-empty trackRecord, the separate-signal line comes AFTER the sweep block", () => {
    const out = formatReport({
      trackRecord: [{ family: "f", capability: "role:x", delivered: 1, rejected: 0, cross_family_rejected: 0, reject_rate: 0, total_tokens: 100 }],
      sweepUsage: [{ family: "g", sweeps: 1, tokens: 50 }],
    });
    const sweepIdx = out.indexOf("spend that moved nothing");
    const signalIdx = out.indexOf("(spend is a separate signal");
    expect(sweepIdx).toBeGreaterThan(-1);
    expect(signalIdx).toBeGreaterThan(sweepIdx);
  });

  // ── Governance section (v5 — substrate-revoked capabilities) ─────────────
  test("temp ban: renders heal time from seconds_to_heal", () => {
    const out = formatReport({
      governance: [{ family: "grok+grok-build", capability: "role:implementer", banned: true, permanent: false, seconds_to_heal: 5400 }],
    });
    expect(out).toContain("  - grok+grok-build / role:implementer: BANNED (heals in 1h 30m)");
  });

  test("permanent ban: renders BANNED (permanent — human)", () => {
    const out = formatReport({
      governance: [{ family: "f", capability: "c", banned: true, permanent: true }],
    });
    expect(out).toContain("BANNED (permanent — human)");
  });

  test("trending row: renders strikes/threshold — trending toward a ban", () => {
    const out = formatReport({
      governance: [{ family: "f", capability: "c", trending: true, banned: false, strikes: 2, threshold: 3 }],
    });
    expect(out).toContain("  - f / c: 2/3 strikes — trending toward a ban");
  });

  test("singleton halt: prints the MERGE QUEUE HALTED warning once", () => {
    const out = formatReport({
      governance: [
        { family: "f", capability: "role:implementer", banned: true, permanent: true, singleton_halt: true },
        { family: "g", capability: "role:reviewer", banned: true, permanent: false, seconds_to_heal: 100, singleton_halt: true },
      ],
    });
    const haltLine = "  ⚠ MERGE QUEUE HALTED — the integrator capability is banned; a human must intervene.";
    expect(out).toContain(haltLine);
    // Count occurrences — must be exactly one
    expect(out.split(haltLine).length - 1).toBe(1);
  });

  test("good standing: empty governance or no banned/trending rows prints the placeholder", () => {
    const out = formatReport({ governance: [] });
    expect(out).toContain("  (all families in good standing)");

    const out2 = formatReport({
      governance: [{ family: "f", capability: "c", banned: false, trending: false }],
    });
    expect(out2).toContain("  (all families in good standing)");
  });

  test("totality: formatReport with governance still contains pre-existing sections and does not throw", () => {
    expect(() => formatReport({})).not.toThrow();
    const out = formatReport({});
    expect(out).toContain("shipped (");
    expect(out).toContain("family track record");
    expect(out).toContain("governance");
  });

  // ── M22 — Open audit flags, ban recommendations, human action trail ───────

  test("auditFlags renders one line per flag sorted by family then capability", () => {
    const auditFlags = [
      { family: "f", capability: "role:designer", flag_count: 2, last_gap: "ignores the spec", last_severity: "critical" },
    ];
    const out = formatReport({ board: [], timeline: [], auditFlags });
    expect(out).toContain("  - f / role:designer: 2 audit flag(s) — ignores the spec");
  });

  test("permanent-ban recommendation from governance ban_count >= recommend_ban_count", () => {
    const governance = [
      { family: "g", capability: "role:implementer", banned: false, ban_count: 4, recommend_ban_count: 3 },
    ];
    const out = formatReport({ board: [], timeline: [], governance });
    expect(out).toContain("⚑ RECOMMEND PERMANENT BAN — g / role:implementer");
    expect(out).toContain("4 reflexive bans ≥ 3");
    expect(out).toContain("a human must decide");
  });

  test("permanent-ban recommendation from auditFlags flag_count >= recommend_flag_count", () => {
    const auditFlags = [
      { family: "h", capability: "role:designer", flag_count: 3, recommend_flag_count: 2, last_gap: "x" },
    ];
    const out = formatReport({ board: [], timeline: [], auditFlags });
    expect(out).toContain("⚑ RECOMMEND PERMANENT BAN — h / role:designer");
    expect(out).toContain("3 audit flags ≥ 2");
  });

  test("(family, capability) qualifying from BOTH governance and auditFlags prints exactly ONE recommend line with reasons joined by ; ", () => {
    const governance = [
      { family: "m", capability: "role:designer", banned: false, ban_count: 5, recommend_ban_count: 3 },
    ];
    const auditFlags = [
      { family: "m", capability: "role:designer", flag_count: 4, recommend_flag_count: 2, last_gap: "y" },
    ];
    const out = formatReport({ board: [], timeline: [], governance, auditFlags });
    // Exactly one line containing RECOMMEND PERMANENT BAN for m / role:designer
    const lines = out.split("\n").filter(l => l.includes("RECOMMEND PERMANENT BAN — m / role:designer"));
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("5 reflexive bans ≥ 3");
    expect(lines[0]).toContain("4 audit flags ≥ 2");
    expect(lines[0]).toContain("; ");
  });

  test("governanceActions renders action trail, newest-first, capped at 10", () => {
    const governanceActions = [
      { family: "f", capability: "role:designer", action: "lift", reason: "reinstated" },
      { family: "f", capability: "role:designer", action: "ban_permanent", reason: "repeat" },
    ];
    const out = formatReport({ board: [], timeline: [], governanceActions });
    expect(out).toContain("  governance actions:");
    expect(out).toContain("    - lift f / role:designer — reinstated");
    expect(out).toContain("    - ban_permanent f / role:designer — repeat");
  });

  test("formatReport({}) with no flags/recommendations/actions prints none of the new lines", () => {
    const out = formatReport({});
    expect(out).not.toContain("audit flag(s)");
    expect(out).not.toContain("RECOMMEND PERMANENT BAN");
    expect(out).not.toContain("governance actions:");
  });

  // ── M23 Slice B — operational watch (health & spend) ──────────────────────

  test("operational block: empty groups print the header + single all-clear line, existing sections still render, no throw", () => {
    const out = formatReport({});
    expect(out).toContain("operational (v6 — health & spend watch):");
    expect(out).toContain("  (all clear — no health, spend, or operational-flag anomalies)");
    // The all-clear line REPLACES the three groups — no group lines at all.
    expect(out).not.toContain("  - health: ");
    expect(out).not.toContain(" the peer median");
    expect(out).not.toContain(" — looped ");
    // Pre-existing sections still render.
    expect(out).toContain("shipped (");
    expect(out).toContain("family track record");
    expect(out).toContain("governance (v5");
    expect(() => formatReport({})).not.toThrow();
  });

  test("operational block is the LAST section, after the entire governance section", () => {
    const out = formatReport({
      board: [{ task_id: "t1", stage: "implementing", claimed_by: "fam-x", abandoned: true }],
      governanceActions: [{ action: "lift", family: "f", capability: "c", reason: "ok" }],
    });
    const govIdx = out.indexOf("governance actions:");
    const opIdx = out.indexOf("operational (v6 — health & spend watch):");
    const healthIdx = out.indexOf("  - health: t1 stalled in implementing, held by fam-x (review)");
    expect(govIdx).toBeGreaterThan(-1);
    expect(opIdx).toBeGreaterThan(govIdx);
    expect(healthIdx).toBeGreaterThan(opIdx);
    // The health line is the very last line of the report.
    expect(out.trimEnd().endsWith("held by fam-x (review)")).toBe(true);
  });

  test("health: abandoned board rows render stalled-in lines sorted by task_id, em dash when unclaimed", () => {
    const board = [
      { task_id: "t2", stage: "reviewing", claimed_by: null, abandoned: true },
      { task_id: "t1", stage: "implementing", claimed_by: "fam-x", abandoned: true },
      { task_id: "t3", stage: "implementing", claimed_by: "fam-y", abandoned: false },
    ];
    const out = formatReport({ board });
    const healthLines = out.split("\n").filter(l => l.startsWith("  - health: "));
    expect(healthLines).toEqual([
      "  - health: t1 stalled in implementing, held by fam-x (review)",
      "  - health: t2 stalled in reviewing, held by — (review)",
    ]);
    // Not-abandoned rows are not health signals.
    expect(healthLines.join("\n")).not.toContain("t3");
  });

  test("spend: overspending line carries fmtTokens, the × multiplier, and ends (cost)", () => {
    const spendAnomalies = [
      { family: "c", capability: "role:implementer", anomaly: "overspending", tokens_per_delivery: 5000, peer_median: 120, multiple_over_median: 41.67, overspend_multiple: 5, delivered: 1, usage_events: 1 },
    ];
    const out = formatReport({ spendAnomalies });
    const line = out.split("\n").find(l => l.includes("c / role:implementer: overspending"));
    expect(line).toBeTruthy();
    expect(line).toContain("5.0k/delivery");
    expect(line).toContain("41.67× the peer median");
    expect(line.endsWith("(cost)")).toBe(true);
  });

  test("spend: no_delivery_spend reads burned, with usage event count and (review)", () => {
    const spendAnomalies = [
      { family: "d", capability: "role:reviewer", anomaly: "no_delivery_spend", tokens_per_delivery: null, delivered: 0, usage_events: 2 },
    ];
    const out = formatReport({ spendAnomalies });
    expect(out).toContain("  - d / role:reviewer: burned — 2 usage event(s), 0 delivered (review)");
  });

  test("spend: rows sorted by family then capability", () => {
    const spendAnomalies = [
      { family: "b", capability: "role:z", anomaly: "overspending", multiple_over_median: 1 },
      { family: "a", capability: "role:y", anomaly: "overspending", multiple_over_median: 1 },
      { family: "a", capability: "role:x", anomaly: "overspending", multiple_over_median: 1 },
    ];
    const out = formatReport({ spendAnomalies });
    const ia = out.indexOf("a / role:x");
    const ib = out.indexOf("a / role:y");
    const ic = out.indexOf("b / role:z");
    expect(ia).toBeGreaterThan(-1);
    expect(ib).toBeGreaterThan(ia);
    expect(ic).toBeGreaterThan(ib);
  });

  test("flags: spinning renders (review), overspending kind ends (cost), capped at 10, order preserved", () => {
    const flags = [
      { family: "e", capability: "role:implementer", kind: "spinning", detail: "looped on a hallucinated tool" },
    ];
    const out = formatReport({ operationalFlags: flags });
    expect(out).toContain("  - e / role:implementer: spinning — looped on a hallucinated tool (review)");

    const out2 = formatReport({
      operationalFlags: [{ family: "e", capability: "role:implementer", kind: "overspending", detail: "spend spike" }],
    });
    expect(out2).toContain("  - e / role:implementer: overspending — spend spike (cost)");

    // Cap at the 10 most recent; given (newest-first) order preserved.
    const many = Array.from({ length: 12 }, (_, i) => ({
      family: `f${i}`, capability: "role:implementer", kind: "health", detail: `d${i}`,
    }));
    const out3 = formatReport({ operationalFlags: many });
    const flagLines = out3.split("\n").filter(l => l.includes(": health — d"));
    expect(flagLines.length).toBe(10);
    expect(flagLines[0]).toContain("f0");
    expect(flagLines[9]).toContain("f9");
    expect(flagLines.join("\n")).not.toContain("f10");
    expect(flagLines.join("\n")).not.toContain("f11");
  });

  test("overspending never reads as a ban recommendation in the operational block", () => {
    const spendAnomalies = [
      { family: "c", capability: "role:implementer", anomaly: "overspending", tokens_per_delivery: 5000, multiple_over_median: 41.67 },
    ];
    const out = formatReport({ spendAnomalies });
    const opSection = out.slice(out.indexOf("operational (v6 — health & spend watch):"));
    expect(opSection).not.toContain("BAN");
    expect(opSection).not.toContain("ban");
  });

  // ── v8 — stuck-alive watch (api.stuck_tasks) ──────────────────────────────

  test("stuck: silent_hold row renders inside the operational section, after health and before spend", () => {
    const out = formatReport({
      board: [{ task_id: "h1", stage: "implementing", claimed_by: "fam-x", abandoned: true }],
      stuckTasks: [{ task_id: "t1", stage: "implementing", family: "opencode+big-pickle", kind: "silent_hold", held_for: "01:30:00", silent_for: "01:30:00" }],
      spendAnomalies: [{ family: "c", capability: "role:implementer", anomaly: "overspending", tokens_per_delivery: 5000, multiple_over_median: 5 }],
    });
    expect(out).toContain("  - stuck: t1 in implementing, held by opencode+big-pickle for 1h 30m, silent 1h 30m (review)");
    // Order: health, then stuck, then spend.
    const healthIdx = out.indexOf("  - health: h1");
    const stuckIdx = out.indexOf("  - stuck: t1");
    const spendIdx = out.indexOf("c / role:implementer: overspending");
    expect(healthIdx).toBeGreaterThan(-1);
    expect(stuckIdx).toBeGreaterThan(healthIdx);
    expect(spendIdx).toBeGreaterThan(stuckIdx);
  });

  test("stuck: heartbeat_treadmill row renders lease renewed +duration and alive, not progressing", () => {
    const out = formatReport({
      stuckTasks: [{ task_id: "t2", stage: "reviewing", family: "grok+grok-build", kind: "heartbeat_treadmill", held_for: "03:20:00", extended_by: "02:00:00" }],
    });
    expect(out).toContain("  - stuck: t2 in reviewing, held by grok+grok-build for 3h 20m, lease renewed +2h 0m — alive, not progressing (review)");
  });

  test("stuck: null/absent family renders held by —", () => {
    const out = formatReport({
      stuckTasks: [{ task_id: "t3", stage: "implementing", family: null, kind: "silent_hold", held_for: "00:45:00", silent_for: "00:45:00" }],
    });
    expect(out).toContain("  - stuck: t3 in implementing, held by — for 45m, silent 45m (review)");
  });

  test("stuck: non-empty rows suppress the all-clear line; all-empty still prints it", () => {
    const out = formatReport({
      stuckTasks: [{ task_id: "t1", stage: "implementing", family: "f", kind: "silent_hold", held_for: "00:45:00", silent_for: "00:45:00" }],
    });
    expect(out).not.toContain("(all clear — no health, spend, or operational-flag anomalies)");

    const clear = formatReport({});
    expect(clear).toContain("  (all clear — no health, spend, or operational-flag anomalies)");
  });

  test("stuck: more than 10 rows renders exactly 10 stuck lines, in the given order", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      task_id: `s${i}`, stage: "implementing", family: `fam-${i}`, kind: "silent_hold", held_for: "00:45:00", silent_for: "00:45:00",
    }));
    const out = formatReport({ stuckTasks: many });
    const stuckLines = out.split("\n").filter(l => l.startsWith("  - stuck: "));
    expect(stuckLines.length).toBe(10);
    expect(stuckLines[0]).toContain("s0");
    expect(stuckLines[9]).toContain("s9");
    expect(stuckLines.join("\n")).not.toContain("s10");
    expect(stuckLines.join("\n")).not.toContain("s11");
  });

  test("stuck: rows are tagged (review), never ban, and no consequence is computed", () => {
    const out = formatReport({
      stuckTasks: [{ task_id: "t1", stage: "implementing", family: "f", kind: "silent_hold", held_for: "00:45:00", silent_for: "00:45:00" }],
    });
    expect(out).toContain("(review)");
    expect(out).not.toContain("ban");
    expect(out).not.toContain("BAN");
  });

  test("formatReport({}) still renders every existing section and does not throw", () => {
    expect(() => formatReport({})).not.toThrow();
    const out = formatReport({});
    expect(out).toContain("shipped (");
    expect(out).toContain("family track record");
    expect(out).toContain("governance (v5");
    expect(out).toContain("intake (v6 — open briefs):");
    expect(out).toContain("operational (v6 — health & spend watch):");
  });

  // ── M24 Slice B — intake watch (open briefs) ──────────────────────────────

  test("intake block: empty briefs print the header + (no briefs), every existing section still renders, no throw", () => {
    const out = formatReport({});
    expect(out).toContain("intake (v6 — open briefs):");
    expect(out).toContain("  (no briefs)");
    // Existing sections still render.
    expect(out).toContain("shipped (");
    expect(out).toContain("family track record");
    expect(out).toContain("governance (v5");
    expect(out).toContain("operational (v6 — health & spend watch):");
    expect(() => formatReport({})).not.toThrow();
  });

  test("intake block renders IMMEDIATELY BEFORE the operational block (operational stays last)", () => {
    const out = formatReport({});
    const intakeIdx = out.indexOf("intake (v6 — open briefs):");
    const opIdx = out.indexOf("operational (v6 — health & spend watch):");
    expect(intakeIdx).toBeGreaterThan(-1);
    expect(opIdx).toBeGreaterThan(intakeIdx);
    // Operational is still the last section.
    const opSection = out.slice(opIdx);
    expect(opSection).toContain("operational (v6 — health & spend watch):");
    expect(opSection.trimEnd().endsWith("(all clear — no health, spend, or operational-flag anomalies)")).toBe(true);
  });

  test("intake block: summary counts by stage, lists open briefs (stage !== accepted), never the accepted row", () => {
    const openBriefs = [
      { task_id: "i3", stage: "proposed_brief" },
      { task_id: "i2", stage: "briefed" },
      { task_id: "i1", stage: "accepted" },
    ];
    const out = formatReport({ openBriefs });
    expect(out).toContain("intake (v6 — open briefs):");
    expect(out).toContain("  1 proposed · 1 briefed · 1 accepted");
    expect(out).toContain("  - i3 — proposed_brief");
    expect(out).toContain("  - i2 — briefed");
    expect(out).not.toContain("  - i1 —");
  });

  test("intake block: open briefs listed in the GIVEN order, capped at the 10 most recent", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      task_id: `i${i}`, stage: i % 2 === 0 ? "proposed_brief" : "briefed",
    }));
    const out = formatReport({ openBriefs: many });
    const lines = out.split("\n").filter(l => /^  - i\d+ — /.test(l));
    expect(lines.length).toBe(10);
    expect(lines[0]).toBe("  - i0 — proposed_brief");
    expect(lines[9]).toBe("  - i9 — briefed");
    expect(lines.join("\n")).not.toContain("i10");
    expect(lines.join("\n")).not.toContain("i11");
  });

  // ── v8 — operator ledger (api.operator_actions) ────────────────────────────

  test("operator block: empty actions print the header + (no operator actions), every existing section still renders, no throw", () => {
    const out = formatReport({});
    expect(out).toContain("operator (v8 — what the seat did):");
    expect(out).toContain("  (no operator actions)");
    // Pre-existing sections still render.
    expect(out).toContain("shipped (");
    expect(out).toContain("family track record");
    expect(out).toContain("governance (v5");
    expect(out).toContain("intake (v6 — open briefs):");
    expect(out).toContain("operational (v6 — health & spend watch):");
    expect(() => formatReport({})).not.toThrow();
  });

  test("operator block renders AFTER intake and IMMEDIATELY BEFORE the operational block (operational stays last)", () => {
    const out = formatReport({});
    const intakeIdx = out.indexOf("intake (v6 — open briefs):");
    const opIdx = out.indexOf("operator (v8 — what the seat did):");
    const operationalIdx = out.indexOf("operational (v6 — health & spend watch):");
    expect(intakeIdx).toBeGreaterThan(-1);
    expect(opIdx).toBeGreaterThan(intakeIdx);
    expect(operationalIdx).toBeGreaterThan(opIdx);
    // Nothing but the operator section sits between its header and the
    // operational header.
    expect(out.slice(opIdx, operationalIdx)).toBe("operator (v8 — what the seat did):\n  (no operator actions)\n");
    // Operational is still the last section.
    const opSection = out.slice(operationalIdx);
    expect(opSection).toContain("operational (v6 — health & spend watch):");
    expect(opSection.trimEnd().endsWith("(all clear — no health, spend, or operational-flag anomalies)")).toBe(true);
  });

  test("operator block: ok row with a task_id renders → task t1 and the count line", () => {
    const out = formatReport({
      operatorActions: [{ family: "agent+operator", action: "refine", target: null, task_id: "t1", outcome: "ok" }],
    });
    expect(out).toContain("  - agent+operator refine → task t1");
    expect(out).toContain("  1 action(s) · 0 refused/failed");
  });

  test("operator block: service_start with a target renders → the standing service", () => {
    const out = formatReport({
      operatorActions: [{ family: "agent+operator", action: "service_start", target: "the standing service", outcome: "ok" }],
    });
    expect(out).toContain("service_start → the standing service");
  });

  test("operator block: instance-scoped act with no target and no task_id renders (instance)", () => {
    const out = formatReport({
      operatorActions: [{ family: "agent+operator", action: "service_start", target: null, task_id: null, outcome: "ok" }],
    });
    expect(out).toContain("service_start (instance)");
  });

  test("operator block: refused act shows its reason and the count line reads 1 refused/failed", () => {
    const out = formatReport({
      operatorActions: [{ family: "agent+operator", action: "refine", task_id: "t2", outcome: "refused", reason: "advance to briefed was refused" }],
    });
    expect(out).toContain("— refused: advance to briefed was refused");
    expect(out).toContain("  1 action(s) · 1 refused/failed");
  });

  test("operator block: failed act with no reason renders — failed: no reason given", () => {
    const out = formatReport({
      operatorActions: [{ family: "agent+operator", action: "refine", task_id: "t3", outcome: "failed", reason: null }],
    });
    expect(out).toContain("— failed: no reason given");
  });

  test("operator block: null family renders an em dash", () => {
    const out = formatReport({
      operatorActions: [{ family: null, action: "refine", task_id: "t4", outcome: "ok" }],
    });
    expect(out).toContain("  - — refine → task t4");
  });

  test("operator block: 12 rows render EXACTLY 10 detail lines, count line still says 12 action(s)", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      family: "agent+operator", action: "refine", task_id: `t${i}`, outcome: "ok",
    }));
    const out = formatReport({ operatorActions: many });
    expect(out).toContain("  12 action(s) · 0 refused/failed");
    const detailLines = out.split("\n").filter(l => l.startsWith("  - agent+operator refine → task t"));
    expect(detailLines.length).toBe(10);
    expect(detailLines[0]).toContain("t0");
    expect(detailLines[9]).toContain("t9");
    expect(detailLines.join("\n")).not.toContain("t10");
    expect(detailLines.join("\n")).not.toContain("t11");
  });

  test("operator block: refused/failed count spans ALL rows (pre-cap), not just the rendered 10", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      family: "agent+operator", action: "refine", task_id: `t${i}`, outcome: i === 11 ? "failed" : "ok",
    }));
    const out = formatReport({ operatorActions: many });
    expect(out).toContain("  12 action(s) · 1 refused/failed");
    // The failed row (t11) is beyond the 10-line cap and must NOT be rendered.
    expect(out).not.toContain("t11");
  });

  test("operator block: the ledger is a RECORD — no scoring, no ban recommendation, no judgement", () => {
    const out = formatReport({
      operatorActions: [
        { family: "agent+operator", action: "refine", task_id: "t1", outcome: "refused", reason: "advance to briefed was refused" },
        { family: "agent+operator", action: "service_start", target: "the standing service", outcome: "failed", reason: null },
      ],
    });
    const opSection = out.slice(out.indexOf("operator (v8 — what the seat did):"));
    expect(opSection).not.toContain("ban");
    expect(opSection).not.toContain("BAN");
    expect(opSection).not.toContain("failing");
    expect(opSection).not.toContain("score");
  });
});

describe("fmtTokens", () => {
  test("scales to k/M and reports null as unknown (never 0 — unknown ≠ free)", () => {
    expect(fmtTokens(null)).toBe("unknown");
    expect(fmtTokens(undefined)).toBe("unknown");
    expect(fmtTokens(0)).toBe("0");
    expect(fmtTokens(950)).toBe("950");
    expect(fmtTokens(1234)).toBe("1.2k");
    expect(fmtTokens(1_200_000)).toBe("1.2M");
  });
});

describe("fmtDuration", () => {
  test("formats PostgREST interval strings per the rendering rule", () => {
    expect(fmtDuration("00:45:00")).toBe("45m");
    expect(fmtDuration("03:20:00")).toBe("3h 20m");
    expect(fmtDuration("1 day 02:00:00")).toBe("26h 0m");
    expect(fmtDuration("00:00:30")).toBe("0m");
  });

  test("null / undefined / non-string / unparseable all read as unknown, never throws", () => {
    expect(fmtDuration(null)).toBe("unknown");
    expect(fmtDuration(undefined)).toBe("unknown");
    expect(fmtDuration(42)).toBe("unknown");
    expect(fmtDuration("")).toBe("unknown");
    expect(fmtDuration("garbage")).toBe("unknown");
    expect(fmtDuration("abc:def:ghi")).toBe("unknown");
    expect(fmtDuration("1 day")).toBe("unknown");
    expect(() => fmtDuration(null)).not.toThrow();
    expect(() => fmtDuration("00:45:00")).not.toThrow();
  });
});

describe("reportJson", () => {
  test("(1) shipped task with pr, cross-family review, and full attribution", () => {
    const board = [
      { task_id: "T1", is_terminal: true },
    ];
    const timeline = [
      { task_id: "T1", type: "transition", family: "opencode+big-pickle", data: { from: "implementing", to: "reviewing" } },
      { task_id: "T1", type: "transition", family: "claude-code+sonnet", data: { from: "reviewing", to: "integrating" } },
      { task_id: "T1", type: "transition", family: "grok+grok-build", data: { from: "integrating", to: "validating" } },
      { task_id: "T1", type: "transition", family: "opencode+big-pickle", data: { artifacts: [{ type: "pr", url: "https://x/pr/1" }] } },
    ];
    const result = reportJson({ board, timeline }, { lane: "dev" });
    expect(result.shipped[0]).toEqual({
      task_id: "T1",
      pr: "https://x/pr/1",
      implemented: "opencode+big-pickle",
      reviewed: "claude-code+sonnet",
      integrated: "grok+grok-build",
      crossFamilyReview: true,
    });
  });

  test("(2) same-family review sets crossFamilyReview to false", () => {
    const board = [
      { task_id: "T1", is_terminal: true },
    ];
    const timeline = [
      { task_id: "T1", type: "transition", family: "same-family", data: { from: "implementing", to: "reviewing" } },
      { task_id: "T1", type: "transition", family: "same-family", data: { from: "reviewing", to: "integrating" } },
    ];
    const result = reportJson({ board, timeline });
    expect(result.shipped[0].crossFamilyReview).toBe(false);
  });

  test("(3) no args returns empty shape", () => {
    expect(reportJson()).toEqual({
      lane: null,
      shipped: [],
      trackRecord: [],
      governance: [],
      auditFlags: [],
      governanceActions: [],
      intake: { proposed: 0, briefed: 0, accepted: 0, open: [] },
      operator: { total: 0, failed: 0, actions: [] },
      operational: { health: [], spend: [], flags: [], stuck: [] },
      sweepSpend: { total: 0, families: [] },
    });
  });

  test("(4) pass-through of trackRecord, governance, auditFlags, governanceActions unchanged", () => {
    const trackRecord = [{ family: "f", capability: "c", delivered: 1 }];
    const governance = [{ family: "f", capability: "c", banned: false }];
    const auditFlags = [{ family: "f", capability: "c", flag_count: 1 }];
    const governanceActions = [{ action: "warn", family: "f", capability: "c" }];
    const result = reportJson({ trackRecord, governance, auditFlags, governanceActions });
    expect(result.trackRecord).toBe(trackRecord);
    expect(result.governance).toBe(governance);
    expect(result.auditFlags).toBe(auditFlags);
    expect(result.governanceActions).toBe(governanceActions);
  });

  test("(5) JSON.stringify(reportJson({})) round-trips to empty shape (valid JSON, no undefined/functions)", () => {
    const parsed = JSON.parse(JSON.stringify(reportJson({})));
    expect(parsed).toEqual({
      lane: null,
      shipped: [],
      trackRecord: [],
      governance: [],
      auditFlags: [],
      governanceActions: [],
      intake: { proposed: 0, briefed: 0, accepted: 0, open: [] },
      operator: { total: 0, failed: 0, actions: [] },
      operational: { health: [], spend: [], flags: [], stuck: [] },
      sweepSpend: { total: 0, families: [] },
    });
  });

  // ── M23 Slice B — operational watch (health & spend) ──────────────────────

  test("(6) operational field: health from abandoned board rows (family null fallback, sorted), spend and flags passed through", () => {
    const board = [
      { task_id: "t2", stage: "reviewing", claimed_by: null, abandoned: true },
      { task_id: "t1", stage: "implementing", claimed_by: "fam-x", abandoned: true },
      { task_id: "t3", stage: "implementing", claimed_by: "fam-y", abandoned: false },
    ];
    const spendAnomalies = [{ family: "c", capability: "role:implementer", anomaly: "overspending", tokens_per_delivery: 5000 }];
    const operationalFlags = [{ family: "e", capability: "role:implementer", kind: "spinning", detail: "looped" }];
    const result = reportJson({ board, spendAnomalies, operationalFlags });
    expect(result.operational).toEqual({
      health: [
        { task_id: "t1", stage: "implementing", family: "fam-x" },
        { task_id: "t2", stage: "reviewing", family: null },
      ],
      spend: spendAnomalies,
      flags: operationalFlags,
      stuck: [],
    });
  });

  test("(6) operational flags capped at 10 in reportJson, newest-first order preserved", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      family: `f${i}`, capability: "role:implementer", kind: "health", detail: `d${i}`,
    }));
    const result = reportJson({ operationalFlags: many });
    expect(result.operational.flags.length).toBe(10);
    expect(result.operational.flags[0].family).toBe("f0");
    expect(result.operational.flags[9].family).toBe("f9");
  });

  test("(6) stuck rows pass through UNCHANGED in operational.stuck, capped at 10", () => {
    const stuckTasks = [{ task_id: "t1", stage: "implementing", family: "f", kind: "silent_hold", held_for: "01:30:00", silent_for: "01:30:00" }];
    const result = reportJson({ stuckTasks });
    expect(result.operational.stuck).toHaveLength(1);
    expect(result.operational.stuck[0]).toBe(stuckTasks[0]);

    const many = Array.from({ length: 12 }, (_, i) => ({ task_id: `s${i}` }));
    const capped = reportJson({ stuckTasks: many });
    expect(capped.operational.stuck.length).toBe(10);
    expect(capped.operational.stuck[0]).toEqual({ task_id: "s0" });
    expect(capped.operational.stuck[9]).toEqual({ task_id: "s9" });
  });

  test("(6) pre-existing reportJson fields are unchanged by the operational field", () => {
    const trackRecord = [{ family: "f", capability: "c", delivered: 1 }];
    const governance = [{ family: "f", capability: "c", banned: false }];
    const auditFlags = [{ family: "f", capability: "c", flag_count: 1 }];
    const governanceActions = [{ action: "warn", family: "f", capability: "c" }];
    const board = [{ task_id: "s1", is_terminal: true }];
    const result = reportJson({ board, timeline: [], trackRecord, governance, auditFlags, governanceActions });
    expect(result.trackRecord).toBe(trackRecord);
    expect(result.governance).toBe(governance);
    expect(result.auditFlags).toBe(auditFlags);
    expect(result.governanceActions).toBe(governanceActions);
    expect(result.shipped).toEqual([{ task_id: "s1", pr: null, implemented: null, reviewed: null, integrated: null, crossFamilyReview: false }]);
    expect(Object.keys(result)).toEqual(["lane", "shipped", "trackRecord", "governance", "auditFlags", "governanceActions", "intake", "operator", "operational", "sweepSpend"]);
  });

  // ── M24 Slice B — intake watch (open briefs) ──────────────────────────────

  test("(7) intake field: counts by stage and open rows (stage !== accepted), UNCAPPED, excluding accepted", () => {
    const openBriefs = [
      { task_id: "i3", stage: "proposed_brief" },
      { task_id: "i2", stage: "briefed" },
      { task_id: "i1", stage: "accepted" },
    ];
    expect(reportJson({ openBriefs }).intake).toEqual({
      proposed: 1,
      briefed: 1,
      accepted: 1,
      open: [
        { task_id: "i3", stage: "proposed_brief" },
        { task_id: "i2", stage: "briefed" },
      ],
    });
  });

  test("(7) intake.open is UNCAPPED — more than 10 open briefs all appear, in the given order", () => {
    const many = Array.from({ length: 15 }, (_, i) => ({ task_id: `i${i}`, stage: "proposed_brief" }));
    const result = reportJson({ openBriefs: many });
    expect(result.intake.open.length).toBe(15);
    expect(result.intake.open[0]).toEqual({ task_id: "i0", stage: "proposed_brief" });
    expect(result.intake.open[14]).toEqual({ task_id: "i14", stage: "proposed_brief" });
    expect(result.intake.open.map(r => r.task_id)).toEqual(many.map(r => r.task_id));
  });

  // ── v8 — operator ledger (api.operator_actions) ────────────────────────────

  test("(8) operator field: a single failed row yields total 1, failed 1, actions [that row]", () => {
    const row = { family: "agent+operator", action: "refine", outcome: "failed" };
    expect(reportJson({ operatorActions: [row] }).operator).toEqual({
      total: 1,
      failed: 1,
      actions: [row],
    });
  });

  test("(8) operator field: empty input yields total 0, failed 0, actions []", () => {
    expect(reportJson({}).operator).toEqual({ total: 0, failed: 0, actions: [] });
  });

  test("(8) operator field: total/failed count ALL rows (pre-cap), actions pass through UNCHANGED, capped at 10", () => {
    const operatorActions = [
      { family: "agent+operator", action: "refine", outcome: "failed" },
      { family: "agent+operator", action: "service_start", target: "the standing service", outcome: "ok" },
    ];
    const result = reportJson({ operatorActions });
    expect(result.operator).toEqual({
      total: 2,
      failed: 1,
      actions: operatorActions,
    });
    expect(result.operator.actions[0]).toBe(operatorActions[0]);
    expect(result.operator.actions[1]).toBe(operatorActions[1]);

    const many = Array.from({ length: 12 }, (_, i) => ({
      family: "agent+operator", action: "refine", task_id: `t${i}`, outcome: "ok",
    }));
    const capped = reportJson({ operatorActions: many });
    expect(capped.operator.total).toBe(12);
    expect(capped.operator.failed).toBe(0);
    expect(capped.operator.actions.length).toBe(10);
    expect(capped.operator.actions[0]).toEqual({ family: "agent+operator", action: "refine", task_id: "t0", outcome: "ok" });
    expect(capped.operator.actions[9]).toEqual({ family: "agent+operator", action: "refine", task_id: "t9", outcome: "ok" });
  });

  // ── v8 — empty-sweep spend (api.sweep_usage) ──────────────────────────────

  test("(9) sweepSpend field: a single row yields total and families unchanged", () => {
    const row = { family: "f", sweeps: 2, tokens: 10 };
    expect(reportJson({ sweepUsage: [row] }).sweepSpend).toEqual({
      total: 10,
      families: [row],
    });
  });

  test("(9) sweepSpend field: empty input yields total 0, families []", () => {
    expect(reportJson({}).sweepSpend).toEqual({ total: 0, families: [] });
  });
});

describe("formatServiceStatus", () => {
  test("null returns header + not-running line, no throw", () => {
    const out = formatServiceStatus(null);
    expect(out).toContain("service (v7 \u2014 standing supervisor):");
    expect(out).toContain("(not running \u2014 no status file)");
  });

  test("idle status shows state/board/poll/last tick/note lines and NO activation line", () => {
    const out = formatServiceStatus({
      state: "idle", activation: 2, round: 0, active: 0, blocked: 0,
      poll_secs: 15, pid: 123, note: "board drained", last_tick: "2026-08-19T14:00:00Z",
    });
    expect(out).toContain("state: idle");
    expect(out).toContain("board: 0 active \u00b7 0 blocked");
    expect(out).toContain("poll every 15s \u00b7 pid 123");
    expect(out).toContain("last tick: 2026-08-19T14:00:00Z");
    expect(out).toContain("note: board drained");
    expect(out).not.toContain("activation #");
  });

  test("running status shows activation #N \u00b7 round N", () => {
    const out = formatServiceStatus({
      state: "running", activation: 3, round: 2, active: 5, blocked: 0,
      poll_secs: 15, pid: 1, note: "activation #3", last_tick: "t",
    });
    expect(out).toContain("activation #3 \u00b7 round 2");
    expect(out).toContain("state: running");
  });

  test("stalled status shows state + note", () => {
    const out = formatServiceStatus({
      state: "stalled", activation: 4, round: 0, active: 2, blocked: 0,
      poll_secs: 15, pid: 1, note: "board stuck \u2014 awaiting a human", last_tick: "t",
    });
    expect(out).toContain("state: stalled");
    expect(out).toContain("note: board stuck \u2014 awaiting a human");
  });

  test("no note field omits note line and does not throw", () => {
    const out = formatServiceStatus({
      state: "idle", active: 0, blocked: 0, poll_secs: 15, pid: 1, last_tick: "t",
    });
    expect(out).not.toContain("note:");
  });
});
