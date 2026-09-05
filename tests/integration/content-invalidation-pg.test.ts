import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { FakeEmbedder } from "../../src/core/embedder.js";
import { PgvectorBackend } from "../../src/core/storage/pgvector-backend.js";
import { createIngestHandler } from "../../src/tools/ingest.js";
import { createInvalidationHandler } from "../../src/tools/invalidation.js";
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
    backend = new PgvectorBackend(SCHEMA_URL, DIM, 2000);
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
});
