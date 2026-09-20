/**
 * Embedding generation rotate T2 — ingest/push dual-write unit tests.
 *
 * The tool layer computes BOTH slot batches for the stored slice texts
 * BEFORE touching storage: whichever (model, dimensions) pair matches env
 * uses the configured embedder, the other goes through the slot-embedding
 * factory. A secondary embed failure must refuse the ingest outright.
 */
import { describe, expect, it } from "vitest";

import {
  createIngestHandler,
  type IngestDeps,
} from "../../src/tools/ingest.js";
import { GraphragError } from "../../src/core/errors.js";
import { FakeEmbedder, type EmbeddingClient } from "../../src/core/embedder.js";
import { MemoryBackend } from "../../src/core/storage/memory-backend.js";
import type { SlotEmbeddingSource } from "../../src/core/embed-slots.js";
import type {
  ChunkRecord,
  EmbeddingGenerationState,
} from "../../src/core/types.js";

const TEST_DIM = 8;

function openState(
  overrides: Partial<EmbeddingGenerationState> = {}
): EmbeddingGenerationState {
  return {
    activeSlot: "embedding",
    active: { model: "m1", dimensions: TEST_DIM },
    incomingSlot: "embedding_g2",
    incoming: { model: "m2", dimensions: TEST_DIM },
    rotateMode: "dual_write",
    rollbackSlot: null,
    rollback: null,
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

/** Recording backend: MemoryBackend + ledger state + captured upsert rows. */
class DualWriteMemoryBackend extends MemoryBackend {
  upserted: ChunkRecord[][] = [];
  constructor(
    dimensions: number,
    private readonly state: EmbeddingGenerationState | null
  ) {
    super(dimensions);
  }
  override async upsert(chunks: ChunkRecord[]): Promise<string[]> {
    this.upserted.push(chunks.map((c) => ({ ...c })));
    return super.upsert(chunks);
  }
  getGenerationState(): EmbeddingGenerationState | undefined {
    return this.state ?? undefined;
  }
}

function taggingEmbedder(tag: string, calls: string[]): EmbeddingClient {
  return {
    modelId: tag,
    embed: async (texts: string[]) => {
      calls.push(tag);
      // TEST_DIM-wide vectors (MemoryBackend validates the width); the tag
      // byte in slot 0 keeps different models in different vector spaces.
      return texts.map((text) => [
        tag.charCodeAt(0),
        ...Array.from({ length: TEST_DIM - 1 }, (_, i) => text.length + i),
      ]);
    },
  };
}

function makeSlotSource(desiredModel: "m1" | "m2") {
  const calls: string[] = [];
  const source: SlotEmbeddingSource = {
    embedder: taggingEmbedder("env", calls),
    desired: { model: desiredModel, dimensions: TEST_DIM },
    buildEmbedder: (pair) => {
      calls.push(`build:${pair.model}`);
      return taggingEmbedder(pair.model ?? "none", calls);
    },
  };
  return { source, calls };
}

const envelope = {
  source_ref: "docs/dual.md",
  content: "alpha beta",
  chunks: [
    { content: "alpha", index: 0 },
    { content: "beta", index: 1 },
  ],
};

describe("ingest dual-write while a rotate is open", () => {
  it("passes BOTH slot vectors on every ChunkRecord, computed with the two pairs", async () => {
    const storage = new DualWriteMemoryBackend(TEST_DIM, openState());
    const { source, calls } = makeSlotSource("m1");
    const deps: IngestDeps = {
      embedder: new FakeEmbedder(TEST_DIM),
      storage,
      slotEmbedding: source,
    };

    await createIngestHandler(deps)(envelope);

    expect(storage.upserted).toHaveLength(1);
    const records = storage.upserted[0]!;
    expect(records).toHaveLength(2);
    for (const record of records) {
      expect(record.embedding).toBeDefined();
      expect(record.incoming_embedding).toBeDefined();
      // active was embedded by the env embedder (desired == active),
      // incoming by a factory-built embedder for the incoming pair.
      expect(record.incoming_embedding).not.toEqual(record.embedding);
    }
    expect(calls).toEqual(["env", "build:m2", "m2"]);
  });

  it("refuses the whole ingest when the secondary embed fails — nothing stored", async () => {
    const storage = new DualWriteMemoryBackend(TEST_DIM, openState());
    const source: SlotEmbeddingSource = {
      embedder: new FakeEmbedder(TEST_DIM),
      desired: { model: "m1", dimensions: TEST_DIM },
      buildEmbedder: () => {
        throw new GraphragError("secondary down", "EMBEDDING_FAILED");
      },
    };
    const deps: IngestDeps = {
      embedder: new FakeEmbedder(TEST_DIM),
      storage,
      slotEmbedding: source,
    };

    const err = await createIngestHandler(deps)(envelope).catch(
      (e: unknown) => e
    );

    expect(err).toBeInstanceOf(GraphragError);
    expect((err as GraphragError).code).toBe("EMBEDDING_FAILED");
    expect(storage.upserted).toHaveLength(0);
  });

  it("refuses when a dual-write rotate is open but slotEmbedding is not wired", async () => {
    const storage = new DualWriteMemoryBackend(TEST_DIM, openState());
    const deps: IngestDeps = {
      embedder: new FakeEmbedder(TEST_DIM),
      storage,
    };

    const err = await createIngestHandler(deps)(envelope).catch(
      (e: unknown) => e
    );

    expect(err).toBeInstanceOf(GraphragError);
    expect((err as GraphragError).code).toBe("EMBEDDING_FAILED");
    expect(storage.upserted).toHaveLength(0);
  });

  it("no rotate open: single embed, no incoming_embedding on records", async () => {
    const storage = new DualWriteMemoryBackend(TEST_DIM, null);
    const { source, calls } = makeSlotSource("m1");
    const deps: IngestDeps = {
      embedder: new FakeEmbedder(TEST_DIM),
      storage,
      slotEmbedding: source,
    };

    await createIngestHandler(deps)(envelope);

    const records = storage.upserted[0]!;
    for (const record of records) {
      expect(record.incoming_embedding).toBeUndefined();
    }
    expect(calls).toEqual(["env"]);
  });
});
