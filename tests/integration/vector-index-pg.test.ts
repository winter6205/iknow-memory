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
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PgvectorBackend } from "../../src/core/storage/pgvector-backend.js";

const DIM = 1536;
const DB_URL =
  process.env.GRAPHRAG_MEMORY_DB_URL ??
  "postgresql://postgres@localhost:5432/postgres";
const SCHEMA = `vector_index_pg_${randomUUID().slice(0, 8).replace(/-/g, "")}`;
const SCHEMA_URL =
  DB_URL +
  (DB_URL.includes("?") ? "&" : "?") +
  `options=-c%20search_path%3D${SCHEMA},public`;

let PGVECTOR_AVAILABLE = false;
try {
  const probe = new pg.Client({ connectionString: DB_URL });
  await probe.connect();
  await probe.query("SELECT 1");
  const extension = await probe.query<{ installed_version: string | null }>(
    "SELECT installed_version FROM pg_available_extensions WHERE name = 'vector'"
  );
  await probe.end();
  if (extension.rows[0]?.installed_version === undefined) {
    throw new Error("pgvector extension is not installed");
  }
  PGVECTOR_AVAILABLE = true;
} catch (err) {
  console.warn(
    `\n[vector-index-pg] Postgres/pgvector unavailable at ${DB_URL}: ${(err as Error).message}\n`
  );
  console.warn(
    "Validation:\n" +
      "- Not run: tests/integration/vector-index-pg.test.ts\n" +
      "- Expected command: npx vitest run tests/integration/vector-index-pg.test.ts\n" +
      `- Blocking issue: cannot use Postgres with pgvector at ${DB_URL}\n`
  );
}

const describePg = PGVECTOR_AVAILABLE ? describe : describe.skip;

function vectorLiteral(): string {
  return `[${new Array<number>(DIM).fill(0).join(",")}]`;
}

describePg("chunk vector ANN index (SC-2)", () => {
  let client: pg.Client | undefined;
  let backend: PgvectorBackend | undefined;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: SCHEMA_URL });
    await client.connect();
    await client.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await client.query(`CREATE SCHEMA "${SCHEMA}"`);
    await client.query(`SET search_path TO "${SCHEMA}", public`);
    backend = new PgvectorBackend(SCHEMA_URL, DIM, 2000);
  });

  afterAll(async () => {
    if (backend) await backend.close();
    if (client) {
      await client.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
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

    const indexes = await client!.query<{ indexname: string }>(
      `SELECT indexname
         FROM pg_indexes
        WHERE schemaname = $1
          AND tablename = 'chunks'
          AND indexname = $2`,
      [SCHEMA, "chunks_embedding_idx"]
    );
    expect(indexes.rows).toHaveLength(1);

    await client!.query("SET enable_seqscan = off");
    const plan = await client!.query(
      `EXPLAIN (FORMAT JSON)
         SELECT id
           FROM chunks
          ORDER BY embedding <=> '${vectorLiteral()}'::vector
          LIMIT 1`
    );
    expect(JSON.stringify(plan.rows)).not.toContain('"Node Type": "Seq Scan"');
  });
});
