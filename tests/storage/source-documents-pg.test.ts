/**
 * Empty-`iknow_memory` boot contract (operator-console T1).
 *
 * The plan / spec narrows the empty-DB contract to:
 *   1. Pointing `GRAPHRAG_MEMORY_DB_URL` at an empty `iknow_memory`
 *      database, process start + `ensureTable` exits 0.
 *   2. A 资料 (source_documents) row can exist with N chunk rows
 *      indexed `0..N-1` that back-point to it.
 *
 * The harness simulates that empty database by giving every test its own
 * throwaway schema inside the dev Postgres — same machinery as the rest
 * of the integration suite — and runs `PgvectorBackend.initialize()`
 * against it. If the bootstrap is honest (creates the 资料 table,
 * adds the chunks back-pointer columns, no leftover-narrow-chunks
 * `embedding NOT NULL` failure), the assertions below hold.
 *
 * Postgres is probed up front; an unavailable local service skips
 * loudly with the project-documented skip format, never silently.
 */
import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PgvectorBackend } from "../../src/core/storage/pgvector-backend.js";
import type { ChunkRecord } from "../../src/core/types.js";
import { createPgIntegrationHarness } from "../integration/pg-test-harness.js";

const DIM = 8;
const pgHarness = await createPgIntegrationHarness({
  label: "source-documents-pg",
  testPath: "tests/storage/source-documents-pg.test.ts",
  expectedCommand: "npx vitest run tests/storage/source-documents-pg.test.ts",
  schemaPrefix: "source_documents",
  defaultConnectionString: "postgresql://postgres@localhost/postgres",
  requiresVector: true,
});
const {
  schemaConnectionString: SCHEMA_URL,
  createClient,
  resetSchema,
  dropSchema,
  describePg,
} = pgHarness;

describePg("source_documents ledger (operator-console T1)", () => {
  let admin: pg.Client | undefined;
  let backend: PgvectorBackend | undefined;

  beforeAll(async () => {
    admin = createClient(SCHEMA_URL);
    await admin.connect();
    await resetSchema(admin);
    // Boot against the empty schema exactly as a fresh `iknow_memory`
    // database would feel to `ensureTable()`.
    backend = new PgvectorBackend(SCHEMA_URL, DIM, 2000);
    await backend.initialize();
  });

  afterAll(async () => {
    if (backend) await backend.close();
    if (admin) {
      await dropSchema(admin);
      await admin.end();
    }
  });

  it("exposes the 资料 table with the columns the spec calls out", async () => {
    const result = await admin!.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'source_documents'`
    );
    const columns = new Set(result.rows.map((row) => row.column_name));
    for (const column of [
      "id",
      "source_ref",
      "title",
      "content",
      "created_at",
    ]) {
      expect(columns, `source_documents.${column} missing`).toContain(column);
    }
  });

  it("exposes the chunks back-pointer columns source_doc_id + ordinal", async () => {
    const result = await admin!.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'chunks'`
    );
    const columns = new Set(result.rows.map((row) => row.column_name));
    expect(columns, "chunks.source_doc_id missing").toContain("source_doc_id");
    expect(columns, "chunks.ordinal missing").toContain("ordinal");
  });

  it("supports a 资料 row with N chunk rows indexed 0..N-1 that back-point to it", async () => {
    const sourceDocId = randomUUID();
    const sourceRef = `specs/operator-console/${randomUUID()}`;

    await admin!.query(
      `INSERT INTO source_documents (id, source_ref, content)
         VALUES ($1, $2, $3)`,
      [sourceDocId, sourceRef, "fixture body"]
    );

    const chunkIds = [randomUUID(), randomUUID(), randomUUID()];
    for (let i = 0; i < chunkIds.length; i += 1) {
      await admin!.query(
        `INSERT INTO chunks
           (id, content, embedding, valid_from, valid_until,
            source_ref, metadata, created_at,
            source_doc_id, ordinal)
           VALUES ($1, $2, $3::vector, $4, $5, $6, $7::jsonb, $8,
                   $9, $10)`,
        [
          chunkIds[i],
          `slice-${i}`,
          `[${new Array(DIM)
            .fill(0)
            .map((_, axis) => (axis === i ? 1 : 0))
            .join(",")}]`,
          "2024-01-01T00:00:00Z",
          null,
          sourceRef,
          "{}",
          "2024-01-01T00:00:00Z",
          sourceDocId,
          i,
        ]
      );
    }

    const back = await admin!.query<{ ordinal: number; id: string }>(
      `SELECT id, ordinal FROM chunks
         WHERE source_doc_id = $1
         ORDER BY ordinal ASC`,
      [sourceDocId]
    );
    expect(back.rows.map((row) => row.ordinal)).toEqual([0, 1, 2]);
    expect(back.rows.map((row) => row.id)).toEqual(chunkIds);
  });

  it("FK from chunks.source_doc_id to source_documents uses ON DELETE SET NULL", async () => {
    // Knowledge outlives its source: removing a 资料 row nulls the
    // back-pointers on its chunk rows but keeps the chunks themselves.
    const sourceDocId = randomUUID();
    await admin!.query(
      `INSERT INTO source_documents (id, source_ref, content)
         VALUES ($1, $2, $3)`,
      [sourceDocId, `fk-${randomUUID()}`, "to be removed"]
    );
    const chunkId = randomUUID();
    await admin!.query(
      `INSERT INTO chunks
         (id, content, embedding, valid_from, valid_until,
          source_ref, metadata, created_at,
          source_doc_id, ordinal)
         VALUES ($1, $2, $3::vector, $4, $5, $6, $7::jsonb, $8,
                 $9, $10)`,
      [
        chunkId,
        "anchored",
        `[${new Array(DIM).fill(0).join(",")}]`,
        "2024-01-01T00:00:00Z",
        null,
        `src-${chunkId}`,
        "{}",
        "2024-01-01T00:00:00Z",
        sourceDocId,
        0,
      ]
    );

    await admin!.query(`DELETE FROM source_documents WHERE id = $1`, [
      sourceDocId,
    ]);

    const after = await admin!.query<{
      source_doc_id: string | null;
      ordinal: number | null;
    }>(`SELECT source_doc_id, ordinal FROM chunks WHERE id = $1`, [chunkId]);
    expect(after.rowCount).toBe(1);
    expect(after.rows[0].source_doc_id).toBeNull();
    expect(after.rows[0].ordinal).toBe(0);
  });

  it("PgvectorBackend.upsert persists back-pointers when ChunkRecord carries them", async () => {
    const sourceDocId = randomUUID();
    const sourceRef = `upsert-${randomUUID()}`;
    await admin!.query(
      `INSERT INTO source_documents (id, source_ref, content)
         VALUES ($1, $2, $3)`,
      [sourceDocId, sourceRef, "upsert body"]
    );

    const makeChunk = (ordinal: number): ChunkRecord => ({
      id: randomUUID(),
      content: `slice-${ordinal}`,
      embedding: new Array(DIM)
        .fill(0)
        .map((_, axis) => (axis === ordinal ? 1 : 0)),
      source_ref: sourceRef,
      metadata: {},
      valid_from: "2024-01-01T00:00:00Z",
      valid_until: null,
      created_at: "2024-01-01T00:00:00Z",
      source_doc_id: sourceDocId,
      ordinal,
    });
    const records = [makeChunk(0), makeChunk(1)];
    await backend!.upsert(records);

    const rows = await admin!.query<{
      source_doc_id: string;
      ordinal: number;
    }>(
      `SELECT source_doc_id, ordinal FROM chunks
         WHERE source_doc_id = $1
         ORDER BY ordinal ASC`,
      [sourceDocId]
    );
    expect(rows.rows.map((row) => row.ordinal)).toEqual([0, 1]);
    for (const row of rows.rows) {
      expect(row.source_doc_id).toBe(sourceDocId);
    }
  });

  it("upsert without back-pointers stays valid (legacy chunk rows load)", async () => {
    // Old writes / replay paths still pass through; the new columns are
    // nullable so an old chunk row remains SELECT-able.
    const legacyChunk: ChunkRecord = {
      id: randomUUID(),
      content: "legacy slice",
      embedding: new Array(DIM).fill(0),
      source_ref: `legacy-${randomUUID()}`,
      metadata: {},
      valid_from: "2024-01-01T00:00:00Z",
      valid_until: null,
      created_at: "2024-01-01T00:00:00Z",
    };
    await backend!.upsert([legacyChunk]);

    const result = await admin!.query<{
      id: string;
      source_doc_id: string | null;
      ordinal: number | null;
    }>(`SELECT id, source_doc_id, ordinal FROM chunks WHERE id = $1`, [
      legacyChunk.id,
    ]);
    expect(result.rowCount).toBe(1);
    expect(result.rows[0].source_doc_id).toBeNull();
    expect(result.rows[0].ordinal).toBeNull();
  });
});
