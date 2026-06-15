import { beforeAll, describe, expect, it } from "vitest";
import { exec, query, waitForDb } from "./helpers/db";

// M1: the events table is append-only (ADR 0006). Two layers:
//   - belt:       no role is granted UPDATE/DELETE on app.events
//   - suspenders: a trigger raises on UPDATE/DELETE even for the table owner
// Both are asserted here.

beforeAll(() => waitForDb());

describe("events append-only — suspenders (trigger)", () => {
  // One transaction: create a throwaway task + event, prove UPDATE and DELETE are
  // both blocked by the trigger, then ROLLBACK so nothing persists. If either
  // mutation is NOT blocked, the embedded RAISE fires, ON_ERROR_STOP aborts, and
  // exec() returns ok:false — failing the test.
  it("blocks UPDATE and DELETE even as the table owner (superuser)", () => {
    const res = exec(`
      begin;

      insert into app.tasks (lane_id, stage)
      select l.id, s.id
      from app.lanes l
      join app.stages s on s.workflow_id = l.workflow_id and s.is_initial
      where l.key = 'api'
      limit 1;

      insert into app.events (task_id, type)
      select id, 'test.append' from app.tasks
      where stage in (select id from app.stages where is_initial)
      order by created_at desc limit 1;

      do $$
      begin
        update app.events set type = 'mutated' where type = 'test.append';
        raise exception 'EXPECTED_FAIL: UPDATE was not blocked';
      exception
        when restrict_violation then null;            -- our trigger's errcode: good
        when others then
          if sqlerrm like 'EXPECTED_FAIL%' then raise; end if;
      end $$;

      do $$
      begin
        delete from app.events where type = 'test.append';
        raise exception 'EXPECTED_FAIL: DELETE was not blocked';
      exception
        when restrict_violation then null;
        when others then
          if sqlerrm like 'EXPECTED_FAIL%' then raise; end if;
      end $$;

      rollback;
    `);
    expect(res.ok, res.error).toBe(true);
  });
});

describe("events append-only — belt (grants)", () => {
  it("no coarse role has UPDATE or DELETE on app.events", () => {
    const rows = query<{ role: string; can_update: boolean; can_delete: boolean }>(`
      select r as role,
             has_table_privilege(r, 'app.events', 'UPDATE') as can_update,
             has_table_privilege(r, 'app.events', 'DELETE') as can_delete
      from unnest(array['agent','oversight','reaper']) as r
      order by r
    `);
    for (const row of rows) {
      expect(row.can_update, `${row.role} must not UPDATE events`).toBe(false);
      expect(row.can_delete, `${row.role} must not DELETE events`).toBe(false);
    }
  });

  it("oversight can read coordination state; agent cannot touch tables directly", () => {
    const [row] = query<{
      oversight_reads_tasks: boolean;
      oversight_reads_events: boolean;
      agent_reads_tasks: boolean;
    }>(`
      select has_table_privilege('oversight', 'app.tasks', 'SELECT')  as oversight_reads_tasks,
             has_table_privilege('oversight', 'app.events', 'SELECT') as oversight_reads_events,
             has_table_privilege('agent', 'app.tasks', 'SELECT')      as agent_reads_tasks
    `);
    expect(row.oversight_reads_tasks).toBe(true);
    expect(row.oversight_reads_events).toBe(true);
    expect(row.agent_reads_tasks).toBe(false); // agents go through verbs (RPC), never tables
  });
});
