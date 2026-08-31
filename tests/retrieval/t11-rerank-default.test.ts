import { describe, expect, it } from "vitest";

import { assembleRetrievalResult } from "../../src/core/retrieval/index.js";
import type {
  ChunkReranker,
  RetrieveConfig,
} from "../../src/core/retrieval/types.js";
import type { EmbeddingClient } from "../../src/core/embedder.js";
import type {
  ChunkRecord,
  RetrievedChunk,
  SearchOptions,
  StorageBackend,
} from "../../src/core/types.js";

const NOW = "2026-08-31T00:00:00.000Z";

const RERANK_CONFIG: RetrieveConfig = {
  preset: "balanced",
  w_vec: 0.7,
  w_bm25: 0.15,
  w_graph: 0.15,
  bm25Enabled: false,
  graphEnabled: false,
  rerankEnabled: true,
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

class SearchBackend implements StorageBackend {
  async upsert(_chunks: ChunkRecord[]): Promise<string[]> {
    return [];
  }

  async search(
    _embedding: number[],
    _opts: SearchOptions
  ): Promise<RetrievedChunk[]> {
    return [
      {
        id: "a",
        content: "content-a",
        source_ref: "source/a",
        valid_window: [NOW, null],
        score: 1,
      },
      {
        id: "b",
        content: "content-b",
        source_ref: "source/b",
        valid_window: [NOW, null],
        score: 0.5,
      },
    ];
  }

  async close(): Promise<void> {}
}

describe("T11 rerank default and degradation", () => {
  it("invokes an available reranker exactly once on a default-on retrieve", async () => {
    let calls = 0;
    const reranker: ChunkReranker = {
      permute: async () => {
        calls += 1;
        return ["b", "a"];
      },
    };

    const result = await assembleRetrievalResult(
      { query: "query", validAt: NOW, limit: 2 },
      {
        embedder: new FixedEmbedder(),
        storage: new SearchBackend(),
        retrieveConfig: RERANK_CONFIG,
        reranker,
      }
    );

    expect(calls).toBe(1);
    expect(result.chunks.map((chunk) => chunk.id)).toEqual(["b", "a"]);
    expect(result).not.toHaveProperty("degraded");
  });

  it("keeps the pre-rerank order and marks a reranker failure", async () => {
    const reranker: ChunkReranker = {
      permute: async () => {
        throw new Error("rerank service unavailable");
      },
    };

    const result = await assembleRetrievalResult(
      { query: "query", validAt: NOW, limit: 2 },
      {
        embedder: new FixedEmbedder(),
        storage: new SearchBackend(),
        retrieveConfig: RERANK_CONFIG,
        reranker,
      }
    );

    expect(result.chunks.map((chunk) => chunk.id)).toEqual(["a", "b"]);
    expect(result.degraded).toBe(true);
    expect(result.degraded_reasons).toEqual(["rerank:attempted-and-failed"]);
  });

  it("marks an enabled reranker without a token as unattempted", async () => {
    const result = await assembleRetrievalResult(
      { query: "query", validAt: NOW, limit: 2 },
      {
        embedder: new FixedEmbedder(),
        storage: new SearchBackend(),
        retrieveConfig: RERANK_CONFIG,
      }
    );

    expect(result.chunks.map((chunk) => chunk.id)).toEqual(["a", "b"]);
    expect(result.degraded).toBe(true);
    expect(result.degraded_reasons).toEqual(["rerank:unattempted"]);
  });
});
