import { describe, it, expect, beforeEach } from "vitest";
import {
  createInvalidationHandler,
  invalidationTool,
  type InvalidationDeps,
} from "../../src/tools/invalidation.js";
import { FakeEmbedder } from "../../src/core/embedder.js";
import { MemoryBackend } from "../../src/core/storage/memory-backend.js";
import { GraphragError } from "../../src/core/errors.js";
import type { ToolResult } from "../../src/tools/registry.js";

const TEST_DIM = 1536;

/** Parse the JSON text body of a ToolResult. */
function parseBody(result: ToolResult): {
  invalidated_chunk_ids: string[];
  invalidations: Array<{
    chunk_id: string;
    invalidated_at: string;
    triggered_by: string;
  }>;
} {
  const text = result.content[0]?.text;
  if (typeof text !== "string") {
    throw new Error("expected text content in ToolResult");
  }
  return JSON.parse(text);
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

describe("invalidationTool", () => {
  it("registers under the name 'invalidation' with a non-empty inputSchema", () => {
    const tool = invalidationTool({
      embedder: new FakeEmbedder(TEST_DIM),
      storage: new MemoryBackend(TEST_DIM),
    });
    expect(tool.name).toBe("invalidation");
    expect(typeof tool.description).toBe("string");
    expect(tool.description.length).toBeGreaterThan(0);
    expect(tool.inputSchema).toBeDefined();
  });
});
