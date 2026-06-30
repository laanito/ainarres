import { existsSync, readFileSync } from "node:fs";

// Load .env ourselves so the suite is self-sufficient (independent of how it's
// invoked). Runs before test modules are imported, so config.ts sees the values.
// process.loadEnvFile does NOT overwrite env vars already set — fine for most keys.
if (existsSync(".env")) {
  process.loadEnvFile(".env");
}

// …but for the keys that decide WHICH substrate the suite talks to, `.env` MUST win
// over an inherited value. The autonomous-loop driver exports AINARRES_BASE_URL
// (=the loop substrate, :3011) to its harnesses; if a harness then runs the full
// `npm test`, loadEnvFile's no-overwrite rule would leave that inherited :3011 in
// place and the WHOLE suite would seed its fixtures onto the live loop board — the
// M11/M13 pollution, recurring through AINARRES_BASE_URL instead of the
// COMPOSE_PROJECT_NAME vector closed in #44. The suite IS the test substrate's
// client: `.env` defines that substrate, so `.env` is authoritative here. Force the
// substrate-selecting keys from `.env`, overwriting whatever was inherited, so the
// suite can NEVER target the loop no matter who (or what) invoked it.
if (existsSync(".env")) {
  const PINNED = new Set(["AINARRES_BASE_URL", "JWT_SECRET"]);
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m || !PINNED.has(m[1])) continue;
    let v = m[2].trim().replace(/\s+#.*$/, ""); // strip trailing inline comment
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    process.env[m[1]] = v;
  }
}
