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
const SCHEMA = `ingest_idempotency_${randomUUID().replace(/-/g, "")}`;
const SCHEMA_URL =
  DB_URL +
  (DB_URL.includes("?") ? "&" : "?") +
  `options=${encodeURIComponent(`-c search_path=${SCHEMA},public`)}`;

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
    `\n[ingest-idempotency-pg] Postgres unavailable at ${DB_URL}: ${message}\n`
  );
  console.warn(
    "Validation:\n" +
      "- Not run: tests/integration/ingest-idempotency-pg.test.ts\n" +
      "- Expected command: npx vitest run tests/integration/ingest-idempotency-pg.test.ts\n" +
      `- Blocking issue: cannot connect to Postgres at ${DB_URL}\n`
  );
}

const describePg = PG_AVAILABLE ? describe : describe.skip;

describePg("T5 ingest idempotency: live PostgreSQL", () => {
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

  it("returns one stable id for concurrent duplicate pushes and stores one row", async () => {
    const ingest = createIngestHandler({
      embedder: new FakeEmbedder(DIM),
      storage: backend!,
    });
    const sourceRef = "t5/live-concurrent";
    const content = "concurrent idempotent content";

    const results = await Promise.all(
      Array.from({ length: 16 }, () =>
        ingest({ content, source_ref: sourceRef })
      )
    );
    const idSets = results.map((result) => {
      const text = (result.content as Array<{ type: string; text?: string }>)
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join("");
      return (JSON.parse(text) as { chunk_ids: string[] }).chunk_ids;
    });

    expect(idSets[0]).toHaveLength(1);
    for (const idSet of idSets) expect(idSet).toEqual(idSets[0]);

    const count = await client!.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM chunks WHERE source_ref = $1`,
      [sourceRef]
    );
    expect(count.rows[0]?.count).toBe("1");
  });
});
