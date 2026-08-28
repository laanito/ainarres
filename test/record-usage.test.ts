import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { exec, query, waitForDb } from "./helpers/db";
import { restGet, rpc, waitForReady } from "./helpers/http";
import { mintToken } from "./helpers/mint";

// M20 Slice A (v5 governance; design/track-record.md D1). api.record_usage — the ONE
// new write path: a privileged verb that stamps a task's TOKEN spend into the event log
// as a `type='usage'` event. Attribution is the WORKER's sub (→ its family); oversight
// only asserts the number. Invariants under test: it writes to the actor's most-recent
// transition; an unknown actor with a named task is refused; and only oversight may call
// it (an agent token cannot write its own scorecard). Tokens only — no USD anywhere (D3).
//
// v8 AMENDMENT: the "empty-sweep invariant" — a no-work actor writes NOTHING — is GONE,
// and the two tests below now pin what replaced it. It rested on the assumption that a
// sweep which moved no task cost nothing. Measurement disproved that: three implementer
// tiers waking to a board already claimed burned ~474k tokens in a single run, all of it
// silently dropped by this verb. Task-less spend now lands in app.sweep_usage (it cannot
// be an event — events.task_id is NOT NULL). See test/empty-sweep-spend.test.ts.

const FAMILY = "opencode+qwen";

const FIXTURE = `
  insert into app.features (kind, key) values ('lane','m20u'), ('role','worker')
  on conflict (kind, key) do nothing;
  insert into app.workflows (key, description) values ('m20u-wf', 'M20 record_usage flow')
  on conflict (key) do nothing;
  insert into app.stages (workflow_id, key, ordering, is_initial, is_terminal)
  select w.id, v.key, v.ord, v.ini, v.term from app.workflows w
  cross join (values ('s0',0,true,false),('s1',1,false,true)) as v(key,ord,ini,term)
  where w.key = 'm20u-wf' on conflict (workflow_id, key) do nothing;
  insert into app.transitions (workflow_id, from_stage, to_stage, kind, required_features)
  select w.id, sf.id, st.id, 'advance', array['role:worker']
  from app.workflows w
  join app.stages sf on sf.workflow_id = w.id and sf.key = 's0'
  join app.stages st on st.workflow_id = w.id and st.key = 's1'
  where w.key = 'm20u-wf' and not exists (select 1 from app.transitions t where t.from_stage = sf.id and t.to_stage = st.id and t.kind = 'advance');
  insert into app.lanes (project_id, key, workflow_id)
  select p.id, 'm20u', w.id from app.projects p
  join app.workflows w on w.key = 'm20u-wf'
  where p.slug = 'ainarres' on conflict (project_id, key) do nothing;
`;

const json = (r: Response) => r.json() as Promise<any>;
const oversight = () => mintToken(FAMILY, "oversight", { features: [] });
const worker = (sub: string) =>
  mintToken(FAMILY, "agent", { sub, features: ["lane:m20u", "role:worker"] });

const familyId = () => query<{ id: string }>(`select id from app.agent_families where key = '${FAMILY}'`)[0]?.id;

function park(lane: string): void {
  const r = exec(`update app.tasks set blocked = true
    where lane_id = (select id from app.lanes where key = '${lane}') and not blocked`);
  if (!r.ok) throw new Error(`park ${lane} failed: ${r.error}`);
}

// Create → claim → advance s0→s1 as `sub`, leaving `sub` as the producing family of a
// real transition. Returns the task id.
async function transitionOne(sub: string): Promise<string> {
  const w = worker(sub);
  const created = await json(await rpc("create_task", { token: w, body: { lane_key: "m20u" } }));
  const id = created.task.id;
  await json(await rpc("claim_next_task", { token: w, body: { lane_key: "m20u" } }));
  const adv = await json(await rpc("advance_task", { token: w, body: { task_id: id, to_stage: "s1" } }));
  expect(adv.ok).toBe(true);
  return id;
}

const USAGE = { tokens: { input: 4049, output: 3264, cache_read: 840768, cache_creation: 26712 }, model: "claude-sonnet-5", sweep_id: "sweep-abc" };

beforeAll(async () => {
  waitForDb();
  const res = exec(FIXTURE);
  if (!res.ok) throw new Error(`fixture failed: ${res.error}`);
  await waitForReady();
});

describe("api.record_usage", () => {
  it("stamps a usage event on the actor's most-recent task, attributed to its family", async () => {
    park("m20u");
    const sub = randomUUID();
    const id = await transitionOne(sub);

    const r = await json(await rpc("record_usage", { token: oversight(), body: { actor: sub, data: USAGE } }));
    expect(r.ok).toBe(true);
    expect(r.event.type).toBe("usage");
    expect(r.event.task_id).toBe(id); // resolved from the actor's last transition

    // Surfaces on the family-joined timeline as this family's usage event.
    const rows = await json(await restGet(`timeline?task_id=eq.${id}&type=eq.usage`, { token: oversight() }));
    expect(rows).toHaveLength(1);
    expect(rows[0].family).toBe(FAMILY);
    expect(rows[0].data.tokens.input).toBe(4049);
    expect(rows[0].data.model).toBe("claude-sonnet-5");
    // Tokens only — never USD (D3).
    expect(JSON.stringify(rows[0].data)).not.toContain("usd");
    expect(JSON.stringify(rows[0].data)).not.toContain("cost");
  });

  it("honors an explicit task id when the driver names one", async () => {
    park("m20u");
    const sub = randomUUID();
    await transitionOne(sub); // actor's last transition (would be the default)
    const other = await transitionOne(sub); // a second task; pass it explicitly

    const r = await json(await rpc("record_usage", { token: oversight(), body: { actor: sub, data: USAGE, task: other } }));
    expect(r.ok).toBe(true);
    expect(r.event.task_id).toBe(other);
  });

  it("writes no EVENT for a no-work actor, but no longer loses the spend (v8)", async () => {
    // An actor that exists (claim ran ensure_agent) but transitioned no task — exactly
    // what an empty sweep leaves behind. Seed the bare agent row directly.
    // This used to return `no_work` and write nothing at all. It still writes no event —
    // there is no task to anchor one to — but the tokens are now attributed to the
    // actor's family in app.sweep_usage instead of vanishing.
    const sub = randomUUID();
    const r0 = exec(`insert into app.agents (id, family_id) values ('${sub}', '${familyId()}')`);
    expect(r0.ok).toBe(true);

    const r = await json(await rpc("record_usage", { token: oversight(), body: { actor: sub, data: USAGE } }));
    expect(r.ok).toBe(true);
    expect(r.code).toBe("no_task_spend");
    const n = query<{ c: string }>(`select count(*)::text c from app.events where actor = '${sub}' and type = 'usage'`)[0].c;
    expect(n).toBe("0");
    const s = query<{ c: string }>(`select count(*)::text c from app.sweep_usage where actor_sub = '${sub}'`)[0].c;
    expect(s).toBe("1");
  });

  it("refuses an unknown actor with no family either — spend must not be orphaned", async () => {
    // The actor check moved to where it is needed: it still refuses when there is nothing
    // to attribute to, but a sweep that never claimed (so never got an agent row) can now
    // be charged to the family the driver names. An unattributable number is worse than a
    // missing one, because it reads as somebody's.
    const r = await json(await rpc("record_usage", { token: oversight(), body: { actor: randomUUID(), data: USAGE } }));
    expect(r.ok).toBe(false);
    expect(r.code).toBe("unknown_family");
  });

  it("is oversight-only — an agent token cannot write its own scorecard", async () => {
    const sub = randomUUID();
    const id = await transitionOne(sub);
    // The producing agent tries to record its own usage: execute is not granted to
    // `agent`, so PostgREST refuses (4xx) — no event written.
    const res = await rpc("record_usage", { token: worker(sub), body: { actor: sub, data: USAGE, task: id } });
    expect(res.status).toBeGreaterThanOrEqual(400);
    const n = query<{ c: string }>(`select count(*)::text c from app.events where task_id = '${id}' and type = 'usage'`)[0].c;
    expect(n).toBe("0");
  });
});
