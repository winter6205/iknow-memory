import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { FakeEmbedder } from "../../src/core/embedder.js";
import { PgvectorBackend } from "../../src/core/storage/pgvector-backend.js";
import { createIngestHandler } from "../../src/tools/ingest.js";
import { createInvalidationHandler } from "../../src/tools/invalidation.js";
import { createReadSourceHandler } from "../../src/tools/read_source.js";
import { createPgIntegrationHarness } from "./pg-test-harness.js";

const DIM = 32;
const pgHarness = await createPgIntegrationHarness({
  label: "content-invalidation-pg",
  testPath: "tests/integration/content-invalidation-pg.test.ts",
  expectedCommand:
    "npx vitest run tests/integration/content-invalidation-pg.test.ts",
  schemaPrefix: "content_invalidation",
  defaultConnectionString: "postgresql://postgres@localhost/postgres",
  requiresVector: false,
});
const {
  schema: SCHEMA,
  schemaConnectionString: SCHEMA_URL,
  describePg,
} = pgHarness;

const CONTENT = "content that is closed by invalidation";
const SOURCE_REF = "t6/live-invalidation";
const BEFORE_INVALIDATION = "2026-08-31T11:59:59.999Z";
const INVALIDATED_AT = "2026-08-31T12:00:00.000Z";
const AFTER_INVALIDATION = "2026-08-31T12:00:00.001Z";

function textOf(result: { content: unknown }): string {
  return (result.content as Array<{ type: string; text?: string }>)
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("");
}

describePg("T6 content invalidation: live PostgreSQL", () => {
  let client: pg.Client | undefined;
  let backend: PgvectorBackend | undefined;

  beforeAll(async () => {
    client = pgHarness.createClient(SCHEMA_URL);
    await client.connect();
    await pgHarness.resetSchema(client);
    backend = new PgvectorBackend(SCHEMA_URL, DIM, { annMaxDimensions: 2000 });
  });

  afterAll(async () => {
    if (backend) await backend.close();
    if (client) {
      await pgHarness.dropSchema(client);
      await client.end();
    }
  });

  it("keeps the row, removes it at and after the instant, and persists an idempotent record", async () => {
    const embedder = new FakeEmbedder(DIM);
    const ingest = createIngestHandler({ embedder, storage: backend! });
    // The MCP tool is `invalidate` (specs/mcp-tool-surface.md); the
    // close-window semantics under Postgres are unchanged.
    const invalidate = createInvalidationHandler({
      embedder,
      storage: backend!,
    });
    const ingested = await ingest({
      content: CONTENT,
      source_ref: SOURCE_REF,
      valid_from: "2026-01-01T00:00:00.000Z",
    });
    const chunkId = (JSON.parse(textOf(ingested)) as { chunk_ids: string[] })
      .chunk_ids[0]!;
    const beforeCount = await client!.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM chunks WHERE source_ref = $1`,
      [SOURCE_REF]
    );

    const request = {
      source_ref: SOURCE_REF,
      invalidated_at: INVALIDATED_AT,
      triggered_by: "fin",
    };
    const first = await invalidate(request);
    const second = await invalidate(request);
    const retry = await ingest({
      content: CONTENT,
      source_ref: SOURCE_REF,
      valid_from: "2026-01-01T00:00:00.000Z",
    });

    const [queryEmbedding] = await embedder.embed([CONTENT]);
    const before = await backend!.search(queryEmbedding!, {
      limit: 10,
      validAt: BEFORE_INVALIDATION,
    });
    const atInstant = await backend!.search(queryEmbedding!, {
      limit: 10,
      validAt: INVALIDATED_AT,
    });
    const after = await backend!.search(queryEmbedding!, {
      limit: 10,
      validAt: AFTER_INVALIDATION,
    });
    const afterCount = await client!.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM chunks WHERE source_ref = $1`,
      [SOURCE_REF]
    );

    expect(before.map((chunk) => chunk.id)).toEqual([chunkId]);
    expect(atInstant).toEqual([]);
    expect(after).toEqual([]);
    expect(afterCount.rows[0]?.count).toBe(beforeCount.rows[0]?.count);
    expect(textOf(second)).toBe(textOf(first));
    expect(
      (JSON.parse(textOf(retry)) as { chunk_ids: string[] }).chunk_ids
    ).toEqual([chunkId]);
    await expect(backend!.listInvalidations(SOURCE_REF)).resolves.toEqual([
      {
        chunk_id: chunkId,
        invalidated_at: INVALIDATED_AT,
        triggered_by: "fin",
      },
    ]);
    await expect(
      invalidate({
        source_ref: "t6/unknown",
        invalidated_at: INVALIDATED_AT,
        triggered_by: "fin",
      })
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect("delete" in backend!).toBe(false);
    expect("deleteBySourceRef" in backend!).toBe(false);
  });

  /**
   * Operator-console T5: content invalidation targets the 资料 AND its
   * derived chunks. The source_documents window closes in the same
   * transaction; read_source answers a named-invalid; rows stay
   * SELECT-able.
   */
  it("T5: closes the 资料 window with the chunk windows; read_source named-invalid; rows SELECT-able", async () => {
    const embedder = new FakeEmbedder(DIM);
    const ingest = createIngestHandler({ embedder, storage: backend! });
    const invalidate = createInvalidationHandler({
      embedder,
      storage: backend!,
    });
    const body = "alpha middle omega";
    await ingest({
      source_ref: SOURCE_REF,
      content: body,
      chunks: [
        { content: "alpha", index: 0 },
        { content: "middle", index: 1 },
        { content: "omega", index: 2 },
      ],
    });

    const request = {
      source_ref: SOURCE_REF,
      invalidated_at: INVALIDATED_AT,
      triggered_by: "fin",
    };
    const first = await invalidate(request);
    const second = await invalidate(request);
    expect(textOf(second)).toBe(textOf(first));

    // 资料 window closed in the same transaction.
    const docRow = await client!.query<{
      id: string;
      valid_until: Date | null;
    }>(`SELECT id, valid_until FROM source_documents WHERE source_ref = $1`, [
      SOURCE_REF,
    ]);
    expect(docRow.rows[0]?.valid_until?.toISOString()).toBe(INVALIDATED_AT);
    const docRowId = docRow.rows[0]?.id;

    // Rows remain SELECT-able — no physical delete.
    const docCount = await client!.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM source_documents WHERE source_ref = $1`,
      [SOURCE_REF]
    );
    expect(docCount.rows[0]?.count).toBe("1");
    const chunkCount = await client!.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM chunks WHERE source_ref = $1`,
      [SOURCE_REF]
    );
    expect(chunkCount.rows[0]?.count).toBe("3");

    // read_source answers a named-invalid (distinct from not-found),
    // carrying the resolved row identity (doc.id, doc.source_ref) so a
    // host can map a request back to the underlying 资料.
    const read = await createReadSourceHandler({ storage: backend! })({
      source_ref: SOURCE_REF,
    });
    expect(read.isError).toBe(true);
    const readBody = JSON.parse(textOf(read)) as Record<string, unknown>;
    expect(readBody.error).toBe("read_source_invalidated");
    expect(readBody.source_ref).toBe(SOURCE_REF);
    expect(readBody.id).toBe(docRowId);
    expect(readBody.valid_until).toBe(INVALIDATED_AT);

    // Same-content re-push keeps the closed 资料 window.
    await ingest({
      source_ref: SOURCE_REF,
      content: body,
      chunks: [
        { content: "alpha", index: 0 },
        { content: "middle", index: 1 },
        { content: "omega", index: 2 },
      ],
    });
    const docAfterRepush = await client!.query<{
      valid_until: Date | null;
    }>(`SELECT valid_until FROM source_documents WHERE source_ref = $1`, [
      SOURCE_REF,
    ]);
    expect(docAfterRepush.rows[0]?.valid_until?.toISOString()).toBe(
      INVALIDATED_AT
    );
  });
});
