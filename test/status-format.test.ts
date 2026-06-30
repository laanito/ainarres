import { describe, expect, test } from "vitest";
import { formatStatus, formatEvents, formatReport } from "../bin/ainarres.mjs";

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
});
