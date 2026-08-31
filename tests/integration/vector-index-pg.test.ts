/**
 * Real-Postgres proof for the chunk vector ANN index (SC-2).
 *
 * The unit suite verifies emitted DDL and typed failure paths without a
 * service. This file is the live proof that catalog introspection finds one
 * index and that an ordered cosine query does not use a sequential scan.
 * When Postgres or pgvector is unavailable it skips loudly, matching the
 * existing integration-suite convention.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import {
  buildVectorSearchQuery,
  PgvectorBackend,
} from "../../src/core/storage/pgvector-backend.js";
import { createPgIntegrationHarness } from "./pg-test-harness.js";

const DIM = 1536;
const VALID_AT = "2026-08-01T00:00:00.000Z";
const REPRESENTATIVE_ROW_COUNT = 5_000;
const pgHarness = await createPgIntegrationHarness({
  label: "vector-index-pg",
  testPath: "tests/integration/vector-index-pg.test.ts",
  expectedCommand: "npx vitest run tests/integration/vector-index-pg.test.ts",
  schemaPrefix: "vector_index_pg",
  defaultConnectionString: "postgresql://postgres@localhost:5432/postgres",
  requiresVector: true,
});
const {
  schema: SCHEMA,
  schemaConnectionString: SCHEMA_URL,
  describePg,
} = pgHarness;

function vectorLiteral(): string {
  return `[${new Array<number>(DIM).fill(0).join(",")}]`;
}

function sequentialScanRelations(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => sequentialScanRelations(entry));
  }
  if (typeof value !== "object" || value === null) return [];

  const node = value as {
    "Node Type"?: string;
    "Relation Name"?: string;
  };
  const own =
    node["Node Type"] === "Seq Scan"
      ? [node["Relation Name"] ?? "<unknown>"]
      : [];
  return own.concat(
    Object.values(value).flatMap((entry) => sequentialScanRelations(entry))
  );
}

describePg("chunk vector ANN index (SC-2)", () => {
  let client: pg.Client | undefined;
  let backend: PgvectorBackend | undefined;

  beforeAll(async () => {
    client = pgHarness.createClient(SCHEMA_URL);
    await client.connect();
    await pgHarness.resetSchema(client);
    await client.query(`SET search_path TO "${SCHEMA}", public`);
    backend = new PgvectorBackend(SCHEMA_URL, DIM, 2000);
  });

  afterAll(async () => {
    if (backend) await backend.close();
    if (client) {
      await pgHarness.dropSchema(client);
      await client.end();
    }
  });

  it("finds exactly one chunk vector index and avoids a sequential scan", async () => {
    await backend!.upsert([
      {
        id: randomUUID(),
        content: "vector index fixture",
        embedding: new Array<number>(DIM).fill(0),
        valid_from: "2026-01-01T00:00:00.000Z",
        valid_until: null,
        source_ref: "vector-index/fixture",
        metadata: {},
        created_at: "2026-01-01T00:00:00.000Z",
      },
    ]);
    await client!.query(
      `INSERT INTO chunks
         (id, content, embedding, valid_from, valid_until,
          source_ref, metadata, created_at)
       SELECT lpad(to_hex(row_number), 32, '0')::uuid,
              'representative vector fixture ' || row_number,
              $1::vector,
              $2::timestamptz,
              NULL::timestamptz,
              'vector-index/representative',
              '{}'::jsonb,
              $2::timestamptz
         FROM generate_series(1, $3::int) AS rows(row_number)`,
      [vectorLiteral(), "2026-01-01T00:00:00.000Z", REPRESENTATIVE_ROW_COUNT]
    );

    const indexes = await client!.query<{ indexname: string }>(
      `SELECT indexname
         FROM pg_indexes
        WHERE schemaname = $1
          AND tablename = 'chunks'
          AND indexname = $2`,
      [SCHEMA, "chunks_embedding_idx"]
    );
    expect(indexes.rows).toHaveLength(1);

    const settings = await client!.query<{ enable_seqscan: string }>(
      "SELECT current_setting('enable_seqscan') AS enable_seqscan"
    );
    expect(settings.rows[0]?.enable_seqscan).toBe("on");

    const retrieval = buildVectorSearchQuery(new Array<number>(DIM).fill(0), {
      validAt: VALID_AT,
      limit: 10,
    });
    expect(retrieval.sql).toContain("valid_from <= $2::timestamptz");
    expect(retrieval.sql).toContain(
      "(valid_until IS NULL OR valid_until > $2::timestamptz)"
    );
    const plan = await client!.query(
      `EXPLAIN (FORMAT JSON) ${retrieval.sql}`,
      retrieval.params
    );
    const planJson = plan.rows[0]?.["QUERY PLAN"];
    console.info(
      `[vector-index-pg] settings: enable_seqscan=${settings.rows[0]?.enable_seqscan}; ` +
        `representative_rows=${REPRESENTATIVE_ROW_COUNT}\n` +
        JSON.stringify(planJson, null, 2)
    );
    expect(sequentialScanRelations(planJson)).not.toContain("chunks");
  });
});
