import { describe, expect, it } from "vitest";
import { assembleRetrievalResult } from "../../src/core/retrieval/index.js";
import type {
  EntityChunkRow,
  EntityEmbeddingStorage,
  RetrieveConfig,
} from "../../src/core/retrieval/types.js";
import type { EmbeddingClient } from "../../src/core/embedder.js";
import type {
  ChunkRecord,
  RetrievedChunk,
  SearchOptions,
  StorageBackend,
} from "../../src/core/types.js";

const NOW = "2026-08-01T00:00:00.000Z";

const CFG: RetrieveConfig = {
  preset: "balanced",
  w_vec: 0.7,
  w_bm25: 0.15,
  w_graph: 0.15,
  bm25Enabled: false,
  graphEnabled: false,
  rerankEnabled: false,
  nodeEmbeddingEnabled: true,
  entityLinkTopK: 8,
  candidateCap: 50,
  neighborWidth: 0,
  graphArmFloor: 3,
};

class FixedEmbedder implements EmbeddingClient {
  async embed(_texts: string[]): Promise<number[][]> {
    return [[1]];
  }
}

function chunk(id: string): RetrievedChunk {
  return {
    id,
    content: id,
    source_ref: `source/${id}`,
    valid_window: [NOW, null],
    score: 1,
  };
}

function entityRow(entityId: string, chunkId: string): EntityChunkRow {
  return {
    entity_id: entityId,
    id: chunkId,
    content: chunkId,
    source_ref: `source/${chunkId}`,
    valid_from: NOW,
    valid_until: null,
  };
}

class NodeEmbeddingBackend implements StorageBackend {
  readonly entityEmbedding: EntityEmbeddingStorage = {
    seedEntitiesByEmbedding: async (_embedding, _topK) => {
      if (this.seedError !== undefined) throw this.seedError;
      return [{ id: "entity-1", canonical_name: "Entity 1", score: 0.99 }];
    },
    chunksByEntityIds: async () => [entityRow("entity-1", "entity-ranked")],
  };

  seedError: Error | undefined;

  async upsert(_chunks: ChunkRecord[]): Promise<string[]> {
    return [];
  }

  async search(
    _embedding: number[],
    opts: SearchOptions
  ): Promise<RetrievedChunk[]> {
    return [chunk("vector-ranked"), chunk("entity-ranked")].slice(
      0,
      opts.limit
    );
  }

  async close(): Promise<void> {}
}

describe("retrieve node embedding path", () => {
  it("uses Postgres entity embeddings as a graph-priority seed when enabled", async () => {
    const storage = new NodeEmbeddingBackend();

    const out = await assembleRetrievalResult(
      { query: "entity", validAt: NOW, limit: 2 },
      { embedder: new FixedEmbedder(), storage, retrieveConfig: CFG }
    );

    expect(out.chunks.map((item) => item.id)).toEqual([
      "entity-ranked",
      "vector-ranked",
    ]);
    expect(out.degraded).toBeUndefined();
  });

  it("falls back to the pre-embedding ranking and marks degraded on a read failure", async () => {
    const storage = new NodeEmbeddingBackend();
    storage.seedError = new Error("entities embedding unavailable");

    const out = await assembleRetrievalResult(
      { query: "entity", validAt: NOW, limit: 2 },
      { embedder: new FixedEmbedder(), storage, retrieveConfig: CFG }
    );

    expect(out.chunks.map((item) => item.id)).toEqual([
      "vector-ranked",
      "entity-ranked",
    ]);
    expect(out.degraded).toBe(true);
  });

  it("keeps the T1 graph-priority/RRF result unchanged when disabled", async () => {
    const storage = new NodeEmbeddingBackend();

    const out = await assembleRetrievalResult(
      { query: "entity", validAt: NOW, limit: 2 },
      {
        embedder: new FixedEmbedder(),
        storage,
        retrieveConfig: { ...CFG, nodeEmbeddingEnabled: false },
      }
    );

    expect(out.chunks.map((item) => item.id)).toEqual([
      "vector-ranked",
      "entity-ranked",
    ]);
    expect(out.degraded).toBeUndefined();
  });
});
