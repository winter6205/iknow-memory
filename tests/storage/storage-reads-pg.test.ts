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
    ...(patch.source_doc_id !== undefined
      ? { source_doc_id: patch.source_doc_id }
      : {}),
    ...(patch.ordinal !== undefined ? { ordinal: patch.ordinal } : {}),
  };
}

describePg("PgvectorBackend storage reads (T1)", () => {
  let client: pg.Client | undefined;
  let backend: PgvectorBackend | undefined;

  beforeAll(async () => {
    client = pgHarness.createClient(SCHEMA_URL);
    await client.connect();
    await pgHarness.resetSchema(client);
    backend = new PgvectorBackend(SCHEMA_URL, DIM, { annMaxDimensions: 2000 });
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
    await client!.query("DELETE FROM triples");
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
    await expect(backend!.listSourceDocs({ limit: 0 })).rejects.toBeInstanceOf(
      GraphragError
    );
    await expect(backend!.listSourceDocs({ offset: -1 })).rejects.toMatchObject(
      { code: "INVALID_INPUT" }
    );
  });

  it("lists 资料 summaries in created order WITHOUT the content body", async () => {
    const refA = `specs/t6/${randomUUID()}`;
    const refB = `specs/t6/${randomUUID()}`;
    await backend!.upsertSourceDoc({
      id: randomUUID(),
      source_ref: refA,
      title: "第一条",
      content: "full body one — must not appear in the list",
      created_at: "2026-01-01T00:00:00.000Z",
    });
    await backend!.upsertSourceDoc({
      id: randomUUID(),
      source_ref: refB,
      title: null,
      content: "full body two — must not appear in the list",
      created_at: "2026-01-02T00:00:00.000Z",
    });

    const page = await backend!.listSourceDocs({ limit: 100, offset: 0 });
    const ours = page.items.filter(
      (item) => item.source_ref === refA || item.source_ref === refB
    );
    expect(ours.map((item) => item.source_ref)).toEqual([refA, refB]);
    expect(ours[0]).toMatchObject({
      title: "第一条",
      valid_until: null,
    });
    expect(ours[1]!.title).toBeNull();
    // On-demand list: summaries only — no full-corpus body fetch.
    const serialized = JSON.stringify(ours);
    expect(serialized).not.toContain("full body one");
    expect(serialized).not.toContain("full body two");
  });

  it("persists 就绪 / 失败 status and derives chunk_count from back-pointers", async () => {
    // corpus-ready retrieve T3 against the real schema: status is a stored
    // column (not inferred), the count is a correlated COUNT over
    // chunks.source_doc_id (not a second mutable counter), and the
    // collection name is the single process-wide constant.
    const readyRef = `specs/t3/${randomUUID()}`;
    const readyId = randomUUID();
    await backend!.upsertSourceDoc({
      id: readyId,
      source_ref: readyRef,
      title: "就绪资料",
      content: "ready body",
      created_at: "2026-01-01T00:00:00.000Z",
    });
    await backend!.upsert([
      makeChunk({
        id: randomUUID(),
        source_ref: readyRef,
        source_doc_id: readyId,
        ordinal: 0,
      }),
      makeChunk({
        id: randomUUID(),
        source_ref: readyRef,
        source_doc_id: readyId,
        ordinal: 1,
      }),
    ]);
    await backend!.markSourceDocReady(readyId);

    const failedRef = `specs/t3/${randomUUID()}`;
    const failedId = randomUUID();
    await backend!.upsertSourceDoc({
      id: failedId,
      source_ref: failedRef,
      title: "失败资料",
      content: "failed body",
      created_at: "2026-01-02T00:00:00.000Z",
    });
    await backend!.recordSourceDocFailure(failedRef, "CONTENT_TOO_LARGE");

    const page = await backend!.listSourceDocs({ limit: 100, offset: 0 });
    const ready = page.items.find((item) => item.source_ref === readyRef);
    const failed = page.items.find((item) => item.source_ref === failedRef);
    expect(ready).toMatchObject({
      status: "ready",
      failure_code: null,
      chunk_count: 2,
      collection: "默认资料集合",
    });
    expect(failed).toMatchObject({
      status: "failed",
      failure_code: "CONTENT_TOO_LARGE",
      chunk_count: 0,
    });
    // A 资料 row written before the status columns existed reads as 进行中.
    const freshRef = `specs/t3/${randomUUID()}`;
    await client!.query(
      `INSERT INTO source_documents (id, source_ref, content)
         VALUES ($1, $2, $3)`,
      [randomUUID(), freshRef, "legacy row"]
    );
    const freshPage = await backend!.listSourceDocs({ limit: 100, offset: 0 });
    expect(
      freshPage.items.find((item) => item.source_ref === freshRef)
    ).toMatchObject({ status: "in_progress", chunk_count: 0 });
  });

  it("a plain re-upsert resets a previously 就绪 / 失败 资料 back to 进行中", async () => {
    // The push write path sends status in_progress on every 资料 upsert and
    // only calls markSourceDocReady after the chunk rows are durable. If the
    // upsert ignored that field (the earlier pending-ALTER schema had no
    // status column to write), a re-push would read 就绪 / 失败 throughout
    // the rebuild window — a status the store cannot back with rows.
    const readyRef = `specs/t3/${randomUUID()}`;
    const readyId = randomUUID();
    await backend!.upsertSourceDoc({
      id: readyId,
      source_ref: readyRef,
      title: "旧就绪",
      content: "old body",
      created_at: "2026-01-01T00:00:00.000Z",
    });
    await backend!.markSourceDocReady(readyId);

    await backend!.upsertSourceDoc({
      id: readyId,
      source_ref: readyRef,
      title: "新正文",
      content: "new body",
      created_at: "2026-01-02T00:00:00.000Z",
      status: "in_progress",
      failure_code: null,
    });
    const duringRebuild = await backend!.getSourceDoc(readyRef);
    if (!duringRebuild.ok) throw new Error("expected source doc");
    expect(duringRebuild.value.status).toBe("in_progress");
    expect(duringRebuild.value.failure_code).toBeNull();

    // Same contract for a 失败 资料: a re-push clears the failure code.
    const failedRef = `specs/t3/${randomUUID()}`;
    const failedId = randomUUID();
    await backend!.upsertSourceDoc({
      id: failedId,
      source_ref: failedRef,
      title: "旧失败",
      content: "blocked body",
      created_at: "2026-01-01T00:00:00.000Z",
    });
    await backend!.recordSourceDocFailure(failedRef, "INVALID_INPUT");

    await backend!.upsertSourceDoc({
      id: failedId,
      source_ref: failedRef,
      title: "重推",
      content: "retried body",
      created_at: "2026-01-02T00:00:00.000Z",
      status: "in_progress",
      failure_code: null,
    });
    const retried = await backend!.getSourceDoc(failedRef);
    if (!retried.ok) throw new Error("expected source doc");
    expect(retried.value.status).toBe("in_progress");
    expect(retried.value.failure_code).toBeNull();
  });

  it("exposes the four fields on the detail path and never invents a 资料 on failure", async () => {
    const ref = `specs/t3/${randomUUID()}`;
    const docId = randomUUID();
    await backend!.upsertSourceDoc({
      id: docId,
      source_ref: ref,
      title: "详情",
      content: "detail body",
      created_at: "2026-01-01T00:00:00.000Z",
    });
    await backend!.upsert([
      makeChunk({ id: randomUUID(), source_ref: ref, source_doc_id: docId }),
    ]);
    await backend!.markSourceDocReady(docId);

    const byRef = await backend!.getSourceDoc(ref);
    const byId = await backend!.getSourceDocById(docId);
    for (const read of [byRef, byId]) {
      expect(read.ok).toBe(true);
      if (!read.ok) throw new Error("expected source doc");
      expect(read.value).toMatchObject({
        collection: "默认资料集合",
        status: "ready",
        chunk_count: 1,
        failure_code: null,
      });
    }

    // Best-effort failure record: an unknown source_ref matches zero rows
    // and must NOT invent a row (matches the memory backend contract).
    const missingRef = `specs/t3/${randomUUID()}`;
    await backend!.recordSourceDocFailure(missingRef, "INVALID_INPUT");
    const missing = await backend!.getSourceDoc(missingRef);
    expect(missing).toEqual({ ok: false, code: "NOT_FOUND" });
  });

  it("exposes closed valid_until for an invalidated 资料", async () => {
    const ref = `specs/t6/${randomUUID()}`;
    const docId = randomUUID();
    await backend!.upsertSourceDoc({
      id: docId,
      source_ref: ref,
      title: "已失效",
      content: "stale body",
      created_at: "2026-01-01T00:00:00.000Z",
    });
    // invalidateSourceRef requires a matching chunk row; T5 closes the
    // 资料 window in the same transaction.
    await backend!.upsert([makeChunk({ id: randomUUID(), source_ref: ref })]);
    await backend!.invalidateSourceRef(
      ref,
      "2026-06-01T00:00:00.000Z",
      "t6-pg"
    );

    const page = await backend!.listSourceDocs({ limit: 100, offset: 0 });
    const hit = page.items.find((item) => item.source_ref === ref);
    expect(hit).toBeDefined();
    expect(hit!.valid_until).toBe("2026-06-01T00:00:00.000Z");
  });
});
