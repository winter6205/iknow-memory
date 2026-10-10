/**
 * Vitest global setup — guarantees `dist/` is fresh before any test file runs.
 *
 * Why this exists:
 *   `npm test` is just `vitest run` with no build step, but many tests spawn
 *   subprocesses that assert on `dist/index.js`, `dist/cli/extract.js`, etc.
 *   The build → test dependency was previously encoded ONLY in
 *   `.github/workflows/test.yml` (`- run: npm run build` before vitest),
 *   which is why CI was green while local `npm test` failed with confusing
 *   "expected +0 to be 1" / "column 'embedding' does not exist" symptoms —
 *   the test runner was hitting a stale `dist/` built before the SC-2 vector
 *   index guarantees were enforced.
 *
 *   Fix: at the start of every test session, rebuild `dist/` if and only if
 *   any source file under `src/` is newer than its corresponding `.js` in
 *   `dist/`. This is cheap on a clean tree (~5 s) and effectively free when
 *   `npm run build` already ran (incremental tsc + the no-op fast path).
 *
 *   Why not always rebuild?
 *     A handful of CLI subprocess tests use 5 s timeouts (`it("...", 5000)`
 *     in tests/cli/*). Forcing a 5 s rebuild before every single test run
 *     pushes those close to the edge and surfaces intermittent flakes that
 *     have nothing to do with correctness. Staleness-only rebuild keeps the
 *     safety guarantee without the overhead.
 *
 *   Why not just `pretest: "npm run build"` in package.json?
 *     It only fires for `npm test`. Bare `npx vitest run <file>` (the way
 *     CI, agents, and many developers invoke tests) would skip it and hit
 *     the same stale-dist trap. `globalSetup` covers every entry path.
 *
 *   The five `existsSync("compiled ... missing")` guards in tests/ stay in
 *   place as redundant safety nets — this hook is the primary fix, not a
 *   replacement.
 *
 * Single source of truth:
 *   We invoke `npm run build` rather than re-typing the `tsc -p tsconfig.json`
 *   invocation. `package.json` stays the single source of truth for build
 *   flags; adding a second tsc invocation here would let them drift.
 *
 * Fail-loud contract:
 *   If the build exits non-zero, we throw — vitest must never run against a
 *   broken or stale `dist/`. The thrown error carries stdout+stderr so the
 *   operator sees the real tsc diagnostic, not a cryptic test failure later.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const REPO_ROOT = process.cwd();
const SRC_DIR = join(REPO_ROOT, "src");
const DIST_DIR = join(REPO_ROOT, "dist");

/** Recursively collect regular files under `root`. */
function walk(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const p = join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(p));
    } else if (entry.isFile()) {
      out.push(p);
    }
  }
  return out;
}

/**
 * Decide whether `dist/` is stale.
 *
 * Returns true (rebuild needed) when:
 *   - `dist/` doesn't exist yet, OR
 *   - any source file in `src/` has a mtime strictly greater than the
 *     corresponding compiled artifact in `dist/` (mapped via path), OR
 *   - any source file in `src/` lacks a compiled counterpart (e.g. a new
 *     file added since the last build).
 *
 * Returns false (skip) when every src file is present in dist/ and none
 * of them are newer. Mtime tie (equal mtimeMs) is treated as fresh —
 * tsc preserves mtimes for unchanged outputs.
 */
function distIsStale(): boolean {
  if (!existsSync(DIST_DIR)) return true;
  const srcFiles = walk(SRC_DIR);
  for (const src of srcFiles) {
    if (!src.endsWith(".ts") && !src.endsWith(".tsx")) continue;
    const rel = relative(SRC_DIR, src).replace(/\.tsx?$/, ".js");
    const compiled = join(DIST_DIR, rel);
    if (!existsSync(compiled)) return true;
    const srcM = statSync(src).mtimeMs;
    const outM = statSync(compiled).mtimeMs;
    if (srcM > outM) return true;
  }
  return false;
}

export function setup(): void {
  if (!distIsStale()) {
    // Already fresh. Skip the rebuild so we don't push subprocess tests
    // into flaky territory under heavy parallel load.
    return;
  }

  const result = spawnSync("npm", ["run", "build"], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });

  if (result.error) {
    throw new Error(
      `Failed to spawn \`npm run build\` for vitest globalSetup: ${result.error.message}\n` +
        "Issue #169: subprocess tests assert on dist/ artifacts; " +
        "without a working build, every test in tests/storage/, tests/cli/, " +
        "tests/integration/, and tests/host-smoke.test.ts will report false failures."
    );
  }

  if (result.status !== 0) {
    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";
    throw new Error(
      `\`npm run build\` exited with status ${String(result.status)} before tests could run. ` +
        "Issue #169: vitest will not run against a broken or stale dist/ — " +
        "fix the build errors below and re-run.\n" +
        "----- stdout -----\n" +
        stdout +
        "----- stderr -----\n" +
        stderr
    );
  }
}
