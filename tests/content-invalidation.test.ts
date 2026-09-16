import { describe, expect, it } from "vitest";

import { FakeEmbedder } from "../src/core/embedder.js";
import { GraphragError } from "../src/core/errors.js";
import { MemoryBackend } from "../src/core/storage/memory-backend.js";
import type { StorageBackend } from "../src/core/types.js";
import { createIngestHandler, IngestInputSchema } from "../src/tools/ingest.js";
import { createReadSourceHandler } from "../src/tools/read_source.js";
import {
  createInvalidationHandler,
  InvalidationInputSchema,
} from "../src/tools/invalidation.js";

const TEST_DIM = 32;
const SOURCE_REF = "t6/invalidation";
const CONTENT = "content that will be invalidated";
const BEFORE_INVALIDATION = "2026-08-31T11:59:59.999Z";
const INVALIDATED_AT = "2026-08-31T12:00:00.000Z";
const AFTER_INVALIDATION = "2026-08-31T12:00:00.001Z";

function makeDeps(): {
  embedder: FakeEmbedder;
  storage: MemoryBackend;
} {
  return {
    embedder: new FakeEmbedder(TEST_DIM),
    storage: new MemoryBackend(TEST_DIM),
  };
}

function textOf(result: { content: unknown }): string {
  return (result.content as Array<{ type: string; text?: string }>)
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("");
}

function invalidationPayload(result: { content: unknown }): {
  invalidated_chunk_ids: string[];
  invalidations: Array<{
    chunk_id: string;
    invalidated_at: string;
    triggered_by: string;
  }>;
} {
  return JSON.parse(textOf(result)) as {
    invalidated_chunk_ids: string[];
    invalidations: Array<{
      chunk_id: string;
      invalidated_at: string;
      triggered_by: string;
    }>;
  };
}

async function queryContent(
  deps: ReturnType<typeof makeDeps>,
  validAt: string
) {
  const [embedding] = await deps.embedder.embed([CONTENT]);
  return deps.storage.search(embedding!, { limit: 100, validAt });
}

/**
 * Operator-console T5: content invalidation targets the 资料 AND its
 * derived chunks. Closing the chunk windows alone is not enough — the
 * source_documents row gets its validity window closed in the same
 * invalidate call so `read_source` can answer with a named-invalid miss
 * while every row stays physically present (no delete this wave).
 */
describe("T5 invalidate closes the 资料 window, keeps rows", () => {
  const BODY = "alpha middle omega";
  const SLICES = [
    { content: "alpha", index: 0 },
    { content: "middle", index: 1 },
    { content: "omega", index: 2 },
  ];

  async function seedEnvelope(
    deps: ReturnType<typeof makeDeps>,
    sourceRef: string,
    slices: Array<{ content: string; index: number }> = [
      { content: "content that will be invalidated", index: 0 },
    ]
  ): Promise<{ source_doc_id: string; chunk_ids: string[] }> {
    const result = await createIngestHandler(deps)({
      source_ref: sourceRef,
      content: slices.length === 1 ? slices[0]!.content : BODY,
      chunks: slices,
    });
    return JSON.parse(textOf(result)) as {
      source_doc_id: string;
      chunk_ids: string[];
    };
  }

  it("closes the 资料 window with the chunk windows (one-slice)", async () => {
    const deps = makeDeps();
    const seeded = await seedEnvelope(deps, SOURCE_REF);

    const invalidated = invalidationPayload(
      await createInvalidationHandler(deps)({
        source_ref: SOURCE_REF,
        invalidated_at: INVALIDATED_AT,
        triggered_by: "fin",
      })
    );
    expect(invalidated.invalidated_chunk_ids).toEqual(seeded.chunk_ids);

    // The 资料 row's window is closed at the same instant.
    const doc = await deps.storage.getSourceDoc(SOURCE_REF);
    expect(doc.ok).toBe(true);
    if (!doc.ok) throw new Error("expected source doc");
    expect(doc.value.valid_until).toBe(INVALIDATED_AT);

    // Retrieve omits the slice after the close.
    expect(await queryContent(deps, AFTER_INVALIDATION)).toEqual([]);
  });

  it("closes every derived chunk window (multi-slice)", async () => {
    const deps = makeDeps();
    await seedEnvelope(deps, SOURCE_REF, SLICES);

    const invalidated = invalidationPayload(
      await createInvalidationHandler(deps)({
        source_ref: SOURCE_REF,
        invalidated_at: INVALIDATED_AT,
        triggered_by: "fin",
      })
    );
    expect(invalidated.invalidated_chunk_ids).toHaveLength(SLICES.length);

    const doc = await deps.storage.getSourceDoc(SOURCE_REF);
    expect(doc.ok).toBe(true);
    if (!doc.ok) throw new Error("expected source doc");
    expect(doc.value.valid_until).toBe(INVALIDATED_AT);

    const chunks = await deps.storage.listChunksBySourceDoc(doc.value.id);
    expect(chunks.map((chunk) => chunk.valid_until)).toEqual(
      SLICES.map(() => INVALIDATED_AT)
    );
    expect(await queryContent(deps, AFTER_INVALIDATION)).toEqual([]);
  });

  it("read_source answers a named-invalid after invalidate, rows still SELECT-able", async () => {
    const deps = makeDeps();
    const seeded = await seedEnvelope(deps, SOURCE_REF);
    await createInvalidationHandler(deps)({
      source_ref: SOURCE_REF,
      invalidated_at: INVALIDATED_AT,
      triggered_by: "fin",
    });

    const read = await createReadSourceHandler({ storage: deps.storage })({
      source_ref: SOURCE_REF,
    });
    expect(read.isError).toBe(true);
    const body = JSON.parse(textOf(read)) as Record<string, unknown>;
    expect(body.error).toBe("read_source_invalidated");
    expect(body.source_ref).toBe(SOURCE_REF);
    expect(body.id).toBe(seeded.source_doc_id);
    expect(body.valid_until).toBe(INVALIDATED_AT);

    // No physical delete: the 资料 row and its chunk rows are still there.
    const doc = await deps.storage.getSourceDoc(SOURCE_REF);
    expect(doc.ok).toBe(true);
    if (!doc.ok) throw new Error("expected source doc");
    const chunks = await deps.storage.listChunksBySourceDoc(doc.value.id);
    expect(chunks).toHaveLength(1);
  });

  it("read_source by id answers the same named-invalid", async () => {
    const deps = makeDeps();
    const seeded = await seedEnvelope(deps, SOURCE_REF);
    await createInvalidationHandler(deps)({
      source_ref: SOURCE_REF,
      invalidated_at: INVALIDATED_AT,
      triggered_by: "fin",
    });

    const read = await createReadSourceHandler({ storage: deps.storage })({
      id: seeded.source_doc_id,
    });
    expect(read.isError).toBe(true);
    const body = JSON.parse(textOf(read)) as Record<string, unknown>;
    expect(body.error).toBe("read_source_invalidated");
    expect(body.id).toBe(seeded.source_doc_id);
    expect(body.source_ref).toBe(SOURCE_REF);
  });

  it("repeating the same invalidate leaves the 资料 window unchanged", async () => {
    const deps = makeDeps();
    await seedEnvelope(deps, SOURCE_REF);
    const request = {
      source_ref: SOURCE_REF,
      invalidated_at: INVALIDATED_AT,
      triggered_by: "fin",
    };
    const invalidate = createInvalidationHandler(deps);
    const first = invalidationPayload(await invalidate(request));
    const second = invalidationPayload(await invalidate(request));

    expect(second).toEqual(first);
    const doc = await deps.storage.getSourceDoc(SOURCE_REF);
    expect(doc.ok).toBe(true);
    if (!doc.ok) throw new Error("expected source doc");
    expect(doc.value.valid_until).toBe(INVALIDATED_AT);
    await expect(
      deps.storage.listInvalidations(SOURCE_REF)
    ).resolves.toHaveLength(1);
  });

  it("re-pushing the same content keeps the closed 资料 window; different content reopens it", async () => {
    const deps = makeDeps();
    const ingest = createIngestHandler(deps);
    await seedEnvelope(deps, SOURCE_REF);
    await createInvalidationHandler(deps)({
      source_ref: SOURCE_REF,
      invalidated_at: INVALIDATED_AT,
      triggered_by: "fin",
    });

    // Same content re-push: the 资料 stays closed (mirrors the chunk-level
    // preserveInvalidationState rule).
    await ingest({
      source_ref: SOURCE_REF,
      content: "content that will be invalidated",
      chunks: [{ content: "content that will be invalidated", index: 0 }],
    });
    const closedDoc = await deps.storage.getSourceDoc(SOURCE_REF);
    expect(closedDoc.ok).toBe(true);
    if (!closedDoc.ok) throw new Error("expected source doc");
    expect(closedDoc.value.valid_until).toBe(INVALIDATED_AT);
    expect(await queryContent(deps, AFTER_INVALIDATION)).toEqual([]);

    // Different content: a fresh content version reopens the 资料 window
    // and the new slices are retrievable again. The re-push stamps
    // valid_from = now, so the query time must be past that.
    await ingest({
      source_ref: SOURCE_REF,
      content: BODY,
      chunks: SLICES,
    });
    const reopenedDoc = await deps.storage.getSourceDoc(SOURCE_REF);
    expect(reopenedDoc.ok).toBe(true);
    if (!reopenedDoc.ok) throw new Error("expected source doc");
    expect(reopenedDoc.value.valid_until).toBeNull();
    const hits = await queryContent(deps, "2099-01-01T00:00:00.000Z");
    expect(hits).toHaveLength(SLICES.length);
  });
});

describe("T6 content invalidation", () => {
  it("closes the window at the invalidation instant and leaves a queryable record", async () => {
    const deps = makeDeps();
    const ingest = createIngestHandler(deps);
    const invalidate = createInvalidationHandler(deps);
    const ingested = await ingest({
      content: CONTENT,
      source_ref: SOURCE_REF,
      valid_from: "2026-01-01T00:00:00.000Z",
    });
    const chunkId = JSON.parse(textOf(ingested)).chunk_ids[0] as string;

    const before = await queryContent(deps, BEFORE_INVALIDATION);
    const invalidated = await invalidate({
      source_ref: SOURCE_REF,
      invalidated_at: INVALIDATED_AT,
      triggered_by: "fin",
    });
    const atInstant = await queryContent(deps, INVALIDATED_AT);
    const after = await queryContent(deps, AFTER_INVALIDATION);

    expect(before.map((chunk) => chunk.id)).toEqual([chunkId]);
    expect(atInstant).toEqual([]);
    expect(after).toEqual([]);

    const payload = invalidationPayload(invalidated);
    expect(payload.invalidated_chunk_ids).toEqual([chunkId]);
    expect(payload.invalidations).toEqual([
      {
        chunk_id: chunkId,
        invalidated_at: INVALIDATED_AT,
        triggered_by: "fin",
      },
    ]);
    await expect(deps.storage.listInvalidations(SOURCE_REF)).resolves.toEqual(
      payload.invalidations
    );
  });

  it("repeating the same invalidation request is idempotent", async () => {
    const deps = makeDeps();
    const invalidate = createInvalidationHandler(deps);
    await createIngestHandler(deps)({
      content: CONTENT,
      source_ref: SOURCE_REF,
    });
    const request = {
      source_ref: SOURCE_REF,
      invalidated_at: INVALIDATED_AT,
      triggered_by: "fin",
    };

    const first = invalidationPayload(await invalidate(request));
    const second = invalidationPayload(await invalidate(request));

    expect(second).toEqual(first);
    await expect(
      deps.storage.listInvalidations(SOURCE_REF)
    ).resolves.toHaveLength(1);
  });

  it("does not reopen a closed row when the same content is re-pushed", async () => {
    const deps = makeDeps();
    const ingest = createIngestHandler(deps);
    const invalidate = createInvalidationHandler(deps);
    await ingest({
      content: CONTENT,
      source_ref: SOURCE_REF,
      valid_from: "2026-01-01T00:00:00.000Z",
    });
    await invalidate({
      source_ref: SOURCE_REF,
      invalidated_at: INVALIDATED_AT,
      triggered_by: "fin",
    });

    await ingest({
      content: CONTENT,
      source_ref: SOURCE_REF,
      valid_from: "2026-01-01T00:00:00.000Z",
    });

    expect(await queryContent(deps, AFTER_INVALIDATION)).toEqual([]);
    await expect(
      deps.storage.listInvalidations(SOURCE_REF)
    ).resolves.toHaveLength(1);
  });

  it("invalidates the chunk belonging to the source_ref", async () => {
    const deps = makeDeps();
    const first = createIngestHandler({
      ...deps,
      identityVersions: { normalizationRuleVersion: "v1" },
    });
    const second = createIngestHandler({
      ...deps,
      identityVersions: { normalizationRuleVersion: "v2" },
    });
    await first({ content: CONTENT, source_ref: SOURCE_REF });
    // T3 rebuild: a re-push with a different content identity wipes the
    // previous chunk for that source_doc — only the new chunk remains,
    // and invalidation should still find it under the same source_ref.
    await second({ content: CONTENT, source_ref: SOURCE_REF });

    const invalidated = invalidationPayload(
      await createInvalidationHandler(deps)({
        source_ref: SOURCE_REF,
        invalidated_at: INVALIDATED_AT,
        triggered_by: "fin",
      })
    );

    expect(invalidated.invalidated_chunk_ids).toHaveLength(1);
    expect(await queryContent(deps, AFTER_INVALIDATION)).toEqual([]);
    await expect(
      deps.storage.listInvalidations(SOURCE_REF)
    ).resolves.toHaveLength(1);
  });

  it("returns a typed error for an unknown source_ref", async () => {
    const deps = makeDeps();
    const invalidate = createInvalidationHandler(deps);

    await expect(
      invalidate({
        source_ref: "t6/unknown",
        invalidated_at: INVALIDATED_AT,
        triggered_by: "fin",
      })
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("rejects invalid invalidation input before any storage write", () => {
    expect(
      InvalidationInputSchema.safeParse({
        source_ref: SOURCE_REF,
        invalidated_at: "not-a-date",
        triggered_by: "fin",
      }).success
    ).toBe(false);
    expect(
      InvalidationInputSchema.safeParse({
        source_ref: SOURCE_REF,
        invalidated_at: INVALIDATED_AT,
        triggered_by: "",
      }).success
    ).toBe(false);
  });

  it("ingest no longer carries an invalidation action (SC2: write-only)", () => {
    // specs/mcp-tool-surface.md SC2: `ingest` with action "invalidate"
    // (or any invalidate-only field) is a validation error — the schema
    // is strict and knows no such keys. Invalidation is only `invalidate`.
    expect(
      IngestInputSchema.safeParse({
        action: "invalidate",
        source_ref: SOURCE_REF,
        invalidated_at: INVALIDATED_AT,
        triggered_by: "fin",
      }).success
    ).toBe(false);
    expect(
      IngestInputSchema.safeParse({
        source_ref: SOURCE_REF,
        triggered_by: "fin",
      }).success
    ).toBe(false);
    expect(
      IngestInputSchema.safeParse({
        source_ref: SOURCE_REF,
        invalidated_at: INVALIDATED_AT,
      }).success
    ).toBe(false);
  });

  it("keeps a typed storage exception visible for invalidation", async () => {
    const storage: StorageBackend = {
      upsert: async () => [],
      search: async () => [],
      close: async () => {},
    };
    const invalidate = createInvalidationHandler({
      embedder: new FakeEmbedder(TEST_DIM),
      storage,
    });

    await expect(
      invalidate({
        source_ref: SOURCE_REF,
        invalidated_at: INVALIDATED_AT,
        triggered_by: "fin",
      })
    ).rejects.toBeInstanceOf(GraphragError);
  });

  it("does not expose a physical-delete method on the backend", () => {
    const backend = new MemoryBackend(TEST_DIM);
    expect("delete" in backend).toBe(false);
    expect("deleteBySourceRef" in backend).toBe(false);
  });
});
