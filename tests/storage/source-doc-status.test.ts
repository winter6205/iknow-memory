/**
 * T3 (corpus-ready retrieve) — persisted 资料 status + successful chunk count.
 *
 * The 资料页 four fields are: collection name, 资料 identity, status
 * (进行中 / 就绪 / 失败), successful chunk count. Status is PERSISTED, not
 * inferred from `valid_until`: a push sets 进行中, a push that lands ≥1
 * successful chunk sets 就绪, and a failed push records 失败 with a stable
 * code. The count is DERIVED from `chunks.source_doc_id` back-pointers —
 * never a second mutable counter that could drift from the rows.
 */
import { describe, expect, it } from "vitest";

import { MemoryBackend } from "../../src/core/storage/memory-backend.js";
import { GraphragError } from "../../src/core/errors.js";
import {
  SOURCE_DOC_STATUS,
  SOURCE_DOC_COLLECTION_NAME,
  type ChunkRecord,
  type SourceDocRecord,
} from "../../src/core/types.js";

const TEST_DIM = 8;
const NOW = "2026-01-01T00:00:00.000Z";

function makeChunk(
  patch: Partial<ChunkRecord> & { id: string; source_doc_id: string }
): ChunkRecord {
  return {
    id: patch.id,
    content: patch.content ?? `content of ${patch.id}`,
    embedding: patch.embedding ?? new Array<number>(TEST_DIM).fill(0.5),
    source_ref: patch.source_ref ?? "docs/a.md",
    metadata: patch.metadata ?? {},
    valid_from: patch.valid_from ?? NOW,
    valid_until: patch.valid_until ?? null,
    created_at: patch.created_at ?? NOW,
    source_doc_id: patch.source_doc_id,
    ordinal: patch.ordinal ?? 0,
  };
}

function makeDoc(
  patch: Partial<SourceDocRecord> & { id: string; source_ref: string }
): SourceDocRecord {
  return {
    id: patch.id,
    source_ref: patch.source_ref,
    title: patch.title ?? null,
    content: patch.content ?? "body",
    created_at: patch.created_at ?? NOW,
    ...(patch.status !== undefined ? { status: patch.status } : {}),
  };
}

describe("MemoryBackend 资料 status (corpus-ready retrieve T3)", () => {
  it("a freshly written 资料 defaults to 进行中", async () => {
    const backend = new MemoryBackend(TEST_DIM);
    await backend.upsertSourceDoc(
      makeDoc({ id: "d1", source_ref: "docs/a.md" })
    );

    const read = await backend.getSourceDoc("docs/a.md");
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error("expected source doc");
    expect(read.value.status).toBe(SOURCE_DOC_STATUS.IN_PROGRESS);
    expect(read.value.failure_code).toBeNull();
  });

  it("就绪 pairs with a derived count of ≥1 chunk row", async () => {
    const backend = new MemoryBackend(TEST_DIM);
    await backend.upsertSourceDoc(
      makeDoc({ id: "d1", source_ref: "docs/a.md" })
    );

    // 进行中 with zero rows: the page must not be able to claim 就绪 yet
    // (CONTEXT 资料集合: ready means status ready AND count ≥ 1).
    const before = await backend.getSourceDoc("docs/a.md");
    if (!before.ok) throw new Error("expected source doc");
    expect(before.value.status).toBe(SOURCE_DOC_STATUS.IN_PROGRESS);
    expect(before.value.chunk_count).toBe(0);

    await backend.markSourceDocReady("d1");
    await backend.upsert([makeChunk({ id: "c1", source_doc_id: "d1" })]);
    const after = await backend.getSourceDoc("docs/a.md");
    if (!after.ok) throw new Error("expected source doc");
    expect(after.value.status).toBe(SOURCE_DOC_STATUS.READY);
    expect(after.value.chunk_count).toBe(1);
  });

  it("records 失败 with the stable code and keeps it across later reads", async () => {
    const backend = new MemoryBackend(TEST_DIM);
    await backend.upsertSourceDoc(
      makeDoc({ id: "d1", source_ref: "docs/a.md" })
    );

    await backend.recordSourceDocFailure("docs/a.md", "INVALID_INPUT");
    const read = await backend.getSourceDoc("docs/a.md");
    if (!read.ok) throw new Error("expected source doc");
    expect(read.value.status).toBe(SOURCE_DOC_STATUS.FAILED);
    expect(read.value.failure_code).toBe("INVALID_INPUT");
  });

  it("a successful re-push clears a previous 失败 record", async () => {
    const backend = new MemoryBackend(TEST_DIM);
    await backend.upsertSourceDoc(
      makeDoc({ id: "d1", source_ref: "docs/a.md" })
    );
    await backend.recordSourceDocFailure("docs/a.md", "CONTENT_TOO_LARGE");

    await backend.upsertSourceDoc(
      makeDoc({ id: "d1", source_ref: "docs/a.md" })
    );
    await backend.markSourceDocReady("d1");
    const read = await backend.getSourceDoc("docs/a.md");
    if (!read.ok) throw new Error("expected source doc");
    expect(read.value.status).toBe(SOURCE_DOC_STATUS.READY);
    expect(read.value.failure_code).toBeNull();
  });

  it("a declared in_progress re-upsert resets 就绪 / 失败 back to 进行中", async () => {
    // The push path declares 进行中 on every 资料 write and only marks
    // 就绪 after the chunk rows land. The pg backend honours that; this
    // pins the memory backend to the same contract so the two do not
    // diverge (the pg side is pinned in storage-reads-pg.test.ts).
    const backend = new MemoryBackend(TEST_DIM);
    await backend.upsertSourceDoc(
      makeDoc({ id: "d1", source_ref: "docs/a.md" })
    );
    await backend.markSourceDocReady("d1");

    await backend.upsertSourceDoc(
      makeDoc({
        id: "d1",
        source_ref: "docs/a.md",
        content: "new body",
        status: SOURCE_DOC_STATUS.IN_PROGRESS,
      })
    );
    const rebuild = await backend.getSourceDoc("docs/a.md");
    if (!rebuild.ok) throw new Error("expected source doc");
    expect(rebuild.value.status).toBe(SOURCE_DOC_STATUS.IN_PROGRESS);
    expect(rebuild.value.failure_code).toBeNull();
  });

  it("an UNDECLARED status upsert leaves a 就绪 资料 untouched", async () => {
    // `ingest` predates T3 and declares no status. That write must not
    // silently downgrade a 资料 that a push already landed.
    const backend = new MemoryBackend(TEST_DIM);
    await backend.upsertSourceDoc(
      makeDoc({ id: "d1", source_ref: "docs/a.md" })
    );
    await backend.markSourceDocReady("d1");

    await backend.upsertSourceDoc(
      makeDoc({ id: "d1", source_ref: "docs/a.md", content: "ingest body" })
    );
    const read = await backend.getSourceDoc("docs/a.md");
    if (!read.ok) throw new Error("expected source doc");
    expect(read.value.status).toBe(SOURCE_DOC_STATUS.READY);
  });

  it("recording a failure for an UNKNOWN source_ref never invents a row", async () => {
    const backend = new MemoryBackend(TEST_DIM);
    await backend.recordSourceDocFailure(
      "docs/never-pushed.md",
      "INVALID_INPUT"
    );

    const read = await backend.getSourceDoc("docs/never-pushed.md");
    expect(read).toEqual({ ok: false, code: "NOT_FOUND" });
    const page = await backend.listSourceDocs();
    expect(page.total).toBe(0);
  });

  it("rejects a blank source_ref with INVALID_INPUT", async () => {
    const backend = new MemoryBackend(TEST_DIM);
    await expect(
      backend.recordSourceDocFailure("  ", "INVALID_INPUT")
    ).rejects.toBeInstanceOf(GraphragError);
  });
});

describe("MemoryBackend 资料 chunk count (derived, corpus-ready retrieve T3)", () => {
  it("counts zero chunks for a fresh 资料 and N after N rows land", async () => {
    const backend = new MemoryBackend(TEST_DIM);
    await backend.upsertSourceDoc(
      makeDoc({ id: "d1", source_ref: "docs/a.md" })
    );

    const empty = await backend.listSourceDocs();
    expect(empty.items[0]?.chunk_count).toBe(0);

    await backend.upsert([
      makeChunk({ id: "c1", source_doc_id: "d1", ordinal: 0 }),
      makeChunk({ id: "c2", source_doc_id: "d1", ordinal: 1 }),
      makeChunk({ id: "c3", source_doc_id: "d1", ordinal: 2 }),
    ]);
    const filled = await backend.listSourceDocs();
    expect(filled.items[0]?.chunk_count).toBe(3);
  });

  it("ignores chunk rows that belong to another 资料", async () => {
    const backend = new MemoryBackend(TEST_DIM);
    await backend.upsertSourceDoc(
      makeDoc({ id: "d1", source_ref: "docs/a.md" })
    );
    await backend.upsertSourceDoc(
      makeDoc({ id: "d2", source_ref: "docs/b.md" })
    );
    await backend.upsert([
      makeChunk({ id: "c1", source_doc_id: "d2" }),
      makeChunk({ id: "c2", source_doc_id: "d2", ordinal: 1 }),
    ]);

    const page = await backend.listSourceDocs();
    expect(page.items.map((item) => item.chunk_count)).toEqual([0, 2]);
  });

  it("exposes the single process-wide 资料集合 name on every summary", async () => {
    const backend = new MemoryBackend(TEST_DIM);
    await backend.upsertSourceDoc(
      makeDoc({ id: "d1", source_ref: "docs/a.md" })
    );
    const page = await backend.listSourceDocs();
    expect(page.items[0]?.collection).toBe(SOURCE_DOC_COLLECTION_NAME);
  });

  it("exposes status / chunk_count / collection on the detail view too", async () => {
    const backend = new MemoryBackend(TEST_DIM);
    await backend.upsertSourceDoc(
      makeDoc({ id: "d1", source_ref: "docs/a.md" })
    );
    await backend.upsert([makeChunk({ id: "c1", source_doc_id: "d1" })]);
    await backend.markSourceDocReady("d1");

    const byRef = await backend.getSourceDoc("docs/a.md");
    const byId = await backend.getSourceDocById("d1");
    for (const read of [byRef, byId]) {
      if (!read.ok) throw new Error("expected source doc");
      expect(read.value.collection).toBe(SOURCE_DOC_COLLECTION_NAME);
      expect(read.value.status).toBe(SOURCE_DOC_STATUS.READY);
      expect(read.value.chunk_count).toBe(1);
    }
  });
});
