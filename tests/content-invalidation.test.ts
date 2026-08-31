import { describe, expect, it } from "vitest";

import { FakeEmbedder } from "../src/core/embedder.js";
import { GraphragError } from "../src/core/errors.js";
import { MemoryBackend } from "../src/core/storage/memory-backend.js";
import type { StorageBackend } from "../src/core/types.js";
import { createIngestHandler, IngestInputSchema } from "../src/tools/ingest.js";

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

describe("T6 content invalidation", () => {
  it("closes the window at the invalidation instant and leaves a queryable record", async () => {
    const deps = makeDeps();
    const ingest = createIngestHandler(deps);
    const ingested = await ingest({
      content: CONTENT,
      source_ref: SOURCE_REF,
      valid_from: "2026-01-01T00:00:00.000Z",
    });
    const chunkId = JSON.parse(textOf(ingested)).chunk_ids[0] as string;

    const before = await queryContent(deps, BEFORE_INVALIDATION);
    const invalidated = await ingest({
      action: "invalidate",
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
    const ingest = createIngestHandler(deps);
    await ingest({ content: CONTENT, source_ref: SOURCE_REF });
    const request = {
      action: "invalidate" as const,
      source_ref: SOURCE_REF,
      invalidated_at: INVALIDATED_AT,
      triggered_by: "fin",
    };

    const first = invalidationPayload(await ingest(request));
    const second = invalidationPayload(await ingest(request));

    expect(second).toEqual(first);
    await expect(
      deps.storage.listInvalidations(SOURCE_REF)
    ).resolves.toHaveLength(1);
  });

  it("does not reopen a closed row when the same content is re-pushed", async () => {
    const deps = makeDeps();
    const ingest = createIngestHandler(deps);
    await ingest({
      content: CONTENT,
      source_ref: SOURCE_REF,
      valid_from: "2026-01-01T00:00:00.000Z",
    });
    await ingest({
      action: "invalidate",
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

  it("invalidates every chunk belonging to the source_ref", async () => {
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
    await second({ content: CONTENT, source_ref: SOURCE_REF });

    const invalidated = invalidationPayload(
      await first({
        action: "invalidate",
        source_ref: SOURCE_REF,
        invalidated_at: INVALIDATED_AT,
        triggered_by: "fin",
      })
    );

    expect(invalidated.invalidated_chunk_ids).toHaveLength(2);
    expect(await queryContent(deps, AFTER_INVALIDATION)).toEqual([]);
    await expect(
      deps.storage.listInvalidations(SOURCE_REF)
    ).resolves.toHaveLength(2);
  });

  it("returns a typed error for an unknown source_ref", async () => {
    const deps = makeDeps();
    const ingest = createIngestHandler(deps);

    await expect(
      ingest({
        action: "invalidate",
        source_ref: "t6/unknown",
        invalidated_at: INVALIDATED_AT,
        triggered_by: "fin",
      })
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("rejects invalid invalidation input before any storage write", async () => {
    expect(
      IngestInputSchema.safeParse({
        action: "invalidate",
        source_ref: SOURCE_REF,
        invalidated_at: "not-a-date",
        triggered_by: "fin",
      }).success
    ).toBe(false);
    expect(
      IngestInputSchema.safeParse({
        action: "invalidate",
        source_ref: SOURCE_REF,
        invalidated_at: INVALIDATED_AT,
        triggered_by: "",
      }).success
    ).toBe(false);
  });

  it("keeps a typed storage exception visible for invalidation", async () => {
    const storage: StorageBackend = {
      upsert: async () => [],
      search: async () => [],
      close: async () => {},
    };
    const ingest = createIngestHandler({
      embedder: new FakeEmbedder(TEST_DIM),
      storage,
    });

    await expect(
      ingest({
        action: "invalidate",
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
