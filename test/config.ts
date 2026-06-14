// Shared test configuration. Values come from the environment (test/setup.ts loads
// .env before this module is read); the fallbacks mirror the dev-only defaults in
// .env so the suite also runs under a bare `npm test` when the stack is already up.
const fromEnv = (v: string | undefined): string | undefined =>
  v && v.length > 0 ? v : undefined; // treat empty string as unset

// NB: read AINARRES_BASE_URL, not BASE_URL — Vite/Vitest reserves BASE_URL (app base
// path) and injects "/" into process.env, which would clobber ours inside the worker.
export const BASE_URL = fromEnv(process.env.AINARRES_BASE_URL) ?? "http://localhost:3010";
export const JWT_SECRET =
  fromEnv(process.env.JWT_SECRET) ?? "ainarres-dev-only-secret-change-me-min-32-chars";
