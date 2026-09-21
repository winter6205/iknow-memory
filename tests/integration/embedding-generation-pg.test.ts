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
 *
 * The third suite adds the T3 read-binding proof: before cutover, chunk
 * search, entity seed and community-summary cosine all rank on the ACTIVE
 * slot's vectors only — incoming-filled rows never surface or reorder.
 *
 * The fourth suite is the T4 live story: fill → completeness-gated cutover
 * → reads follow the flipped pointer → rollback → reads follow it back →
 * drop removes the inactive column, second drop no-ops — plus the downtime
 * read refuse and a dimension-change rotate proving the old floats are
 * never touched.
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
  cutoverRotate,
  dropInactiveSlot,
  fillIncoming,
  rollbackRotate,
} from "../../src/core/storage/embedding-rotate.js";
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
import type {
  ChunkRecord,
  EmbeddingGenerationPair,
} from "../../src/core/types.js";
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

async function bootBackend(
  model: string | undefined
): Promise<PgvectorBackend> {
  const backend = new PgvectorBackend(SCHEMA_URL, DIM, {
    annMaxDimensions: ANN_MAX,
    embedModel: model,
  });
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
    const rejecting = new PgvectorBackend(SCHEMA_URL, DIM, {
      annMaxDimensions: ANN_MAX,
      embedModel: "m2",
    });
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

function slotSourceFor(desiredModel: string): {
  source: SlotEmbeddingSource;
  built: EmbeddingGenerationPair[];
} {
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

function chunkRecordFor(
  id: string,
  over: Partial<ChunkRecord> = {}
): ChunkRecord {
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
    return openRotate(
      c,
      { model: "m2", dimensions: DIM },
      "dual_write",
      ANN_MAX
    );
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

    const backend = new PgvectorBackend(SCHEMA_URL, DIM, {
      annMaxDimensions: ANN_MAX,
      embedModel: "m2",
    });
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
      tailType: "organization",
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
      [entityId, `[${new Array(DIM).fill(3).join(",")}]`]
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

// ─── T3: cosine reads bound to the ACTIVE slot before cutover ─────────────

/** Width-DIM unit vector along axis `k` — makes cosine orderings exact. */
function axis(k: number): number[] {
  return new Array<number>(DIM).fill(0).map((_, i) => (i === k ? 1 : 0));
}

function vectorText(values: number[]): string {
  return `[${values.join(",")}]`;
}

describePg("embedding generation active-slot read binding (T3)", () => {
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

  it("before cutover, chunk/entity/community reads rank on ACTIVE vectors only", async () => {
    const c = client!;
    await pgHarness.resetSchema(c);
    await c.query(`SET search_path TO "${SCHEMA}", public`);
    await bootBackend("m1");
    const state = await openRotate(
      c,
      { model: "m2", dimensions: DIM },
      "dual_write",
      ANN_MAX
    );
    expect(state.incomingSlot).toBe("embedding_g2");

    // env == incoming: the process boots, and every read must stay on the
    // ACTIVE (legacy) slot until cutover.
    const backend = new PgvectorBackend(SCHEMA_URL, DIM, {
      annMaxDimensions: ANN_MAX,
      embedModel: "m2",
    });
    await backend.initialize();
    try {
      const validAt = "2026-06-01T00:00:00Z";
      const chunkA = randomUUID();
      const chunkB = randomUUID();
      // A is near the query on ACTIVE and far on incoming; B is the mirror.
      // If any read touched embedding_g2, B would outrank A.
      for (const [id, active, incoming] of [
        [chunkA, axis(0), axis(1)],
        [chunkB, axis(1), axis(0)],
      ] as const) {
        await c.query(
          `INSERT INTO chunks (id, content, embedding, embedding_g2, source_ref,
                               valid_from, metadata, created_at)
           VALUES ($1, 'rotate read binding', $2::vector, $3::vector,
                   'docs/rotate-read.md', '2026-01-01T00:00:00Z', '{}'::jsonb,
                   '2026-01-01T00:00:00Z')`,
          [id, vectorText(active), vectorText(incoming)]
        );
      }
      const hits = await backend.search(axis(0), { limit: 5, validAt });
      expect(hits.map((hit) => hit.id)).toEqual([chunkA, chunkB]);
      expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);

      // Entity with a NULL ACTIVE vector but a near incoming one must stay
      // invisible; the near-active entity ranks first regardless of the
      // incoming fill state.
      const entityY = randomUUID();
      const entityX = randomUUID();
      await c.query(
        `INSERT INTO entities (id, canonical_name, type, embedding, embedding_g2,
                               metadata, retired)
         VALUES ($1, 'Near Active', 'person', $2::vector, NULL, '{}'::jsonb, false),
                ($3, 'Incoming Only', 'person', NULL, $4::vector, '{}'::jsonb, false)`,
        [entityY, vectorText(axis(0)), entityX, vectorText(axis(0))]
      );
      const seeds = await backend.graphArmSeed.seedEntitiesByEmbedding(
        axis(0),
        5
      );
      expect(seeds.map((seed) => seed.id)).toEqual([entityY]);

      // Community summaries: same mirror trick — active decides the order.
      const sumP = randomUUID();
      const sumQ = randomUUID();
      await c.query(
        `INSERT INTO community_summaries (id, community_id, summary, entity_ids,
                                          level, embedding, embedding_g2)
         VALUES ($1, 'com-p', 'near active', '{}', 1, $2::vector, $3::vector),
                ($4, 'com-q', 'near incoming', '{}', 1, $5::vector, $6::vector)`,
        [
          sumP,
          vectorText(axis(0)),
          vectorText(axis(1)),
          sumQ,
          vectorText(axis(1)),
          vectorText(axis(0)),
        ]
      );
      const summaries =
        await backend.communitySummaries.searchCommunitySummaries(
          axis(0),
          5,
          2
        );
      expect(summaries.map((row) => row.id)).toEqual([sumP, sumQ]);

      // And the emitted SQL never names both slots (no mixed-generation
      // cosine) — proven exhaustively by the unit recording fakes in
      // tests/storage/pgvector-active-read.unit.test.ts.
    } finally {
      await backend.close();
    }
  });
});

// ─── T4: fill → cutover → reads flip → rollback → drop (live story) ───────

describePg("embedding generation rotate cutover/rollback/drop (T4)", () => {
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

  async function seedLegacyRows(c: pg.Client): Promise<{
    chunkA: string;
    chunkB: string;
    retiredId: string;
  }> {
    const chunkA = randomUUID();
    const chunkB = randomUUID();
    for (const [id, active] of [
      [chunkA, axis(0)],
      [chunkB, axis(1)],
    ] as const) {
      await c.query(
        `INSERT INTO chunks (id, content, embedding, source_ref, valid_from,
                             metadata, created_at)
         VALUES ($1, 'rotate lifecycle', $2::vector, 'docs/rotate-t4.md',
                 '2026-01-01T00:00:00Z', '{}'::jsonb, '2026-01-01T00:00:00Z')`,
        [id, vectorText(active)]
      );
    }
    await c.query(
      `INSERT INTO entities (id, canonical_name, type, embedding, metadata, retired)
       VALUES ($1, 'Alice Smith', 'person', $2::vector,
               '{"description":"works at Acme"}'::jsonb, false),
              ($3, 'Acme Corp', 'organization', $4::vector, '{}'::jsonb, false),
              ($5, 'Old Gone', 'person', $6::vector, '{}'::jsonb, true)`,
      [
        randomUUID(),
        vectorText(axis(0)),
        randomUUID(),
        vectorText(axis(1)),
        randomUUID(),
        vectorText(axis(0)),
      ]
    );
    const retired = await c.query<{ id: string }>(
      `SELECT id FROM entities WHERE canonical_name = 'Old Gone'`
    );
    await c.query(
      `INSERT INTO community_summaries (id, community_id, summary, entity_ids, level, embedding)
       VALUES ($1, 'com-t4', 'cluster about Acme', '{}', 1, $2::vector)`,
      [randomUUID(), vectorText(axis(0))]
    );
    return { chunkA, chunkB, retiredId: retired.rows[0]!.id };
  }

  it("full rotate story: refuse incomplete, fill incoming only, flip, read on the flip, roll back, drop, no-op", async () => {
    const c = client!;
    await pgHarness.resetSchema(c);
    await c.query(`SET search_path TO "${SCHEMA}", public`);
    await bootBackend("m1");
    const { chunkA, chunkB, retiredId } = await seedLegacyRows(c);
    const oldActive = await c.query<{ embedding: string }>(
      `SELECT embedding::text AS embedding FROM chunks WHERE id = $1`,
      [chunkA]
    );

    await openRotate(
      c,
      { model: "m2", dimensions: DIM },
      "dual_write",
      ANN_MAX
    );

    // (1) Cutover refuses typed while the incoming column is still empty,
    // naming the FIRST incomplete class (chunks) and its missing count.
    const refusal = await cutoverRotate(c).catch((caught: unknown) => caught);
    expect(refusal).toBeInstanceOf(GraphragError);
    expect(refusal).toMatchObject({ code: "INVALID_INPUT" });
    expect((refusal as Error).message).toContain("chunks");
    expect((refusal as Error).message).toContain("2");
    expect((await readGenerationState(c))?.activeSlot).toBe("embedding");

    // (2) Fill embeds only the incoming-IS-NULL rows toward the incoming
    // pair; the retired entity is out of scope; a second run fills nothing.
    const { source, built } = slotSourceFor("m1");
    const summary = await fillIncoming(c, source);
    expect(summary.perTable).toEqual({
      chunks: { scanned: 2, filled: 2 },
      entities: { scanned: 2, filled: 2 },
      community_summaries: { scanned: 1, filled: 1 },
    });
    expect(built).toEqual([{ model: "m2", dimensions: DIM }]);
    expect(
      (
        await c.query<{ embedding_g2: string | null }>(
          `SELECT embedding_g2::text AS embedding_g2 FROM entities WHERE id = $1`,
          [retiredId]
        )
      ).rows[0]?.embedding_g2
    ).toBeNull();
    const again = await fillIncoming(c, source);
    expect(again.perTable.chunks).toEqual({ scanned: 0, filled: 0 });
    expect(again.perTable.entities.filled).toBe(0);
    // Fill never rewrote the ACTIVE column.
    const afterFill = await c.query<{ embedding: string }>(
      `SELECT embedding::text AS embedding FROM chunks WHERE id = $1`,
      [chunkA]
    );
    expect(afterFill.rows[0]?.embedding).toBe(oldActive.rows[0]?.embedding);

    // (3) Cutover flips ALL three classes with one pointer move and records
    // the displaced generation as the rollback pair.
    const flipped = await cutoverRotate(c);
    expect(flipped.activeSlot).toBe("embedding_g2");
    expect(flipped.active).toEqual({ model: "m2", dimensions: DIM });
    expect(flipped.rollbackSlot).toBe("embedding");
    expect(flipped.rollback).toEqual({ model: "m1", dimensions: DIM });
    expect(flipped.incomingSlot).toBeNull();
    expect(flipped.rotateMode).toBeNull();

    // (4) Reads follow the flip: rank the incoming slot differently from
    // the legacy one — the live search must order by the NEW column.
    await c.query(`UPDATE chunks SET embedding_g2 = $2::vector WHERE id = $1`, [
      chunkA,
      vectorText(axis(1)),
    ]);
    await c.query(`UPDATE chunks SET embedding_g2 = $2::vector WHERE id = $1`, [
      chunkB,
      vectorText(axis(0)),
    ]);
    const newGen = new PgvectorBackend(SCHEMA_URL, DIM, {
      annMaxDimensions: ANN_MAX,
      embedModel: "m2",
    });
    await newGen.initialize();
    const stale = new PgvectorBackend(SCHEMA_URL, DIM, {
      annMaxDimensions: ANN_MAX,
      embedModel: "m1",
    });
    const oldGenRefused = await stale
      .initialize()
      .then(() => undefined)
      .catch((caught: unknown) => caught);
    await stale.close();
    expect(oldGenRefused).toBeInstanceOf(ConfigError); // old env no longer boots
    try {
      const hits = await newGen.search(axis(0), {
        limit: 5,
        validAt: "2026-06-01T00:00:00Z",
      });
      expect(hits.map((hit) => hit.id)).toEqual([chunkB, chunkA]);
    } finally {
      await newGen.close();
    }

    // (5) Rollback swaps active back; reads follow; the displaced
    // generation stays tracked.
    const rolled = await rollbackRotate(c);
    expect(rolled.activeSlot).toBe("embedding");
    expect(rolled.rollbackSlot).toBe("embedding_g2");
    const oldGen = new PgvectorBackend(SCHEMA_URL, DIM, {
      annMaxDimensions: ANN_MAX,
      embedModel: "m1",
    });
    await oldGen.initialize();
    try {
      const hits = await oldGen.search(axis(0), {
        limit: 5,
        validAt: "2026-06-01T00:00:00Z",
      });
      expect(hits.map((hit) => hit.id)).toEqual([chunkA, chunkB]);
    } finally {
      await oldGen.close();
    }

    // (6) Drop removes the inactive generation's index + column across all
    // three tables and clears the ledger; a second drop is a no-op.
    const dropped = await dropInactiveSlot(c);
    expect(dropped.droppedSlots).toEqual(["embedding_g2"]);
    for (const table of ["chunks", "entities", "community_summaries"]) {
      expect(await vectorWidth(c, table, "embedding_g2")).toBeUndefined();
      expect(await indexNames(c, table)).not.toContain(
        `${table}_embedding_g2_idx`
      );
      expect(await vectorWidth(c, table, "embedding")).toBe(`vector(${DIM})`);
    }
    const settled = await readGenerationState(c);
    expect(settled.rollbackSlot).toBeNull();
    expect(settled.rollback).toBeNull();
    const second = await dropInactiveSlot(c);
    expect(second.droppedSlots).toEqual([]);
    // The surviving generation's data is intact end to end.
    const kept = await c.query<{ embedding: string }>(
      `SELECT embedding::text AS embedding FROM chunks WHERE id = $1`,
      [chunkA]
    );
    expect(kept.rows[0]?.embedding).toBe(oldActive.rows[0]?.embedding);
  });

  // Review repair F: openRotate must refuse while a cutover-displaced
  // rollback generation still awaits its drop (cutover already refuses on
  // the same condition); after drop the next slot opens cleanly.
  it("openRotate refuses a pending rollback, then opens after drop", async () => {
    const c = client!;
    await pgHarness.resetSchema(c);
    await c.query(`SET search_path TO "${SCHEMA}", public`);
    await bootBackend("m1");
    await openRotate(
      c,
      { model: "m2", dimensions: DIM },
      "dual_write",
      ANN_MAX
    );
    await fillIncoming(c, slotSourceFor("m1").source);
    await cutoverRotate(c);

    const refusal = await openRotate(
      c,
      { model: "m3", dimensions: DIM },
      "dual_write",
      ANN_MAX
    ).catch((caught: unknown) => caught);
    expect(refusal).toBeInstanceOf(GraphragError);
    expect(refusal).toMatchObject({ code: "INVALID_INPUT" });
    expect((refusal as Error).message).toMatch(/drop/);
    // The refusal left the pending rollback column intact.
    expect(await vectorWidth(c, "chunks", "embedding")).toBe(`vector(${DIM})`);

    await dropInactiveSlot(c);
    const reopened = await openRotate(
      c,
      { model: "m3", dimensions: DIM },
      "dual_write",
      ANN_MAX
    );
    // embedding_g2 is live as ACTIVE, so the next free incoming skips it.
    expect(reopened.incomingSlot).toBe("embedding_g3");
    expect(await vectorWidth(c, "chunks", "embedding_g3")).toBe(
      `vector(${DIM})`
    );
  });

  it("downtime rotate refuses all three vector reads until cutover clears it", async () => {
    const c = client!;
    await pgHarness.resetSchema(c);
    await c.query(`SET search_path TO "${SCHEMA}", public`);
    await bootBackend("m1");
    await seedLegacyRows(c);
    await openRotate(c, { model: "m2", dimensions: DIM }, "downtime", ANN_MAX);

    const backend = new PgvectorBackend(SCHEMA_URL, DIM, {
      annMaxDimensions: ANN_MAX,
      embedModel: "m1",
    });
    await backend.initialize();
    try {
      for (const read of [
        () =>
          backend.search(axis(0), {
            limit: 5,
            validAt: "2026-06-01T00:00:00Z",
          }),
        () => backend.graphArmSeed.seedEntitiesByEmbedding(axis(0), 5),
        () =>
          backend.communitySummaries.searchCommunitySummaries(axis(0), 5, 2),
      ]) {
        const error = await read().catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(GraphragError);
        expect(error).toMatchObject({ code: "STORAGE_ERROR" });
        expect((error as Error).message).toBe(
          "embedding rotate downtime: vector retrieve refused until cutover"
        );
      }
    } finally {
      await backend.close();
    }

    // fill + cutover clear the blind window: the new-gen backend reads live.
    await fillIncoming(c, slotSourceFor("m1").source);
    await cutoverRotate(c);
    const after = new PgvectorBackend(SCHEMA_URL, DIM, {
      annMaxDimensions: ANN_MAX,
      embedModel: "m2",
    });
    await after.initialize();
    try {
      const hits = await after.search(axis(0), {
        limit: 5,
        validAt: "2026-06-01T00:00:00Z",
      });
      expect(hits.length).toBeGreaterThan(0);
    } finally {
      await after.close();
    }
  });

  it("dimension change: the incoming slot is the NEW width and the old floats stay byte-identical", async () => {
    const c = client!;
    await pgHarness.resetSchema(c);
    await c.query(`SET search_path TO "${SCHEMA}", public`);
    await bootBackend("m1");
    const chunk = randomUUID();
    await c.query(
      `INSERT INTO chunks (id, content, embedding, source_ref, valid_from,
                           metadata, created_at)
       VALUES ($1, 'rotate dim change', $2::vector, 'docs/rotate-t4-dim.md',
               '2026-01-01T00:00:00Z', '{}'::jsonb, '2026-01-01T00:00:00Z')`,
      [chunk, vectorText(axis(0))]
    );
    const before = await c.query<{ embedding: string }>(
      `SELECT embedding::text AS embedding FROM chunks WHERE id = $1`,
      [chunk]
    );

    await openRotate(c, { model: "m1", dimensions: 6 }, "downtime", ANN_MAX);
    expect(await vectorWidth(c, "chunks", "embedding_g2")).toBe("vector(6)");

    // Width-aware slot source: the secondary embeds at the RECORDED pair's
    // width, which is the whole point of a dimension rotate.
    const pairEmbedder = (pair: EmbeddingGenerationPair): EmbeddingClient => ({
      modelId: `${pair.model ?? "none"}-${pair.dimensions}`,
      embed: async (texts: string[]) =>
        texts.map(() => new Array<number>(pair.dimensions).fill(0.5)),
    });
    const source: SlotEmbeddingSource = {
      embedder: pairEmbedder({ model: "m1", dimensions: DIM }),
      desired: { model: "m1", dimensions: DIM },
      buildEmbedder: pairEmbedder,
    };
    const summary = await fillIncoming(c, source);
    expect(summary.perTable.chunks).toEqual({ scanned: 1, filled: 1 });

    await cutoverRotate(c);
    const six = new PgvectorBackend(SCHEMA_URL, 6, {
      annMaxDimensions: ANN_MAX,
      embedModel: "m1",
    });
    await six.initialize();
    try {
      const hits = await six.search(new Array<number>(6).fill(0.5), {
        limit: 5,
        validAt: "2026-06-01T00:00:00Z",
      });
      expect(hits.map((hit) => hit.id)).toEqual([chunk]);
    } finally {
      await six.close();
    }

    // Roll back to width 8: old floats untouched, reads work again.
    await rollbackRotate(c);
    const eight = new PgvectorBackend(SCHEMA_URL, DIM, {
      annMaxDimensions: ANN_MAX,
      embedModel: "m1",
    });
    await eight.initialize();
    try {
      const hits = await eight.search(axis(0), {
        limit: 5,
        validAt: "2026-06-01T00:00:00Z",
      });
      expect(hits[0]?.id).toBe(chunk);
    } finally {
      await eight.close();
    }
    const after = await c.query<{ embedding: string }>(
      `SELECT embedding::text AS embedding FROM chunks WHERE id = $1`,
      [chunk]
    );
    expect(after.rows[0]?.embedding).toBe(before.rows[0]?.embedding);

    // Drop removes the never-settled NEW generation.
    const dropped = await dropInactiveSlot(c);
    expect(dropped.droppedSlots).toEqual(["embedding_g2"]);
    expect(await vectorWidth(c, "chunks", "embedding_g2")).toBeUndefined();
    expect(await vectorWidth(c, "chunks", "embedding")).toBe(`vector(${DIM})`);
    const final = await c.query<{ embedding: string }>(
      `SELECT embedding::text AS embedding FROM chunks WHERE id = $1`,
      [chunk]
    );
    expect(final.rows[0]?.embedding).toBe(before.rows[0]?.embedding);
  });
});

// ─── Review repair A: entity merge reads the ledger's ACTIVE slot ─────────

describePg(
  "cross-generation entity read after cutover + drop (review repair A)",
  () => {
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

    /** Every text embeds to this unit vector, so L3 cosine is exactly 1.0. */
    const UNIT = new Array<number>(DIM).fill(1 / Math.sqrt(DIM));
    function constantEmbedder(): EmbeddingClient {
      return {
        modelId: "constant",
        embed: async (texts: string[]) => texts.map(() => [...UNIT]),
      };
    }

    it("extract merge survives the slot flip AND the legacy column drop", async () => {
      const c = client!;
      await pgHarness.resetSchema(c);
      await c.query(`SET search_path TO "${SCHEMA}", public`);
      await bootBackend("m1");
      await openRotate(
        c,
        { model: "m2", dimensions: DIM },
        "dual_write",
        ANN_MAX
      );

      // Two mergeable entities, BOTH slots filled (the cutover gate must
      // pass without a fill run): the L3 survivor "Alice Smith" and the
      // L0-exact "Acme Corp". The unit vector equals what the constant
      // embedder will produce for the incoming endpoints.
      const unitLiteral = vectorText(UNIT);
      const survivorId = randomUUID();
      await c.query(
        `INSERT INTO entities (id, canonical_name, type, embedding, embedding_g2,
                               metadata, retired)
         VALUES ($1, 'Alice Smith', 'person', $3::vector, $3::vector,
                 '{"description":"Alicia Smith works at Acme Corp"}'::jsonb, false),
                ($2, 'Acme Corp', 'organization', $3::vector, $3::vector,
                 '{}'::jsonb, false)`,
        [survivorId, randomUUID(), unitLiteral]
      );
      const chunkId = randomUUID();
      await c.query(
        `INSERT INTO chunks (id, content, embedding, embedding_g2, source_ref,
                             valid_from, metadata, created_at)
         VALUES ($1, 'Alicia Smith works at Acme Corp', $2::vector, $2::vector,
                 'docs/repair-a.md', '2026-01-01T00:00:00Z', '{}'::jsonb,
                 '2026-01-01T00:00:00Z')`,
        [chunkId, unitLiteral]
      );

      // Flip to embedding_g2, then DROP the legacy column: after this the
      // hardcoded `embedding::text` read would be a column-not-found crash.
      const flipped = await cutoverRotate(c);
      expect(flipped.activeSlot).toBe("embedding_g2");
      const dropped = await dropInactiveSlot(c);
      expect(dropped.droppedSlots).toEqual(["embedding"]);
      expect(await vectorWidth(c, "entities", "embedding")).toBeUndefined();

      // The persist path runs with env == the NEW generation, no rotate
      // open. Head merges into the survivor via L3 — which only happens if
      // the candidate read returned the survivor's embedding_g2 vector.
      const deps: ExtractPersistDeps = {
        embedder: constantEmbedder(),
        logger: silentLogger(),
        now: () => "2026-01-01T00:00:00Z",
      };
      const output: ExtractionOutput = {
        head: "Alicia Smith",
        headType: "person",
        relationRaw: "works at",
        relationNorm: "MEMBER_OF",
        tail: "Acme Corp",
        tailType: "organization",
        description: "Alicia Smith works at Acme Corp",
        evidenceSpan: "Alicia Smith works at Acme Corp",
        confidence: 0.9,
      };
      const counts = await persistOutputs(
        deps,
        c,
        chunkId,
        "Alicia Smith works at Acme Corp",
        [output],
        "2026-01-01T00:00:00Z"
      );
      expect(counts.triples).toBe(1);
      expect(counts.mergedLoserIds).toHaveLength(1);

      // L3 loser row: pointer set, and its vectors landed in the NEW slot.
      const loser = await c.query<{
        merged_into: string | null;
        embedding_g2: string | null;
      }>(
        `SELECT merged_into, embedding_g2::text AS embedding_g2
           FROM entities WHERE canonical_name = 'Alicia Smith'`
      );
      expect(loser.rows).toHaveLength(1);
      expect(loser.rows[0]?.merged_into).toBe(survivorId);
      expect(loser.rows[0]?.embedding_g2).not.toBeNull();

      // A8 first-write-wins: the survivor is untouched.
      const survivor = await c.query<{ canonical_name: string }>(
        `SELECT canonical_name FROM entities WHERE id = $1`,
        [survivorId]
      );
      expect(survivor.rows[0]?.canonical_name).toBe("Alice Smith");
    });
  }
);
