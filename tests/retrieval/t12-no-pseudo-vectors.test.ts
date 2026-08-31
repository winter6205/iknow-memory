import { describe, expect, it } from "vitest";

import { GraphragError } from "../../src/core/errors.js";
import { assembleRetrievalResult } from "../../src/core/retrieval/index.js";
import type { EmbeddingClient } from "../../src/core/embedder.js";
import type { RetrieveConfig } from "../../src/core/retrieval/types.js";
import type {
  ChunkRecord,
  RetrievedChunk,
  SearchOptions,
  StorageBackend,
} from "../../src/core/types.js";

const NOW = "2026-08-31T00:00:00.000Z";

const LEXICAL_CONFIG: RetrieveConfig = {
  preset: "balanced",
  w_vec: 0.7,
  w_bm25: 0.15,
  w_graph: 0.15,
  bm25Enabled: true,
  graphEnabled: false,
  rerankEnabled: false,
  entityLinkTopK: 8,
  candidateCap: 50,
  neighborWidth: 0,
  graphArmFloor: 3,
};

function lexicalHit(id: string): RetrievedChunk {
  return {
    id,
    content: `content-${id}`,
    source_ref: `source/${id}`,
    valid_window: [NOW, null],
    score: 1,
  };
}

class LexicalOnlyBackend implements StorageBackend {
  vectorCalls = 0;

  async upsert(_chunks: ChunkRecord[]): Promise<string[]> {
    return [];
  }

  async search(
    _embedding: number[],
    _opts: SearchOptions
  ): Promise<RetrievedChunk[]> {
    this.vectorCalls += 1;
    throw new Error("vector search must not run without embedding credentials");
  }

  async searchLexical(
    _query: string,
    _opts: SearchOptions
  ): Promise<RetrievedChunk[]> {
    return [lexicalHit("keyword-a"), lexicalHit("keyword-b")];
  }

  async close(): Promise<void> {}
}

class CredentialsMissingEmbedder implements EmbeddingClient {
  readonly available = false;
  calls = 0;

  async embed(_texts: string[]): Promise<number[][]> {
    this.calls += 1;
    return [[999]];
  }
}

class ThrowingEmbedder implements EmbeddingClient {
  async embed(): Promise<number[][]> {
    throw new GraphragError(
      "embedding credentials are unavailable",
      "EMBEDDING_FAILED"
    );
  }
}

describe("T12 retrieval without deterministic pseudo-vectors", () => {
  it("does not call an unavailable embedder and marks vector unattempted", async () => {
    const embedder = new CredentialsMissingEmbedder();
    const storage = new LexicalOnlyBackend();

    const result = await assembleRetrievalResult(
      { query: "keyword query", validAt: NOW, limit: 10 },
      {
        embedder,
        storage,
        retrieveConfig: LEXICAL_CONFIG,
      }
    );

    expect(embedder.calls).toBe(0);
    expect(storage.vectorCalls).toBe(0);
    expect(result.degraded).toBe(true);
    expect(result.degraded_reasons).toContain("vector:unattempted");
    expect(result.chunks.map((chunk) => chunk.id)).toEqual([
      "keyword-a",
      "keyword-b",
    ]);
  });

  it("replays identically with a typed failing embedder and never returns a pseudo hit", async () => {
    const first = await assembleRetrievalResult(
      { query: "keyword query", validAt: NOW, limit: 10 },
      {
        embedder: new CredentialsMissingEmbedder(),
        storage: new LexicalOnlyBackend(),
        retrieveConfig: LEXICAL_CONFIG,
      }
    );
    const second = await assembleRetrievalResult(
      { query: "keyword query", validAt: NOW, limit: 10 },
      {
        embedder: new ThrowingEmbedder(),
        storage: new LexicalOnlyBackend(),
        retrieveConfig: LEXICAL_CONFIG,
      }
    );

    expect(second.chunks.map((chunk) => chunk.id)).toEqual(
      first.chunks.map((chunk) => chunk.id)
    );
    expect(second.chunks).not.toEqual([]);
    expect(second.degraded_reasons).toEqual(["vector:attempted-and-failed"]);
  });
});
