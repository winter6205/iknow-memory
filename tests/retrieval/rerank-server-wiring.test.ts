/**
 * Q-T2 wiring — dedicated HTTP rerank adapter behind the retrieve hook
 * (specs/retrieve-graph-quality.md SC1, SC2, SC3, SC14).
 *
 * The orchestrator already routes through `maybeRerank`. Server wiring
 * (`buildRetrieveReranker`) builds `createHttpChunkReranker` when
 * `env.rerankUrl` is set, otherwise the MiniMax LLM adapter when
 * `env.rerank` creds exist, otherwise no adapter.
 *
 * SC14: no live HTTP. Every test injects `fetch` via `createHttpChunkReranker`
 * (or skips the adapter entirely), so `npm test` never opens a socket.
 */
import { describe, expect, it, vi } from "vitest";

import { assembleRetrievalResult } from "../../src/core/retrieval/index.js";
import { createHttpChunkReranker } from "../../src/core/rerank/http-reranker.js";
import type {
  ChunkReranker,
  RetrieveConfig,
} from "../../src/core/retrieval/types.js";
import type {
  RetrievedChunk,
  SearchOptions,
  StorageBackend,
} from "../../src/core/types.js";

const NOW = "2026-08-31T00:00:00.000Z";

/**
 * Hybrid disabled → vector-only path; the rerank branch is what SC1–SC3
 * are isolating, so other arms stay off to keep the assertions narrow.
 */
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

class FixedEmbedder {
  async embed(_texts: string[]): Promise<number[][]> {
    return [[1]];
  }
}

class VectorOnlyBackend implements StorageBackend {
  constructor(private readonly hits: RetrievedChunk[]) {}

  async upsert(): Promise<string[]> {
    return [];
  }

  async search(
    _embedding: number[],
    _opts: SearchOptions
  ): Promise<RetrievedChunk[]> {
    return this.hits;
  }

  async close(): Promise<void> {}
}

function vec(id: string): RetrievedChunk {
  return {
    id,
    content: `content of ${id}`,
    source_ref: `src/${id}`,
    valid_window: ["2024-01-01T00:00:00.000Z", null],
    score: 0.9,
  };
}

const ARGS = {
  query: "find it",
  validAt: NOW,
  limit: 2,
};

describe("Q-T2 — dedicated HTTP rerank server wiring", () => {
  it("SC1: rerankEnabled=false leaves the hit list untouched and skips the adapter", async () => {
    // The stub throws on purpose; if `getReranker` ever short-circuits
    // `rerankEnabled=false`, this throw must never surface — proving the
    // wiring does not leak past the off switch regardless of `rerankUrl`.
    const permute = vi.fn(async () => {
      throw new Error("rerank must not be called when rerankEnabled=false");
    });
    const reranker: ChunkReranker = { permute };

    const out = await assembleRetrievalResult(ARGS, {
      embedder: new FixedEmbedder(),
      storage: new VectorOnlyBackend([vec("a"), vec("b"), vec("c")]),
      retrieveConfig: { ...RERANK_CONFIG, rerankEnabled: false },
      reranker,
    });

    expect(permute).not.toHaveBeenCalled();
    expect(out.chunks.map((chunk) => chunk.id)).toEqual(["a", "b"]);
    expect(out).not.toHaveProperty("degraded");
  });

  it("SC2: rerankEnabled=true without a wired reranker is unattempted + degraded", async () => {
    // `reranker` is undefined: this mirrors `buildDeps` when `env.rerankUrl`
    // is absent under the dedicated-rerank adapter. The orchestrator must
    // flip `degraded: true` AND surface `rerank:unattempted` (C-3 supersede
    // of the older "skip, no degraded" plan line).
    const out = await assembleRetrievalResult(ARGS, {
      embedder: new FixedEmbedder(),
      storage: new VectorOnlyBackend([vec("a"), vec("b")]),
      retrieveConfig: RERANK_CONFIG,
    });

    expect(out.chunks.map((chunk) => chunk.id)).toEqual(["a", "b"]);
    expect(out.degraded).toBe(true);
    expect(out.degraded_reasons).toContain("rerank:unattempted");
  });

  it("SC3: on+URL with a stubbed fetch permutation is reflected on chunks[] then cut to limit", async () => {
    // SC14 — no real HTTP. The stub `fetch` returns a valid permutation
    // for whatever query / candidates arrive; the test then asserts that
    // `assembleRetrievalResult` honors the order and the Host limit.
    const stubFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ chunks: ["c", "b", "a"] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
    );
    const reranker = createHttpChunkReranker("https://rerank.example.test", {
      fetch: stubFetch,
    });

    const out = await assembleRetrievalResult(
      { ...ARGS, limit: 2 },
      {
        embedder: new FixedEmbedder(),
        storage: new VectorOnlyBackend([vec("a"), vec("b"), vec("c")]),
        retrieveConfig: RERANK_CONFIG,
        reranker,
      }
    );

    // The stub is invoked exactly once with the URL we wired.
    expect(stubFetch).toHaveBeenCalledTimes(1);
    expect(stubFetch.mock.calls[0]?.[0]).toBe("https://rerank.example.test");
    // Permutation honored, then cut to Host `limit`.
    expect(out.chunks.map((chunk) => chunk.id)).toEqual(["c", "b"]);
    expect(out).not.toHaveProperty("degraded");
  });
});
