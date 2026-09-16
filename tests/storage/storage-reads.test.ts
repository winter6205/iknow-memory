import { describe, it, expect, beforeEach } from "vitest";

import { MemoryBackend } from "../../src/core/storage/memory-backend.js";
import { GraphragError } from "../../src/core/errors.js";
import type { ChunkRecord } from "../../src/core/types.js";

const TEST_DIM = 8;

function embeddingAlongAxis(axis: number): number[] {
  const v = new Array<number>(TEST_DIM).fill(0);
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

describe("MemoryBackend storage reads (T1)", () => {
  let backend: MemoryBackend;

  beforeEach(() => {
    backend = new MemoryBackend(TEST_DIM);
  });

  it("returns zero counts and empty pages on an empty store", async () => {
    await expect(backend.counts()).resolves.toEqual({
      chunks: 0,
      entities: 0,
      invalidations: 0,
    });
    await expect(backend.listChunks()).resolves.toMatchObject({
      items: [],
      total: 0,
      offset: 0,
    });
    await expect(backend.listEntities()).resolves.toMatchObject({
      items: [],
      total: 0,
    });
    await expect(backend.listTimeline()).resolves.toMatchObject({
      items: [],
      total: 0,
    });
  });

  it("counts stored chunks and pages them in ingest order", async () => {
    await backend.upsert([
      makeChunk({ id: "c-later", created_at: "2024-02-01T00:00:00Z" }),
      makeChunk({ id: "a-first", created_at: "2024-01-01T00:00:00Z" }),
    ]);

    await expect(backend.counts()).resolves.toMatchObject({
      chunks: 2,
      entities: 0,
    });

    const page = await backend.listChunks({ limit: 1, offset: 0 });
    expect(page.total).toBe(2);
    expect(page.limit).toBe(1);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.id).toBe("a-first");
    expect(page.items[0]?.source_ref).toBe("src/default");

    const rest = await backend.listChunks({ limit: 1, offset: 1 });
    expect(rest.items[0]?.id).toBe("c-later");
  });

  it("returns a typed miss for an unknown chunk id and INVALID_INPUT for a blank id", async () => {
    await backend.upsert([makeChunk({ id: "known" })]);

    await expect(backend.getChunk("missing")).resolves.toEqual({
      ok: false,
      code: "NOT_FOUND",
    });
    await expect(backend.getChunk("")).resolves.toEqual({
      ok: false,
      code: "INVALID_INPUT",
    });
    await expect(backend.getChunk("   ")).resolves.toEqual({
      ok: false,
      code: "INVALID_INPUT",
    });

    const hit = await backend.getChunk("known");
    expect(hit).toMatchObject({
      ok: true,
      value: { id: "known", content: "content of known" },
    });
  });

  it("returns a typed miss for every entity id in memory mode (empty entity ledger)", async () => {
    await expect(backend.getEntity("any-id")).resolves.toEqual({
      ok: false,
      code: "NOT_FOUND",
    });
    await expect(backend.getEntity("")).resolves.toEqual({
      ok: false,
      code: "INVALID_INPUT",
    });
  });

  it("projects timeline events from valid_window and invalidation records", async () => {
    await backend.upsert([
      makeChunk({
        id: "open",
        valid_from: "2024-01-01T00:00:00Z",
        valid_until: null,
      }),
      makeChunk({
        id: "closed",
        source_ref: "src/closed",
        valid_from: "2024-01-02T00:00:00Z",
        valid_until: "2024-06-01T00:00:00Z",
      }),
    ]);
    await backend.invalidateSourceRef(
      "src/closed",
      "2024-06-01T00:00:00Z",
      "t1-test"
    );

    const counts = await backend.counts();
    expect(counts.invalidations).toBe(1);

    const timeline = await backend.listTimeline();
    expect(timeline.total).toBeGreaterThanOrEqual(3);
    const kinds = timeline.items.map((event) => event.kind);
    expect(kinds).toContain("chunk_valid_from");
    expect(kinds).toContain("chunk_valid_until");
    expect(kinds).toContain("invalidation");
    const invalidation = timeline.items.find(
      (event) => event.kind === "invalidation"
    );
    expect(invalidation).toMatchObject({
      kind: "invalidation",
      chunk_id: "closed",
      triggered_by: "t1-test",
    });
  });

  it("rejects illegal list pagination with GraphragError INVALID_INPUT", async () => {
    await expect(backend.listChunks({ limit: 0 })).rejects.toBeInstanceOf(
      GraphragError
    );
    await expect(backend.listChunks({ offset: -1 })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(backend.listSourceDocs({ limit: 0 })).rejects.toBeInstanceOf(
      GraphragError
    );
    await expect(backend.listSourceDocs({ offset: -1 })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });
});

describe("MemoryBackend 资料 list (operator-console T6)", () => {
  let backend: MemoryBackend;

  beforeEach(() => {
    backend = new MemoryBackend(TEST_DIM);
  });

  it("returns an empty page on an empty store", async () => {
    await expect(backend.listSourceDocs()).resolves.toEqual({
      items: [],
      total: 0,
      limit: 20,
      offset: 0,
    });
  });

  it("lists 资料 summaries in creation order WITHOUT the content body", async () => {
    await backend.upsertSourceDoc({
      id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      source_ref: "docs/first.md",
      title: "第一条",
      content: "full body one — must not appear in the list",
      created_at: "2026-01-01T00:00:00.000Z",
    });
    await backend.upsertSourceDoc({
      id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      source_ref: "docs/second.md",
      title: null,
      content: "full body two — must not appear in the list",
      created_at: "2026-01-02T00:00:00.000Z",
    });

    const page = await backend.listSourceDocs();
    expect(page.total).toBe(2);
    expect(page.items.map((item) => item.source_ref)).toEqual([
      "docs/first.md",
      "docs/second.md",
    ]);
    const first = page.items[0]!;
    expect(first).toMatchObject({
      id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      title: "第一条",
      created_at: "2026-01-01T00:00:00.000Z",
      valid_until: null,
    });
    // On-demand list: summaries only — no full-corpus body fetch.
    expect(JSON.stringify(page.items)).not.toContain("full body one");
    expect(JSON.stringify(page.items)).not.toContain("full body two");
  });

  it("pages and exposes valid_until for invalidated rows", async () => {
    await backend.upsertSourceDoc({
      id: "cccccccc-cccc-cccc-cccc-cccccccccccc",
      source_ref: "docs/closed.md",
      title: "已失效",
      content: "stale body",
      created_at: "2026-01-01T00:00:00.000Z",
    });
    // invalidateSourceRef requires a matching chunk row; memory-mode T5
    // semantics close the 资料 window in the same transaction.
    await backend.upsert([
      makeChunk({
        id: "chunk-closed",
        source_ref: "docs/closed.md",
      }),
    ]);
    await backend.invalidateSourceRef(
      "docs/closed.md",
      "2026-06-01T00:00:00.000Z",
      "t6-test"
    );

    const page1 = await backend.listSourceDocs({ limit: 1, offset: 0 });
    expect(page1.total).toBe(1);
    expect(page1.items[0]).toMatchObject({
      source_ref: "docs/closed.md",
      valid_until: "2026-06-01T00:00:00.000Z",
    });
  });
});
