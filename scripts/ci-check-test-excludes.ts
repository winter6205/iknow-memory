/**
 * CI guard: scan `tests/` and diff against `.github/workflows/test.yml`
 * `--exclude` lists per job.
 *
 * Assembly class (taxonomy measurement, call-form only):
 *   `\b(requireBwrap|runInSandbox|createBashTool|createDefaultAciRegistry|createWorkerDeps|buildHarnessEngine)\s*\(`
 *   Hits must be excluded in BOTH test-fast and test-full.
 *
 * Slow path: Postgres-dependent files that are not assembly-class
 * (assembly wins when both would match). This repo has no bwrap runtime.
 *   Detected if source matches ANY of:
 *     - `\bnew pg\.Client\s*\(`
 *     - `\bnew PgClient\s*\(`  (named import `Client as PgClient`)
 *     - `\bdescribePg\b`
 *   Must be excluded in test-fast only (directory glob or path).
 *   Must NOT be excluded in test-full (nightly Postgres service).
 *   Does NOT flag URL-only mentions or `PgvectorBackend("postgres://...")`.
 *
 * Assertions:
 *   A) every slow-path (postgres-dependent) file is excluded in test-fast
 *   B) no slow-path file is excluded in test-full
 *   C) `tests/integration/**` must not appear in test-full excludes
 *   D) every assembly-class file is excluded in test-fast AND test-full
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

const ASSEMBLY_PATTERNS: ReadonlyArray<RegExp> = [
  /\brequireBwrap\s*\(/,
  /\brunInSandbox\s*\(/,
  /\bcreateBashTool\s*\(/,
  /\bcreateDefaultAciRegistry\s*\(/,
  /\bcreateWorkerDeps\s*\(/,
  /\bbuildHarnessEngine\s*\(/,
];

/**
 * How a test reaches a real database.
 *
 * `new pg.Client(` alone missed every lane that obtains its client from a
 * helper, so the guard reported the suite clean while `test-fast` failed to
 * load the structured lanes one by one. Those lanes reach PostgreSQL through
 * one of three entry points — a direct constructor, the strict driver, or the
 * shared integration harness — so all three are matched here.
 *
 * Prose is deliberately NOT a signal. An earlier revision matched "requires"
 * and pulled in two dozen hermetic tests whose copy happens to use the word;
 * a match on English is a guess about behaviour, and guessing wrong here
 * silences coverage rather than merely misfiling it.
 */
const PG_PATTERNS: ReadonlyArray<RegExp> = [
  /\bnew pg\.Client\s*\(/,
  /\bnew PgClient\s*\(/,
  /\bdescribePg\b/,
  /\bopenStrictPgDriver\b/,
  /\bcreatePgIntegrationHarness\b/,
];

/**
 * Files that legitimately name the helpers above without needing a database.
 *
 * The harness's own unit test exercises the module in isolation and passes with
 * no server, so matching on the helper name alone would exclude a hermetic file
 * and lose its coverage. A file that both DEFINES the helper and is not itself
 * a lane is that case.
 */
const PG_HELPER_DEFINERS: ReadonlySet<string> = new Set([
  "tests/pg-test-harness.test.ts",
]);

const EXCLUDE_RE = /--exclude\s+(['"]?)([^'"\s]+)\1/g;

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (/\.test\.tsx?$/.test(entry)) {
      out.push(relative(repoRoot, full).split("\\").join("/"));
    }
  }
}

function parseExcludes(section: string): Set<string> {
  const excludes = new Set<string>();
  for (const m of section.matchAll(EXCLUDE_RE)) {
    excludes.add(m[2]!);
  }
  return excludes;
}

function isExcluded(file: string, excludes: Set<string>): boolean {
  if (excludes.has(file)) return true;
  for (const ex of excludes) {
    if (ex.endsWith("/**")) {
      const prefix = ex.slice(0, -3);
      if (file === prefix || file.startsWith(prefix + "/")) return true;
    }
  }
  return false;
}

function matchesAny(src: string, patterns: ReadonlyArray<RegExp>): boolean {
  return patterns.some((re) => re.test(src));
}

const testsDir = join(repoRoot, "tests");
const files: string[] = [];
walk(testsDir, files);

const pgFiles = new Set<string>();
const assemblyFiles = new Set<string>();
for (const f of files) {
  const src = readFileSync(join(repoRoot, f), "utf8");
  if (matchesAny(src, ASSEMBLY_PATTERNS)) assemblyFiles.add(f);
  else if (matchesAny(src, PG_PATTERNS) && !PG_HELPER_DEFINERS.has(f)) pgFiles.add(f);
}

const workflowPath = join(repoRoot, ".github", "workflows", "test.yml");
const workflow = readFileSync(workflowPath, "utf8");

// Slice by real job boundaries. This guard reasons about test-fast and
// test-full only, but other jobs can sit between them (test-es); folding
// their `--exclude` text into test-fast's set would let a violation pass
// on entries that never run in that job.
const jobsStart = workflow.indexOf("\njobs:");
const jobs: Array<{ name: string; index: number }> = [];
if (jobsStart !== -1) {
  for (const m of workflow.matchAll(/^ {2}([A-Za-z0-9_-]+):$/gm)) {
    if (m.index > jobsStart) jobs.push({ name: m[1]!, index: m.index });
  }
}
function jobSection(name: string): string | undefined {
  const i = jobs.findIndex((j) => j.name === name);
  if (i === -1) return undefined;
  const end = i + 1 < jobs.length ? jobs[i + 1]!.index : workflow.length;
  return workflow.slice(jobs[i]!.index, end);
}
const fastSection = jobSection("test-fast");
const fullSection = jobSection("test-full");
if (fastSection === undefined || fullSection === undefined) {
  console.error(
    "FAIL: could not locate test-fast: / test-full: sections in test.yml"
  );
  process.exit(1);
}
const fastExcludes = parseExcludes(fastSection);
const fullExcludes = parseExcludes(fullSection);

let failed = false;

const missingFast = [...pgFiles]
  .filter((f) => !isExcluded(f, fastExcludes))
  .sort();
if (missingFast.length > 0) {
  failed = true;
  console.error(
    `FAIL: ${missingFast.length}/${pgFiles.size} slow-path (postgres) test files NOT excluded in test-fast.`
  );
  console.error(
    "Add each to test-fast in .github/workflows/test.yml (tests/integration/** glob covers integration/):"
  );
  for (const f of missingFast) console.error(`    --exclude ${f} \\`);
  console.error("");
}

const wronglyExcludedFull = [...pgFiles]
  .filter((f) => isExcluded(f, fullExcludes))
  .sort();
if (wronglyExcludedFull.length > 0) {
  failed = true;
  console.error(
    `FAIL: ${wronglyExcludedFull.length} slow-path (postgres) test files must NOT be excluded in test-full:`
  );
  for (const f of wronglyExcludedFull) {
    console.error(`    remove --exclude ${f} from test-full`);
  }
  console.error("");
}

if (fullExcludes.has("tests/integration/**")) {
  failed = true;
  console.error(
    "FAIL: tests/integration/** must not appear in test-full excludes."
  );
  console.error("");
}

const missingAssembly = [...assemblyFiles]
  .filter((f) => !isExcluded(f, fastExcludes) || !isExcluded(f, fullExcludes))
  .sort();
if (missingAssembly.length > 0) {
  failed = true;
  console.error(
    `FAIL: ${missingAssembly.length}/${assemblyFiles.size} assembly-class files NOT excluded in both jobs.`
  );
  console.error(
    "Add each to BOTH test-fast and test-full in .github/workflows/test.yml:"
  );
  for (const f of missingAssembly) console.error(`    --exclude ${f} \\`);
  console.error("");
}

if (failed) {
  console.error(
    "Reason: test-fast PR gate has no Postgres service; slow-path tests run in test-full. Assembly-class files stay excluded on both jobs."
  );
  process.exit(1);
}

console.log(
  `OK: ${pgFiles.size} slow-path (postgres) files excluded in test-fast only; ${assemblyFiles.size} assembly-class files excluded in both jobs (${fastExcludes.size} fast / ${fullExcludes.size} full --exclude entries).`
);
