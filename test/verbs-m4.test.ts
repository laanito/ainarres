import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { exec, query, waitForDb } from "./helpers/db";
import { rpc, waitForReady } from "./helpers/http";
import { mintToken } from "./helpers/mint";

// M4: the rest of the agent surface (ADR 0008). One small lane per scenario for
// clean isolation; each test parks the lane's existing tasks first so a fresh
// create→claim holds a known task. Subject family m4-subject-fam exists so the
// `effects` (governance) path can revoke one of its features.

const FAMILY = "opencode+qwen"; // caller family (exists → instance registration works)
const SUBJECT = "00000000-0000-7000-8000-000000000004"; // a governed agent instance

const FIXTURE = `
  insert into app.features (kind, key) values
    ('lane','m4'), ('lane','m4block'), ('lane','m4rel'), ('lane','m4guard'), ('lane','m4gov'),
    ('role','worker'), ('role','reviewer'), ('work-area','asana')
  on conflict (kind, key) do nothing;

  insert into app.agent_families (key, description) values
    ('m4-subject-fam', 'M4 governed subject family')
  on conflict (key) do nothing;

  insert into app.family_features (family_id, feature_id)
  select f.id, ft.id from app.agent_families f, app.features ft
  where f.key = 'm4-subject-fam' and ft.name = 'work-area:asana'
  on conflict (family_id, feature_id) do nothing;

  insert into app.agents (id, family_id)
  select '${SUBJECT}'::uuid, f.id from app.agent_families f where f.key = 'm4-subject-fam'
  on conflict (id) do nothing;

  -- m4-wf: todo -> in_review -> done, with a reviewer-only reject back to todo.
  insert into app.workflows (key, description) values ('m4-wf', 'M4 main flow')
  on conflict (key) do nothing;
  insert into app.stages (workflow_id, key, ordering, is_initial, is_terminal)
  select w.id, v.key, v.ord, v.ini, v.term from app.workflows w
  cross join (values ('todo',0,true,false),('in_review',1,false,false),('done',2,false,true)) as v(key,ord,ini,term)
  where w.key = 'm4-wf' on conflict (workflow_id, key) do nothing;

  -- m4-rel-wf: a 2-attempt cap so release threshold is reachable.
  insert into app.workflows (key, description, default_max_attempts) values ('m4-rel-wf', 'M4 release flow', 2)
  on conflict (key) do nothing;
  insert into app.stages (workflow_id, key, ordering, is_initial, is_terminal)
  select w.id, v.key, v.ord, v.ini, v.term from app.workflows w
  cross join (values ('solo',0,true,false),('reldone',1,false,true)) as v(key,ord,ini,term)
  where w.key = 'm4-rel-wf' on conflict (workflow_id, key) do nothing;

  -- m4-guard-wf: a guarded advance.
  insert into app.workflows (key, description) values ('m4-guard-wf', 'M4 guard flow')
  on conflict (key) do nothing;
  insert into app.stages (workflow_id, key, ordering, is_initial, is_terminal)
  select w.id, v.key, v.ord, v.ini, v.term from app.workflows w
  cross join (values ('todo',0,true,false),('gdone',1,false,true)) as v(key,ord,ini,term)
  where w.key = 'm4-guard-wf' on conflict (workflow_id, key) do nothing;

  -- m4-gov-wf: an advance whose effect revokes a feature from the subject's family.
  insert into app.workflows (key, description) values ('m4-gov-wf', 'M4 governance flow')
  on conflict (key) do nothing;
  insert into app.stages (workflow_id, key, ordering, is_initial, is_terminal)
  select w.id, v.key, v.ord, v.ini, v.term from app.workflows w
  cross join (values ('todo',0,true,false),('govdone',1,false,true)) as v(key,ord,ini,term)
  where w.key = 'm4-gov-wf' on conflict (workflow_id, key) do nothing;

  -- transitions (idempotent via NOT EXISTS on (workflow, from, to, kind))
  insert into app.transitions (workflow_id, from_stage, to_stage, kind, required_features)
  select w.id, sf.id, st.id, 'advance', array['role:worker']
  from app.workflows w
  join app.stages sf on sf.workflow_id = w.id and sf.key = 'todo'
  join app.stages st on st.workflow_id = w.id and st.key = 'in_review'
  where w.key = 'm4-wf' and not exists (select 1 from app.transitions t where t.from_stage = sf.id and t.to_stage = st.id and t.kind = 'advance');

  insert into app.transitions (workflow_id, from_stage, to_stage, kind, required_features)
  select w.id, sf.id, st.id, 'advance', array['role:reviewer','work-area:asana']
  from app.workflows w
  join app.stages sf on sf.workflow_id = w.id and sf.key = 'in_review'
  join app.stages st on st.workflow_id = w.id and st.key = 'done'
  where w.key = 'm4-wf' and not exists (select 1 from app.transitions t where t.from_stage = sf.id and t.to_stage = st.id and t.kind = 'advance');

  insert into app.transitions (workflow_id, from_stage, to_stage, kind, required_features)
  select w.id, sf.id, st.id, 'reject', array['role:reviewer']
  from app.workflows w
  join app.stages sf on sf.workflow_id = w.id and sf.key = 'in_review'
  join app.stages st on st.workflow_id = w.id and st.key = 'todo'
  where w.key = 'm4-wf' and not exists (select 1 from app.transitions t where t.from_stage = sf.id and t.to_stage = st.id and t.kind = 'reject');

  insert into app.transitions (workflow_id, from_stage, to_stage, kind, required_features)
  select w.id, sf.id, st.id, 'advance', array['role:worker']
  from app.workflows w
  join app.stages sf on sf.workflow_id = w.id and sf.key = 'solo'
  join app.stages st on st.workflow_id = w.id and st.key = 'reldone'
  where w.key = 'm4-rel-wf' and not exists (select 1 from app.transitions t where t.from_stage = sf.id and t.to_stage = st.id and t.kind = 'advance');

  insert into app.transitions (workflow_id, from_stage, to_stage, kind, required_features, guard)
  select w.id, sf.id, st.id, 'advance', array['role:worker'],
    'coalesce((($1)->''payload''->>''ready'')::boolean, false)'
  from app.workflows w
  join app.stages sf on sf.workflow_id = w.id and sf.key = 'todo'
  join app.stages st on st.workflow_id = w.id and st.key = 'gdone'
  where w.key = 'm4-guard-wf' and not exists (select 1 from app.transitions t where t.from_stage = sf.id and t.to_stage = st.id and t.kind = 'advance');

  insert into app.transitions (workflow_id, from_stage, to_stage, kind, required_features, effects)
  select w.id, sf.id, st.id, 'advance', array['role:reviewer'], '{"revoke":["work-area:asana"]}'::jsonb
  from app.workflows w
  join app.stages sf on sf.workflow_id = w.id and sf.key = 'todo'
  join app.stages st on st.workflow_id = w.id and st.key = 'govdone'
  where w.key = 'm4-gov-wf' and not exists (select 1 from app.transitions t where t.from_stage = sf.id and t.to_stage = st.id and t.kind = 'advance');

  -- lanes
  insert into app.lanes (project_id, key, workflow_id)
  select p.id, v.lane, w.id
  from app.projects p
  join (values ('m4','m4-wf'),('m4block','m4-wf'),('m4rel','m4-rel-wf'),('m4guard','m4-guard-wf'),('m4gov','m4-gov-wf')) as v(lane, wf) on true
  join app.workflows w on w.key = v.wf
  where p.slug = 'ainarres'
  on conflict (project_id, key) do nothing;
`;

const json = (r: Response) => r.json() as Promise<any>;
const worker = (lane: string) => mintToken(FAMILY, "agent", { sub: randomUUID(), features: [`lane:${lane}`, "role:worker"] });
const reviewer = (lane: string, extra: string[] = []) =>
  mintToken(FAMILY, "agent", { sub: randomUUID(), features: [`lane:${lane}`, "role:reviewer", ...extra] });

function park(lane: string): void {
  const r = exec(`update app.tasks set blocked = true
    where lane_id = (select id from app.lanes where key = '${lane}') and not blocked`);
  if (!r.ok) throw new Error(`park ${lane} failed: ${r.error}`);
}

// Create one task in a parked lane and claim it with the same token (the only
// unblocked task, so the claim is deterministic). Returns the held task.
async function freshHold(token: string, lane: string, body: Record<string, unknown> = {}): Promise<any> {
  park(lane);
  const created = await json(await rpc("create_task", { token, body: { lane_key: lane, ...body } }));
  expect(created.ok, `create: ${created.reason}`).toBe(true);
  const claimed = await json(await rpc("claim_next_task", { token, body: { lane_key: lane } }));
  expect(claimed.ok, `claim: ${claimed.reason}`).toBe(true);
  expect(claimed.task.id).toBe(created.task.id);
  return claimed.task;
}

beforeAll(async () => {
  waitForDb();
  const res = exec(FIXTURE);
  if (!res.ok) throw new Error(`fixture failed: ${res.error}`);
  await waitForReady();
});

describe("advance / reject", () => {
  it("advance moves the stage, releases the hold, and logs a transition event; reject is gated independently", async () => {
    const w = worker("m4");
    const t = await freshHold(w, "m4");
    expect(t.stage_key).toBe("todo");

    const adv = await json(await rpc("advance_task", { token: w, body: { task_id: t.id, to_stage: "in_review", note: "did it" } }));
    expect(adv.ok).toBe(true);
    expect(adv.task.stage_key).toBe("in_review");
    expect(adv.task.claimed_by).toBeNull(); // hold released
    expect(adv.event.type).toBe("transition");

    const [ev] = query<{ n: number }>(`select count(*)::int as n from app.events where task_id = '${t.id}' and type = 'transition'`);
    expect(ev.n).toBe(1);

    // A reviewer can claim the in_review task (it has a reject transition it can perform).
    const rv = reviewer("m4"); // note: no work-area:asana
    const rclaim = await json(await rpc("claim_next_task", { token: rv, body: { lane_key: "m4" } }));
    expect(rclaim.ok).toBe(true);
    expect(rclaim.task.id).toBe(t.id);

    // advance to done needs role:reviewer + work-area:asana → reviewer lacks asana.
    const advDone = await json(await rpc("advance_task", { token: rv, body: { task_id: t.id, to_stage: "done" } }));
    expect(advDone.ok).toBe(false);
    expect(advDone.code).toBe("not_eligible");

    // reject back to todo IS permitted for the reviewer (separately gated).
    const rej = await json(await rpc("reject_task", { token: rv, body: { task_id: t.id, to_stage: "todo", reason: "needs work" } }));
    expect(rej.ok).toBe(true);
    expect(rej.task.stage_key).toBe("todo");
    expect(rej.task.claimed_by).toBeNull();
  });

  it("illegal_transition when no such transition exists", async () => {
    const w = worker("m4");
    const t = await freshHold(w, "m4");
    const res = await json(await rpc("advance_task", { token: w, body: { task_id: t.id, to_stage: "done" } }));
    expect(res.ok).toBe(false);
    expect(res.code).toBe("illegal_transition");
  });
});

describe("release_task", () => {
  it("increments attempts and auto-blocks at the cap", async () => {
    const w = mintToken(FAMILY, "agent", { sub: randomUUID(), features: ["lane:m4rel", "role:worker"] });
    park("m4rel");
    const created = await json(await rpc("create_task", { token: w, body: { lane_key: "m4rel" } }));
    expect(created.ok).toBe(true);
    const id = created.task.id;

    // attempt 1: ordinary release
    await json(await rpc("claim_next_task", { token: w, body: { lane_key: "m4rel" } }));
    const r1 = await json(await rpc("release_task", { token: w, body: { task_id: id } }));
    expect(r1.ok).toBe(true);
    expect(r1.code).toBe("ok");
    expect(r1.task.attempts).toBe(1);

    // attempt 2: hits the cap (default_max_attempts = 2) → auto-blocked
    await json(await rpc("claim_next_task", { token: w, body: { lane_key: "m4rel" } }));
    const r2 = await json(await rpc("release_task", { token: w, body: { task_id: id } }));
    expect(r2.code).toBe("blocked");
    expect(r2.task.blocked).toBe(true);
    expect(r2.task.blocked_reason).toBe("max attempts exceeded");
  });
});

describe("block / unblock", () => {
  it("a blocked task is excluded from claim; unblock makes it claimable again", async () => {
    const w = mintToken(FAMILY, "agent", { sub: randomUUID(), features: ["lane:m4block", "role:worker"] });
    const t = await freshHold(w, "m4block");

    const blocked = await json(await rpc("block_task", { token: w, body: { task_id: t.id, reason: "stuck" } }));
    expect(blocked.ok).toBe(true);
    expect(blocked.task.blocked).toBe(true);
    expect(blocked.task.claimed_by).toBeNull();

    const other = mintToken(FAMILY, "agent", { sub: randomUUID(), features: ["lane:m4block", "role:worker"] });
    const empty = await json(await rpc("claim_next_task", { token: other, body: { lane_key: "m4block" } }));
    expect(empty.code).toBe("empty"); // blocked task not handed out

    const unblocked = await json(await rpc("unblock_task", { token: w, body: { task_id: t.id } }));
    expect(unblocked.ok).toBe(true);
    expect(unblocked.task.blocked).toBe(false);

    const claim = await json(await rpc("claim_next_task", { token: other, body: { lane_key: "m4block" } }));
    expect(claim.ok).toBe(true);
    expect(claim.task.id).toBe(t.id);
  });
});

describe("report_progress / heartbeat", () => {
  it("report_progress appends an event and renews the lease", async () => {
    const w = worker("m4");
    const t = await freshHold(w, "m4");
    const lease0 = Date.parse(t.lease_expires_at);

    const res = await json(await rpc("report_progress", {
      token: w,
      body: { task_id: t.id, note: "halfway", artifacts: [{ type: "pr", url: "https://example/pr/1" }] },
    }));
    expect(res.ok).toBe(true);
    expect(res.event.type).toBe("progress");
    expect(Date.parse(res.task.lease_expires_at)).toBeGreaterThan(lease0);

    const [ev] = query<{ n: number }>(`select count(*)::int as n from app.events where task_id = '${t.id}' and type = 'progress'`);
    expect(ev.n).toBe(1);
  });

  it("heartbeat renews the lease", async () => {
    const w = worker("m4");
    const t = await freshHold(w, "m4");
    const lease0 = Date.parse(t.lease_expires_at);
    const res = await json(await rpc("heartbeat", { token: w, body: { task_id: t.id } }));
    expect(res.ok).toBe(true);
    expect(Date.parse(res.task.lease_expires_at)).toBeGreaterThan(lease0);
  });
});

describe("lease_lost invariant", () => {
  it("a held task whose lease expired rejects further verbs", async () => {
    const w = worker("m4");
    const t = await freshHold(w, "m4");
    // Simulate the lease expiring (what the reaper-free reclaim relies on).
    exec(`update app.tasks set lease_expires_at = now() - interval '1 second' where id = '${t.id}'`);

    const hb = await json(await rpc("heartbeat", { token: w, body: { task_id: t.id } }));
    expect(hb.ok).toBe(false);
    expect(hb.code).toBe("lease_lost");

    const adv = await json(await rpc("advance_task", { token: w, body: { task_id: t.id, to_stage: "in_review" } }));
    expect(adv.code).toBe("lease_lost");
  });
});

describe("guard", () => {
  it("blocks the transition when unsatisfied and allows it when satisfied", async () => {
    const wf = worker("m4guard");
    const notReady = await freshHold(wf, "m4guard", { payload: { ready: false } });
    const fail = await json(await rpc("advance_task", { token: wf, body: { task_id: notReady.id, to_stage: "gdone" } }));
    expect(fail.ok).toBe(false);
    expect(fail.code).toBe("guard_failed");

    const wf2 = worker("m4guard");
    const ready = await freshHold(wf2, "m4guard", { payload: { ready: true } });
    const ok = await json(await rpc("advance_task", { token: wf2, body: { task_id: ready.id, to_stage: "gdone" } }));
    expect(ok.ok).toBe(true);
    expect(ok.task.stage_key).toBe("gdone");
  });
});

describe("transition effects (reflexive governance plumbing)", () => {
  it("an effect revokes a feature from the subject's family (instant denial)", async () => {
    // Clean any prior denial so the test is repeatable.
    exec(`delete from app.feature_denials d using app.agent_families f, app.features ft
      where d.family_id = f.id and d.feature_id = ft.id
        and f.key = 'm4-subject-fam' and ft.name = 'work-area:asana'`);

    const rv = reviewer("m4gov");
    park("m4gov");
    const created = await json(await rpc("create_task", { token: rv, body: { lane_key: "m4gov", subject: SUBJECT } }));
    expect(created.ok).toBe(true);
    expect(created.task.subject).toBe(SUBJECT);

    const claimed = await json(await rpc("claim_next_task", { token: rv, body: { lane_key: "m4gov" } }));
    expect(claimed.ok).toBe(true);

    const adv = await json(await rpc("advance_task", { token: rv, body: { task_id: claimed.task.id, to_stage: "govdone" } }));
    expect(adv.ok).toBe(true);
    expect(adv.event.data.effects.revoked).toContain("work-area:asana");

    const [d] = query<{ n: number }>(`
      select count(*)::int as n from app.feature_denials d
      join app.agent_families f on f.id = d.family_id
      join app.features ft on ft.id = d.feature_id
      where f.key = 'm4-subject-fam' and ft.name = 'work-area:asana'`);
    expect(d.n).toBe(1); // the family now has an instant veto on work-area:asana
  });
});
