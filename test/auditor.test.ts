import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { exec, query, waitForDb } from "./helpers/db";
import { rpc, waitForReady } from "./helpers/http";
import { mintToken } from "./helpers/mint";

// M22 Slice A (v5 governance; design/auditor.md) — the auditor role & the human boundary.
// The QUALITATIVE path: an auditor FLAGS a delivery-vs-request/design gap against the
// producing family — recorded as an event, with NO feature_denial (never auto-penalized).
// The PERMANENT path: oversight (only) makes a ban permanent or lifts it, audited in the
// governance_actions ledger, effective on the family's next effective-features read.

const AUD = "m22-auditor";      // holds role:auditor
const SUBJ = "m22-subject";     // the flagged/banned designer family
const OVERSIGHT_FAM = "m22-oversight";

const FIXTURE = `
  insert into app.features (kind,key) values ('lane','m22') on conflict (kind,key) do nothing;
  insert into app.agent_families (key) values ('${AUD}'),('${SUBJ}'),('${OVERSIGHT_FAM}') on conflict (key) do nothing;
  insert into app.workflows (key, description) values ('m22-wf','M22 audit flow') on conflict (key) do nothing;
  insert into app.stages (workflow_id, key, ordering, is_initial, is_terminal)
  select w.id, v.key, v.ord, v.ini, v.term from app.workflows w
  cross join (values ('done',0,true,true)) as v(key,ord,ini,term)
  where w.key='m22-wf' on conflict (workflow_id,key) do nothing;
  insert into app.lanes (project_id, key, workflow_id)
  select p.id, 'm22', w.id from app.projects p join app.workflows w on w.key='m22-wf'
  where p.slug='ainarres' on conflict (project_id,key) do nothing;
`;

const json = (r: Response) => r.json() as Promise<any>;
// The auditor also holds lane:m22 so it can create the task it later flags.
const auditor = (sub: string) => mintToken(AUD, "agent", { sub, features: ["lane:m22", "role:auditor"] });
const nonAuditor = (sub: string) => mintToken(AUD, "agent", { sub, features: ["lane:m22"] });
const oversight = () => mintToken(OVERSIGHT_FAM, "oversight", { features: [] });
const agentTok = () => mintToken(SUBJ, "agent", { features: ["lane:m22", "role:designer"] });
// A subject token to read its own effective features across a ban/lift cycle.
const subjectTok = (sub: string) => mintToken(SUBJ, "agent", { sub, features: ["lane:m22", "role:designer"] });

async function ok(p: Promise<Response>) {
  const r = await json(await p);
  expect(r.ok).toBe(true);
  return r;
}

const denialRow = (fam: string, cap: string) => query<{ expires_at: string | null }>(
  `select d.expires_at from app.feature_denials d
   join app.agent_families f on f.id = d.family_id
   join app.features ft on ft.id = d.feature_id
   where f.key = '${fam}' and ft.name = '${cap}'`)[0];

const actionRows = (fam: string) => query<{ action: string; reason: string | null }>(
  `select ga.action, ga.reason from app.governance_actions ga
   join app.agent_families f on f.id = ga.family_id
   where f.key = '${fam}' order by ga.created_at`);

beforeAll(async () => {
  waitForDb();
  const res = exec(FIXTURE);
  if (!res.ok) throw new Error(`fixture failed: ${res.error}`);
  await waitForReady();
});

describe("M22 auditor flag (qualitative path)", () => {
  it("records an audit_flag event, names the family + gap, and writes NO denial (D2)", async () => {
    const aSub = randomUUID();
    const created = await ok(rpc("create_task", { token: auditor(aSub), body: { lane_key: "m22" } }));
    const id = created.task.id;

    const flagged = await ok(rpc("raise_audit_flag", {
      token: auditor(aSub),
      body: {
        p_task: id, p_subject_family: SUBJ, p_capability: "role:designer",
        p_gap: "delivery ignores the acceptance criteria in the brief", p_severity: "critical",
      },
    }));
    expect(flagged.event.type).toBe("audit_flag");
    expect(flagged.event.data.subject_family).toBe(SUBJ);
    expect(flagged.event.data.capability).toBe("role:designer");
    expect(flagged.event.data.gap).toContain("acceptance criteria");
    expect(flagged.event.data.severity).toBe("critical");

    // The signal is on the log...
    const ev = query<{ c: string }>(
      `select count(*)::text c from app.events where task_id='${id}' and type='audit_flag'`)[0].c;
    expect(ev).toBe("1");
    // ...but the qualitative path NEVER writes a denial (D2).
    expect(denialRow(SUBJ, "role:designer")).toBeUndefined();
  });

  it("refuses a non-auditor (D6), an empty gap, an unknown task, and an unknown family", async () => {
    const aSub = randomUUID();
    const created = await ok(rpc("create_task", { token: auditor(aSub), body: { lane_key: "m22" } }));
    const id = created.task.id;

    const noRole = await json(await rpc("raise_audit_flag", {
      token: nonAuditor(randomUUID()),
      body: { p_task: id, p_subject_family: SUBJ, p_capability: "role:designer", p_gap: "x" },
    }));
    expect(noRole.ok).toBe(false);
    expect(noRole.reason).toContain("role:auditor");

    const emptyGap = await json(await rpc("raise_audit_flag", {
      token: auditor(aSub),
      body: { p_task: id, p_subject_family: SUBJ, p_capability: "role:designer", p_gap: "   " },
    }));
    expect(emptyGap.ok).toBe(false);

    const noTask = await json(await rpc("raise_audit_flag", {
      token: auditor(aSub),
      body: { p_task: randomUUID(), p_subject_family: SUBJ, p_capability: "role:designer", p_gap: "x" },
    }));
    expect(noTask.code).toBe("not_found");

    const noFam = await json(await rpc("raise_audit_flag", {
      token: auditor(aSub),
      body: { p_task: id, p_subject_family: "nope-family", p_capability: "role:designer", p_gap: "x" },
    }));
    expect(noFam.code).toBe("not_found");
  });
});

describe("M22 permanent ban / lift (human path)", () => {
  it("oversight makes a ban permanent (NULL expiry), audited; it vetoes the next claim; lift restores it", async () => {
    const subSub = randomUUID();
    // Baseline: the subject holds role:designer in its effective features.
    const before = await json(await rpc("effective_features", { token: subjectTok(subSub) }));
    expect(before).toContain("role:designer");

    // Oversight permanently bans the capability.
    const banned = await ok(rpc("set_permanent_ban", {
      token: oversight(),
      body: { p_family: SUBJ, p_capability: "role:designer", p_reason: "repeated qualitative flags" },
    }));
    expect(banned.event.permanent).toBe(true);

    // A permanent denial (NULL expiry) exists, and the act is on the ledger.
    const d = denialRow(SUBJ, "role:designer");
    expect(d).toBeDefined();
    expect(d.expires_at).toBeNull();
    expect(actionRows(SUBJ).some((a) => a.action === "ban_permanent")).toBe(true);

    // Effective on the next read (ADR 0007 veto): role:designer is gone.
    const afterBan = await json(await rpc("effective_features", { token: subjectTok(subSub) }));
    expect(afterBan).not.toContain("role:designer");

    // Lift restores it — the denial is removed and the lift is audited.
    const lifted = await ok(rpc("lift_ban", {
      token: oversight(),
      body: { p_family: SUBJ, p_capability: "role:designer", p_reason: "reinstated after review" },
    }));
    expect(lifted.event.lifted).toBe(true);
    expect(denialRow(SUBJ, "role:designer")).toBeUndefined();
    expect(actionRows(SUBJ).some((a) => a.action === "lift")).toBe(true);

    const afterLift = await json(await rpc("effective_features", { token: subjectTok(subSub) }));
    expect(afterLift).toContain("role:designer");
  });

  it("an agent token cannot call the permanent-ban / lift RPCs (oversight-only)", async () => {
    const banRes = await rpc("set_permanent_ban", {
      token: agentTok(),
      body: { p_family: SUBJ, p_capability: "role:designer" },
    });
    expect(banRes.ok).toBe(false);
    expect(banRes.status).toBeGreaterThanOrEqual(400);

    const liftRes = await rpc("lift_ban", {
      token: agentTok(),
      body: { p_family: SUBJ, p_capability: "role:designer" },
    });
    expect(liftRes.ok).toBe(false);
    expect(liftRes.status).toBeGreaterThanOrEqual(400);

    // Nothing was written by the refused calls (no phantom action beyond the prior test's).
    const agentWrites = query<{ c: string }>(
      `select count(*)::text c from app.governance_actions ga
       join app.agent_families f on f.id = ga.family_id where f.key='${SUBJ}' and ga.actor_sub is null`)[0].c;
    expect(agentWrites).toBe("0");
  });
});
