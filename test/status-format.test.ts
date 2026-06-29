import { describe, expect, test } from "vitest";
import { formatStatus } from "../bin/ainarres.mjs";

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
});
