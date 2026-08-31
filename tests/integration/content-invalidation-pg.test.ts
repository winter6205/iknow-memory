import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FakeEmbedder } from "../../src/core/embedder.js";
import { PgvectorBackend } from "../../src/core/storage/pgvector-backend.js";
import { createIngestHandler } from "../../src/tools/ingest.js";

const DIM = 32;
const DB_URL =
  process.env.GRAPHRAG_MEMORY_DB_URL ??
  "postgresql://postgres@localhost/postgres";
const SCHEMA = `content_invalidation_${randomUUID().replace(/-/g, "")}`;
const SCHEMA_URL =
  DB_URL +
  (DB_URL.includes("?") ? "&" : "?") +
  `options=${encodeURIComponent(`-c search_path=${SCHEMA},public`)}`;

const CONTENT = "content that is closed by invalidation";
const SOURCE_REF = "t6/live-invalidation";
const BEFORE_INVALIDATION = "2026-08-31T11:59:59.999Z";
const INVALIDATED_AT = "2026-08-31T12:00:00.000Z";
const AFTER_INVALIDATION = "2026-08-31T12:00:00.001Z";

let PG_AVAILABLE = false;
try {
  const probe = new pg.Client({ connectionString: DB_URL });
  await probe.connect();
  await probe.query("SELECT 1");
  await probe.end();
  PG_AVAILABLE = true;
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.warn(
    `\n[content-invalidation-pg] Postgres unavailable at ${DB_URL}: ${message}\n`
  );
  console.warn(
    "Validation:\n" +
      "- Not run: tests/integration/content-invalidation-pg.test.ts\n" +
      "- Expected command: npx vitest run tests/integration/content-invalidation-pg.test.ts\n" +
      `- Blocking issue: cannot connect to Postgres at ${DB_URL}\n`
  );
}

const describePg = PG_AVAILABLE ? describe : describe.skip;

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
    client = new pg.Client({ connectionString: SCHEMA_URL });
    await client.connect();
    await client.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await client.query(`CREATE SCHEMA "${SCHEMA}"`);
    backend = new PgvectorBackend(SCHEMA_URL, DIM);
  });

  afterAll(async () => {
    if (backend) await backend.close();
    if (client) {
      await client.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
      await client.end();
    }
  });

  it("keeps the row, removes it at and after the instant, and persists an idempotent record", async () => {
    const embedder = new FakeEmbedder(DIM);
    const ingest = createIngestHandler({ embedder, storage: backend! });
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
      action: "invalidate" as const,
      source_ref: SOURCE_REF,
      invalidated_at: INVALIDATED_AT,
      triggered_by: "fin",
    };
    const first = await ingest(request);
    const second = await ingest(request);
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
      ingest({
        action: "invalidate",
        source_ref: "t6/unknown",
        invalidated_at: INVALIDATED_AT,
        triggered_by: "fin",
      })
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect("delete" in backend!).toBe(false);
    expect("deleteBySourceRef" in backend!).toBe(false);
  });
});
