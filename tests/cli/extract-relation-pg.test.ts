/**
 * Real-Postgres coverage for the A10 relation-norm trust policy (T2 / SC8).
 *
 * The unit suite (tests/cli/extract.unit.test.ts) asserts the values the CLI
 * binds to `INSERT INTO triples`; this suite asserts what actually lands in
 * `triples.relation_norm` after a full `runCli` transaction against a real
 * schema, which is the wording SC8 uses ("the persisted
 * `triples.relation_norm` equals the vocabulary term").
 *
 * Harness contract mirrors tests/cli/extract.test.ts: a unique schema plus a
 * per-connection `search_path` (libpq `options=`), because the parallel
 * schema-bootstrap worker drops/recreates the ledger tables in `public`.
 *
 * The run is driven through `runCli` with an injected FakeLLMClient rather
 * than the compiled subprocess: a real extraction refuses to run keyless
 * (CR High #1) and there is no env hook to script LLM output — the same
 * documented fallback tests/cli/extract.test.ts uses for Success Criterion #6.
 *
 * Per docs/.claude/rules/test.md: if Postgres is unreachable the suite SKIPS
 * LOUDLY — a top-level probe flips the suite to `describe.skip` and prints the
 * documented Validation block, the same shape
 * tests/integration/retrieval-pg.test.ts uses. It never silently passes, and
 * it never reports an unreachable database as a test failure.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { upSchemaBootstrap } from "../../src/core/storage/schema-bootstrap.js";
import { FakeLLMClient } from "../../src/core/extraction/llm-client.js";
import { FakeEmbedder, type EmbeddingClient } from "../../src/core/embedder.js";
import { ALLOWED } from "../../src/core/extraction/vocabulary.js";
import { runCli, type CliDeps } from "../../src/cli/extract.js";
import { warnPgUnavailable } from "../integration/pg-test-harness.js";

const DIM = 8;
const BASE_DB_URL = "postgresql://postgres@localhost/postgres";
const SCHEMA = `extract_relation_${randomUUID().slice(0, 8)}`;
const ANN_MAX_DIMENSIONS_VAR = "GRAPHRAG_MEMORY_PGVECTOR_ANN_MAX_DIMENSIONS";
const savedAnnMaxDimensions = process.env[ANN_MAX_DIMENSIONS_VAR];

/** Per-connection search_path targeting SCHEMA via libpq `options=`. */
function schemaDbUrl(): string {
  return `${BASE_DB_URL}?options=-c%20search_path%3D${SCHEMA}%2Cpublic`;
}

/**
 * FakeEmbedder's derived vectors sit around cosine 0.75 for any pair of texts,
 * above the cascade's 0.7 embedding floor, so it cannot express "no cascade
 * hit". This double reserves axis 0 for the vocabulary terms and projects
 * every other text off that axis: cosine(raw, ALLOWED[i]) is exactly 0, while
 * entity texts keep FakeEmbedder's spread.
 */
class VocabAxisEmbedder implements EmbeddingClient {
  private readonly fake: FakeEmbedder;
  constructor(private readonly dimensions: number) {
    this.fake = new FakeEmbedder(dimensions);
  }
  async embed(texts: string[]): Promise<number[][]> {
    const derived = await this.fake.embed(texts);
    return texts.map((text, i) =>
      ALLOWED.includes(text.trim().toLowerCase())
        ? vocabAxis(this.dimensions)
        : offVocabAxis(derived[i]!)
    );
  }
}

function vocabAxis(dimensions: number): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  vector[0] = 1;
  return vector;
}

function offVocabAxis(vector: number[]): number[] {
  const projected = vector.map((v, i) => (i === 0 ? 0 : v));
  const norm = Math.hypot(...projected) || 1;
  return projected.map((v) => v / norm);
}

interface Output {
  head: string;
  headType: string;
  relationRaw: string;
  relationNorm: string;
  tail: string;
  tailType: string;
  description: string;
  evidenceSpan: string;
  confidence: number;
}

function output(
  head: string,
  raw: string,
  claim: string,
  tail: string
): Output {
  return {
    head,
    headType: "person",
    relationRaw: raw,
    relationNorm: claim,
    tail,
    tailType: "organization",
    description: `${head} ${raw} ${tail}`,
    evidenceSpan: `${head} ${raw} ${tail}`,
    confidence: 0.8,
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
    label: "extract-relation-pg",
    testPath: "tests/cli/extract-relation-pg.test.ts",
    expectedCommand: "npx vitest run tests/cli/extract-relation-pg.test.ts",
    connectionString: BASE_DB_URL,
    error: err,
    requiresVector: false,
  });
}
const describePg = PG_AVAILABLE ? describe : describe.skip;

describePg("persisted relation_norm follows the A10 trust policy (SC8)", () => {
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
    await c.query(`
      CREATE TABLE IF NOT EXISTS chunks (
        id uuid PRIMARY KEY,
        content text NOT NULL,
        source_ref text NOT NULL DEFAULT '',
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await upSchemaBootstrap(c, DIM, 2000);
  }

  /** Extract one chunk whose scripted output carries the given triples. */
  async function extractOutputs(outputs: Output[]): Promise<void> {
    const pool = new pg.Pool({ connectionString: schemaDbUrl() });
    const deps: CliDeps = {
      pool,
      llm: new FakeLLMClient({
        scripted: async () => ({ kind: "ok" as const, outputs }),
      }),
      embedder: new VocabAxisEmbedder(DIM),
      dims: DIM,
      logger: silentLogger(),
      now: () => "2026-08-07T00:00:00.000Z",
    };
    let code: number;
    try {
      code = await runCli(["--batch-size", "1"], deps);
    } finally {
      await pool.end();
    }
    expect(code).toBe(0);
  }

  it("maps a rejected claim, keeps a valid one, and never silently coerces", async () => {
    const c = client!;
    await resetSchema(c);
    // The chunk content must carry all three outputs' evidenceSpan
    // (`${head} ${raw} ${tail}`) or the persist gate — not the A10 cascade
    // this test exercises — would drop them.
    await c.query(`INSERT INTO chunks (id, content) VALUES ($1, $2)`, [
      randomUUID(),
      "Dana Lee works at Initech Ravi Patel mysteriously linked to Globex Mona Diaz works at Umbrella",
    ]);

    await extractOutputs([
      // SC8 case 1: claim outside ALLOWED, synonym-table hit on the raw form.
      output("Dana Lee", "works at", "WORKS_WITH", "Initech"),
      // SC8 case 2: claim outside ALLOWED, no cascade leg hits → sentinel.
      output("Ravi Patel", "mysteriously linked to", "WORKS_WITH", "Globex"),
      // SC8 case 3: claim inside ALLOWED — kept, not re-derived from the raw
      // form (which would have cascaded to `works_for`).
      output("Mona Diaz", "works at", "knows", "Umbrella"),
    ]);

    const rows = await c.query<{ relation_raw: string; relation_norm: string }>(
      `SELECT relation_raw, relation_norm FROM triples
       ORDER BY relation_raw, relation_norm`
    );
    expect(rows.rows).toEqual([
      { relation_raw: "mysteriously linked to", relation_norm: "UNMAPPED" },
      { relation_raw: "works at", relation_norm: "knows" },
      { relation_raw: "works at", relation_norm: "works_for" },
    ]);

    // The sentinel is a legal value the review surface can see (#4 D5/D7).
    const record = await c.query<{ unmapped_count: number }>(
      `SELECT unmapped_count FROM extraction_records WHERE status = 'succeeded'`
    );
    expect(record.rows).toHaveLength(1);
    expect(record.rows[0]?.unmapped_count).toBe(1);
  });
});
