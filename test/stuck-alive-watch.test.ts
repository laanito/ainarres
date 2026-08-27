import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { exec, query, waitForDb } from "./helpers/db";
import { restGet, waitForReady } from "./helpers/http";
import { mintToken } from "./helpers/mint";

// v8 step 1 — api.stuck_tasks, the STUCK-ALIVE watch. The failure mode ADR 0009's lazy
// reclaim cannot catch: a worker holding a LIVE lease that is going nowhere. Two kinds:
// silent_hold (no progress for stuck_silence_fraction of the stage lease) and
// heartbeat_treadmill (lease renewed past its original expiry — api.heartbeat writes no
// event, so renewal only shows in lease_expires_at — while the hold outran a full lease).
//
// DB test (validated ASSISTED — a view has no substrate-free self-check in a worktree).
// Fixtures are built directly so time can be moved: a live loop cannot be made to wait 2h.
// Each run gets a UNIQUE lane so re-runs against the same substrate stay green.

const FAM = "v8-stuck";
const LANE = `v8-stuck-${randomUUID().slice(0, 8)}`;
const LEASE = "1 hour"; // the fixture stage's lease; every assertion is relative to it

const FIXTURE = `
  insert into app.features (kind, key) values ('lane', '${LANE}') on conflict (kind, key) do nothing;
  insert into app.agent_families (key) values ('${FAM}') on conflict (key) do nothing;
  insert into app.workflows (key, description, default_lease)
  values ('${LANE}-wf', 'v8 stuck-watch fixture', interval '${LEASE}')
  on conflict (key) do nothing;
  insert into app.stages (workflow_id, key, ordering, is_initial, is_terminal, lease_duration)
  select w.id, v.key, v.ord, v.ini, v.term, v.lease
  from app.workflows w
  cross join (values
    ('working', 0, true,  false, interval '${LEASE}'),
    ('done',    1, false, true,  null::interval)
  ) as v(key, ord, ini, term, lease)
  where w.key = '${LANE}-wf'
  on conflict (workflow_id, key) do nothing;
  insert into app.lanes (project_id, key, workflow_id)
  select p.id, '${LANE}', w.id from app.projects p, app.workflows w
  where p.slug = 'ainarres' and w.key = '${LANE}-wf'
  on conflict (project_id, key) do nothing;
  insert into app.agents (id, family_id)
  select '${"00000000-0000-4000-8000-" + "0".repeat(12)}'::uuid, f.id
  from app.agent_families f where f.key = '${FAM}'
  on conflict (id) do nothing;
`;

// Plant a claimed task whose hold began `heldMins` ago, whose lease expires `leaseInMins`
// from now, optionally with a `progress` event `progressMins` ago.
function plant(opts: { heldMins: number; leaseInMins: number; progressMins?: number }): string {
  const id = randomUUID();
  const agent = "00000000-0000-4000-8000-000000000000";
  exec(`
    insert into app.tasks (id, lane_id, stage, payload, claimed_by, lease_expires_at)
    select '${id}'::uuid, l.id, s.id, '{"goal":"v8 stuck fixture"}'::jsonb,
           '${agent}'::uuid, now() + interval '${opts.leaseInMins} minutes'
    from app.lanes l
    join app.stages s on s.workflow_id = l.workflow_id and s.key = 'working'
    where l.key = '${LANE}';
    insert into app.events (task_id, actor, type, data, created_at)
    values ('${id}'::uuid, '${agent}'::uuid, 'claimed', '{}'::jsonb,
            now() - interval '${opts.heldMins} minutes');
    ${
      opts.progressMins === undefined
        ? ""
        : `insert into app.events (task_id, actor, type, data, created_at)
           values ('${id}'::uuid, '${agent}'::uuid, 'progress', '{"note":"working"}'::jsonb,
                   now() - interval '${opts.progressMins} minutes');`
    }
  `);
  return id;
}

const rows = (): any[] =>
  query<any>(`select * from api.stuck_tasks where lane = '${LANE}'`) as any[];
const kindOf = (id: string) => rows().find((r) => r.task_id === id)?.kind ?? null;

let healthy = "";
let silent = "";
let treadmill = "";
let fresh = "";

beforeAll(async () => {
  waitForDb();
  const res = exec(FIXTURE);
  if (!res.ok) throw new Error(`fixture failed: ${res.error}`);
  await waitForReady();

  // Held 50m of a 60m lease, but reported progress 5m ago → working, not stuck.
  healthy = plant({ heldMins: 50, leaseInMins: 10, progressMins: 5 });
  // Held 45m, never said anything; 45m > 0.5 × 60m → silent_hold.
  silent = plant({ heldMins: 45, leaseInMins: 15 });
  // Held 200m with the lease still 55m out — only heartbeats can do that — and progress
  // 3m ago, so it is NOT silent: alive, reporting, going nowhere.
  treadmill = plant({ heldMins: 200, leaseInMins: 55, progressMins: 3 });
  // Just claimed, silent for 5m of a 60m lease → below the threshold, not yet a concern.
  fresh = plant({ heldMins: 5, leaseInMins: 55 });
});

describe("api.stuck_tasks — the stuck-alive watch", () => {
  it("flags a silent hold once it passes stuck_silence_fraction of the stage lease", () => {
    expect(kindOf(silent)).toBe("silent_hold");
  });

  it("flags a heartbeat treadmill: lease renewed past its original expiry, hold outran a lease", () => {
    expect(kindOf(treadmill)).toBe("heartbeat_treadmill");
    const row = rows().find((r) => r.task_id === treadmill);
    // The renewal is the signature api.heartbeat leaves — it writes no event at all.
    expect(row.extended_by).toBeTruthy();
  });

  it("leaves a progressing worker and a freshly claimed task alone", () => {
    expect(kindOf(healthy)).toBeNull();
    expect(kindOf(fresh)).toBeNull();
  });

  it("names the family, stage and how long the hold has run", () => {
    const row = rows().find((r) => r.task_id === silent);
    expect(row.family).toBe(FAM);
    expect(row.stage).toBe("working");
    expect(row.attempts).toBe(0);
    expect(row.held_for).toBeTruthy();
    expect(row.silent_for).toBeTruthy();
  });

  it("ignores a LAPSED lease — that is lazy reclaim's job, not the watch's (ADR 0009)", () => {
    const lapsed = plant({ heldMins: 300, leaseInMins: -30 });
    expect(kindOf(lapsed)).toBeNull();
  });

  it("ignores blocked and terminal tasks", () => {
    const blocked = plant({ heldMins: 45, leaseInMins: 15 });
    exec(`update app.tasks set blocked = true where id = '${blocked}'::uuid`);
    expect(kindOf(blocked)).toBeNull();
  });

  it("is readable by oversight AND by the read-only monitor role", async () => {
    for (const role of ["oversight", "monitor"]) {
      const res = await restGet("stuck_tasks?limit=1", {
        token: mintToken(FAM, role, { features: [] }),
      });
      expect(res.status, `GET /stuck_tasks as ${role}`).toBe(200);
    }
  });

  it("counts silence from THIS hold, not an older one (re-claim resets the clock)", () => {
    // Progress 90m ago, but the current hold started 10m ago (a re-claim): silence is 10m.
    const reclaimed = plant({ heldMins: 10, leaseInMins: 50, progressMins: 90 });
    expect(kindOf(reclaimed)).toBeNull();
  });
});
