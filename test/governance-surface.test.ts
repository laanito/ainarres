import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { exec, query, waitForDb } from "./helpers/db";
import { restGet, rpc, waitForReady } from "./helpers/http";
import { mintToken } from "./helpers/mint";

// M22 Slice B (v5 governance; design/auditor.md D1/D5) — the oversight SURFACE views.
// Read-only display of the auditor's flags (api.audit_flags), the human ban/lift trail
// (api.governance_actions), and the ban→recommend threshold now on api.governance_status.
// DB test (validated ASSISTED — a view has no self-check in a worktree). The pure report
// formatter that turns these rows into a RECOMMEND-PERMANENT line is the swarm slice.

const AUD = "m22b-auditor";
const SUBJ = "m22b-subject";
const OVERSIGHT_FAM = "m22b-oversight";

const FIXTURE = `
  insert into app.features (kind,key) values ('lane','m22b') on conflict (kind,key) do nothing;
  insert into app.agent_families (key) values ('${AUD}'),('${SUBJ}'),('${OVERSIGHT_FAM}') on conflict (key) do nothing;
  insert into app.workflows (key, description) values ('m22b-wf','M22 surface flow') on conflict (key) do nothing;
  insert into app.stages (workflow_id, key, ordering, is_initial, is_terminal)
  select w.id, 'done', 0, true, true from app.workflows w
  where w.key='m22b-wf' on conflict (workflow_id,key) do nothing;
  insert into app.lanes (project_id, key, workflow_id)
  select p.id, 'm22b', w.id from app.projects p join app.workflows w on w.key='m22b-wf'
  where p.slug='ainarres' on conflict (project_id,key) do nothing;
`;

const json = (r: Response) => r.json() as Promise<any>;
const auditor = (sub: string) => mintToken(AUD, "agent", { sub, features: ["lane:m22b", "role:auditor"] });
const oversight = () => mintToken(OVERSIGHT_FAM, "oversight", { features: [] });

async function ok(p: Promise<Response>) {
  const r = await json(await p);
  expect(r.ok).toBe(true);
  return r;
}

beforeAll(async () => {
  waitForDb();
  const res = exec(FIXTURE);
  if (!res.ok) throw new Error(`fixture failed: ${res.error}`);
  await waitForReady();
});

describe("M22 governance surface views", () => {
  it("api.audit_flags aggregates flags per (subject family, capability) with the latest gap + threshold", async () => {
    const aSub = randomUUID();
    const created = await ok(rpc("create_task", { token: auditor(aSub), body: { lane_key: "m22b" } }));
    const id = created.task.id;
    // Unique capability (free text in the flag, not validated against features) so the
    // count is deterministic regardless of prior runs against the same DB — the view
    // aggregates ALL matching audit_flag events ever.
    const cap = `role:designer-${randomUUID().slice(0, 8)}`;

    await ok(rpc("raise_audit_flag", { token: auditor(aSub), body: {
      p_task: id, p_subject_family: SUBJ, p_capability: cap, p_gap: "first gap", p_severity: "warning" } }));
    await ok(rpc("raise_audit_flag", { token: auditor(aSub), body: {
      p_task: id, p_subject_family: SUBJ, p_capability: cap, p_gap: "second gap (latest)", p_severity: "critical" } }));

    const rows = await json(await restGet(
      `audit_flags?family=eq.${SUBJ}&capability=eq.${cap}`, { token: oversight() }));
    expect(rows).toHaveLength(1);
    expect(rows[0].flag_count).toBe(2);
    expect(rows[0].last_gap).toBe("second gap (latest)");
    expect(rows[0].last_severity).toBe("critical");
    expect(rows[0].recommend_flag_count).toBe(2); // seeded system threshold (D5)
  });

  it("api.governance_actions shows the human ban/lift trail newest-first", async () => {
    await ok(rpc("set_permanent_ban", { token: oversight(), body: {
      p_family: SUBJ, p_capability: "role:designer", p_reason: "repeated flags" } }));
    await ok(rpc("lift_ban", { token: oversight(), body: {
      p_family: SUBJ, p_capability: "role:designer", p_reason: "reinstated" } }));

    const rows = await json(await restGet(
      `governance_actions?family=eq.${SUBJ}&capability=eq.role:designer`, { token: oversight() }));
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows[0].action).toBe("lift"); // newest first
    expect(rows[0].reason).toBe("reinstated");
    expect(rows.some((r: any) => r.action === "ban_permanent")).toBe(true);
  });

  it("api.governance_status carries the ban→recommend threshold (D5)", async () => {
    // Seed a strike row directly so the strike-keyed view has a row to read.
    exec(`insert into app.governance_strikes (family_id, feature_id, strikes, ban_count)
          select f.id, ft.id, 1, 4 from app.agent_families f, app.features ft
          where f.key='${SUBJ}' and ft.name='role:designer'
          on conflict (family_id, feature_id) do update set ban_count = 4`);
    const rows = await json(await restGet(
      `governance_status?family=eq.${SUBJ}&capability=eq.role:designer`, { token: oversight() }));
    expect(rows).toHaveLength(1);
    expect(rows[0].recommend_ban_count).toBe(3); // seeded system threshold
    expect(rows[0].ban_count).toBe(4);           // ≥ threshold → the formatter will recommend
  });

  it("the surface is oversight-only (an unauthenticated read is refused)", async () => {
    const res = await restGet(`audit_flags`, {});
    expect(res.ok).toBe(false);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
