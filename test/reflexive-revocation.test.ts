import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { exec, query, waitForDb } from "./helpers/db";
import { rpc, waitForReady } from "./helpers/http";
import { mintToken } from "./helpers/mint";

// M21 Slice A (v5 governance; design/reflexive-revocation.md) — THE GATE. The substrate
// temp-bans a family that crosses a reject threshold at a capability, autonomously, with
// exponential backoff, self-healing on expiry, the strike history surviving. This test
// drives real reject cycles and asserts: the ban lands on the PRODUCER at its role (D4),
// takes effect on the next claim (ADR 0007 veto), self-heals at expiry (D2), a repeat
// offense yields a strictly longer ban (D3), and governance never grants (D8).

const IMPL = "m21-impl";
const IMPL2 = "m21-impl2"; // independent, never-banned implementer for the fail-safe case
const REV = "m21-rev";

const FIXTURE = `
  insert into app.features (kind,key) values ('lane','m21'),('role','implementer'),('role','reviewer')
  on conflict (kind,key) do nothing;
  insert into app.agent_families (key) values ('${IMPL}'),('${IMPL2}'),('${REV}') on conflict (key) do nothing;
  insert into app.workflows (key, description) values ('m21-wf','M21 reflexive-revocation flow')
  on conflict (key) do nothing;
  insert into app.stages (workflow_id, key, ordering, is_initial, is_terminal)
  select w.id, v.key, v.ord, v.ini, v.term from app.workflows w
  cross join (values ('implementing',0,true,false),('reviewing',1,false,false),('done',2,false,true)) as v(key,ord,ini,term)
  where w.key='m21-wf' on conflict (workflow_id,key) do nothing;
  insert into app.transitions (workflow_id, from_stage, to_stage, kind, required_features)
  select w.id, sf.id, st.id, 'advance', v.req from app.workflows w
  join (values ('implementing','reviewing',array['role:implementer']), ('reviewing','done',array['role:reviewer'])) as v(f,t,req) on true
  join app.stages sf on sf.workflow_id=w.id and sf.key=v.f
  join app.stages st on st.workflow_id=w.id and st.key=v.t
  where w.key='m21-wf' and not exists (select 1 from app.transitions x where x.from_stage=sf.id and x.to_stage=st.id and x.kind='advance');
  insert into app.transitions (workflow_id, from_stage, to_stage, kind, required_features)
  select w.id, sf.id, st.id, 'reject', array['role:reviewer'] from app.workflows w
  join app.stages sf on sf.workflow_id=w.id and sf.key='reviewing'
  join app.stages st on st.workflow_id=w.id and st.key='implementing'
  where w.key='m21-wf' and not exists (select 1 from app.transitions x where x.from_stage=sf.id and x.to_stage=st.id and x.kind='reject');
  insert into app.lanes (project_id, key, workflow_id)
  select p.id, 'm21', w.id from app.projects p join app.workflows w on w.key='m21-wf'
  where p.slug='ainarres' on conflict (project_id,key) do nothing;
`;

const json = (r: Response) => r.json() as Promise<any>;
const impl = (sub: string) => mintToken(IMPL, "agent", { sub, features: ["lane:m21", "role:implementer"] });
const impl2 = (sub: string) => mintToken(IMPL2, "agent", { sub, features: ["lane:m21", "role:implementer"] });
const rev = (sub: string) => mintToken(REV, "agent", { sub, features: ["lane:m21", "role:reviewer"] });

async function ok(p: Promise<Response>) {
  const r = await json(await p);
  expect(r.ok).toBe(true);
  return r;
}

// One reject cycle: the implementer delivers implementing→reviewing, the reviewer
// (a different family) bounces it reviewing→implementing — one attributable strike
// against the implementer at role:implementer.
async function cycle(id: string, iSub: string, rSub: string) {
  await ok(rpc("claim_next_task", { token: impl(iSub), body: { lane_key: "m21" } }));
  await ok(rpc("advance_task", { token: impl(iSub), body: { task_id: id, to_stage: "reviewing" } }));
  await ok(rpc("claim_next_task", { token: rev(rSub), body: { lane_key: "m21" } }));
  await ok(rpc("reject_task", { token: rev(rSub), body: { task_id: id, to_stage: "implementing", reason: "not yet" } }));
}

const strikeRow = (fam: string) => query<{ strikes: string; ban_count: string }>(
  `select gs.strikes, gs.ban_count from app.governance_strikes gs
   join app.agent_families f on f.id = gs.family_id
   join app.features ft on ft.id = gs.feature_id
   where f.key = '${fam}' and ft.name = 'role:implementer'`)[0];

const denialSecs = (fam: string) => query<{ secs: string }>(
  `select extract(epoch from (d.expires_at - now()))::int as secs from app.feature_denials d
   join app.agent_families f on f.id = d.family_id
   join app.features ft on ft.id = d.feature_id
   where f.key = '${fam}' and ft.name = 'role:implementer'`)[0];

beforeAll(async () => {
  waitForDb();
  const res = exec(FIXTURE);
  if (!res.ok) throw new Error(`fixture failed: ${res.error}`);
  await waitForReady();
});

describe("M21 reflexive temporary revocation", () => {
  it("bans the producer at its role on the 3rd reject; heals on expiry; escalates on repeat; never grants", async () => {
    const iSub = randomUUID();
    const rSub = randomUUID();
    const created = await ok(rpc("create_task", { token: impl(iSub), body: { lane_key: "m21" } }));
    const id = created.task.id;

    // Two rejects: strikes accumulate, no ban yet (threshold = 3).
    await cycle(id, iSub, rSub);
    await cycle(id, iSub, rSub);
    expect(Number(strikeRow(IMPL).strikes)).toBe(2);
    expect(Number(strikeRow(IMPL).ban_count)).toBe(0);
    expect(denialSecs(IMPL)).toBeUndefined(); // no denial written yet

    // Third reject crosses the threshold → temporary ban, strikes reset, ban_count=1.
    await cycle(id, iSub, rSub);
    expect(Number(strikeRow(IMPL).ban_count)).toBe(1);
    expect(Number(strikeRow(IMPL).strikes)).toBe(0);
    const firstBan = Number(denialSecs(IMPL).secs);
    expect(firstBan).toBeGreaterThan(0); // an expiring (non-permanent) denial exists
    expect(firstBan).toBeLessThanOrEqual(3600 + 5); // ~1h = base·2^0

    // The reviewer that CALLED the rejects is untouched — only the producer is struck.
    expect(strikeRow(REV)).toBeUndefined();
    expect(query(`select 1 from app.feature_denials d join app.agent_families f on f.id=d.family_id where f.key='${REV}'`)).toHaveLength(0);

    // Takes effect on the next claim: the banned implementer can no longer claim the
    // implementing task (its only outbound transition needs role:implementer).
    const blocked = await json(await rpc("claim_next_task", { token: impl(iSub), body: { lane_key: "m21" } }));
    expect(blocked.code).toBe("empty");

    // Self-heal (D2): once the denial expires, the capability returns on the next claim.
    // The strike ledger persists (ban_count stays 1 — no shed by waiting).
    exec(`update app.feature_denials set expires_at = now() - interval '1 minute'
          where family_id = (select id from app.agent_families where key='${IMPL}')
            and feature_id = (select id from app.features where name='role:implementer')`);
    const healed = await json(await rpc("claim_next_task", { token: impl(iSub), body: { lane_key: "m21" } }));
    expect(healed.code).toBe("ok");
    expect(healed.task.id).toBe(id);
    expect(Number(strikeRow(IMPL).ban_count)).toBe(1); // history survived the expiry
    // release it so the repeat cycles can re-claim cleanly.
    await ok(rpc("release_task", { token: impl(iSub), body: { task_id: id } }));

    // Repeat offense (D3): three more rejects → a SECOND ban, strictly longer
    // (base·2^1 ≈ 2h vs the first ~1h), ban_count=2.
    await cycle(id, iSub, rSub);
    await cycle(id, iSub, rSub);
    await cycle(id, iSub, rSub);
    expect(Number(strikeRow(IMPL).ban_count)).toBe(2);
    const secondBan = Number(denialSecs(IMPL).secs);
    expect(secondBan).toBeGreaterThan(3600); // strictly longer than the first (~1h) → escalation
    expect(secondBan).toBeLessThanOrEqual(24 * 3600 + 5); // capped at 24h

    // D8 — governance only REMOVES: no family_features were granted to the implementer
    // by any of this (it holds only what the seed/fixture gave it, via the token).
    const granted = query<{ c: string }>(
      `select count(*)::text c from app.family_features ff
       join app.agent_families f on f.id = ff.family_id where f.key='${IMPL}'`)[0].c;
    expect(granted).toBe("0"); // features come from the token, never from governance
  });

  it("strikes no one for a reject with no resolvable producer (fail-safe)", async () => {
    // A reject event on a fresh task with NO prior advance-into-reviewing — a malformed
    // history. The rule must credit no family (never guess who to punish).
    const iSub = randomUUID();
    const created = await ok(rpc("create_task", { token: impl2(iSub), body: { lane_key: "m21" } }));
    const id = created.task.id;
    const before = query<{ c: string }>(`select count(*)::text c from app.governance_strikes`)[0].c;
    // Stamp a reject transition directly (human/system style), no producing advance.
    exec(`insert into app.events (task_id, actor, type, data)
          values ('${id}', null, 'transition', '{"kind":"reject","from":"reviewing","to":"implementing"}'::jsonb)`);
    const after = query<{ c: string }>(`select count(*)::text c from app.governance_strikes`)[0].c;
    expect(after).toBe(before); // no strike created
  });
});
