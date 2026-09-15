/**
 * Subprocess proof for SC-2 Check 4.
 *
 * A tool-level `isError` response is too late: pgvector dimension and index
 * bootstrap failures must stop the server before the stdio transport opens.
 * These tests therefore launch the compiled production entry point and
 * inspect its real exit code and stderr.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  redactPgDiagnostic,
  resolvePgConnectionString,
  warnPgUnavailable,
} from "../integration/pg-test-harness.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "../..");
const serverPath = path.join(pkgRoot, "dist", "index.js");
const failingPgLoaderPath = path.join(
  here,
  "pgvector-startup-failing-pg-loader.mjs"
);
const baseDbUrl = resolvePgConnectionString(
  "postgresql://postgres@localhost:5432/postgres"
);
const schema = `vector_startup_${Math.random().toString(16).slice(2, 10)}`;

// Startup budget for one compiled-server boot, and the enclosing per-test
// budget. The test budget must stay strictly above the startup budget so the
// process-level timer reports a clean `timedOut` result instead of vitest
// cutting the test off first.
const STARTUP_BUDGET_MS = 20_000;
const TEST_TIMEOUT_MS = STARTUP_BUDGET_MS + 10_000;

interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

let postgresAvailable = false;
let postgresProbeError: unknown;
let probe: pg.Client | undefined;
try {
  probe = new pg.Client({ connectionString: baseDbUrl });
  await probe.connect();
  await probe.query("SELECT 1");
  const extension = await probe.query<{ installed_version: string | null }>(
    "SELECT installed_version FROM pg_available_extensions WHERE name = 'vector'"
  );
  if (extension.rows[0]?.installed_version === undefined) {
    throw new Error("pgvector extension is not installed");
  }
  postgresAvailable = true;
} catch (error) {
  postgresProbeError = error;
} finally {
  if (probe !== undefined) {
    await probe.end().catch((error: unknown) => {
      postgresProbeError ??= error;
    });
  }
}

if (!postgresAvailable) {
  warnPgUnavailable({
    label: "pgvector-startup",
    testPath: "tests/storage/pgvector-startup.test.ts",
    expectedCommand: "npx vitest run tests/storage/pgvector-startup.test.ts",
    connectionString: baseDbUrl,
    error: postgresProbeError ?? new Error("Postgres probe failed"),
    requiresVector: true,
  });
}

const describePg = postgresAvailable ? describe : describe.skip;

function schemaDbUrl(): string {
  const separator = baseDbUrl.includes("?") ? "&" : "?";
  return `${baseDbUrl}${separator}options=-c%20search_path%3D${encodeURIComponent(`${schema},public`)}`;
}

interface RunServerOptions {
  connectionString?: string;
  logLevel?: "error" | "info";
  nodeOptions?: string;
}

function serverEnv(
  dimensions: number,
  options: RunServerOptions
): Record<string, string> {
  return {
    GRAPHRAG_MEMORY_STORAGE: "pgvector",
    GRAPHRAG_MEMORY_DB_URL: options.connectionString ?? schemaDbUrl(),
    GRAPHRAG_MEMORY_EMBED_DIMENSIONS: String(dimensions),
    GRAPHRAG_MEMORY_PGVECTOR_ANN_MAX_DIMENSIONS: "2000",
    GRAPHRAG_MEMORY_LOG_LEVEL: options.logLevel ?? "error",
    // ADR-0006 fail-start: these suites exercise pgvector startup, not the
    // graph/rerank arms, so both switches go explicitly off — the boot must
    // succeed (or fail on pgvector grounds) without sidecar credentials.
    GRAPHRAG_MEMORY_RETRIEVAL_GRAPH_ENABLED: "false",
    GRAPHRAG_MEMORY_RETRIEVAL_RERANK_ENABLED: "false",
    // ADR-0007: the startup self-check never exercises the lexical arm.
    GRAPHRAG_MEMORY_RETRIEVAL_BM25_ENABLED: "false",
    PATH: process.env.PATH ?? "",
    ...(options.nodeOptions === undefined
      ? {}
      : { NODE_OPTIONS: options.nodeOptions }),
  };
}

function runServer(
  dimensions: number,
  options: RunServerOptions = {}
): Promise<ProcessResult> {
  if (!existsSync(serverPath)) {
    throw new Error(
      `compiled server missing at ${serverPath} — run \`npm run build\` first`
    );
  }

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serverPath], {
      env: serverEnv(dimensions, options),
      // stdin stays open like a real MCP host: /dev/null EOF makes the stdio
      // transport shut down and the process exit 0 on its own, which would
      // masquerade as the "keeps running" assertion failing.
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    // Startup budget, not an assertion: the compiled server needs a cold
    // `node dist/index.js` boot plus a live Postgres round-trip. A loaded
    // dev box (4 cores, load > 10) starves that well past 5s and turns the
    // "should die" cases into false timeouts, so the budget is generous;
    // the timedOut flag still proves a graceful SIGTERM when it does fire.
    const startupTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 1_000);
    }, STARTUP_BUDGET_MS);

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });
    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });
    child.on("error", (error) => {
      clearTimeout(startupTimer);
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(startupTimer);
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      resolve({ code, signal, stdout, stderr, timedOut });
    });
  });
}

function reportProcess(label: string, result: ProcessResult): void {
  console.info(
    `[pgvector-startup] ${label}: exit=${String(result.code)} signal=${String(result.signal)}\n` +
      `stderr:\n${redactPgDiagnostic(result.stderr)}`
  );
}

it(
  "redacts a password from fatal startup stderr",
  async () => {
    const secret = "startup-fatal-password";
    const connectionString = `postgresql://ci-user:${secret}@db.example.test:5432/graph`;
    const result = await runServer(1_536, {
      connectionString,
      nodeOptions: `--no-warnings --experimental-loader=${failingPgLoaderPath}`,
    });

    reportProcess("fatal-redaction", result);

    expect(result.timedOut).toBe(false);
    expect(result.code).toBe(1);
    expect(result.stderr).not.toContain(secret);
    expect(result.stderr).toContain("iknow-memory fatal");
  },
  TEST_TIMEOUT_MS
);

it("redacts captured child stderr before replaying it", () => {
  const secret = "replayed-child-password";
  const output: string[] = [];
  const info = vi
    .spyOn(console, "info")
    .mockImplementation((...args: unknown[]) => {
      output.push(args.map((arg) => String(arg)).join(" "));
    });

  try {
    reportProcess("child-error", {
      code: 1,
      signal: null,
      stdout: "",
      stderr: `driver error for postgresql://ci-user:${secret}@db.example.test:5432/graph`,
      timedOut: false,
    });
  } finally {
    info.mockRestore();
  }

  expect(output.join("\n")).not.toContain(secret);
});

describePg("pgvector startup self-check (SC-2 Check 4)", () => {
  let client: pg.Client | undefined;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: baseDbUrl });
    await client.connect();
  });

  beforeEach(async () => {
    await client!.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await client!.query(`CREATE SCHEMA "${schema}"`);
  });

  afterAll(async () => {
    if (client !== undefined) {
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await client.end();
    }
  });

  it(
    "exits with code 2 when dimensions exceed the ANN limit",
    async () => {
      const result = await runServer(2_001);
      reportProcess("dimension-over-limit", result);

      expect(result.timedOut).toBe(false);
      expect(result.code).toBe(2);
      expect(result.stderr.trim()).not.toBe("");
      expect(result.stderr).toMatch(/GRAPHRAG_MEMORY_EMBED_DIMENSIONS|2000/);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "exits with code 1 when the chunk index cannot be built",
    async () => {
      await client!.query(`
      CREATE TABLE "${schema}".chunks (
        id uuid PRIMARY KEY,
        content text NOT NULL
      )
    `);

      const result = await runServer(1_536);
      reportProcess("index-build-failure", result);

      expect(result.timedOut).toBe(false);
      expect(result.code).toBe(1);
      expect(result.stderr.trim()).not.toBe("");
      expect(result.stderr).toMatch(/chunks_embedding_idx|embedding|index/i);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "keeps a correctly configured pgvector server running after startup",
    async () => {
      const result = await runServer(1_536, { logLevel: "info" });
      reportProcess("startup-success", result);

      expect(result.timedOut).toBe(true);
      expect(result.code).toBeNull();
      expect(result.signal).toBe("SIGTERM");
      expect(result.stderr).toContain("stdio transport connected");
    },
    TEST_TIMEOUT_MS
  );
});
