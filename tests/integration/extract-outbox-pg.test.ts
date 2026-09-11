/**
 * extract-outbox-pg: real-Postgres proof of the T2 emit contract
 * (specs/neo4j-graph-arm.md SC1 + SC3).
 *
 *   SC1 — the extract CLI commits its ledger rows with no Neo4j anywhere in
 *         the environment. The projection is a downstream concern; a graph
 *         that is not running must never block the system of record.
 *   SC3 — the outbox intent and the ledger rows it describes share one
 *         transaction. Proven in both directions: a committed chunk leaves
 *         exactly one pending intent per touched subject, and a chunk whose
 *         emit fails leaves NEITHER the intent NOR the entities/triples.
 *
 * The failing-emit leg injects the failure the way production would hit it —
 * a database-side rejection on the INSERT — via a BEFORE INSERT trigger, so
 * the rollback under test is Postgres's own, not a stubbed one.
 *
 * Harness follows tests/integration/extract-persist-pg.test.ts: a unique
 * schema reached through the libpq `options=-c search_path=...` startup
 * string, and a loud skip with the documented Validation block when Postgres
 * is unreachable (docs/.claude/rules/test.md) — never a silent pass.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runCli, type CliDeps } from "../../src/cli/extract.js";
import { FakeLLMClient } from "../../src/core/extraction/llm-client.js";
import { FakeEmbedder } from "../../src/core/embedder.js";
import { upSchemaBootstrap } from "../../src/core/storage/schema-bootstrap.js";
import { NEO4J_URI_VAR } from "../../src/config.js";
import { warnPgUnavailable } from "./pg-test-harness.js";

const DIM = 32;
const BASE_DB_URL = "postgresql://postgres@localhost/postgres";
const SCHEMA = `extract_outbox_${randomUUID().slice(0, 8)}`;
const ANN_MAX_DIMENSIONS_VAR = "GRAPHRAG_MEMORY_PGVECTOR_ANN_MAX_DIMENSIONS";
const savedAnnMaxDimensions = process.env[ANN_MAX_DIMENSIONS_VAR];

function schemaDbUrl(): string {
  return `${BASE_DB_URL}?options=-c%20search_path%3D${SCHEMA}%2Cpublic`;
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

const OUTPUT = {
  head: "Alice Smith",
  headType: "person",
  relationRaw: "works at",
  relationNorm: "MEMBER_OF",
  tail: "Acme Corp",
  tailType: "system",
  description: "Alice Smith works at Acme Corp on the billing platform",
  evidenceSpan: "Alice Smith works at Acme Corp",
  confidence: 0.9,
};

let PG_AVAILABLE = false;
try {
  const probe = new pg.Client({ connectionString: BASE_DB_URL });
  await probe.connect();
  await probe.query("SELECT 1");
  await probe.end();
  PG_AVAILABLE = true;
} catch (err) {
  warnPgUnavailable({
    label: "extract-outbox-pg",
    testPath: "tests/integration/extract-outbox-pg.test.ts",
    expectedCommand:
      "npx vitest run tests/integration/extract-outbox-pg.test.ts",
    connectionString: BASE_DB_URL,
    error: err,
    requiresVector: false,
  });
}
const describePg = PG_AVAILABLE ? describe : describe.skip;

describePg("extract-outbox-pg: outbox emit rides the chunk transaction", () => {
  let client: pg.Client | undefined;

  beforeAll(async () => {
    process.env[ANN_MAX_DIMENSIONS_VAR] = "2000";
    client = new pg.Client({ connectionString: BASE_DB_URL });
    await client.connect();
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
    await c.query(`
      CREATE TABLE IF NOT EXISTS chunks (
        id uuid PRIMARY KEY,
        content text NOT NULL,
        embedding vector(${DIM}) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await upSchemaBootstrap(c, DIM, 2000);
  }

  async function seedChunk(c: pg.Client, content: string): Promise<string> {
    const id = randomUUID();
    const zeroVec = `[${new Array(DIM).fill(0).join(",")}]`;
    await c.query(
      `INSERT INTO chunks (id, content, embedding) VALUES ($1, $2, $3)`,
      [id, content, zeroVec]
    );
    return id;
  }

  async function runExtraction(): Promise<number> {
    const pool = new pg.Pool({ connectionString: schemaDbUrl() });
    const deps: CliDeps = {
      pool,
      llm: new FakeLLMClient({ queue: [{ kind: "ok", outputs: [OUTPUT] }] }),
      embedder: new FakeEmbedder(DIM),
      dims: DIM,
      logger: silentLogger(),
      now: () => "2026-08-26T00:00:00.000Z",
    };
    try {
      return await runCli(["--batch-size", "1"], deps);
    } finally {
      await pool.end();
    }
  }

  /**
   * Run `fn` with the Neo4j env contract removed, whatever the developer has
   * configured. SC1's claim is that extract commits without a graph, so the
   * run has to genuinely happen with none available — asserting the variable
   * merely happens to be unset would make the check vacuous on a CI box and
   * red on a workstation running the sidecar.
   */
  async function withoutNeo4jEnv<T>(fn: () => Promise<T>): Promise<T> {
    const saved = process.env[NEO4J_URI_VAR];
    delete process.env[NEO4J_URI_VAR];
    try {
      expect(process.env[NEO4J_URI_VAR]).toBeUndefined();
      return await fn();
    } finally {
      if (saved !== undefined) process.env[NEO4J_URI_VAR] = saved;
    }
  }

  async function count(c: pg.Client, table: string): Promise<number> {
    const res = await c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${table}`
    );
    return Number(res.rows[0]!.n);
  }

  it("SC1/SC3: a committed chunk leaves one pending intent per ledger subject", async () => {
    const c = client!;
    await resetSchema(c);
    await seedChunk(c, "Alice Smith works at Acme Corp.");

    // SC1 is about absence: the ledger commits with no graph configured.
    expect(await withoutNeo4jEnv(runExtraction)).toBe(0);

    expect(await count(c, "entities")).toBe(2);
    expect(await count(c, "triples")).toBe(1);

    const intents = await c.query<{
      subject_kind: string;
      subject_id: string;
      status: string;
      attempts: number;
    }>(
      `SELECT subject_kind, subject_id, status, attempts
         FROM projection_outbox ORDER BY subject_kind, subject_id`
    );
    expect(intents.rows).toHaveLength(3); // head + tail + triple
    expect(intents.rows.every((r) => r.status === "pending")).toBe(true);
    expect(intents.rows.every((r) => r.attempts === 0)).toBe(true);
    expect(
      intents.rows.filter((r) => r.subject_kind === "entity")
    ).toHaveLength(2);
    expect(
      intents.rows.filter((r) => r.subject_kind === "triple")
    ).toHaveLength(1);

    // Every intent points at a row that actually exists in the ledger.
    const dangling = await c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM projection_outbox o
        WHERE NOT EXISTS (
          SELECT 1 FROM entities e
           WHERE o.subject_kind = 'entity' AND e.id = o.subject_id)
          AND NOT EXISTS (
          SELECT 1 FROM triples t
           WHERE o.subject_kind = 'triple' AND t.id = o.subject_id)`
    );
    expect(Number(dangling.rows[0]!.n)).toBe(0);
    // No chunk ever becomes a subject (ADR-0001).
    const chunkSubjects = await c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM projection_outbox o
         JOIN chunks ch ON ch.id = o.subject_id`
    );
    expect(Number(chunkSubjects.rows[0]!.n)).toBe(0);
  });

  it("SC3: a rejected emit rolls the ledger rows back with it", async () => {
    const c = client!;
    await resetSchema(c);
    await seedChunk(c, "Alice Smith works at Acme Corp.");
    // Reject every intent at the database, the way a constraint violation or
    // a lost table would — the chunk's entities and triples must go with it.
    await c.query(`
      CREATE FUNCTION reject_intent() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION 'projection_outbox is rejecting writes'; END;
      $$ LANGUAGE plpgsql`);
    await c.query(`
      CREATE TRIGGER reject_intent_trigger BEFORE INSERT ON projection_outbox
        FOR EACH ROW EXECUTE FUNCTION reject_intent()`);

    // Exit 2 is the CLI's write-partial-failure code.
    expect(await runExtraction()).toBe(2);

    expect(await count(c, "projection_outbox")).toBe(0);
    expect(await count(c, "entities")).toBe(0);
    expect(await count(c, "triples")).toBe(0);
    expect(await count(c, "entity_aliases")).toBe(0);
    // The extraction_record was written in the same transaction, so it is
    // gone too — the chunk stays unprocessed and a re-run picks it up.
    expect(await count(c, "extraction_records")).toBe(0);
  });
});
