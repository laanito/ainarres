import { beforeAll, describe, expect, it } from "vitest";
import { exec, query, scalar, waitForDb } from "./helpers/db";

// M1 schema assertions: the migrations created the full data model in the private
// `app` schema, the coarse roles, and the claim-supporting indexes. Read-only
// except for two behavioral checks that run inside a rolled-back transaction.

beforeAll(() => waitForDb());

describe("domain tables", () => {
  const EXPECTED = [
    "agent_families",
    "agents",
    "events",
    "family_features",
    "feature_denials",
    "features",
    "lanes",
    "projects",
    "stages",
    "tasks",
    "transitions",
    "workflows",
  ];

  it("all live in the private `app` schema (not REST-exposed `api`)", () => {
    const rows = query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'app' order by table_name",
    );
    expect(rows.map((r) => r.table_name)).toEqual(EXPECTED);
  });

  it("no domain base tables leak into the `api` schema", () => {
    // `api` holds only verb functions + oversight VIEWS (M5); never a base table —
    // that's what keeps agent access RPC-only. (information_schema.tables counts
    // views too, so filter to BASE TABLE.)
    const n = scalar<number>(
      "select count(*)::int from information_schema.tables where table_schema = 'api' and table_type = 'BASE TABLE'",
    );
    expect(n).toBe(0);
  });
});

describe("coarse roles", () => {
  it("agent, oversight, reaper exist and are nologin", () => {
    const rows = query<{ rolname: string; rolcanlogin: boolean }>(
      "select rolname, rolcanlogin from pg_roles where rolname in ('agent','oversight','reaper') order by rolname",
    );
    expect(rows).toEqual([
      { rolname: "agent", rolcanlogin: false },
      { rolname: "oversight", rolcanlogin: false },
      { rolname: "reaper", rolcanlogin: false },
    ]);
  });

  it("authenticator can SET ROLE to each (membership granted)", () => {
    const rows = query<{ member: string }>(`
      select r.rolname as member
      from pg_auth_members m
      join pg_roles r on r.oid = m.roleid
      join pg_roles a on a.oid = m.member
      where a.rolname = 'authenticator' and r.rolname in ('agent','oversight','reaper')
      order by 1
    `);
    expect(rows.map((r) => r.member)).toEqual(["agent", "oversight", "reaper"]);
  });
});

describe("claim-supporting indexes (ADR 0001 / 0009)", () => {
  it("the key indexes exist on app tables", () => {
    const rows = query<{ indexname: string }>(
      "select indexname from pg_indexes where schemaname = 'app'",
    );
    const names = rows.map((r) => r.indexname);
    for (const idx of [
      "tasks_claimable",
      "tasks_by_claimed_by",
      "tasks_by_lease",
      "transitions_by_from_stage",
      "events_by_task",
      "stages_one_initial_per_workflow",
    ]) {
      expect(names, `missing index ${idx}`).toContain(idx);
    }
  });
});

describe("structural invariants", () => {
  it("uuidv7() is native (no extension) and wired as the pk default", () => {
    // The function resolves and yields a v7 uuid (version nibble '7').
    const id = scalar<string>("select uuidv7()::text");
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(id[14]).toBe("7");

    // tasks.id defaults to uuidv7() (spot-check one core table's default).
    const def = scalar<string>(`
      select pg_get_expr(d.adbin, d.adrelid)
      from pg_attribute a
      join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
      where a.attrelid = 'app.tasks'::regclass and a.attname = 'id'
    `);
    expect(def).toContain("uuidv7()");
  });

  it("a workflow may not have two initial stages", () => {
    const res = exec(`
      begin;
      insert into app.workflows (key) values ('__two_initials__');
      insert into app.stages (workflow_id, key, is_initial)
        select id, 'a', true from app.workflows where key = '__two_initials__';
      insert into app.stages (workflow_id, key, is_initial)
        select id, 'b', true from app.workflows where key = '__two_initials__';
      rollback;
    `);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/stages_one_initial_per_workflow|duplicate key/i);
  });
});
