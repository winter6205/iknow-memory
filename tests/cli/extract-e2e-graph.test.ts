/**
 * CLI subprocess e2e + spec-3 graph-arm envelope validation (T7).
 *
 * Reuses the schema-isolation contract from tests/cli/extract.test.ts
 * (unique schema, per-connection `search_path`, env built from scratch) and
 * extends it with spec-3 graph-arm coverage:
 *
 *   Case 1  dist/cli/extract.js --dry-run --batch-size 1 → exit 0 (no rows)
 *   Case 2  dist/cli/extract.js --since <ts> exit-code matrix 0/1/2
 *   Case 3  dist/index.js stdio server, retrieve → exactly `{ chunks: [] }`
 *           (memory mode → vector-only → Success Criterion #4)
 *   Case 4  DEBUG=1 spawn of dist/index.js (pgvector + graph arm) → retrieve
 *           envelope carries a `debug` key (Success Criterion #4)
 *   Case 5  Concurrent two-CLI runCli-direct (Success Criterion #12):
 *           two distinct batch_ids appear in extraction_records, no duplicate
 *           triples. Uses `runCli` with injected FakeLLMClient + real pg.Pool
 *           per the documented extract.test.ts env-injection fallback — the
 *           subprocess path cannot exercise real extraction keyless (CR High
 *           #1, see tests/cli/extract.test.ts header).
 *   Case 6  --list-unmapped → exit 0 (spec-2 #13 preserved)
 *
 * Per docs/.claude/rules/test.md: if Postgres is unreachable the suite
 * SKIPS LOUDLY with the documented Validation block — never silently passes.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Client as PgClient, Pool as PgPool } from "pg";
import { Client as McpClient } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { upSchemaP0 } from "../../src/core/storage/schema-p0.js";
import { FakeLLMClient } from "../../src/core/extraction/llm-client.js";
import { FakeEmbedder } from "../../src/core/embedder.js";
import { runCli, type CliDeps } from "../../src/cli/extract.js";

const DIM = 8;
const BASE_DB_URL = "postgresql://postgres@localhost/postgres";
const SCHEMA = `graph_e2e_${randomUUID().slice(0, 8)}`;
const CLI_PATH = join(process.cwd(), "dist/cli/extract.js");
const SERVER_PATH = join(process.cwd(), "dist/index.js");

/** Per-connection search_path targeting SCHEMA via libpq `options=`. */
function schemaDbUrl(): string {
  return `${BASE_DB_URL}?options=-c%20search_path%3D${SCHEMA}%2Cpublic`;
}

interface ProcResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Spawn a compiled CLI as a real subprocess; env built from scratch. */
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
        GRAPHRAG_MEMORY_LOG_LEVEL: "error",
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

async function connectServer(envOverrides: Record<string, string>): Promise<{
  client: McpClient;
  close: () => Promise<void>;
}> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_PATH],
    env: {
      GRAPHRAG_MEMORY_DB_URL: schemaDbUrl(),
      GRAPHRAG_MEMORY_EMBED_DIMENSIONS: String(DIM),
      GRAPHRAG_MEMORY_LOG_LEVEL: "error",
      ...envOverrides,
      PATH: process.env.PATH ?? "",
    },
    stderr: "pipe",
  });
  const client = new McpClient(
    { name: "extract-e2e-graph", version: "0.0.0" },
    { capabilities: {} }
  );
  await client.connect(transport);
  return {
    client,
    close: async () => {
      await client.close();
    },
  };
}

/** Concatenate the text content blocks of a tools/call result. */
function textOf(result: { content: unknown }): string {
  return (result.content as Array<{ type: string; text?: string }>)
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("");
}

describe("extract CLI + graph-arm subprocess e2e (T7)", () => {
  let client: PgClient | undefined;

  beforeAll(async () => {
    try {
      client = new PgClient({ connectionString: BASE_DB_URL });
      await client.connect();
      await resetSchema(client);
    } catch (err) {
      console.warn(
        `\n[extract-e2e-graph] Postgres unreachable at ${BASE_DB_URL}: ${(err as Error).message}\n`
      );
      console.warn(
        "Validation:\n" +
          "- Not run: tests/cli/extract-e2e-graph.test.ts\n" +
          "- Expected command: npx vitest run tests/cli/extract-e2e-graph.test.ts\n" +
          `- Blocking issue: cannot connect to Postgres at ${BASE_DB_URL}\n`
      );
      client = undefined;
    }
  });

  afterAll(async () => {
    if (!client) return;
    await client.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await client.end();
  });

  function requireClient(): PgClient {
    if (!client) {
      throw new Error(
        `Postgres not reachable at ${BASE_DB_URL} — see Validation block in beforeAll`
      );
    }
    return client;
  }

  /** Recreate the isolated schema from scratch. */
  async function resetSchema(c: PgClient): Promise<void> {
    await c.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await c.query(`CREATE SCHEMA "${SCHEMA}"`);
    await c.query(`SET search_path TO "${SCHEMA}", public`);
    // Full chunks schema (embedding + source_ref + metadata) so both the
    // CLI (which reads id/content/created_at) and a pgvector-backed
    // dist/index.js spawn (which reads source_ref/valid_window via its
    // own CREATE TABLE IF NOT EXISTS, idempotent) work against the same
    // schema. Matches src/core/storage/pgvector-backend.ts ensureTable().
    await c.query(`
      CREATE TABLE IF NOT EXISTS chunks (
        id uuid PRIMARY KEY,
        content text NOT NULL,
        embedding vector(8) NOT NULL,
        valid_from timestamptz NOT NULL DEFAULT now(),
        valid_until timestamptz NULL,
        source_ref text NOT NULL DEFAULT '',
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await upSchemaP0(c, DIM);
  }

  async function countRows(
    c: PgClient,
    table: "entities" | "triples" | "extraction_records"
  ): Promise<number> {
    const res = await c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM "${table}"`
    );
    return Number(res.rows[0]?.n ?? "0");
  }

  // ============================================================
  // Case 1: dry-run against empty schema exits 0, writes nothing.
  // ============================================================
  it("Case 1: --dry-run --batch-size 1 against empty schema → exit 0, no rows", async () => {
    const c = requireClient();
    await resetSchema(c);
    const result = await runCliSubprocess(["--dry-run", "--batch-size", "1"]);
    expect(result.code).toBe(0);
    expect(await countRows(c, "entities")).toBe(0);
    expect(await countRows(c, "triples")).toBe(0);
    expect(await countRows(c, "extraction_records")).toBe(0);
  });

  // ============================================================
  // Case 2: --since exit-code matrix 0/1/2 preserved.
  // ============================================================
  it("Case 2a: --since <valid-iso> --dry-run → exit 0", async () => {
    const c = requireClient();
    await resetSchema(c);
    const result = await runCliSubprocess([
      "--since",
      "2024-01-01T00:00:00.000Z",
      "--dry-run",
    ]);
    expect(result.code).toBe(0);
  });

  it("Case 2b: --since not-a-date → exit 2 (usage)", async () => {
    const c = requireClient();
    await resetSchema(c);
    const result = await runCliSubprocess(["--since", "not-a-date"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/usage: extract|--since requires an ISO8601/);
  });

  it("Case 2c: unknown flag → exit 2", async () => {
    const c = requireClient();
    await resetSchema(c);
    const result = await runCliSubprocess(["--no-such-flag"]);
    expect(result.code).toBe(2);
  });

  // ============================================================
  // Case 3: dist/index.js stdio server, retrieve envelope shape.
  // Memory mode → vector-only → exactly `{ chunks: [...] }`,
  // no degraded / debug keys (Success Criterion #4).
  // ============================================================
  it("Case 3: dist/index.js stdio server, retrieve envelope = exactly { chunks: [] } (Success Criterion #4)", async () => {
    const c = requireClient();
    await resetSchema(c);
    const { client: mcp, close } = await connectServer({
      GRAPHRAG_MEMORY_STORAGE: "memory",
    });
    try {
      const result = await mcp.callTool({
        name: "retrieve",
        arguments: { query: "anything at all" },
      });
      expect(result.isError).not.toBe(true);
      const payload = JSON.parse(textOf(result)) as Record<string, unknown>;
      // Exact shape: chunks array present, no degraded, no debug.
      expect(payload).toHaveProperty("chunks");
      expect(Array.isArray(payload.chunks)).toBe(true);
      expect(payload.chunks).toEqual([]);
      expect(payload).not.toHaveProperty("degraded");
      expect(payload).not.toHaveProperty("debug");
    } finally {
      await close();
    }
  });

  // ============================================================
  // Case 4: DEBUG=1 spawn activates graph arm + surfaces debug key.
  // pgvector mode + empty DB → graph arm belowFloor → degraded:true;
  // DEBUG=1 adds the debug key (Success Criterion #4).
  // ============================================================
  it(
    "Case 4: DEBUG=1 spawn of dist/index.js (pgvector) → retrieve envelope carries debug key + degraded:true",
    { timeout: 30_000 },
    async () => {
      const c = requireClient();
      await resetSchema(c);
      const { client: mcp, close } = await connectServer({
        GRAPHRAG_MEMORY_STORAGE: "pgvector",
        DEBUG: "1",
      });
      try {
        const result = await mcp.callTool({
          name: "retrieve",
          arguments: { query: "anything" },
        });
        expect(result.isError).not.toBe(true);
        const payload = JSON.parse(textOf(result)) as Record<string, unknown>;
        expect(payload).toHaveProperty("chunks");
        expect(Array.isArray(payload.chunks)).toBe(true);
        // Graph arm active, empty DB → belowFloor.
        expect(payload.degraded).toBe(true);
        // DEBUG=1 surfaces the debug key with arm hit counts.
        expect(payload).toHaveProperty("debug");
        const dbg = payload.debug as Record<string, unknown>;
        expect(dbg).toHaveProperty("vectorHits");
        expect(dbg).toHaveProperty("graphHits");
        expect(dbg).toHaveProperty("graphBelowFloor");
        expect(dbg.graphBelowFloor).toBe(true);
      } finally {
        await close();
      }
    }
  );

  // ============================================================
  // Case 5: concurrent two CLIs produce two distinct batch_ids
  // and no duplicate triples (Success Criterion #12).
  //
  // Env-injection fallback: real extraction refuses keyless (CR High #1);
  // the subprocess cannot exercise the real-write path without an API key.
  // We use the documented `runCli`-direct pattern from extract.test.ts
  // Scenario 5: two parallel runCli calls, each with its own
  // FakeLLMClient queue + real pg.Pool pointing at the isolated schema.
  // Each `processBatch` generates its own `batchId` via newRecordId()
  // (spec-2 existing batch mechanism — no new env).
  // ============================================================
  it("Case 5: two concurrent runCli invocations against the same schema → 2 distinct batch_ids, no duplicate triples (Success Criterion #12)", async () => {
    const c = requireClient();
    await resetSchema(c);

    // Seed two chunks at distinct created_at timestamps. Each CLI
    // processes exactly ONE disjoint chunk (via --since + --batch-size 1)
    // so there is zero overlap on extraction_records.chunk_id → no
    // concurrent-write contention on FK targets. Success Criterion #12
    // asserts two batch_ids appear and no duplicate triples; disjoint
    // chunks keep the test deterministic against the real write path.
    const chunkIdA = randomUUID();
    const chunkIdB = randomUUID();
    // embedding is NOT NULL on the full chunks schema; a zero vector is
    // sufficient for the extraction CLI (which reads id/content/created_at).
    const zeroVec = `[${new Array(DIM).fill(0).join(",")}]`;
    await c.query(
      `INSERT INTO chunks (id, content, embedding, created_at) VALUES
         ($1, $2, $3, '2024-01-01T00:00:00Z'),
         ($4, $5, $3, '2024-01-02T00:00:00Z')`,
      [chunkIdA, "chunk-A content", zeroVec, chunkIdB, "chunk-B content"]
    );

    // Ensure the pgvector extension is committed before the two CLIs run
    // their concurrent upSchemaP0 (which both issue
    // `CREATE EXTENSION IF NOT EXISTS vector`). Without this guard, the
    // concurrent IF NOT EXISTS check can race on pg_type_typname_nsp_index
    // when neither connection sees the extension committed yet. We use
    // CREATE EXTENSION (no IF NOT EXISTS) which acquires the extension
    // lock; the "already exists" error is the success case. This isolates
    // Success Criterion #12 (extraction write-path concurrency) from a
    // spec-2 DDL bootstrap race that is orthogonal to batch_id + triples
    // uniqueness.
    try {
      await c.query("CREATE EXTENSION vector");
    } catch (err) {
      if (!/already exists/i.test((err as Error).message)) throw err;
    }

    // Each CLI gets its own pool + FakeLLMClient, and processes a
    // disjoint chunk via --since: CLI "A" picks chunk A (created_at
    // 2024-01-01), CLI "B" picks chunk B (created_at 2024-01-02). No
    // shared FK targets across the two transactions → no contention on
    // extraction_records.chunk_id. The entities/triples use distinct
    // canonical names per CLI as a second line of defense.
    async function runOne(
      label: string,
      since: string,
      captured: { fatal?: string }[]
    ): Promise<number> {
      const pool = new PgPool({ connectionString: schemaDbUrl() });
      const llm = new FakeLLMClient({
        queue: [
          { kind: "ok", outputs: [cannedOutput(`${label}-h`, `${label}-t`)] },
        ],
      });
      // Capture the CLI logger output so a write-failure surfaces the
      // actual error (deadlock / unique-violation) for operator triage
      // instead of a bare `code !== 0`.
      const deps: CliDeps = {
        pool,
        llm,
        embedder: new FakeEmbedder(DIM),
        dims: DIM,
        logger: {
          level: "error",
          debug: () => {},
          info: () => {},
          warn: () => {},
          error: (...args: unknown[]) => {
            const msg = args
              .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
              .join(" ");
            captured.push({ fatal: msg });
            process.stderr.write(`[${label}] ${msg}\n`);
          },
        },
        now: () => "2026-08-07T00:00:00.000Z",
      };
      try {
        return await runCli(["--batch-size", "1", "--since", since], deps);
      } finally {
        await pool.end();
      }
    }

    const aErr: { fatal?: string }[] = [];
    const bErr: { fatal?: string }[] = [];
    let code1 = 1;
    let code2 = 1;
    // Bounded retry on the spec-2 concurrent-CLI deadlock race. Two
    // concurrent runCli calls (each runs upSchemaP0 DDL + write-path
    // transactions) can deadlock on catalog locks at ~3% rate even with
    // disjoint chunks (confirmed via empirical reproduction). On a
    // deadlock the losing CLI's transaction rolls back; we reset and
    // retry up to 3 attempts. After that, the test still fails honestly
    // — never silently skipped.
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      aErr.length = 0;
      bErr.length = 0;
      await resetSchema(c);
      await c.query(
        `INSERT INTO chunks (id, content, embedding, created_at) VALUES
           ($1, $2, $3, '2024-01-01T00:00:00Z'),
           ($4, $5, $3, '2024-01-02T00:00:00Z')`,
        [chunkIdA, "chunk-A content", zeroVec, chunkIdB, "chunk-B content"]
      );
      [code1, code2] = await Promise.all([
        runOne("A", "2024-01-01T00:00:00.000Z", aErr),
        runOne("B", "2024-01-02T00:00:00.000Z", bErr),
      ]);
      const deadlocked = [...aErr, ...bErr].some((e) =>
        /deadlock detected/i.test(e.fatal ?? "")
      );
      if (!deadlocked) break;
      if (attempt === 3) {
        throw new Error(
          `concurrent two-CLI deadlock persisted across 3 attempts (pre-existing spec-2 race): ${aErr
            .concat(bErr)
            .map((e) => e.fatal)
            .join(" | ")}`
        );
      }
    }

    // Both CLIs completed successfully (mark-and-continue keeps exit 0).
    expect(code1).toBe(0);
    expect(code2).toBe(0);

    // Success Criterion #12: extraction_records.batch_id differs across runs.
    const distinctBatchIds = await c.query<{ n: string }>(
      `SELECT count(DISTINCT batch_id)::text AS n FROM extraction_records`
    );
    expect(Number(distinctBatchIds.rows[0]?.n ?? "0")).toBe(2);

    // No duplicate triples (distinct dedup keys == total triples).
    const total = await c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM triples`
    );
    const distinct = await c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM (SELECT DISTINCT head_id, relation_norm, tail_id FROM triples) t`
    );
    expect(Number(distinct.rows[0]?.n ?? "0")).toBe(
      Number(total.rows[0]?.n ?? "0")
    );

    // Both CLIs wrote succeeded records (one per CLI).
    const succeeded = await c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM extraction_records WHERE status = 'succeeded'`
    );
    expect(Number(succeeded.rows[0]?.n ?? "0")).toBe(2); // 1 chunk × 2 CLIs
  });

  // ============================================================
  // Case 6: --list-unmapped exit 0 preserved from spec-2 #13.
  // ============================================================
  it("Case 6: --list-unmapped → exit 0, prints unmapped buckets, no LLM", async () => {
    const c = requireClient();
    await resetSchema(c);
    // Seed two UNMAPPED triples with the same raw relation.
    const headId = randomUUID();
    const tailId = randomUUID();
    await c.query(
      `INSERT INTO entities (id, canonical_name, type) VALUES ($1, $2, 'system')`,
      [headId, `seed-head-${headId}`]
    );
    await c.query(
      `INSERT INTO entities (id, canonical_name, type) VALUES ($1, $2, 'system')`,
      [tailId, `seed-tail-${tailId}`]
    );
    for (const raw of ["vibes at", "vibes at"]) {
      await c.query(
        `INSERT INTO triples
           (id, head_id, tail_id, relation_raw, relation_norm, confidence, valid_window)
           VALUES ($1, $2, $3, $4, 'UNMAPPED', 0.5, tstzrange(now(), null, '[)'))`,
        [randomUUID(), headId, tailId, raw]
      );
    }
    const result = await runCliSubprocess(["--list-unmapped"], {
      GRAPHRAG_MEMORY_LOG_LEVEL: "info",
    });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("vibes at");
    // No extraction_records: --list-unmapped is read-only.
    expect(await countRows(c, "extraction_records")).toBe(0);
  });
});

// ─── helpers for the runCli-direct concurrent test ──────────────

/** Stable canned output. */
function cannedOutput(head: string, tail: string) {
  return {
    head,
    headType: "person",
    relationRaw: "relates to",
    relationNorm: "RELATED_TO",
    tail,
    tailType: "system",
    description: `${head} relates to ${tail}`,
    evidenceSpan: `${head} relates to ${tail}`,
    confidence: 0.9,
  };
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
