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
  });
});
