/**
 * Real-Postgres coverage for the `--list-failed` CLI surface (T5 / G8 / SC11).
 *
 * SC11's four cases run as real `node dist/cli/extract.js` subprocesses so the
 * exit codes are the process's own: empty table, populated table, `--batch-id`
 * filter, and keyless operation. `runCliSubprocess` builds the child env from
 * scratch and never sets ANTHROPIC_AUTH_TOKEN, so *every* case
 * here is the keyless case — a run that reached buildLlm's real-extraction leg
 * would exit 1 with the CR High #1 refusal on stderr instead.
 *
 * The subprocess cannot inject an LLM (no env hook for scripted output — see
 * the header of tests/cli/extract.test.ts), so SC11's "no LLM call, asserted
 * via a throwing FakeLLMClient" runs through `runCli` against the same real
 * schema, the documented fallback the sibling suites already use.
 *
 * Harness contract mirrors tests/cli/extract.test.ts: a unique schema plus a
 * per-connection `search_path` (libpq `options=`), because the parallel
 * schema-p0 worker drops/recreates the P0 tables in `public`.
 *
 * Per docs/.claude/rules/test.md: if Postgres is unreachable the suite SKIPS
 * LOUDLY — a top-level probe flips the suite to `describe.skip` and prints the
 * documented Validation block, the same shape
 * tests/integration/retrieval-pg.test.ts uses. It never silently passes, and
 * it never reports an unreachable database as a test failure.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { upSchemaP0 } from "../../src/core/storage/schema-p0.js";
import { FakeLLMClient } from "../../src/core/extraction/llm-client.js";
import { FakeEmbedder } from "../../src/core/embedder.js";
import { runCli, type CliDeps } from "../../src/cli/extract.js";
import { warnPgUnavailable } from "../integration/pg-test-harness.js";

const DIM = 8;
const BASE_DB_URL = "postgresql://postgres@localhost/postgres";
const SCHEMA = `extract_list_failed_${randomUUID().slice(0, 8)}`;
const CLI_PATH = join(process.cwd(), "dist/cli/extract.js");
const ANN_MAX_DIMENSIONS_VAR = "GRAPHRAG_MEMORY_PGVECTOR_ANN_MAX_DIMENSIONS";
const savedAnnMaxDimensions = process.env[ANN_MAX_DIMENSIONS_VAR];

const BATCH_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BATCH_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/** Per-connection search_path targeting SCHEMA via libpq `options=`. */
function schemaDbUrl(): string {
  return `${BASE_DB_URL}?options=-c%20search_path%3D${SCHEMA}%2Cpublic`;
}

interface ProcResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Spawn the compiled CLI; the child env carries no parent GRAPHRAG_* keys. */
function runCliSubprocess(
  args: string[],
  envOverrides: Record<string, string> = {}
): Promise<ProcResult> {
  if (!existsSync(CLI_PATH)) {
    throw new Error(
      `compiled CLI missing at ${CLI_PATH} — run \`npm run build\` first`
    );
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env: {
        GRAPHRAG_MEMORY_DB_URL: schemaDbUrl(),
        GRAPHRAG_MEMORY_EMBED_DIMENSIONS: String(DIM),
        GRAPHRAG_MEMORY_PGVECTOR_ANN_MAX_DIMENSIONS: "2000",
        // The report lines ride the structured logger, same as --list-unmapped.
        GRAPHRAG_MEMORY_LOG_LEVEL: "info",
        // ADR-0006 fail-start: the child's env has no Neo4j URI or rerank
        // URL, which a default-on graph/rerank boot refuses. The extract
        // CLI exercises neither arm, so switch them off explicitly.
        GRAPHRAG_MEMORY_RETRIEVAL_GRAPH_ENABLED: "false",
        GRAPHRAG_MEMORY_RETRIEVAL_RERANK_ENABLED: "false",
        ...envOverrides,
        PATH: process.env.PATH ?? "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function silentLogger() {
  return {
    level: "error" as const,
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

// Loud skip when Postgres is unreachable (describe.skip + Validation block).
let PG_AVAILABLE = false;
try {
  const probe = new pg.Client({ connectionString: BASE_DB_URL });
  await probe.connect();
  await probe.query("SELECT 1");
  await probe.end();
  PG_AVAILABLE = true;
} catch (err) {
  warnPgUnavailable({
    label: "extract-list-failed",
    testPath: "tests/cli/extract-list-failed.test.ts",
    expectedCommand: "npx vitest run tests/cli/extract-list-failed.test.ts",
    connectionString: BASE_DB_URL,
    error: err,
    requiresVector: false,
  });
}
const describePg = PG_AVAILABLE ? describe : describe.skip;

describePg("extract CLI --list-failed (T5 / SC11)", () => {
  let client: pg.Client | undefined;

  beforeAll(async () => {
    process.env[ANN_MAX_DIMENSIONS_VAR] = "2000";
    client = new pg.Client({ connectionString: BASE_DB_URL });
    await client.connect();
    await resetSchema(client);
  });

  afterAll(async () => {
    if (client) {
      await client.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
      await client.end();
    }
    if (savedAnnMaxDimensions === undefined) {
      delete process.env[ANN_MAX_DIMENSIONS_VAR];
    } else {
      process.env[ANN_MAX_DIMENSIONS_VAR] = savedAnnMaxDimensions;
    }
  });

  async function resetSchema(c: pg.Client): Promise<void> {
    await c.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await c.query(`CREATE SCHEMA "${SCHEMA}"`);
    await c.query(`SET search_path TO "${SCHEMA}", public`);
    // extraction_records carries an FK to chunks, so chunks must pre-exist.
    await c.query(`
      CREATE TABLE IF NOT EXISTS chunks (
        id uuid PRIMARY KEY,
        content text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await upSchemaP0(c, DIM, 2000);
  }

  async function insertChunk(c: pg.Client, content: string): Promise<string> {
    const id = randomUUID();
    await c.query(`INSERT INTO chunks (id, content) VALUES ($1, $2)`, [
      id,
      content,
    ]);
    return id;
  }

  /** Seed one `failed` record at a pinned created_at; returns its chunk id. */
  async function seedFailed(
    c: pg.Client,
    batchId: string,
    errorCode: string,
    createdAt: string
  ): Promise<string> {
    const chunkId = await insertChunk(c, `failed chunk ${randomUUID()}`);
    await c.query(
      `INSERT INTO extraction_records
         (id, batch_id, chunk_id, status, error_code, error_msg,
          started_at, finished_at, created_at)
       VALUES ($1, $2, $3, 'failed', $4, $5, $6, $6, $6)`,
      [
        randomUUID(),
        batchId,
        chunkId,
        errorCode,
        `${errorCode} while extracting`,
        createdAt,
      ]
    );
    return chunkId;
  }

  async function countRecords(c: pg.Client): Promise<number> {
    const res = await c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM extraction_records`
    );
    return Number(res.rows[0]?.n ?? "0");
  }

  // ── SC11 case 1: empty (also keyless) ───────────────────────────────
  it("empty table: exits 0 and reports no failed records", async () => {
    const c = client!;
    await resetSchema(c);

    const result = await runCliSubprocess(["--list-failed"]);

    expect(result.code).toBe(0);
    expect(result.stderr).toContain("no-failed-records");
    expect(result.stderr).not.toContain("refusing to run real extraction");
    // A report flag runs no extraction: nothing was written.
    expect(await countRecords(c)).toBe(0);
  });

  // ── SC11 case 2: populated (also keyless) ───────────────────────────
  it("populated table: prints chunk_id / batch_id / error_code, newest first", async () => {
    const c = client!;
    await resetSchema(c);
    const older = await seedFailed(c, BATCH_A, "5xx", "2026-08-01T00:00:00Z");
    const newer = await seedFailed(
      c,
      BATCH_B,
      "format",
      "2026-08-03T00:00:00Z"
    );
    // A succeeded row must never surface in the report.
    const okChunk = await insertChunk(c, "succeeded chunk");
    await c.query(
      `INSERT INTO extraction_records (id, batch_id, chunk_id, status, started_at)
       VALUES ($1, $2, $3, 'succeeded', now())`,
      [randomUUID(), BATCH_A, okChunk]
    );

    const result = await runCliSubprocess(["--list-failed"]);

    expect(result.code).toBe(0);
    // A15's printed columns.
    expect(result.stderr).toContain(older);
    expect(result.stderr).toContain(newer);
    expect(result.stderr).toContain(BATCH_A);
    expect(result.stderr).toContain(BATCH_B);
    expect(result.stderr).toContain("5xx");
    expect(result.stderr).toContain("format");
    expect(result.stderr).toContain("2026-08-03T00:00:00");
    expect(result.stderr).not.toContain(okChunk);
    // Newest first (A15): the 08-03 row precedes the 08-01 row.
    expect(result.stderr.indexOf(newer)).toBeLessThan(
      result.stderr.indexOf(older)
    );
    expect(result.stderr).not.toContain("refusing to run real extraction");
    // Still a read-only path: no rows added, none removed.
    expect(await countRecords(c)).toBe(3);
  });

  // ── SC11 case 3: --batch-id filter (also keyless) ───────────────────
  it("--batch-id: exits 0 and reports only the matching batch", async () => {
    const c = client!;
    await resetSchema(c);
    const inBatch = await seedFailed(c, BATCH_A, "5xx", "2026-08-01T00:00:00Z");
    const other = await seedFailed(
      c,
      BATCH_B,
      "format",
      "2026-08-03T00:00:00Z"
    );

    const result = await runCliSubprocess([
      "--list-failed",
      "--batch-id",
      BATCH_A,
    ]);

    expect(result.code).toBe(0);
    expect(result.stderr).toContain(inBatch);
    expect(result.stderr).not.toContain(other);
  });

  // ── SC11 exit map: usage errors stay exit 2 ─────────────────────────
  it("--batch-id with a non-UUID value exits 2 (usage error)", async () => {
    const result = await runCliSubprocess(["--list-failed", "--batch-id", "x"]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--batch-id");
    expect(result.stderr).toContain("--list-failed");
  });

  // ── SC11: no LLM call, asserted with a throwing FakeLLMClient ───────
  it("makes no LLM call against a populated table (throwing FakeLLMClient)", async () => {
    const c = client!;
    await resetSchema(c);
    await seedFailed(c, BATCH_A, "5xx", "2026-08-01T00:00:00Z");

    const llm = new FakeLLMClient({
      scripted: async () => {
        throw new Error("--list-failed must not call the LLM");
      },
    });
    const pool = new pg.Pool({ connectionString: schemaDbUrl() });
    const deps: CliDeps = {
      pool,
      llm,
      embedder: new FakeEmbedder(DIM),
      dims: DIM,
      logger: silentLogger(),
    };
    let code: number;
    try {
      code = await runCli(["--list-failed"], deps);
    } finally {
      await pool.end();
    }

    expect(code).toBe(0);
  });

  // ── Existing flags unregressed (SC11 tail clause) ───────────────────
  it("existing flags keep their exit codes (--dry-run 0, unknown flag 2)", async () => {
    const c = client!;
    await resetSchema(c);

    expect((await runCliSubprocess(["--dry-run"])).code).toBe(0);
    expect((await runCliSubprocess(["--list-unmapped"])).code).toBe(0);
    expect((await runCliSubprocess(["--no-such-flag"])).code).toBe(2);
    expect((await runCliSubprocess([])).code).toBe(1);
  });
});
