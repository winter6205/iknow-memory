/**
 * Real-Postgres proof for the embedding-generation ledger (T1).
 *
 * Pins the four facts the unit fakes cannot prove: the seed/backfill rows
 * really land, a boot refuse never drops the live vector column, openRotate
 * really creates the incoming `vector(N)` column + its own cosine HNSW index
 * on all three tables (entities included), and a concurrent second rotate is
 * refused against the live singleton. Skips loudly when Postgres/pgvector is
 * unavailable (tests/integration/pg-test-harness.ts convention).
 *
 * The second suite adds the T2 dual-write persist proofs: a chunk and an
 * entity written while a rotate is OPEN land in BOTH physical slots with
 * vectors from DIFFERENT generations (the (model, dims) pair each slot was
 * opened for), and `--backfill-embeddings` stays NULL-only on the active
 * slot, never filling the incoming column.
 */
import { randomUUID } from "node:crypto";
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
import {
  embedSlotVectors,
  type SlotEmbeddingSource,
} from "../../src/core/embed-slots.js";
import { FakeEmbedder, type EmbeddingClient } from "../../src/core/embedder.js";
import {
  persistOutputs,
  type ExtractPersistDeps,
} from "../../src/core/extraction/persist.js";
import { FakeLLMClient } from "../../src/core/extraction/llm-client.js";
import type { ExtractionOutput } from "../../src/core/extraction/types.js";
import { runCli, type CliDeps } from "../../src/cli/extract.js";
import type { ChunkRecord, EmbeddingGenerationPair } from "../../src/core/types.js";
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

// ─── T2: dual-write persist while a rotate is OPEN ────────────────────────

/** Deterministic width-DIM fake: the model tag makes the vector spaces differ. */
function tagEmbedder(tag: string): EmbeddingClient {
  return {
    modelId: tag,
    embed: async (texts: string[]) =>
      texts.map((text) => {
        const vector = new Array<number>(DIM).fill(text.length);
        vector[0] = tag.charCodeAt(0);
        vector[1] = tag.charCodeAt(1) ?? 0;
        return vector;
      }),
  };
}

function slotSourceFor(
  desiredModel: string
): { source: SlotEmbeddingSource; built: EmbeddingGenerationPair[] } {
  const built: EmbeddingGenerationPair[] = [];
  const source: SlotEmbeddingSource = {
    embedder: tagEmbedder(desiredModel),
    desired: { model: desiredModel, dimensions: DIM },
    buildEmbedder: (pair) => {
      built.push(pair);
      return tagEmbedder(pair.model ?? "none");
    },
  };
  return { source, built };
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

function chunkRecordFor(id: string, over: Partial<ChunkRecord> = {}): ChunkRecord {
  return {
    id,
    content: "Alice Smith works at Acme Corp",
    embedding: new Array<number>(DIM).fill(1),
    valid_from: "2026-01-01T00:00:00Z",
    valid_until: null,
    source_ref: `docs/t2-${id.slice(0, 8)}.md`,
    metadata: {},
    created_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

describePg("embedding generation dual-write persist (T2)", () => {
  let client: pg.Client | undefined;

  beforeAll(async () => {
    client = pgHarness.createClient(SCHEMA_URL);
    await client.connect();
  });

  afterAll(async () => {
    if (client) {
      await client.end();
      client = undefined;
    }
  });

  /** Fresh schema + m1 boot + an OPEN m2/dual_write rotate; returns the state. */
  async function openDualWriteRotate(
    c: pg.Client
  ): Promise<Awaited<ReturnType<typeof readGenerationState>>> {
    await pgHarness.resetSchema(c);
    await c.query(`SET search_path TO "${SCHEMA}", public`);
    await bootBackend("m1");
    return openRotate(c, { model: "m2", dimensions: DIM }, "dual_write", ANN_MAX);
  }

  it("chunk upsert persists both slots with vectors from DIFFERENT generations", async () => {
    const c = client!;
    const state = await openDualWriteRotate(c);
    expect(state?.incomingSlot).toBe("embedding_g2");

    // The T2 SSOT helper computes both slot batches (env == active m1 here).
    const { source, built } = slotSourceFor("m1");
    const batches = await embedSlotVectors(source, state, [
      "Alice Smith works at Acme Corp",
    ]);
    expect(built).toEqual([{ model: "m2", dimensions: DIM }]);

    const backend = new PgvectorBackend(SCHEMA_URL, DIM, ANN_MAX, {}, "m2");
    await backend.initialize();
    const id = randomUUID();
    await backend.upsert([
      chunkRecordFor(id, {
        embedding: batches.active[0]!,
        incoming_embedding: batches.incoming![0]!,
      }),
    ]);
    await backend.close();

    const row = await c.query<{
      embedding: string | null;
      embedding_g2: string | null;
    }>(
      `SELECT embedding::text AS embedding, embedding_g2::text AS embedding_g2
         FROM chunks WHERE id = $1`,
      [id]
    );
    expect(row.rows[0]?.embedding).not.toBeNull();
    expect(row.rows[0]?.embedding_g2).not.toBeNull();
    expect(row.rows[0]?.embedding_g2).not.toBe(row.rows[0]?.embedding);
  });

  it("entity insert during an open rotate dual-writes both slots", async () => {
    const c = client!;
    await openDualWriteRotate(c);

    const chunkId = randomUUID();
    await c.query(
      `INSERT INTO chunks (id, content, embedding, source_ref, valid_from,
                           metadata, created_at)
         VALUES ($1, $2, $3, $4, $5, '{}'::jsonb, $6)`,
      [
        chunkId,
        "Alice Smith works at Acme Corp",
        `[${new Array(DIM).fill(0).join(",")}]`,
        "docs/rotate-test.md",
        "2026-01-01T00:00:00Z",
        "2026-01-01T00:00:00Z",
      ]
    );

    const { source, built } = slotSourceFor("m1");
    const deps: ExtractPersistDeps = {
      embedder: tagEmbedder("m1"),
      slotEmbedding: source,
      logger: silentLogger(),
      now: () => "2026-01-01T00:00:00Z",
    };
    const output: ExtractionOutput = {
      head: "Alice Smith",
      headType: "person",
      relationRaw: "works at",
      relationNorm: "MEMBER_OF",
      tail: "Acme Corp",
      tailType: "system",
      description: "Alice Smith works at Acme Corp",
      evidenceSpan: "Alice Smith works at Acme Corp",
      confidence: 0.9,
    };
    await persistOutputs(
      deps,
      c,
      chunkId,
      "Alice Smith works at Acme Corp",
      [output],
      "2026-01-01T00:00:00Z"
    );

    const row = await c.query<{
      embedding: string | null;
      embedding_g2: string | null;
    }>(
      `SELECT embedding::text AS embedding, embedding_g2::text AS embedding_g2
         FROM entities WHERE canonical_name = 'Alice Smith'`
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0]?.embedding).not.toBeNull();
    expect(row.rows[0]?.embedding_g2).not.toBeNull();
    expect(row.rows[0]?.embedding_g2).not.toBe(row.rows[0]?.embedding);
    // Exactly one secondary build (the incoming pair), used per entity write.
    expect(built).toEqual([{ model: "m2", dimensions: DIM }]);
  });

  it("backfill with desired == active and non-NULL active vectors updates 0 rows and never fills the incoming slot", async () => {
    const c = client!;
    await openDualWriteRotate(c);

    const entityId = randomUUID();
    await c.query(
      `INSERT INTO entities (id, canonical_name, type, embedding, metadata, retired)
         VALUES ($1, 'Alice Smith', 'person', $2, '{}'::jsonb, false)`,
      [
        entityId,
        `[${new Array(DIM).fill(3).join(",")}]`,
      ]
    );

    const { source, built } = slotSourceFor("m1");
    const pool = new pg.Pool({ connectionString: SCHEMA_URL });
    const deps: CliDeps = {
      pool,
      llm: new FakeLLMClient({
        scripted: async () => {
          throw new Error("--backfill-embeddings must not call the LLM");
        },
      }),
      embedder: new FakeEmbedder(DIM),
      dims: DIM,
      logger: silentLogger(),
      slotEmbedding: source,
    };

    const code = await runCli(["--backfill-embeddings"], deps);
    await pool.end();

    expect(code).toBe(0);
    const row = await c.query<{ embedding_g2: string | null }>(
      `SELECT embedding_g2::text AS embedding_g2 FROM entities WHERE id = $1`,
      [entityId]
    );
    expect(row.rows[0]?.embedding_g2).toBeNull();
    // Backfill never embeds toward the incoming generation at all.
    expect(built).toEqual([]);
  });
});
