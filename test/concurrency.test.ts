import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { exec, waitForDb } from "./helpers/db";
import { parseEnvelope, runBarrier, workerScript } from "./helpers/barrier";

// M3 done-test (ADR 0010): claim_next_task is race-free. N instances fire claims
// simultaneously at K tasks; SKIP LOCKED correctness either holds or these
// invariants fail — no task claimed twice, successes = min(N, K).

const LANE = "race";
const FAMILY = "race-fam";
const LOCK_KEY = 918_273;

const FIXTURE = `
  insert into app.features (kind, key) values ('lane','race'), ('role','racer')
  on conflict (kind, key) do nothing;

  insert into app.agent_families (key, description) values ('race-fam','M3 concurrency test family')
  on conflict (key) do nothing;

  insert into app.workflows (key, description) values ('race-wf', 'M3 concurrency test flow')
  on conflict (key) do nothing;

  insert into app.stages (workflow_id, key, ordering, is_initial, is_terminal)
  select w.id, v.key, v.ord, v.ini, v.term
  from app.workflows w
  cross join (values ('start',0,true,false), ('done',1,false,true)) as v(key, ord, ini, term)
  where w.key = 'race-wf'
  on conflict (workflow_id, key) do nothing;

  insert into app.transitions (workflow_id, from_stage, to_stage, kind, required_features)
  select w.id, sf.id, st.id, 'advance', array['role:racer']
  from app.workflows w
  join app.stages sf on sf.workflow_id = w.id and sf.key = 'start'
  join app.stages st on st.workflow_id = w.id and st.key = 'done'
  where w.key = 'race-wf'
    and not exists (
      select 1 from app.transitions t
      where t.workflow_id = w.id and t.from_stage = sf.id and t.to_stage = st.id and t.kind = 'advance'
    );

  insert into app.lanes (project_id, key, workflow_id)
  select p.id, 'race', w.id from app.projects p, app.workflows w
  where p.slug = 'ainarres' and w.key = 'race-wf'
  on conflict (project_id, key) do nothing;
`;

// Reset to exactly K claimable tasks: park anything pre-existing (can't delete —
// events are append-only), then insert K fresh, unclaimed tasks directly.
function resetClaimableTasks(k: number): void {
  const sql = `
    update app.tasks set blocked = true
    where lane_id = (select id from app.lanes where key = '${LANE}') and not blocked;

    insert into app.tasks (lane_id, stage)
    select l.id, s.id
    from app.lanes l
    join app.stages s on s.workflow_id = l.workflow_id and s.is_initial
    cross join generate_series(1, ${k})
    where l.key = '${LANE}';
  `;
  const res = exec(sql);
  if (!res.ok) throw new Error(`reset tasks failed: ${res.error}`);
}

beforeAll(() => {
  waitForDb();
  const res = exec(FIXTURE);
  if (!res.ok) throw new Error(`fixture failed: ${res.error}`);
});

describe("claim_next_task under a release barrier", () => {
  it("never double-claims; successes = min(N, K)", async () => {
    const N = 10;
    const K = 4;
    resetClaimableTasks(K);

    const scripts = Array.from({ length: N }, () =>
      workerScript(
        LOCK_KEY,
        { sub: randomUUID(), family: FAMILY, role: "agent", features: ["lane:race", "role:racer"] },
        `select api.claim_next_task('${LANE}');`,
      ),
    );

    const envelopes = (await runBarrier(scripts, LOCK_KEY)).map(parseEnvelope);

    const claimed = envelopes.filter((e) => e.ok && e.code === "ok" && e.task);
    const empty = envelopes.filter((e) => e.ok && e.code === "empty");
    const claimedIds = claimed.map((e) => e.task.id);

    expect(envelopes).toHaveLength(N);
    expect(claimed).toHaveLength(Math.min(N, K)); // exactly K winners
    expect(empty).toHaveLength(N - Math.min(N, K)); // the rest get nothing
    expect(new Set(claimedIds).size).toBe(claimedIds.length); // no task claimed twice
  });

  it("hands out every task when N < K (no spurious empties)", async () => {
    const N = 3;
    const K = 8;
    resetClaimableTasks(K);

    const scripts = Array.from({ length: N }, () =>
      workerScript(
        LOCK_KEY + 1,
        { sub: randomUUID(), family: FAMILY, role: "agent", features: ["lane:race", "role:racer"] },
        `select api.claim_next_task('${LANE}');`,
      ),
    );

    const envelopes = (await runBarrier(scripts, LOCK_KEY + 1)).map(parseEnvelope);
    const claimed = envelopes.filter((e) => e.ok && e.code === "ok" && e.task);
    const claimedIds = claimed.map((e) => e.task.id);

    expect(claimed).toHaveLength(N); // all instances win a distinct task
    expect(new Set(claimedIds).size).toBe(N);
  });
});
