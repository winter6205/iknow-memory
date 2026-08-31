import { describe, expect, it } from "vitest";

import { assembleRetrievalResult } from "../../src/core/retrieval/index.js";
import type {
  EntityChunkRow,
  GraphRanker,
  Neo4jArmStorage,
  RankedEntity,
  RetrieveConfig,
} from "../../src/core/retrieval/types.js";
import type { EmbeddingClient } from "../../src/core/embedder.js";
import type { GraphRagStorageBackend } from "../../src/core/storage/backend.js";
import type {
  ChunkRecord,
  RetrievedChunk,
  SearchOptions,
  StorageBackend,
} from "../../src/core/types.js";

const NOW = "2026-08-31T00:00:00.000Z";

const DEFAULT_CONFIG: RetrieveConfig = {
  preset: "balanced",
  w_vec: 0.7,
  w_bm25: 0.15,
  w_graph: 0.15,
  bm25Enabled: false,
  graphEnabled: true,
  rerankEnabled: false,
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

function vectorChunk(id: string): RetrievedChunk {
  return {
    id,
    content: `content-${id}`,
    source_ref: `source/${id}`,
    valid_window: [NOW, null],
    score: 1,
  };
}

function entityChunk(entityId: string, id: string): EntityChunkRow {
  return {
    entity_id: entityId,
    id,
    content: `content-${id}`,
    source_ref: `source/${id}`,
    valid_from: NOW,
    valid_until: null,
  };
}

class Neo4jBackend implements GraphRagStorageBackend {
  vectorHits: RetrievedChunk[] = [];
  seeds: Array<{ id: string; canonical_name: string }> = [];
  rows: EntityChunkRow[] = [];
  seedCalls = 0;

  readonly neo4jArmSeed: Neo4jArmStorage = {
    seedEntitiesByEmbedding: async () => {
      this.seedCalls += 1;
      return this.seeds;
    },
    chunksByEntityIds: async () => this.rows,
  };

  async upsert(_chunks: ChunkRecord[]): Promise<string[]> {
    return [];
  }

  async search(
    _embedding: number[],
    opts: SearchOptions
  ): Promise<RetrievedChunk[]> {
    return this.vectorHits.slice(0, opts.limit);
  }

  async close(): Promise<void> {}
}

class CountingRanker implements GraphRanker {
  calls = 0;

  constructor(private readonly ranked: RankedEntity[]) {}

  async rankEntities(): Promise<RankedEntity[]> {
    this.calls += 1;
    return this.ranked;
  }
}

class VectorOnlyBackend implements StorageBackend {
  async upsert(_chunks: ChunkRecord[]): Promise<string[]> {
    return [];
  }

  async search(
    _embedding: number[],
    _opts: SearchOptions
  ): Promise<RetrievedChunk[]> {
    return [vectorChunk("vector-hit")];
  }

  async close(): Promise<void> {}
}

describe("T10 graph multi-hop default", () => {
  it("invokes the configured graph arm exactly once per retrieve", async () => {
    const storage = new Neo4jBackend();
    storage.vectorHits = [vectorChunk("vector-hit")];
    storage.seeds = [{ id: "entity-1", canonical_name: "Entity 1" }];
    storage.rows = [entityChunk("entity-1", "graph-hit")];
    const ranker = new CountingRanker([{ id: "entity-1", score: 0.9 }]);

    const result = await assembleRetrievalResult(
      { query: "query", validAt: NOW, limit: 10 },
      {
        embedder: new FixedEmbedder(),
        storage,
        retrieveConfig: DEFAULT_CONFIG,
        graphRanker: ranker,
      }
    );

    expect(storage.seedCalls).toBe(1);
    expect(ranker.calls).toBe(1);
    expect(result.chunks[0]?.id).toBe("graph-hit");
    expect(result).not.toHaveProperty("degraded");
  });

  it("marks graph multi-hop unattempted when its address is missing", async () => {
    const result = await assembleRetrievalResult(
      { query: "query", validAt: NOW, limit: 10 },
      {
        embedder: new FixedEmbedder(),
        storage: new VectorOnlyBackend(),
        retrieveConfig: DEFAULT_CONFIG,
      }
    );

    expect(result.chunks.map((chunk) => chunk.id)).toEqual(["vector-hit"]);
    expect(result.degraded).toBe(true);
    expect(result.degraded_reasons).toContain("graph_ppr:unattempted");
  });

  it("keeps vector fallback unchanged when an attempted graph is empty", async () => {
    const storage = new Neo4jBackend();
    storage.vectorHits = [vectorChunk("vector-hit")];
    storage.seeds = [];
    const ranker = new CountingRanker([]);

    const result = await assembleRetrievalResult(
      { query: "query", validAt: NOW, limit: 10 },
      {
        embedder: new FixedEmbedder(),
        storage,
        retrieveConfig: DEFAULT_CONFIG,
        graphRanker: ranker,
      }
    );

    expect(result.chunks.map((chunk) => chunk.id)).toEqual(["vector-hit"]);
    expect(result).not.toHaveProperty("degraded");
  });
});
