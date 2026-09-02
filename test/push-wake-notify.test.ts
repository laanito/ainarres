import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { exec, waitForDb } from "./helpers/db";
import { PG_DB, PG_USER } from "./config";

// M28 Slice A — the real DB proof that the push-wake NOTIFY trigger fires (and stays
// silent where it must). Runs in the FULL SUITE at the validating stage against a
// clean rebuild. Uses ONE psql session per case for listen+write+read, so the notice
// is captured on the same connection that committed the write.

beforeAll(() => waitForDb());

const taskId = randomUUID();

// Run a batch of -c commands in a SINGLE psql session and return combined stdout+stderr.
function listenAndWrite(...cmds: string[]): string {
  const out = execFileSync(
    "docker",
    [
      "compose", "exec", "-T", "db", "psql", "-X", "-U", PG_USER, "-d", PG_DB,
      ...cmds.flatMap((c) => ["-c", c]),
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  return out;
}

describe("M28 push-wake NOTIFY trigger", () => {
  it("a. INSERT notifies, with the lane key as payload", () => {
    const out = listenAndWrite(
      "listen ainarres_activity",
      `insert into app.tasks (id, lane_id, stage)
         select '${taskId}', l.id, s.id
         from app.lanes l
         join app.stages s on s.workflow_id = l.workflow_id and s.is_initial
         where l.key = 'api'
         limit 1`,
      "select 1",
    );
    expect(out).toContain('Asynchronous notification "ainarres_activity"');
    expect(out).toContain('payload "api"');
  });

  it("b. a claim-shaped UPDATE stays SILENT", () => {
    // The pin that keeps heartbeats and claims from waking the service: writing
    // claimed_by / lease_expires_at must NOT notify.
    const out = listenAndWrite(
      "listen ainarres_activity",
      `update app.tasks set claimed_by = gen_random_uuid(), lease_expires_at = now() + interval '1 hour'
         where id = '${taskId}'`,
      "select 1",
    );
    expect(out).not.toContain("Asynchronous notification");
  });

  it("c. a blocked flip DOES notify", () => {
    const out = listenAndWrite(
      "listen ainarres_activity",
      `update app.tasks set blocked = true where id = '${taskId}'`,
      "select 1",
    );
    expect(out).toContain('Asynchronous notification "ainarres_activity"');
  });
});

afterAll(() => {
  // Clean up the throwaway task so the shared test board keeps no litter. The DELETE
  // fires nothing — the triggers are INSERT/UPDATE only.
  exec(`delete from app.tasks where id = '${taskId}'`);
});
