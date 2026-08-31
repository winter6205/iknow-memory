/**
 * extract-backfill-pg: real-Postgres coverage for T6 — the `--backfill-embeddings`
 * idempotent repair mode (G1 backfill / A9 / SC5).
 *
 *   SC5 — with N pre-existing NULL-embedding live entities the flag exits 0 and
 *         leaves 0 NULLs; an immediate second run reports 0 backfilled.
 *
 * The repair runs go through `runCli` with an injected `CliDeps` (real
 * `pg.Pool` + FakeEmbedder + a throwing FakeLLMClient) rather than a keyless
 * subprocess. `--backfill-embeddings` PERSISTS vectors, so CR High #3 makes a
 * keyless env-built run a ConfigError (exit 1): FakeEmbedder is legal here
 * only because the deps are injected, which is the documented fallback
 * tests/cli/extract.test.ts already uses for scripted LLM output. The injected
 * FakeEmbedder is deterministic, so the persisted vector is still asserted
 * component-wise against the #6 Q1 SSOT text.
 *
 * The keyless subprocess still appears once, as the CR High #3 regression: a
 * child env with no embedding credentials must exit 1 and write nothing.
 *
 * Harness mirrors tests/integration/extract-persist-pg.test.ts: a unique schema
 * reached through the libpq `options=-c search_path=<schema>,public` startup
 * string, so the parallel schema-p0 worker cannot race these rows.
 *
 * Per .claude/rules/test.md: if Postgres is unreachable the suite SKIPS LOUDLY
 * — a top-level probe flips it to `describe.skip` and prints the documented
 * Validation block, the same shape tests/integration/retrieval-pg.test.ts
 * uses. It never silently passes, and it never reports an unreachable
 * database as a test failure.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FakeEmbedder } from "../../src/core/embedder.js";
import { computeEntityEmbeddingText } from "../../src/core/entities/embedding.js";
import { FakeLLMClient } from "../../src/core/extraction/llm-client.js";
import { upSchemaP0 } from "../../src/core/storage/schema-p0.js";
import { runCli, type CliDeps } from "../../src/cli/extract.js";
import { warnPgUnavailable } from "./pg-test-harness.js";

const DIM = 8;
const ANN_MAX_DIMENSIONS = 2000;
const BASE_DB_URL = "postgresql://postgres@localhost/postgres";
const SCHEMA = `extract_backfill_${randomUUID().slice(0, 8)}`;
const CLI_PATH = join(process.cwd(), "dist/cli/extract.js");
const ANN_MAX_DIMENSIONS_VAR = "GRAPHRAG_MEMORY_PGVECTOR_ANN_MAX_DIMENSIONS";
const savedAnnMaxDimensions = process.env[ANN_MAX_DIMENSIONS_VAR];

/** Per-connection search_path targeting SCHEMA via the libpq `options=` string. */
function schemaDbUrl(): string {
  return `${BASE_DB_URL}?options=-c%20search_path%3D${SCHEMA}%2Cpublic`;
}

interface ProcResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Spawn the compiled CLI; the child env carries no parent GRAPHRAG_* keys. */
function runCliSubprocess(args: string[]): Promise<ProcResult> {
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
        GRAPHRAG_MEMORY_PGVECTOR_ANN_MAX_DIMENSIONS: String(ANN_MAX_DIMENSIONS),
        GRAPHRAG_MEMORY_LOG_LEVEL: "info",
        PATH: process.env.PATH ?? "",
        // Present-but-blank beats `.env.local` (same seam as host-smoke).
        GRAPHRAG_MEMORY_EMBED_API_KEY: "",
        GRAPHRAG_MEMORY_EMBED_API_KEY_ENV: "",
        NINE_ROUTER_KEY: "",
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

interface RunSummary {
  code: number;
  scanned: number;
  backfilled: number;
}

/** The `{ scanned, backfilled }` fields of the run's summary log line. */
function summaryFields(
  lines: Array<{ msg: string; fields?: Record<string, unknown> }>
): { scanned: number; backfilled: number } {
  const line = lines.find((l) => l.msg === "backfill-embeddings-complete");
  if (!line) {
    throw new Error("run output has no backfill-embeddings-complete line");
  }
  return line.fields as unknown as { scanned: number; backfilled: number };
}

/**
 * One `--backfill-embeddings` run against the isolated schema, through the
 * injected-deps path. The LLM fake throws: the repair mode must never call it.
 */
async function runBackfill(): Promise<RunSummary> {
  const lines: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
  const pool = new pg.Pool({ connectionString: schemaDbUrl() });
  const deps: CliDeps = {
    pool,
    llm: new FakeLLMClient({
      scripted: async () => {
        throw new Error("--backfill-embeddings must not call the LLM");
      },
    }),
    embedder: new FakeEmbedder(DIM),
    dims: DIM,
    logger: {
      level: "info",
      debug: () => {},
      info: (msg: string, fields?: Record<string, unknown>) =>
        void lines.push({ msg, fields }),
      warn: () => {},
      error: () => {},
    },
  };
  let code: number;
  try {
    code = await runCli(["--backfill-embeddings"], deps);
  } finally {
    await pool.end();
  }
  return { code, ...summaryFields(lines) };
}

interface SeedEntity {
  id: string;
  canonicalName: string;
  description: string;
  /** null seeds a row with no `description` key at all (A9 empty-string leg). */
  metadata: string | null;
  retired?: boolean;
  embedding?: string;
}

/** Three live NULL-embedding rows: with, without, and NULL metadata. */
function nullEmbeddingSeeds(): SeedEntity[] {
  return [
    {
      id: randomUUID(),
      canonicalName: "Alice Smith",
      description: "Alice Smith works at Acme Corp",
      metadata: JSON.stringify({
        description: "Alice Smith works at Acme Corp",
      }),
    },
    {
      id: randomUUID(),
      canonicalName: "Acme Corp",
      description: "",
      metadata: JSON.stringify({}),
    },
    {
      id: randomUUID(),
      canonicalName: "Bob Jones",
      description: "",
      metadata: null,
    },
  ];
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
    label: "extract-backfill-pg",
    testPath: "tests/integration/extract-backfill-pg.test.ts",
    expectedCommand:
      "npx vitest run tests/integration/extract-backfill-pg.test.ts",
    connectionString: BASE_DB_URL,
    error: err,
    requiresVector: false,
  });
}
const describePg = PG_AVAILABLE ? describe : describe.skip;

describePg("extract-backfill-pg: --backfill-embeddings (T6 / SC5)", () => {
  let client: pg.Client | undefined;

  beforeAll(async () => {
    process.env[ANN_MAX_DIMENSIONS_VAR] = String(ANN_MAX_DIMENSIONS);
    client = new pg.Client({ connectionString: BASE_DB_URL });
    await client.connect();
    // pgvector lives in `public` so the per-test schema's vector(N) columns
    // resolve through the search_path.
    await client.query("CREATE EXTENSION IF NOT EXISTS vector");
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
    // triples carries an FK to chunks, so chunks must pre-exist.
    await c.query(`
      CREATE TABLE IF NOT EXISTS chunks (
        id uuid PRIMARY KEY,
        content text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await upSchemaP0(c, DIM, ANN_MAX_DIMENSIONS);
  }

  async function seedEntity(c: pg.Client, entity: SeedEntity): Promise<void> {
    await c.query(
      `INSERT INTO entities (id, canonical_name, type, embedding, metadata, retired)
       VALUES ($1, $2, 'person', $3::vector, $4::jsonb, $5)`,
      [
        entity.id,
        entity.canonicalName,
        entity.embedding ?? null,
        entity.metadata,
        entity.retired ?? false,
      ]
    );
  }

  async function liveNullCount(c: pg.Client): Promise<number> {
    const res = await c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM entities
        WHERE retired = false AND embedding IS NULL`
    );
    return Number(res.rows[0]?.n ?? "-1");
  }

  /** Stored vectors of `ids`, in order; a NULL column reads back as null. */
  async function storedVectors(
    c: pg.Client,
    ids: string[]
  ): Promise<Array<number[] | null>> {
    const out: Array<number[] | null> = [];
    for (const id of ids) out.push(await storedVector(c, id));
    return out;
  }

  /** Stored vector of one entity, parsed; null when the column is NULL. */
  async function storedVector(
    c: pg.Client,
    id: string
  ): Promise<number[] | null> {
    const res = await c.query<{ embedding: string | null }>(
      `SELECT embedding::text AS embedding FROM entities WHERE id = $1`,
      [id]
    );
    const raw = res.rows[0]?.embedding ?? null;
    return raw === null ? null : (JSON.parse(raw) as number[]);
  }

  /**
   * pgvector stores float4, so the round-trip loses the tail of the float8
   * the embedder produced — compare component-wise, not by literal equality.
   */
  function expectVectorClose(
    actual: number[] | null,
    expected: number[]
  ): void {
    expect(actual).not.toBeNull();
    expect(actual).toHaveLength(expected.length);
    for (let i = 0; i < expected.length; i += 1) {
      expect(actual![i]).toBeCloseTo(expected[i]!, 5);
    }
  }

  // -----------------------------------------------------------------
  // SC5 (first half): N NULLs in, 0 NULLs out, exit 0.
  // -----------------------------------------------------------------
  it("SC5: N NULL-embedding live entities → exits 0 and leaves 0 NULLs", async () => {
    const c = client!;
    await resetSchema(c);
    const seeds = nullEmbeddingSeeds();
    for (const seed of seeds) await seedEntity(c, seed);
    expect(await liveNullCount(c)).toBe(seeds.length);

    const run = await runBackfill();

    expect(run.code).toBe(0);
    expect(await liveNullCount(c)).toBe(0);
    expect({ scanned: run.scanned, backfilled: run.backfilled }).toEqual({
      scanned: seeds.length,
      backfilled: seeds.length,
    });

    // Each vector is the #6 Q1 SSOT text embedded once — including the two
    // rows whose description is absent, which embed against "" (A9).
    const embedder = new FakeEmbedder(DIM);
    for (const seed of seeds) {
      const [expected] = await embedder.embed([
        computeEntityEmbeddingText(seed.canonicalName, seed.description),
      ]);
      expectVectorClose(await storedVector(c, seed.id), expected!);
    }
  });

  // -----------------------------------------------------------------
  // SC5 (second half): an immediate second run reports 0 backfilled and
  // leaves every vector byte-for-byte where the first run put it.
  // -----------------------------------------------------------------
  it("SC5: an immediate second run reports 0 backfilled and rewrites nothing", async () => {
    const c = client!;
    await resetSchema(c);
    const seeds = nullEmbeddingSeeds();
    for (const seed of seeds) await seedEntity(c, seed);

    const first = await runBackfill();
    expect(first.code).toBe(0);
    expect(first.backfilled).toBe(seeds.length);
    const ids = seeds.map((s) => s.id);
    const afterFirst = await storedVectors(c, ids);

    const second = await runBackfill();

    expect(second.code).toBe(0);
    expect({ scanned: second.scanned, backfilled: second.backfilled }).toEqual({
      scanned: 0,
      backfilled: 0,
    });
    expect(await liveNullCount(c)).toBe(0);
    expect(await storedVectors(c, ids)).toEqual(afterFirst);
  });

  // -----------------------------------------------------------------
  // A9 fence: only live NULL rows are touched. A retired NULL row stays
  // NULL, and an already-embedded row keeps its first-write-wins vector.
  // -----------------------------------------------------------------
  it("leaves retired NULL rows and already-embedded rows untouched", async () => {
    const c = client!;
    await resetSchema(c);
    const retired: SeedEntity = {
      id: randomUUID(),
      canonicalName: "Retired Entity",
      description: "",
      metadata: JSON.stringify({ description: "retired" }),
      retired: true,
    };
    const preEmbedded: SeedEntity = {
      id: randomUUID(),
      canonicalName: "Already Embedded",
      description: "",
      metadata: JSON.stringify({ description: "already embedded" }),
      embedding: `[${new Array(DIM).fill(0.125).join(",")}]`,
    };
    await seedEntity(c, retired);
    await seedEntity(c, preEmbedded);

    const run = await runBackfill();

    expect(run.code).toBe(0);
    expect({ scanned: run.scanned, backfilled: run.backfilled }).toEqual({
      scanned: 0,
      backfilled: 0,
    });
    expect(await storedVector(c, retired.id)).toBeNull();
    expectVectorClose(
      await storedVector(c, preEmbedded.id),
      new Array(DIM).fill(0.125)
    );
  });

  // -----------------------------------------------------------------
  // CR High #3: the repair mode PERSISTS vectors, so a keyless env-built
  // run must refuse with a ConfigError rather than fill every row with
  // FakeEmbedder output no real embedder can be compared against.
  // -----------------------------------------------------------------
  it("keyless --backfill-embeddings exits 1 and writes nothing (CR High #3)", async () => {
    const c = client!;
    await resetSchema(c);
    const seeds = nullEmbeddingSeeds();
    for (const seed of seeds) await seedEntity(c, seed);

    const result = await runCliSubprocess(["--backfill-embeddings"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "refusing to persist embeddings without embedding credentials"
    );
    expect(await liveNullCount(c)).toBe(seeds.length);
  });

  // -----------------------------------------------------------------
  // The repair mode is its own flag: a normal extraction run never
  // backfills (A9), and the inherited exit-code map is unregressed.
  // -----------------------------------------------------------------
  it("a normal extraction run leaves the NULL rows alone", async () => {
    const c = client!;
    await resetSchema(c);
    const seeds = nullEmbeddingSeeds();
    for (const seed of seeds) await seedEntity(c, seed);

    // Keyless, so a real extraction refuses with exit 1 (CR High #1); the
    // keyless report flags still exit 0. Neither may backfill.
    expect((await runCliSubprocess([])).code).toBe(1);
    expect((await runCliSubprocess(["--dry-run"])).code).toBe(0);
    expect((await runCliSubprocess(["--list-unmapped"])).code).toBe(0);
    expect((await runCliSubprocess(["--no-such-flag"])).code).toBe(2);

    expect(await liveNullCount(c)).toBe(seeds.length);
  });
});
