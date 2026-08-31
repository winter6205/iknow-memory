/**
 * T7 live-Postgres coverage.
 *
 * The suite is skipped loudly when Postgres or pgvector is unavailable. The
 * batch boundary assertions remain in the unit suite, while this file proves
 * the same ingest surface and the pool cap against the real database.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

import { FakeEmbedder } from "../../src/core/embedder.js";
import { GraphragError } from "../../src/core/errors.js";
import { PgvectorBackend } from "../../src/core/storage/pgvector-backend.js";
import { createIngestHandler } from "../../src/tools/ingest.js";

const DIM = 32;
const BATCH_LIMIT = 3;
const DB_URL =
  process.env.GRAPHRAG_MEMORY_DB_URL ??
  "postgresql://postgres@localhost:5432/postgres";
const SCHEMA = `t7_batch_pool_${randomUUID().replace(/-/g, "")}`;
const SCHEMA_URL =
  DB_URL +
  (DB_URL.includes("?") ? "&" : "?") +
  `options=${encodeURIComponent(`-c search_path=${SCHEMA},public`)}`;

let PGVECTOR_AVAILABLE = false;
try {
  const probe = new pg.Client({ connectionString: DB_URL });
  await probe.connect();
  await probe.query("SELECT 1");
  const extension = await probe.query<{ installed_version: string | null }>(
    "SELECT installed_version FROM pg_available_extensions WHERE name = 'vector'"
  );
  await probe.end();
  PGVECTOR_AVAILABLE = extension.rows[0]?.installed_version !== undefined;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(
    `\n[t7-batch-pool-pg] Postgres/pgvector unavailable at ${DB_URL}: ${message}\n`
  );
  console.warn(
    "Validation:\n" +
      "- Not run: tests/integration/ingest-batch-pool-pg.test.ts\n" +
      "- Expected command: npx vitest run tests/integration/ingest-batch-pool-pg.test.ts\n" +
      `- Blocking issue: cannot use Postgres with pgvector at ${DB_URL}\n`
  );
}

const describePg = PGVECTOR_AVAILABLE ? describe : describe.skip;

type PoolOptions = {
  max: number;
  connectionWaitTimeoutMs: number;
};

const Backend = PgvectorBackend as unknown as new (
  dbUrl: string,
  dimensions: number,
  annMaxDimensions: number,
  poolOptions: PoolOptions
) => PgvectorBackend;

function chunkIds(result: { content: unknown }): string[] {
  const text = (result.content as Array<{ type: string; text?: string }>)
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("");
  return (JSON.parse(text) as { chunk_ids: string[] }).chunk_ids;
}

describePg("T7 batch ingest and pool: live PostgreSQL", () => {
  let client: pg.Client;
  let backend: PgvectorBackend;
  const embedder = new FakeEmbedder(DIM);

  beforeAll(async () => {
    client = new pg.Client({ connectionString: SCHEMA_URL });
    await client.connect();
    await client.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await client.query(`CREATE SCHEMA "${SCHEMA}"`);
    backend = new Backend(SCHEMA_URL, DIM, 2000, {
      max: 2,
      connectionWaitTimeoutMs: 5_000,
    });
    await backend.upsert([
      {
        id: randomUUID(),
        content: "T7 schema bootstrap",
        embedding: new Array<number>(DIM).fill(0),
        source_ref: "t7/bootstrap",
        metadata: {},
        valid_from: "2026-01-01T00:00:00.000Z",
        valid_until: null,
        created_at: "2026-01-01T00:00:00.000Z",
      },
    ]);
    await client.query("DELETE FROM chunks");
  });

  afterAll(async () => {
    await backend.close();
    await client.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await client.end();
  });

  async function rowCount(sourceRef: string): Promise<number> {
    const result = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM chunks WHERE source_ref = $1",
      [sourceRef]
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  it("accepts exactly the limit and idempotently re-submits the same batch", async () => {
    const sourceRef = "t7/live-at-limit";
    const contents = ["live first", "live second", "live third"];
    const ingest = createIngestHandler({
      embedder,
      storage: backend,
      batchLimit: BATCH_LIMIT,
    });

    const before = await rowCount(sourceRef);
    const first = chunkIds(
      await ingest({
        content: contents,
        source_ref: sourceRef,
      })
    );
    const afterFirst = await rowCount(sourceRef);
    const second = chunkIds(
      await ingest({
        content: contents,
        source_ref: sourceRef,
      })
    );
    const afterSecond = await rowCount(sourceRef);

    expect(first).toHaveLength(BATCH_LIMIT);
    expect(afterFirst - before).toBe(BATCH_LIMIT);
    expect(second).toEqual(first);
    expect(afterSecond).toBe(afterFirst);
  });

  it("rejects limit plus one with zero row delta and no truncated tail", async () => {
    const sourceRef = "t7/live-over-limit";
    const ingest = createIngestHandler({
      embedder,
      storage: backend,
      batchLimit: BATCH_LIMIT,
    });

    const before = await rowCount(sourceRef);
    const error = await ingest({
      content: ["live first", "live second", "live third", "live tail"],
      source_ref: sourceRef,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GraphragError);
    expect(error).toMatchObject({
      code: "BATCH_LIMIT_EXCEEDED",
      name: "BatchLimitExceededError",
    });
    expect((error as Error).message).toContain("actual count 4");
    expect((error as Error).message).toContain("limit 3");
    expect(await rowCount(sourceRef)).toBe(before);
  });

  it("observes no more concurrent connections than the configured cap", async () => {
    const [queryEmbedding] = await embedder.embed(["pool observation"]);

    await Promise.all(
      Array.from({ length: 16 }, () =>
        backend.search(queryEmbedding!, {
          limit: 5,
          validAt: "2099-01-01T00:00:00.000Z",
        })
      )
    );

    const stats = (
      backend as unknown as {
        getPoolStats: () => {
          configuredMax: number;
          observedConcurrentConnections: number;
          peakConcurrentConnections: number;
          connectionWaitTimeouts: number;
        };
      }
    ).getPoolStats();
    expect(stats.configuredMax).toBe(2);
    expect(stats.peakConcurrentConnections).toBeLessThanOrEqual(
      stats.configuredMax
    );
    expect(stats.observedConcurrentConnections).toBe(0);
    expect(stats.connectionWaitTimeouts).toBe(0);
  });
});
