import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// M28 Slice A — substrate-free SHAPE test for the push-wake NOTIFY migration.
// Reads the migration text and asserts its structure, so the contract (ADR 0027 D4)
// is pinned without needing a database. The real DB proof lives in
// test/push-wake-notify.test.ts (runs in the full suite at the validating stage).

const sql = readFileSync(
  "db/migrations/20260902100000_m28_push_wake_notify.sql",
  "utf8",
);
// Normalize for robust substring checks: lowercase, collapse runs of whitespace.
const norm = sql.toLowerCase().replace(/\s+/g, " ");

describe("M28 push-wake NOTIFY migration shape", () => {
  it("has both -- migrate:up and -- migrate:down sections", () => {
    // dbmate format requires both; a down section keeps the repo's down-then-up
    // rebuild clean.
    expect(norm).toContain("-- migrate:up");
    expect(norm).toContain("-- migrate:down");
  });

  it("creates app.notify_activity() as security definer with pinned search_path", () => {
    // security definer + set search_path = app, pg_temp is required: the function
    // reads app.lanes, which the agent role has no rights on. Without it a direct
    // insert could fail.
    expect(norm).toContain("create function app.notify_activity()");
    expect(norm).toContain("security definer");
    expect(norm).toContain("set search_path = app, pg_temp");
  });

  it("calls pg_notify('ainarres_activity') and resolves the lane key from app.lanes", () => {
    // The payload is the LANE KEY, minimal and informational.
    expect(norm).toContain("pg_notify('ainarres_activity'");
    expect(norm).toContain("from app.lanes l where l.id = new.lane_id");
  });

  it("swallows exceptions so a nudge never fails a task write", () => {
    // Same rule as the M21 strike trigger: a notification problem must never abort
    // a legitimate task write.
    expect(norm).toContain("exception when others then");
  });

  it("creates AFTER INSERT and AFTER UPDATE triggers, the UPDATE one gated on stage/blocked", () => {
    // The WHEN clause on the UPDATE trigger is what keeps claim/heartbeat/lease
    // writes silent. `after update of stage, blocked` alone would fire when a column
    // is merely TARGETED even if unchanged — so we require the `when (...)` clause.
    expect(norm).toContain("after insert on app.tasks");
    expect(norm).toContain("after update on app.tasks");
    expect(norm).toContain("when (new.stage is distinct from old.stage or new.blocked is distinct from old.blocked)");
  });

  it("is TRUTH-FREE: the up section adds no table, column, view, or row", () => {
    // It adds signal, not truth or state — a function and two triggers, nothing else.
    const up = norm.slice(norm.indexOf("-- migrate:up"), norm.indexOf("-- migrate:down"));
    expect(up).not.toContain("create table");
    expect(up).not.toContain("alter table");
    expect(up).not.toContain("create view");
    expect(up).not.toContain("insert into");
  });

  it("the trigger body does NOT mention claimed_by or lease_expires_at (the lazy-reclaim gap is deliberate)", () => {
    // A claim, a heartbeat or a lease write must NOT notify; the poll covers the
    // lazy-reclaim / release gap. Widening this would reopen a decided contract.
    // Scoped to the up section (the executable trigger code), not the header prose,
    // which names the gap deliberately.
    const up = norm.slice(norm.indexOf("-- migrate:up"), norm.indexOf("-- migrate:down"));
    expect(up).not.toContain("claimed_by");
    expect(up).not.toContain("lease_expires_at");
  });

  it("the down section drops both triggers and the function", () => {
    // So a down-then-up rebuild is clean.
    const down = norm.slice(norm.indexOf("-- migrate:down"));
    expect(down).toContain("drop trigger if exists tasks_notify_activity_update on app.tasks");
    expect(down).toContain("drop trigger if exists tasks_notify_activity_insert on app.tasks");
    expect(down).toContain("drop function if exists app.notify_activity()");
  });

  it("the header prose owns the ADR 0024 crossing", () => {
    // This is ADR 0027's owned exception to ADR 0024's ~zero-migration rule; the
    // header must state that in prose, not silently widen the rule.
    expect(norm).toContain("adr 0027");
    expect(norm).toContain("adr 0024");
  });
});
