/**
 * CLI subprocess e2e for `node dist/cli/extract.js` (T9).
 *
 * Spawns the compiled CLI as a real subprocess (node:child_process.spawn)
 * against a unique-schema Postgres harness, asserts real exit codes, and
 * counts rows it writes. Coverage maps to specs/p0-extraction.md
 *   - Testing Strategy "CLI" row (subprocess spawn + exit codes).
 *   - Success Criteria #5 (≥1 entities / ≥1 triples / 1 succeeded record).
 *   - Success Criteria #6 (4 ok + 1 failed; exit 0; mark-and-continue).
 *   - Success Criteria #13 (`--list-unmapped` groups by raw, exit 0, no LLM).
 * Plus the three documented exit codes (0 success, 2 usage, 1 fatal).
 *
 * Why a unique schema (mirrors tests/integration/extraction-pg.test.ts):
 * the parallel schema-p0.test.ts worker drops/recreates P0 tables in the
 * `public` schema. Bare-name SQL in the pipeline resolves through the
 * per-connection `search_path`, so we point our subprocess's pg.Pool at the
 * isolated schema via the libpq `options=-c search_path=<schema>,public`
 * startup string — verified empirically against the same Postgres 16 the
 * other suites use.
 *
 * Keyless real-run refusal (CR High #1): T6's `buildLlm()` throws
 * ConfigError for a real extraction when ANTHROPIC_AUTH_TOKEN is
 * unset; the `FakeLLMClient` (scripted ok) is only reachable behind `--dry-run`
 * / `--list-unmapped` or via direct `runCli` injection. There is no env hook
 * (e.g. no GRAPHRAG_MEMORY_TEST_FAKE_OUTPUTS) to inject a custom queue or a
 * 5xx through the subprocess. So the subprocess cannot exercise Success
 * Criterion #6's "5xx on chunk 3" shape — that assertion is covered via the
 * `runCli`-direct unit-style path at the bottom of this file, using an
 * injected FakeLLMClient queue (4 ok + 1 5xx) and a scriptable fake pool
 * against the same real Postgres. Per the binding contract, this fallback
 * is the documented path for #6 when env injection is unavailable.
 *
 * Per docs/.claude/rules/test.md: if Postgres is unreachable the suite
 * SKIPS LOUDLY with the documented Validation block — never silently passes.
 *
 * Hard constraints respected: tests-only (no src/ changes), subprocess env
 * built from scratch (no parent GRAPHRAG_* leak), functions <=40 lines,
 * file <=500 lines.
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
import { listFailed } from "../../src/core/extraction/records.js";
import { runCli, type CliDeps } from "../../src/cli/extract.js";
import {
  redactPgConnectionString,
  warnPgUnavailable,
} from "../integration/pg-test-harness.js";

const DIM = 8;
const BASE_DB_URL = "postgresql://postgres@localhost/postgres";
// Random suffix so parallel runs (CI sharding) never collide on schema name.
const SCHEMA = `extract_cli_e2e_${randomUUID().slice(0, 8)}`;
const CLI_PATH = join(process.cwd(), "dist/cli/extract.js");
const ANN_MAX_DIMENSIONS_VAR = "GRAPHRAG_MEMORY_PGVECTOR_ANN_MAX_DIMENSIONS";
const savedAnnMaxDimensions = process.env[ANN_MAX_DIMENSIONS_VAR];

/** Build a subprocess DB_URL whose per-connection search_path targets SCHEMA. */
function schemaDbUrl(): string {
  return `${BASE_DB_URL}?options=-c%20search_path%3D${SCHEMA}%2Cpublic`;
}

interface ProcResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Spawn the compiled CLI as a real subprocess. Env is built from scratch so
 * the parent's GRAPHRAG_MEMORY_* keys (esp. ANTHROPIC_API_KEY) cannot leak
 * into the child — the child must see exactly the env we hand it.
 */
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
        GRAPHRAG_MEMORY_LOG_LEVEL: "error",
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

describe("extract CLI subprocess e2e (T9)", () => {
  let client: pg.Client | undefined;

  beforeAll(async () => {
    process.env[ANN_MAX_DIMENSIONS_VAR] = "2000";
    // Per test.md: skip loudly (never silently pass) when Postgres is down.
    try {
      client = new pg.Client({ connectionString: BASE_DB_URL });
      await client.connect();
      await resetSchema(client);
    } catch (err) {
      warnPgUnavailable({
        label: "extract-cli-e2e",
        testPath: "tests/cli/extract.test.ts",
        expectedCommand: "npx vitest run tests/cli/extract.test.ts",
        connectionString: BASE_DB_URL,
        error: err,
        requiresVector: false,
      });
      client = undefined;
    }
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

  function requireClient(): pg.Client {
    if (!client) {
      throw new Error(
        `Postgres not reachable at ${redactPgConnectionString(BASE_DB_URL)} — see Validation block in beforeAll`
      );
    }
    return client;
  }

  /** Recreate the isolated schema from scratch so each test starts clean. */
  async function resetSchema(c: pg.Client): Promise<void> {
    await c.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await c.query(`CREATE SCHEMA "${SCHEMA}"`);
    await c.query(`SET search_path TO "${SCHEMA}", public`);
    // chunks must pre-exist — triples + extraction_records carry FKs to it.
    // created_at is required: the CLI's scanChunks orders by + filters on it
    // (the --since flag and the SELECT projection both reference it).
    await c.query(`
      CREATE TABLE IF NOT EXISTS chunks (
        id uuid PRIMARY KEY,
        content text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await upSchemaP0(c, DIM, 2000);
  }

  /** Insert one chunk row with a unique content string; returns its id. */
  async function insertChunk(c: pg.Client, content: string): Promise<string> {
    const id = randomUUID();
    await c.query(`INSERT INTO chunks (id, content) VALUES ($1, $2)`, [
      id,
      content,
    ]);
    return id;
  }

  async function countRows(
    c: pg.Client,
    table: "entities" | "triples" | "extraction_records"
  ): Promise<number> {
    const res = await c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM "${table}"`
    );
    return Number(res.rows[0]?.n ?? "0");
  }

  // -----------------------------------------------------------------
  // Scenario 1: empty DB → exit 0, zero rows. Uses --dry-run because a real
  // extraction now refuses to run keyless (CR High #1); dry-run exercises the
  // same pipeline shape without writes.
  // -----------------------------------------------------------------
  it("empty DB: --dry-run --batch-size 1 exits 0 with no rows written", async () => {
    const c = requireClient();
    await resetSchema(c);

    const result = await runCliSubprocess(["--dry-run", "--batch-size", "1"]);
    expect(result.code).toBe(0);
    expect(await countRows(c, "entities")).toBe(0);
    expect(await countRows(c, "triples")).toBe(0);
    expect(await countRows(c, "extraction_records")).toBe(0);
  });

  // -----------------------------------------------------------------
  // Scenario 2 (Success Criterion #5 — refusal half): a *real* extraction
  // without ANTHROPIC_AUTH_TOKEN must refuse to run, exit 1,
  // surface a typed ConfigError on stderr, and write ZERO rows (the canned
  // FakeLLMClient must NOT silently auto-fill the write path — CR High #1).
  //
  // The legacy "happy path writes" assertion used to live here: it relied
  // on the implicit canned fake being auto-selected, which is exactly the
  // production-data-corruption path the fix removes. Equivalent write-path
  // coverage now lives in `extract.unit.test.ts` (`runCli` + injected
  // FakeLLMClient + real pg.Pool via direct injection).
  // -----------------------------------------------------------------
  it("real extraction without API key refuses with ConfigError and writes nothing (CR High #1)", async () => {
    const c = requireClient();
    await resetSchema(c);
    await insertChunk(c, "Alice works at Acme Corp.");

    const result = await runCliSubprocess(["--batch-size", "1"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "refusing to run real extraction without ANTHROPIC_AUTH_TOKEN"
    );
    expect(result.stderr).toContain("extract config error");
    // Zero rows: the canned fake MUST NOT reach the write path.
    expect(await countRows(c, "entities")).toBe(0);
    expect(await countRows(c, "triples")).toBe(0);
    expect(await countRows(c, "extraction_records")).toBe(0);
  });

  // -----------------------------------------------------------------
  // Scenario 3: --dry-run exercises the pipeline shape but writes no rows.
  // -----------------------------------------------------------------
  it("--dry-run exits 0 and writes no rows", async () => {
    const c = requireClient();
    await resetSchema(c);
    await insertChunk(c, "Bob reports to Carol.");

    const result = await runCliSubprocess(["--dry-run", "--batch-size", "1"]);
    expect(result.code).toBe(0);
    expect(await countRows(c, "entities")).toBe(0);
    expect(await countRows(c, "triples")).toBe(0);
    expect(await countRows(c, "extraction_records")).toBe(0);
  });

  // -----------------------------------------------------------------
  // Scenario 4 (Success Criterion #13): --list-unmapped prints
  // relation_raw buckets, exit 0, no LLM call.
  // -----------------------------------------------------------------
  it("--list-unmapped (Success Criterion #13): prints raw buckets, exit 0, no LLM", async () => {
    const c = requireClient();
    await resetSchema(c);
    // Seed two UNMAPPED triples directly so the bucket grouping has data.
    const headId = randomUUID();
    const tailId = randomUUID();
    await c.query(
      `INSERT INTO entities (id, canonical_name, type) VALUES ($1, $2, 'person')`,
      [headId, `seed-head-${headId}`]
    );
    await c.query(
      `INSERT INTO entities (id, canonical_name, type) VALUES ($1, $2, 'system')`,
      [tailId, `seed-tail-${tailId}`]
    );
    for (const raw of [
      "mysteriously linked to",
      "mysteriously linked to",
      "vibes at",
    ]) {
      await c.query(
        `INSERT INTO triples
           (id, head_id, tail_id, relation_raw, relation_norm, confidence, valid_window)
           VALUES ($1, $2, $3, $4, 'UNMAPPED', 0.5, tstzrange(now(), null, '[)'))`,
        [randomUUID(), headId, tailId, raw]
      );
    }

    // LOG_LEVEL=info so the bucket lines surface on stderr.
    const result = await runCliSubprocess(["--list-unmapped"], {
      GRAPHRAG_MEMORY_LOG_LEVEL: "info",
    });
    expect(result.code).toBe(0);

    // Stderr carries the structured logger output (`relation_raw` + `count`).
    expect(result.stderr).toContain("mysteriously linked to");
    expect(result.stderr).toContain("vibes at");
    // `--list-unmapped` does NOT perform extraction — no records rows.
    expect(await countRows(c, "extraction_records")).toBe(0);
    // No new triples: the only triples are the three seeds we inserted.
    expect(await countRows(c, "triples")).toBe(3);
  });

  // -----------------------------------------------------------------
  // Scenario 5 (Success Criterion #6): 4 ok + 1 5xx, exit 0, 4 succeeded
  // + 1 failed in extraction_records, listFailed returns the failed one.
  //
  // Env-injection fallback (see file header): T6's buildLlm hard-wires a
  // scripted-ok fake — there is no env hook to inject a 5xx through the
  // subprocess. We exercise the same pipeline against the SAME real
  // Postgres harness by calling `runCli` directly with an injected
  // FakeLLMClient queue (4 ok + 1 5xx) and a real pg.Pool whose
  // connection URL carries the schema-scoped search_path. Because the
  // whole pipeline writes to the real DB, listFailed() can be asserted
  // against the actual rows — proving the mark-and-continue + exit-code
  // contract Success Criterion #6 owns.
  // -----------------------------------------------------------------
  it("failure isolation (Success Criterion #6): 4 ok + 1 5xx → exit 0, 4 succeeded + 1 failed", async () => {
    const c = requireClient();
    await resetSchema(c);

    // Seed 5 chunks; the FakeLLMClient queue pops one response per chunk.
    // Each chunk content carries its canned output's evidenceSpan
    // (`cN-h relates to cN-t`) so the persist gate (T3, SC7) does not drop
    // the triple this mark-and-continue test needs in the ledger.
    for (let i = 0; i < 5; i += 1) {
      await c.query(`INSERT INTO chunks (id, content) VALUES ($1, $2)`, [
        randomUUID(),
        `c${i}-h relates to c${i}-t`,
      ]);
    }

    const queue = [
      { kind: "ok" as const, outputs: [cannedOutput("c0-h", "c0-t")] },
      { kind: "ok" as const, outputs: [cannedOutput("c1-h", "c1-t")] },
      { kind: "ok" as const, outputs: [cannedOutput("c2-h", "c2-t")] },
      { kind: "ok" as const, outputs: [cannedOutput("c3-h", "c3-t")] },
      // 5th chunk: upstream 5xx — mark-and-continue absorbs it (#4 D4).
      { kind: "5xx" as const, message: "upstream 5xx" },
    ];
    const llm = new FakeLLMClient({ queue });

    const pool = new pg.Pool({ connectionString: schemaDbUrl() });
    const deps: CliDeps = {
      pool,
      llm,
      embedder: new FakeEmbedder(DIM),
      dims: DIM,
      logger: silentLogger(),
      now: () => "2026-08-07T00:00:00.000Z",
    };
    let code: number;
    try {
      code = await runCli(["--batch-size", "5"], deps);
    } finally {
      await pool.end();
    }

    // Per the CLI exit-code map (extract.ts header): mark-and-continue on
    // extraction failures keeps exit 0; exit 2 is reserved for write-partial.
    expect(code).toBe(0);

    // 5 records: 4 succeeded + 1 failed, written to the real DB.
    const statuses = await c.query<{ status: string }>(
      `SELECT status FROM extraction_records ORDER BY created_at`
    );
    expect(statuses.rows).toHaveLength(5);
    const ok = statuses.rows.filter((r) => r.status === "succeeded").length;
    const ko = statuses.rows.filter((r) => r.status === "failed").length;
    expect(ok).toBe(4);
    expect(ko).toBe(1);

    // listFailed() surfaces exactly the failed chunk (the 5xx one).
    const failed = await listFailed(c);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.status).toBe("failed");
    expect(failed[0]?.error_code).toBe("5xx");

    // T3 (SC8): grounded inserts persist `triples.evidence_span` — the real
    // column written by the real pipeline, not a fake client. The 5xx chunk
    // contributes none. The four ok chunks' triples share one dedup key
    // (their entities L3-merge into one head and one tail survivor), so a
    // single surviving row is expected — it must carry the first chunk's
    // grounded span.
    const spans = await c.query<{ evidence_span: string | null }>(
      `SELECT evidence_span FROM triples`
    );
    expect(spans.rows.length).toBeGreaterThanOrEqual(1);
    for (const row of spans.rows) {
      expect(row.evidence_span).toMatch(/^c\d-h relates to c\d-t$/);
    }
  });

  // -----------------------------------------------------------------
  // Scenario 6: exit-code matrix 0/1/2 (subprocess, real env).
  // -----------------------------------------------------------------
  it("exit code 2 on an unknown flag (subprocess)", async () => {
    const c = requireClient();
    await resetSchema(c);
    const result = await runCliSubprocess(["--no-such-flag"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("unknown flag");
  });

  it("exit code 1 on a fatal config error (bad DB URL → ECONNREFUSED)", async () => {
    // Bad URL with closed port → Pool.connect throws → runCli catch → 1.
    const result = await runCliSubprocess(["--dry-run"], {
      GRAPHRAG_MEMORY_DB_URL:
        "postgresql://postgres@localhost:59999/postgres?connection_timeout=2",
    });
    expect(result.code).toBe(1);
  });

  it("exit code 0: --dry-run against a fresh schema is a successful no-op", async () => {
    const c = requireClient();
    await resetSchema(c);
    const result = await runCliSubprocess(["--dry-run"]);
    expect(result.code).toBe(0);
  });

  it("exit code 1: empty args (real extraction) refuses keyless with ConfigError", async () => {
    const c = requireClient();
    await resetSchema(c);
    const result = await runCliSubprocess([]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "refusing to run real extraction without ANTHROPIC_AUTH_TOKEN"
    );
  });
});

// ─── helpers for the runCli-direct failure-isolation test ──────────────

/** Stable canned output: distinct head/tail per call so entities create-new. */
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
