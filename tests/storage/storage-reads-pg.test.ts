import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { GraphragError } from "../../src/core/errors.js";
import { PgvectorBackend } from "../../src/core/storage/pgvector-backend.js";
import type { ChunkRecord } from "../../src/core/types.js";
import { createPgIntegrationHarness } from "../integration/pg-test-harness.js";

const DIM = 8;
const pgHarness = await createPgIntegrationHarness({
  label: "storage-reads-pg",
  testPath: "tests/storage/storage-reads-pg.test.ts",
  expectedCommand: "npx vitest run tests/storage/storage-reads-pg.test.ts",
  schemaPrefix: "storage_reads",
  defaultConnectionString: "postgresql://postgres@localhost/postgres",
  requiresVector: true,
});
const { schemaConnectionString: SCHEMA_URL, describePg } = pgHarness;

function embeddingAlongAxis(axis: number): number[] {
  const v = new Array<number>(DIM).fill(0);
  v[axis] = 1;
  return v;
}

function makeChunk(patch: Partial<ChunkRecord> & { id: string }): ChunkRecord {
  return {
    id: patch.id,
    content: patch.content ?? `content of ${patch.id}`,
    embedding: patch.embedding ?? embeddingAlongAxis(0),
    source_ref: patch.source_ref ?? "src/default",
    metadata: patch.metadata ?? {},
    valid_from: patch.valid_from ?? "2024-01-01T00:00:00Z",
    valid_until: patch.valid_until ?? null,
    created_at: patch.created_at ?? "2024-01-01T00:00:00Z",
  };
}

describePg("PgvectorBackend storage reads (T1)", () => {
  let client: pg.Client | undefined;
  let backend: PgvectorBackend | undefined;

  beforeAll(async () => {
    client = pgHarness.createClient(SCHEMA_URL);
    await client.connect();
    await pgHarness.resetSchema(client);
    backend = new PgvectorBackend(SCHEMA_URL, DIM, 2000);
    await backend.initialize();
  });

  afterAll(async () => {
    if (backend) await backend.close();
    if (client) {
      await pgHarness.dropSchema(client);
      await client.end();
    }
  });

  beforeEach(async () => {
    await client!.query("DELETE FROM entity_aliases");
    await client!.query("DELETE FROM entities");
    await client!.query("DELETE FROM chunks");
  });

  it("returns zero counts and empty pages on an empty store", async () => {
    await expect(backend!.counts()).resolves.toEqual({
      chunks: 0,
      entities: 0,
      invalidations: 0,
    });
    await expect(backend!.listChunks()).resolves.toMatchObject({
      items: [],
      total: 0,
    });
    await expect(backend!.listEntities()).resolves.toMatchObject({
      items: [],
      total: 0,
    });
    await expect(backend!.listTimeline()).resolves.toMatchObject({
      items: [],
      total: 0,
    });
  });

  it("counts chunks and live entities, and pages both", async () => {
    const firstId = randomUUID();
    const secondId = randomUUID();
    await backend!.upsert([
      makeChunk({
        id: firstId,
        created_at: "2024-01-01T00:00:00Z",
      }),
      makeChunk({
        id: secondId,
        created_at: "2024-02-01T00:00:00Z",
      }),
    ]);

    const liveId = randomUUID();
    const mergedAwayId = randomUUID();
    await client!.query(
      `INSERT INTO entities (id, canonical_name, type) VALUES ($1, $2, $3)`,
      [liveId, "Alice", "person"]
    );
    await client!.query(
      `INSERT INTO entities (id, canonical_name, type, merged_into) VALUES ($1, $2, $3, $4)`,
      [mergedAwayId, "Alice Alias", "person", liveId]
    );
    await client!.query(
      `INSERT INTO entity_aliases (id, entity_id, alias, alias_type)
       VALUES ($1, $2, $3, $4)`,
      [randomUUID(), liveId, "Al", "name"]
    );

    const counts = await backend!.counts();
    expect(counts.chunks).toBe(2);
    expect(counts.entities).toBe(1);

    const chunks = await backend!.listChunks({ limit: 1, offset: 0 });
    expect(chunks.total).toBe(2);
    expect(chunks.items).toHaveLength(1);
    expect(chunks.items[0]?.id).toBe(firstId);

    const entities = await backend!.listEntities();
    expect(entities.total).toBe(1);
    expect(entities.items[0]).toMatchObject({
      id: liveId,
      canonical_name: "Alice",
      type: "person",
      aliases: ["Al"],
    });
  });

  it("returns typed miss for unknown ids and INVALID_INPUT for blank ids", async () => {
    const known = randomUUID();
    await backend!.upsert([makeChunk({ id: known })]);
    const liveId = randomUUID();
    await client!.query(
      `INSERT INTO entities (id, canonical_name, type) VALUES ($1, $2, $3)`,
      [liveId, "Bob", "person"]
    );

    await expect(backend!.getChunk(randomUUID())).resolves.toEqual({
      ok: false,
      code: "NOT_FOUND",
    });
    await expect(backend!.getChunk("")).resolves.toEqual({
      ok: false,
      code: "INVALID_INPUT",
    });
    await expect(backend!.getEntity(randomUUID())).resolves.toEqual({
      ok: false,
      code: "NOT_FOUND",
    });
    await expect(backend!.getEntity("")).resolves.toEqual({
      ok: false,
      code: "INVALID_INPUT",
    });

    const chunkHit = await backend!.getChunk(known);
    expect(chunkHit).toMatchObject({ ok: true, value: { id: known } });
    const entityHit = await backend!.getEntity(liveId);
    expect(entityHit).toMatchObject({
      ok: true,
      value: { id: liveId, canonical_name: "Bob" },
    });
  });

  it("projects timeline events from valid_window and invalidation records", async () => {
    const openId = randomUUID();
    const closedId = randomUUID();
    await backend!.upsert([
      makeChunk({
        id: openId,
        valid_from: "2024-01-01T00:00:00Z",
        valid_until: null,
      }),
      makeChunk({
        id: closedId,
        source_ref: "src/closed",
        valid_from: "2024-01-02T00:00:00Z",
        valid_until: "2024-06-01T00:00:00Z",
      }),
    ]);
    await backend!.invalidateSourceRef(
      "src/closed",
      "2024-06-01T00:00:00Z",
      "t1-pg"
    );

    const counts = await backend!.counts();
    expect(counts.invalidations).toBe(1);
    const timeline = await backend!.listTimeline();
    expect(timeline.items.map((event) => event.kind)).toEqual(
      expect.arrayContaining([
        "chunk_valid_from",
        "chunk_valid_until",
        "invalidation",
      ])
    );
  });

  it("rejects illegal list pagination with GraphragError INVALID_INPUT", async () => {
    await expect(backend!.listEntities({ limit: 0 })).rejects.toBeInstanceOf(
      GraphragError
    );
    await expect(backend!.listTimeline({ offset: -1 })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });
});
