import { describe, expect, it } from "vitest";

import { assembleRetrievalResult } from "../../src/core/retrieval/index.js";
import {
  createRetrieveHandler,
  RetrieveInputSchema,
} from "../../src/tools/retrieve.js";
import type {
  CapabilityObservation,
  RetrieveConfig,
} from "../../src/core/retrieval/types.js";
import { GraphragError } from "../../src/core/errors.js";
import type { EmbeddingClient } from "../../src/core/embedder.js";
import type {
  ChunkRecord,
  RetrievedChunk,
  SearchOptions,
  StorageBackend,
} from "../../src/core/types.js";

const NOW = "2026-08-31T00:00:00.000Z";
const CFG: RetrieveConfig = {
  preset: "balanced",
  w_vec: 1,
  w_bm25: 1,
  w_graph: 1,
  bm25Enabled: true,
  graphEnabled: false,
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

class FakeRetrievalBackend implements StorageBackend {
  lexicalError: GraphragError | undefined;
  lexicalResults: RetrievedChunk[] = [];
  lexicalCalls = 0;

  async upsert(_chunks: ChunkRecord[]): Promise<string[]> {
    return [];
  }

  async search(
    _embedding: number[],
    _opts: SearchOptions
  ): Promise<RetrievedChunk[]> {
    return [
      {
        id: "vector-hit",
        content: "vector result",
        source_ref: "source/vector",
        valid_window: [NOW, null],
        score: 1,
      },
    ];
  }

  async searchLexical(
    _query: string,
    _opts: SearchOptions
  ): Promise<RetrievedChunk[]> {
    this.lexicalCalls += 1;
    if (this.lexicalError !== undefined) throw this.lexicalError;
    return this.lexicalResults;
  }

  async close(): Promise<void> {}
}

function observe(
  capability: CapabilityObservation["capability"],
  state: CapabilityObservation["state"]
): CapabilityObservation {
  return { capability, state };
}

describe("retrieve degraded envelope", () => {
  it("rule 1: names a default-on capability that was unattemptable", async () => {
    const backend = new FakeRetrievalBackend();
    const result = await assembleRetrievalResult(
      { query: "q", validAt: NOW, limit: 10 },
      {
        embedder: new FixedEmbedder(),
        storage: backend,
        retrieveConfig: CFG,
        capabilityObservations: [observe("graph_ppr", "unattempted")],
      }
    );

    expect(result.degraded).toBe(true);
    expect(result.degraded_reasons).toEqual(["graph_ppr:unattempted"]);
  });

  it("rule 2: names an attempted capability that failed", async () => {
    const backend = new FakeRetrievalBackend();
    backend.lexicalError = new GraphragError(
      "lexical index unavailable",
      "STORAGE_ERROR"
    );
    const result = await assembleRetrievalResult(
      { query: "q", validAt: NOW, limit: 10 },
      { embedder: new FixedEmbedder(), storage: backend, retrieveConfig: CFG }
    );

    expect(result.degraded).toBe(true);
    expect(result.degraded_reasons).toEqual([
      "keyword_bm25:attempted-and-failed",
    ]);
  });

  it("rule 3: an attempted capability with no hits is not degradation", async () => {
    const backend = new FakeRetrievalBackend();
    const result = await assembleRetrievalResult(
      { query: "q", validAt: NOW, limit: 10 },
      { embedder: new FixedEmbedder(), storage: backend, retrieveConfig: CFG }
    );

    expect(backend.lexicalCalls).toBe(1);
    expect(result.degraded ?? false).toBe(false);
    expect(result.degraded_reasons ?? []).toEqual([]);
  });

  it("rule 4: a caller-switched-off capability is not degradation", async () => {
    const backend = new FakeRetrievalBackend();
    backend.lexicalError = new GraphragError(
      "the disabled arm must not run",
      "STORAGE_ERROR"
    );
    const result = await assembleRetrievalResult(
      { query: "q", validAt: NOW, limit: 10 },
      {
        embedder: new FixedEmbedder(),
        storage: backend,
        retrieveConfig: { ...CFG, bm25Enabled: false },
        capabilityObservations: [observe("keyword_bm25", "disabled")],
      }
    );

    expect(backend.lexicalCalls).toBe(0);
    expect(result.degraded ?? false).toBe(false);
    expect(result.degraded_reasons ?? []).toEqual([]);
  });

  it("records several degraded capabilities in the bounded reason list", async () => {
    const backend = new FakeRetrievalBackend();
    const result = await assembleRetrievalResult(
      { query: "q", validAt: NOW, limit: 10 },
      {
        embedder: new FixedEmbedder(),
        storage: backend,
        retrieveConfig: CFG,
        capabilityObservations: [
          observe("graph_ppr", "unattempted"),
          observe("rerank", "attempted-and-failed"),
        ],
      }
    );

    expect(result.degraded).toBe(true);
    expect(result.degraded_reasons).toEqual([
      "graph_ppr:unattempted",
      "rerank:attempted-and-failed",
    ]);
  });

  it("rejects invalid caller input before a degraded envelope can be produced", () => {
    const parsed = RetrieveInputSchema.safeParse({ query: "" });
    expect(parsed.success).toBe(false);
  });

  it("keeps the success top level to chunks and the two optional keys", async () => {
    const result = await assembleRetrievalResult(
      { query: "q", validAt: NOW, limit: 10 },
      {
        embedder: new FixedEmbedder(),
        storage: new FakeRetrievalBackend(),
        retrieveConfig: CFG,
        debug: true,
      }
    );

    expect(Object.keys(result)).toEqual(["chunks"]);
    expect(JSON.parse(JSON.stringify(result))).toEqual({
      chunks: result.chunks,
    });
  });

  it("serializes degraded reasons without leaking internal debug keys", async () => {
    const backend = new FakeRetrievalBackend();
    backend.lexicalError = new GraphragError(
      "lexical index unavailable",
      "STORAGE_ERROR"
    );
    const handler = createRetrieveHandler({
      embedder: new FixedEmbedder(),
      storage: backend,
      retrieveConfig: CFG,
      debug: true,
    });
    const toolResult = await handler({ query: "q" });
    const text = toolResult.content[0]?.text;
    expect(typeof text).toBe("string");
    const body = JSON.parse(text ?? "{}") as Record<string, unknown>;

    expect(Object.keys(body)).toEqual([
      "chunks",
      "degraded",
      "degraded_reasons",
    ]);
    expect(body.degraded).toBe(true);
    expect(body.degraded_reasons).toEqual([
      "keyword_bm25:attempted-and-failed",
    ]);
  });
});
