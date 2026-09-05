import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createInvalidationHandler,
  invalidationTool,
  type InvalidationDeps,
} from "../../src/tools/invalidation.js";
import { FakeEmbedder } from "../../src/core/embedder.js";
import { MemoryBackend } from "../../src/core/storage/memory-backend.js";
import { GraphragError } from "../../src/core/errors.js";
import type { ToolResult } from "../../src/tools/registry.js";
import type { PrecisionIndexer } from "../../src/core/storage/elasticsearch-precision.js";

const TEST_DIM = 1536;

/** Parse the JSON text body of a ToolResult. */
function parseBody(result: ToolResult): {
  invalidated_chunk_ids: string[];
  invalidations: Array<{
    chunk_id: string;
    invalidated_at: string;
    triggered_by: string;
  }>;
  degraded?: boolean;
  degraded_reasons?: string[];
} {
  const text = result.content[0]?.text;
  if (typeof text !== "string") {
    throw new Error("expected text content in ToolResult");
  }
  return JSON.parse(text);
}

/**
 * Build a PrecisionIndexer stub with only the methods the invalidation
 * handler calls. Keeps each test focused on the precision dual-write
 * contract without hauling in the full ES mock.
 */
function fakePrecision(
  behavior: { kind: "ok" } | { kind: "fail"; error: unknown }
): PrecisionIndexer & {
  invalidateSourceRef: ReturnType<typeof vi.fn>;
} {
  const invalidateSourceRef = vi.fn(async () => {
    if (behavior.kind === "fail") throw behavior.error;
  });
  return {
    searchLexical: vi.fn(async () => []),
    indexChunks: vi.fn(async () => undefined),
    indexEntities: vi.fn(async () => undefined),
    rebuildChunks: vi.fn(async () => undefined),
    rebuildEntities: vi.fn(async () => undefined),
    invalidateSourceRef,
    deleteChunkIndex: vi.fn(async () => undefined),
    deleteEntityIndex: vi.fn(async () => undefined),
    analyze: vi.fn(async () => []),
    close: vi.fn(async () => undefined),
    searchEntities: vi.fn(async () => []),
  } as unknown as PrecisionIndexer & {
    invalidateSourceRef: ReturnType<typeof vi.fn>;
  };
}

/**
 * Plan D0 I-T5: the invalidation tool closes the validity window for a
 * source_ref without physically deleting rows, and it is idempotent —
 * a second call with the same parameters returns the same record set
 * (the append helper dedups identical records). The wire contract is
 * that fin's invalidation_port can call this tool any number of times
 * without surprise.
 */
describe("createInvalidationHandler — close-window semantics", () => {
  let deps: InvalidationDeps;
  let handler: ReturnType<typeof createInvalidationHandler>;

  beforeEach(() => {
    deps = {
      embedder: new FakeEmbedder(TEST_DIM),
      storage: new MemoryBackend(TEST_DIM),
    };
    handler = createInvalidationHandler(deps);
  });

  const now = () => new Date().toISOString();

  async function seedChunk(sourceRef: string): Promise<string> {
    const [embedding] = await deps.embedder.embed([`payload for ${sourceRef}`]);
    const records = [
      {
        id: `chunk-for-${sourceRef}`,
        content: `payload for ${sourceRef}`,
        embedding: embedding!,
        source_ref: sourceRef,
        metadata: {},
        valid_from: "2024-01-01T00:00:00Z",
        valid_until: null,
        created_at: now(),
      },
    ];
    const ids = await deps.storage.upsert(records);
    return ids[0]!;
  }

  it("closes the validity window: retrieve after invalidation returns no chunks", async () => {
    const sourceRef = "docs/close-window.md";
    const chunkId = await seedChunk(sourceRef);

    // Before invalidation, the chunk is retrievable.
    const [vec] = await deps.embedder.embed([`payload for ${sourceRef}`]);
    const beforeHits = await deps.storage.search(vec!, {
      limit: 10,
      validAt: "2024-06-01T00:00:00Z",
    });
    expect(beforeHits.map((c) => c.id)).toContain(chunkId);

    const result = await handler({
      source_ref: sourceRef,
      invalidated_at: "2024-06-01T00:00:00Z",
      triggered_by: "fin",
    });
    const body = parseBody(result);
    expect(body.invalidated_chunk_ids).toEqual([chunkId]);
    // normalizeContentInvalidationRequest parses the timestamp and
    // re-emits it through Date.toISOString(), which canonicalizes to
    // millisecond precision. The wire contract is the ISO instant,
    // not its string form.
    expect(body.invalidations).toEqual([
      {
        chunk_id: chunkId,
        invalidated_at: "2024-06-01T00:00:00.000Z",
        triggered_by: "fin",
      },
    ]);

    // After invalidation, the chunk is no longer in-window.
    const afterHits = await deps.storage.search(vec!, {
      limit: 10,
      validAt: "2024-06-01T00:01:00Z",
    });
    expect(afterHits.map((c) => c.id)).not.toContain(chunkId);
  });

  it("repeat invalidation with identical args returns the same record set (idempotent)", async () => {
    const sourceRef = "docs/idempotent.md";
    await seedChunk(sourceRef);

    const request = {
      source_ref: sourceRef,
      invalidated_at: "2024-06-01T00:00:00Z",
      triggered_by: "fin",
    };
    const first = parseBody(await handler(request));
    const second = parseBody(await handler(request));
    expect(second).toEqual(first);
    // Storage ledger has one (not two) record for the same invalidation.
    const allRecords = await deps.storage.listInvalidations(sourceRef);
    expect(allRecords).toHaveLength(1);
  });

  it("repeat invalidation appends a new record when invalidated_at differs", async () => {
    const sourceRef = "docs/timeline.md";
    await seedChunk(sourceRef);
    await handler({
      source_ref: sourceRef,
      invalidated_at: "2024-06-01T00:00:00Z",
      triggered_by: "fin",
    });
    await handler({
      source_ref: sourceRef,
      invalidated_at: "2024-07-01T00:00:00Z",
      triggered_by: "fin",
    });
    const allRecords = await deps.storage.listInvalidations(sourceRef);
    expect(allRecords).toHaveLength(2);
  });

  it("rejects unknown source_ref with a typed INVALID_INPUT error", async () => {
    await expect(
      handler({
        source_ref: "docs/never-seeded.md",
        invalidated_at: "2024-06-01T00:00:00Z",
        triggered_by: "fin",
      })
    ).rejects.toBeInstanceOf(GraphragError);
  });
});

/**
 * ES precision dual-write semantics. Postgres stays authoritative: an ES
 * failure surfaces as degraded:true + keyword_bm25:attempted-and-failed,
 * never as a rolled-back authoritative write. Unconfigured (no precision)
 * preserves the existing wire shape exactly.
 */
describe("createInvalidationHandler — precision dual-write", () => {
  const NOW = new Date().toISOString();

  async function seededDeps(): Promise<{
    deps: InvalidationDeps;
    seedChunk: (sourceRef: string) => Promise<string>;
    storage: MemoryBackend;
  }> {
    const storage = new MemoryBackend(TEST_DIM);
    const embedder = new FakeEmbedder(TEST_DIM);
    const deps: InvalidationDeps = { embedder, storage };
    const seedChunk = async (sourceRef: string): Promise<string> => {
      const [embedding] = await embedder.embed([`payload for ${sourceRef}`]);
      const ids = await storage.upsert([
        {
          id: `chunk-for-${sourceRef}`,
          content: `payload for ${sourceRef}`,
          embedding: embedding!,
          source_ref: sourceRef,
          metadata: {},
          valid_from: "2024-01-01T00:00:00Z",
          valid_until: null,
          created_at: NOW,
        },
      ]);
      return ids[0]!;
    };
    return { deps, seedChunk, storage };
  }

  it("unconfigured (precision undefined) keeps the legacy wire shape", async () => {
    const { deps, seedChunk } = await seededDeps();
    const sourceRef = "docs/no-precision.md";
    await seedChunk(sourceRef);

    const body = parseBody(
      await createInvalidationHandler(deps)({
        source_ref: sourceRef,
        invalidated_at: "2024-06-01T00:00:00Z",
        triggered_by: "fin",
      })
    );

    expect(body.degraded).toBeUndefined();
    expect(body.degraded_reasons).toBeUndefined();
    expect(body.invalidated_chunk_ids).toHaveLength(1);
  });

  it("precision success: response shape stays non-degraded", async () => {
    const { deps, seedChunk } = await seededDeps();
    const precision = fakePrecision({ kind: "ok" });
    deps.precision = precision;
    const sourceRef = "docs/es-ok.md";
    await seedChunk(sourceRef);

    const body = parseBody(
      await createInvalidationHandler(deps)({
        source_ref: sourceRef,
        invalidated_at: "2024-06-01T00:00:00Z",
        triggered_by: "fin",
      })
    );

    expect(body.degraded).toBeUndefined();
    expect(body.degraded_reasons).toBeUndefined();
    expect(precision.invalidateSourceRef).toHaveBeenCalledTimes(1);
    expect(precision.invalidateSourceRef).toHaveBeenCalledWith(
      sourceRef,
      "2024-06-01T00:00:00.000Z"
    );
  });

  it("precision failure: authority write still completes, response marks degraded", async () => {
    // Spec SC-5: ES write failure must not roll back the authoritative
    // close. The ledger has the invalidation record; the response carries
    // the same `keyword_bm25:attempted-and-failed` reason the ingest/push
    // paths use, so observability stays consistent across dual-writes.
    const { deps, seedChunk, storage } = await seededDeps();
    const precision = fakePrecision({
      kind: "fail",
      error: new Error("es unreachable"),
    });
    deps.precision = precision;
    const sourceRef = "docs/es-fail.md";
    await seedChunk(sourceRef);

    // Silence the stderr observation; assert on the response shape.
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    const body = parseBody(
      await createInvalidationHandler(deps)({
        source_ref: sourceRef,
        invalidated_at: "2024-06-01T00:00:00Z",
        triggered_by: "fin",
      })
    );

    expect(body.degraded).toBe(true);
    expect(body.degraded_reasons).toEqual([
      "keyword_bm25:attempted-and-failed",
    ]);
    expect(body.invalidated_chunk_ids).toHaveLength(1);

    // Authority close still happened: the chunk's validity window is
    // closed and the ledger holds the invalidation record.
    const records = await storage.listInvalidations(sourceRef);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      chunk_id: `chunk-for-${sourceRef}`,
      invalidated_at: "2024-06-01T00:00:00.000Z",
      triggered_by: "fin",
    });

    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining("invalidation precision index failed")
    );
    stderr.mockRestore();
  });
});

describe("invalidationTool.inputSchema — rejects malformed input at the boundary", () => {
  const tool = invalidationTool({
    embedder: new FakeEmbedder(TEST_DIM),
    storage: new MemoryBackend(TEST_DIM),
  });

  it("accepts a minimal valid request", () => {
    const result = tool.inputSchema.safeParse({
      source_ref: "docs/x.md",
      triggered_by: "fin",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an empty source_ref", () => {
    const result = tool.inputSchema.safeParse({
      source_ref: "",
      triggered_by: "fin",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty triggered_by", () => {
    const result = tool.inputSchema.safeParse({
      source_ref: "docs/x.md",
      triggered_by: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a malformed invalidated_at timestamp", () => {
    const result = tool.inputSchema.safeParse({
      source_ref: "docs/x.md",
      invalidated_at: "not-a-date",
      triggered_by: "fin",
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown top-level keys (strict mode)", () => {
    const result = tool.inputSchema.safeParse({
      source_ref: "docs/x.md",
      triggered_by: "fin",
      force: true,
    });
    expect(result.success).toBe(false);
  });
});

describe("invalidateTool registration", () => {
  it("registers under the name 'invalidate' with a non-empty inputSchema", () => {
    const tool = invalidationTool({
      embedder: new FakeEmbedder(TEST_DIM),
      storage: new MemoryBackend(TEST_DIM),
    });
    // specs/mcp-tool-surface.md: the MCP name is `invalidate`
    // (renamed from `invalidation`); the close-window semantics are
    // unchanged.
    expect(tool.name).toBe("invalidate");
    expect(typeof tool.description).toBe("string");
    expect(tool.description.length).toBeGreaterThan(0);
    expect(tool.inputSchema).toBeDefined();
  });

  it("description is Host-readable (no internal jargon)", () => {
    const tool = invalidationTool({
      embedder: new FakeEmbedder(TEST_DIM),
      storage: new MemoryBackend(TEST_DIM),
    });
    expect(tool.description).toMatch(/validity window|no physical delete/i);
    expect(tool.description).not.toMatch(/stage 0|fin|port/i);
  });
});
