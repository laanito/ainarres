import { existsSync } from "node:fs";

// Load .env ourselves so the suite is self-sufficient (independent of how it's
// invoked). Runs before test modules are imported, so config.ts sees the values.
// Real env vars already set are NOT overwritten by loadEnvFile.
if (existsSync(".env")) {
  process.loadEnvFile(".env");
}
