import { defineConfig } from "vitest/config";

/**
 * Vitest config for iknow-memory.
 *
 * Mirrors the root project's test layout: tests live outside `tsconfig.json`'s
 * `include` (which is scoped to src/ for the dist build), so vitest gets its
 * own TS-aware include here. ESM is honored via the package's `"type": "module"`.
 */
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    pool: "forks",
    reporter: "default",
    // Subprocess / live-Postgres / live-Neo4j suites (`tests/cli/extract*`,
    // `tests/integration/*`) each pay a cold `node dist/index.js` boot plus
    // real DB round-trips. Vitest's 5s default starves them on a loaded dev
    // box and reports timeouts for work that did not actually hang. The CI
    // fast job excludes these files and the nightly full job retries once,
    // so this ceiling only changes how long a real hang takes to surface.
    testTimeout: 45_000,
    // Issue #169: many tests spawn subprocesses that assert on `dist/`
    // artifacts. Without a build step `npm test` runs against a stale
    // `dist/` and produces false failures (pgvector-startup, host-smoke,
    // extract / extract-e2e-graph / extract-backfill-pg). The globalSetup
    // hook rebuilds `dist/` only when it's stale (mtime check in
    // tests/global-setup.ts) so every entry path (`npm test`, bare
    // `npx vitest run <file>`, CI) starts from a fresh build without
    // paying for a full rebuild on every invocation.
    globalSetup: ["./tests/global-setup.ts"],
  },
});
