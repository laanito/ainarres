import { describe, expect, test } from "vitest";
import { formatStatus, statusJson, formatEvents, formatReport, fmtTokens } from "../bin/ainarres.mjs";

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
