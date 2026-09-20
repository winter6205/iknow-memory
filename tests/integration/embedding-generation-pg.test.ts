/**
 * Real-Postgres proof for the embedding-generation ledger (T1).
 *
 * Pins the four facts the unit fakes cannot prove: the seed/backfill rows
 * really land, a boot refuse never drops the live vector column, openRotate
 * really creates the incoming `vector(N)` column + its own cosine HNSW index
 * on all three tables (entities included), and a concurrent second rotate is
 * refused against the live singleton. Skips loudly when Postgres/pgvector is
 * unavailable (tests/integration/pg-test-harness.ts convention).
 */
import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { ConfigError } from "../../src/config.js";
import { GraphragError } from "../../src/core/errors.js";
import { PgvectorBackend } from "../../src/core/storage/pgvector-backend.js";
import {
  guardEmbeddingBoot,
  openRotate,
  readGenerationState,
} from "../../src/core/storage/embedding-generation.js";
import { createPgIntegrationHarness } from "./pg-test-harness.js";

const DIM = 8;
const ANN_MAX = 2000;
const pgHarness = await createPgIntegrationHarness({
  label: "embedding-generation-pg",
  testPath: "tests/integration/embedding-generation-pg.test.ts",
  expectedCommand:
    "npx vitest run tests/integration/embedding-generation-pg.test.ts",
  schemaPrefix: "embedding_generation_pg",
  defaultConnectionString: "postgresql://postgres@localhost:5432/postgres",
  requiresVector: true,
});
const {
  schema: SCHEMA,
  schemaConnectionString: SCHEMA_URL,
  describePg,
} = pgHarness;

async function vectorWidth(
  client: pg.Client,
  table: string,
  column: string
): Promise<string | undefined> {
  const result = await client.query<{ column_type: string }>(
    `SELECT format_type(atttypid, atttypmod) AS column_type
       FROM pg_attribute
       JOIN pg_class ON pg_class.oid = pg_attribute.attrelid
       JOIN pg_namespace ON pg_namespace.oid = pg_class.relnamespace
      WHERE pg_class.relname = $1
        AND pg_attribute.attname = $2
        AND NOT pg_attribute.attisdropped
        AND pg_namespace.nspname = $3`,
    [table, column, SCHEMA]
  );
  return result.rows[0]?.column_type;
}

async function indexNames(client: pg.Client, table: string): Promise<string[]> {
  const result = await client.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes
      WHERE schemaname = $1 AND tablename = $2`,
    [SCHEMA, table]
  );
  return result.rows.map((row) => row.indexname);
}

async function bootBackend(model: string | undefined): Promise<PgvectorBackend> {
  const backend = new PgvectorBackend(SCHEMA_URL, DIM, ANN_MAX, {}, model);
  await backend.initialize();
  await backend.close();
  return backend;
}

describePg("embedding generation ledger (T1)", () => {
  let client: pg.Client | undefined;

  beforeAll(async () => {
    client = pgHarness.createClient(SCHEMA_URL);
    await client.connect();
  });

  afterAll(async () => {
    if (client) {
      await pgHarness.dropSchema(client);
      await client.end();
      client = undefined;
    }
  });

  it("fresh boot seeds the singleton with the desired generation", async () => {
    const c = client!;
    await pgHarness.resetSchema(c);
    await c.query(`SET search_path TO "${SCHEMA}", public`);

    await bootBackend("m1");

    const state = await readGenerationState(c);
    expect(state).not.toBeNull();
    expect(state).toMatchObject({
      activeSlot: "embedding",
      active: { model: "m1", dimensions: DIM },
      incomingSlot: null,
      incoming: null,
      rotateMode: null,
    });
  });

  it("model change: boot refuses without dropping the live column, openRotate opens the incoming generation", async () => {
    const c = client!;
    await pgHarness.resetSchema(c);
    await c.query(`SET search_path TO "${SCHEMA}", public`);
    await bootBackend("m1");

    // Same width, different model, no rotate yet → typed ConfigError naming
    // both pairs, and the live columns must survive untouched.
    const rejecting = new PgvectorBackend(SCHEMA_URL, DIM, ANN_MAX, {}, "m2");
    const error = await rejecting
      .initialize()
      .then(() => undefined)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toContain("desired model=m2");
    expect((error as Error).message).toContain("active model=m1");
    await rejecting.close();

    expect(await vectorWidth(c, "chunks", "embedding")).toBe(`vector(${DIM})`);
    expect(await vectorWidth(c, "entities", "embedding")).toBe(
      `vector(${DIM})`
    );
    expect(await vectorWidth(c, "community_summaries", "embedding")).toBe(
      `vector(${DIM})`
    );

    const state = await openRotate(
      c,
      { model: "m2", dimensions: DIM },
      "dual_write",
      ANN_MAX
    );
    expect(state.incomingSlot).toBe("embedding_g2");
    expect(state.incoming).toEqual({ model: "m2", dimensions: DIM });
    expect(state.rotateMode).toBe("dual_write");

    // Same-model-width change keeps the OLD column width AND adds the
    // incoming column at the same width — with its own cosine index per
    // table, including entities (which has none on the legacy column).
    for (const table of ["chunks", "entities", "community_summaries"]) {
      expect(await vectorWidth(c, table, "embedding_g2")).toBe(
        `vector(${DIM})`
      );
      const indexes = await indexNames(c, table);
      expect(indexes).toContain(`${table}_embedding_g2_idx`);
    }
    expect(await indexNames(c, "entities")).not.toContain(
      "entities_embedding_idx"
    );

    // With the rotate open, the m2 boot passes; a second rotate refuses.
    await bootBackend("m2");
    const second = await openRotate(
      c,
      { model: "m3", dimensions: 6 },
      "downtime",
      ANN_MAX
    ).catch((caught: unknown) => caught);
    expect(second).toBeInstanceOf(GraphragError);
    expect(second).toMatchObject({ code: "INVALID_INPUT" });
  });

  it("dimension change: incoming column is the NEW width, old floats keep their column", async () => {
    const c = client!;
    await pgHarness.resetSchema(c);
    await c.query(`SET search_path TO "${SCHEMA}", public`);
    await bootBackend("m1");

    const state = await openRotate(
      c,
      { model: "m1", dimensions: 6 },
      "downtime",
      ANN_MAX
    );
    expect(state.incomingSlot).toBe("embedding_g2");
    expect(state.incoming?.dimensions).toBe(6);

    expect(await vectorWidth(c, "chunks", "embedding")).toBe(`vector(${DIM})`);
    expect(await vectorWidth(c, "chunks", "embedding_g2")).toBe("vector(6)");
    expect(await vectorWidth(c, "entities", "embedding_g2")).toBe("vector(6)");
    expect(await vectorWidth(c, "community_summaries", "embedding_g2")).toBe(
      "vector(6)"
    );

    // Incoming columns start empty (fill is T2/T4 work): nullable.
    const nullable = await c.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'community_summaries'
          AND column_name = 'embedding_g2'`,
      [SCHEMA]
    );
    expect(nullable.rows[0]?.is_nullable).toBe("YES");
  });

  it("existing store without the singleton backfills the catalog width, then refuses a changed desired", async () => {
    const c = client!;
    await pgHarness.resetSchema(c);
    await c.query(`SET search_path TO "${SCHEMA}", public`);
    await bootBackend("m1");
    // Simulate a store that predates the ledger singleton.
    await c.query(`DELETE FROM embedding_generation WHERE id = 1`);

    // Same physical width → backfill records (configured model, catalog
    // width) and boot proceeds.
    await bootBackend("m1");
    const seeded = await readGenerationState(c);
    expect(seeded).toMatchObject({
      activeSlot: "embedding",
      active: { model: "m1", dimensions: DIM },
    });

    // A differing desired against a pre-ledger store refuses boot and
    // never drops the live column (guard runs through the module seam).
    await c.query(`DELETE FROM embedding_generation WHERE id = 1`);
    const error = await guardEmbeddingBoot(c, {
      model: "m1",
      dimensions: 6,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConfigError);
    expect(await vectorWidth(c, "chunks", "embedding")).toBe(`vector(${DIM})`);
  });
});
