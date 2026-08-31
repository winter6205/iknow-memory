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
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "../..");
const serverPath = path.join(pkgRoot, "dist", "index.js");
const baseDbUrl =
  process.env.GRAPHRAG_MEMORY_DB_URL ??
  "postgresql://postgres@localhost:5432/postgres";
const schema = `vector_startup_${Math.random().toString(16).slice(2, 10)}`;

interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

let postgresAvailable = false;
let postgresProbeError: unknown;
const probe = new pg.Client({ connectionString: baseDbUrl });
try {
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
  await probe.end().catch((error: unknown) => {
    postgresProbeError ??= error;
  });
}

if (!postgresAvailable) {
  console.warn(
    `\n[pgvector-startup] Postgres/pgvector unavailable at ${baseDbUrl}: ${String(postgresProbeError)}\n`
  );
  console.warn(
    "Validation:\n" +
      "- Not run: tests/storage/pgvector-startup.test.ts\n" +
      "- Expected command: npx vitest run tests/storage/pgvector-startup.test.ts\n" +
      `- Blocking issue: cannot use Postgres with pgvector at ${baseDbUrl}\n`
  );
}

const describePg = postgresAvailable ? describe : describe.skip;

function schemaDbUrl(): string {
  const separator = baseDbUrl.includes("?") ? "&" : "?";
  return `${baseDbUrl}${separator}options=-c%20search_path%3D${encodeURIComponent(`${schema},public`)}`;
}

function serverEnv(dimensions: number): Record<string, string> {
  return {
    GRAPHRAG_MEMORY_STORAGE: "pgvector",
    GRAPHRAG_MEMORY_DB_URL: schemaDbUrl(),
    GRAPHRAG_MEMORY_EMBED_DIMENSIONS: String(dimensions),
    GRAPHRAG_MEMORY_PGVECTOR_ANN_MAX_DIMENSIONS: "2000",
    GRAPHRAG_MEMORY_LOG_LEVEL: "error",
    PATH: process.env.PATH ?? "",
  };
}

function runServer(dimensions: number): Promise<ProcessResult> {
  if (!existsSync(serverPath)) {
    throw new Error(
      `compiled server missing at ${serverPath} — run \`npm run build\` first`
    );
  }

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serverPath], {
      env: serverEnv(dimensions),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    const startupTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 1_000);
    }, 5_000);

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
      `stderr:\n${result.stderr.trim()}`
  );
}

describePg("pgvector startup self-check (SC-2 Check 4)", () => {
  let client: pg.Client | undefined;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: baseDbUrl });
    await client.connect();
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await client.query(`CREATE SCHEMA "${schema}"`);
  });

  afterAll(async () => {
    if (client !== undefined) {
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await client.end();
    }
  });

  it("exits non-zero with a message when dimensions exceed the ANN limit", async () => {
    const result = await runServer(2_001);
    reportProcess("dimension-over-limit", result);

    expect(result.timedOut).toBe(false);
    expect(result.code).not.toBeNull();
    expect(result.code).not.toBe(0);
    expect(result.stderr.trim()).not.toBe("");
    expect(result.stderr).toMatch(/GRAPHRAG_MEMORY_EMBED_DIMENSIONS|2000/);
  });

  it("exits non-zero with a message when the chunk index cannot be built", async () => {
    await client!.query(`
      CREATE TABLE "${schema}".chunks (
        id uuid PRIMARY KEY,
        content text NOT NULL
      )
    `);

    const result = await runServer(1_536);
    reportProcess("index-build-failure", result);

    expect(result.timedOut).toBe(false);
    expect(result.code).not.toBeNull();
    expect(result.code).not.toBe(0);
    expect(result.stderr.trim()).not.toBe("");
    expect(result.stderr).toMatch(/chunks_embedding_idx|embedding|index/i);
  });
});
