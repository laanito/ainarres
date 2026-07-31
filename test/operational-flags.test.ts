import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { exec, query, scalar, waitForDb } from "./helpers/db";
import { rpc, waitForReady } from "./helpers/http";
import { mintToken } from "./helpers/mint";

// M23 Slice A (v6 — seat the bookends; design/auditor-operational.md) — the auditor's
// OPERATIONAL facet. The same role:auditor grows a second sense: a FAMILY-scoped, qualitative
// flag for a worker that SPINS or OVERSPENDS. Like M22's quality flag it is recorded (here in
// the app.operational_flags append-only ledger) and writes NO feature_denial — the operational
// path never auto-penalizes (ADR 0023). This slice lands the flag verb, the ledger, and the
// spend-watch policy datum; the watch VIEWS + report line are Slice B.

const AUD = "m23-auditor";    // holds role:auditor
const SUBJ = "m23-subject";   // the flagged family (an implementer, say)

const FIXTURE = `
  insert into app.agent_families (key) values ('${AUD}'),('${SUBJ}') on conflict (key) do nothing;
`;

const json = (r: Response) => r.json() as Promise<any>;
const auditor = (sub: string) => mintToken(AUD, "agent", { sub, features: ["role:auditor"] });
const nonAuditor = (sub: string) => mintToken(AUD, "agent", { sub, features: ["lane:dev"] });

async function ok(p: Promise<Response>) {
  const r = await json(await p);
  expect(r.ok).toBe(true);
  return r;
}

const flagRows = (fam: string) => query<{ kind: string; capability: string; detail: string; severity: string }>(
  `select o.kind, o.capability, o.detail, o.severity from app.operational_flags o
   join app.agent_families f on f.id = o.family_id
   where f.key = '${fam}' order by o.created_at`,
);

const denialRow = (fam: string, cap: string) => query<{ expires_at: string | null }>(
  `select d.expires_at from app.feature_denials d
   join app.agent_families f on f.id = d.family_id
   join app.features ft on ft.id = d.feature_id
   where f.key = '${fam}' and ft.name = '${cap}'`)[0];

beforeAll(async () => {
  waitForDb();
  const res = exec(FIXTURE);
  if (!res.ok) throw new Error(`fixture failed: ${res.error}`);
  await waitForReady();
});

describe("M23 operational flag (the auditor's operational facet)", () => {
  it("records an operational flag, names the family + capability + kind, and writes NO denial (D1/D2)", async () => {
    const aSub = randomUUID();
    const flagged = await ok(rpc("raise_operational_flag", {
      token: auditor(aSub),
      body: {
        p_subject_family: SUBJ, p_capability: "role:implementer", p_kind: "overspending",
        p_detail: "burns ~50x the peer median tokens_per_delivery for the same result",
        p_severity: "warning",
      },
    }));
    // The envelope carries the ledger row in its `event` slot (the only data slot besides `task`).
    expect(flagged.event.kind).toBe("overspending");
    expect(flagged.event.capability).toBe("role:implementer");
    expect(flagged.event.severity).toBe("warning");

    const rows = flagRows(SUBJ);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("overspending");
    expect(rows[0].capability).toBe("role:implementer");
    expect(rows[0].detail).toContain("peer median");

    // The operational path NEVER writes a denial — a flagged family keeps working until a
    // human acts through M22's oversight RPC (D2/D5).
    expect(denialRow(SUBJ, "role:implementer")).toBeUndefined();
  });

  it("accepts a spinning flag with the default severity (D1)", async () => {
    const aSub = randomUUID();
    const flagged = await ok(rpc("raise_operational_flag", {
      token: auditor(aSub),
      body: {
        p_subject_family: SUBJ, p_capability: "role:implementer", p_kind: "spinning",
        p_detail: "looped on a hallucinated str_replace_editor tool, ~10 min, 0 progress",
      },
    }));
    expect(flagged.event.kind).toBe("spinning");
    expect(flagged.event.severity).toBe("warning"); // defaulted

    // Two auditor judgments now AGGREGATE in the ledger (append-only, the federated-truth rule).
    expect(flagRows(SUBJ)).toHaveLength(2);
  });

  it("refuses a non-auditor (D6), an unknown family, an empty kind/detail (D1)", async () => {
    const noRole = await json(await rpc("raise_operational_flag", {
      token: nonAuditor(randomUUID()),
      body: { p_subject_family: SUBJ, p_capability: "role:implementer", p_kind: "spinning", p_detail: "x" },
    }));
    expect(noRole.ok).toBe(false);
    expect(noRole.reason).toContain("role:auditor");

    const noFam = await json(await rpc("raise_operational_flag", {
      token: auditor(randomUUID()),
      body: { p_subject_family: "nope-family", p_capability: "role:implementer", p_kind: "spinning", p_detail: "x" },
    }));
    expect(noFam.code).toBe("not_found");

    const badKind = await json(await rpc("raise_operational_flag", {
      token: auditor(randomUUID()),
      body: { p_subject_family: SUBJ, p_capability: "role:implementer", p_kind: "sluggish", p_detail: "x" },
    }));
    expect(badKind.ok).toBe(false);
    expect(badKind.reason).toContain("kind must be one of");

    const emptyDetail = await json(await rpc("raise_operational_flag", {
      token: auditor(randomUUID()),
      body: { p_subject_family: SUBJ, p_capability: "role:implementer", p_kind: "spinning", p_detail: "   " },
    }));
    expect(emptyDetail.ok).toBe(false);
    expect(emptyDetail.reason).toContain("detail");

    const emptyCap = await json(await rpc("raise_operational_flag", {
      token: auditor(randomUUID()),
      body: { p_subject_family: SUBJ, p_capability: "  ", p_kind: "spinning", p_detail: "x" },
    }));
    expect(emptyCap.ok).toBe(false);
    expect(emptyCap.reason).toContain("capability");
  });

  it("the ledger is append-only — update and delete are both rejected (D7)", async () => {
    const upd = exec(`update app.operational_flags set severity = 'critical'
      where family_id = (select id from app.agent_families where key = '${SUBJ}')`);
    expect(upd.ok).toBe(false);
    expect(upd.error).toMatch(/append-only/i);

    const del = exec(`delete from app.operational_flags
      where family_id = (select id from app.agent_families where key = '${SUBJ}')`);
    expect(del.ok).toBe(false);
    expect(del.error).toMatch(/append-only/i);
  });

  it("seeds overspend_multiple on the system policy row (D3)", () => {
    const m = scalar<string>(
      "select overspend_multiple::text from app.governance_policy where scope_kind = 'system'");
    expect(Number(m)).toBeGreaterThan(0);
  });
});
