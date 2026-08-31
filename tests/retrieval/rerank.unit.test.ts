/**
 * Temporary LLM rerank (specs/retrieve-rerank-llm.md SC1–SC6).
 *
 * Tests the pure helper and the assembleRetrievalResult gate with injected
 * fakes — no live Anthropic.
 */
import { describe, it, expect } from "vitest";
import {
  applyRerank,
  rerankWindowSize,
} from "../../src/core/retrieval/rerank.js";
import { assembleRetrievalResult } from "../../src/core/retrieval/index.js";
import { FakeEmbedder } from "../../src/core/embedder.js";
import { GraphragError } from "../../src/core/errors.js";
import type {
  ChunkReranker,
  FusedHit,
  RetrieveConfig,
} from "../../src/core/retrieval/types.js";
import type {
  RetrievedChunk,
  SearchOptions,
  StorageBackend,
} from "../../src/core/types.js";
import type { EmbeddingClient } from "../../src/core/embedder.js";

const CFG: RetrieveConfig = {
  w_vec: 1,
  w_bm25: 1,
  w_graph: 1,
  bm25Enabled: false,
  graphEnabled: false,
  rerankEnabled: true,
  entityLinkTopK: 8,
  candidateCap: 50,
  graphArmFloor: 3,
};

function fused(id: string, rank = 1): FusedHit {
  return {
    id,
    content: `content of ${id}`,
    source_ref: `src/${id}`,
    valid_window: ["2024-01-01T00:00:00Z", null],
    rrfScore: 1 / (60 + rank),
    arms: ["vector"],
  };
}

function permute(ids: readonly string[]): ChunkReranker {
  return {
    permute: async () => ids,
  };
}

describe("rerankWindowSize", () => {
  it("uses candidateCap when it is at least limit", () => {
    expect(rerankWindowSize(10, 50)).toBe(50);
  });

  it("uses Host limit when it exceeds candidateCap", () => {
    expect(rerankWindowSize(100, 50)).toBe(100);
  });

  it("is 0 when limit is not positive", () => {
    expect(rerankWindowSize(0, 50)).toBe(0);
    expect(rerankWindowSize(-1, 50)).toBe(0);
  });
});

describe("applyRerank", () => {
  const hits = [fused("a", 1), fused("b", 2), fused("c", 3)];

  it("empty candidates never call the reranker", async () => {
    let called = 0;
    const reranker: ChunkReranker = {
      permute: async () => {
        called += 1;
        return [];
      },
    };
    const out = await applyRerank([], {
      query: "q",
      limit: 10,
      window: 50,
      reranker,
    });
    expect(called).toBe(0);
    expect(out.hits).toEqual([]);
    expect(out.degraded).toBeUndefined();
  });

  it("limit <= 0 never calls the reranker", async () => {
    let called = 0;
    const reranker: ChunkReranker = {
      permute: async () => {
        called += 1;
        return ["a"];
      },
    };
    const out = await applyRerank(hits, {
      query: "q",
      limit: 0,
      window: 50,
      reranker,
    });
    expect(called).toBe(0);
    expect(out.hits).toEqual([]);
    expect(out.degraded).toBeUndefined();
  });

  it("applies a valid permutation then cuts to limit", async () => {
    const out = await applyRerank(hits, {
      query: "q",
      limit: 2,
      window: 50,
      reranker: permute(["c", "b", "a"]),
    });
    expect(out.hits.map((h) => h.id)).toEqual(["c", "b"]);
    expect(out.degraded).toBeUndefined();
  });

  it("sends only the prefix W to the reranker (overflow)", async () => {
    const seen: string[][] = [];
    const reranker: ChunkReranker = {
      permute: async (_query, candidates) => {
        seen.push(candidates.map((c) => c.id));
        return candidates.map((c) => c.id).reverse();
      },
    };
    const many = ["a", "b", "c", "d", "e"].map((id, i) => fused(id, i + 1));
    const out = await applyRerank(many, {
      query: "q",
      limit: 2,
      window: 3,
      reranker,
    });
    expect(seen).toEqual([["a", "b", "c"]]);
    expect(out.hits.map((h) => h.id)).toEqual(["c", "b"]);
  });

  it("fail-opens with degraded on throw", async () => {
    const reranker: ChunkReranker = {
      permute: async () => {
        throw new Error("llm down");
      },
    };
    const out = await applyRerank(hits, {
      query: "q",
      limit: 2,
      window: 50,
      reranker,
    });
    expect(out.hits.map((h) => h.id)).toEqual(["a", "b"]);
    expect(out.degraded).toBe(true);
  });

  it("fail-opens with degraded on unknown ids", async () => {
    const out = await applyRerank(hits, {
      query: "q",
      limit: 2,
      window: 50,
      reranker: permute(["a", "zzz", "b"]),
    });
    expect(out.hits.map((h) => h.id)).toEqual(["a", "b"]);
    expect(out.degraded).toBe(true);
  });

  it("two concurrent calls do not share a permutation buffer", async () => {
    const reranker: ChunkReranker = {
      permute: async (_q, candidates) =>
        [...candidates.map((c) => c.id)].reverse(),
    };
    const left = [fused("a"), fused("b")];
    const right = [fused("x"), fused("y")];
    const [a, b] = await Promise.all([
      applyRerank(left, { query: "q1", limit: 2, window: 50, reranker }),
      applyRerank(right, { query: "q2", limit: 2, window: 50, reranker }),
    ]);
    expect(a.hits.map((h) => h.id)).toEqual(["b", "a"]);
    expect(b.hits.map((h) => h.id)).toEqual(["y", "x"]);
  });
});

class SearchBackend implements StorageBackend {
  searchResults: RetrievedChunk[] = [];
  capturedLimits: number[] = [];
  capturedLexicalLimits: number[] = [];

  async upsert(): Promise<string[]> {
    return [];
  }

  async search(
    _embedding: number[],
    opts: SearchOptions
  ): Promise<RetrievedChunk[]> {
    this.capturedLimits.push(opts.limit);
    return this.searchResults.slice(0, opts.limit);
  }

  async close(): Promise<void> {}
}

class LexicalSearchBackend extends SearchBackend {
  async searchLexical(
    _query: string,
    opts: SearchOptions
  ): Promise<RetrievedChunk[]> {
    this.capturedLexicalLimits.push(opts.limit);
    return this.searchResults.slice(0, opts.limit);
  }
}

function vec(id: string): RetrievedChunk {
  return {
    id,
    content: `content of ${id}`,
    source_ref: `src/${id}`,
    valid_window: ["2024-01-01T00:00:00Z", null],
    score: 0.9,
  };
}

const ARGS = {
  query: "how does fusion work",
  validAt: "2024-06-01T00:00:00.000Z",
  limit: 2,
};

describe("assembleRetrievalResult — rerank gate", () => {
  it("SC1: rerankEnabled false does not call the reranker", async () => {
    const storage = new SearchBackend();
    storage.searchResults = [vec("a"), vec("b"), vec("c")];
    let called = 0;
    const out = await assembleRetrievalResult(ARGS, {
      embedder: new FakeEmbedder(1536),
      storage,
      retrieveConfig: { ...CFG, rerankEnabled: false },
      reranker: {
        permute: async () => {
          called += 1;
          return ["c", "b", "a"];
        },
      },
    });
    expect(called).toBe(0);
    expect(out.chunks.map((c) => c.id)).toEqual(["a", "b"]);
    expect(out).not.toHaveProperty("degraded");
  });

  it("SC2: enable-on without a wired reranker is unattempted and degraded", async () => {
    const storage = new SearchBackend();
    storage.searchResults = [vec("a"), vec("b")];
    const out = await assembleRetrievalResult(ARGS, {
      embedder: new FakeEmbedder(1536),
      storage,
      retrieveConfig: CFG,
    });
    expect(out.chunks.map((c) => c.id)).toEqual(["a", "b"]);
    expect(out.degraded).toBe(true);
    expect(out.degraded_reasons).toContain("rerank:unattempted");
  });

  it("SC3: a valid fake permutation is visible on chunks[] after limit", async () => {
    const storage = new SearchBackend();
    storage.searchResults = [vec("a"), vec("b"), vec("c")];
    const out = await assembleRetrievalResult(ARGS, {
      embedder: new FakeEmbedder(1536),
      storage,
      retrieveConfig: CFG,
      reranker: permute(["c", "b", "a"]),
    });
    expect(out.chunks.map((c) => c.id)).toEqual(["c", "b"]);
    expect(out).not.toHaveProperty("degraded");
  });

  it("two concurrent retrieve calls keep distinct fake permutations isolated", async () => {
    const leftStorage = new SearchBackend();
    leftStorage.searchResults = [vec("left-a"), vec("left-b")];
    const rightStorage = new SearchBackend();
    rightStorage.searchResults = [vec("right-a"), vec("right-b")];

    const [left, right] = await Promise.all([
      assembleRetrievalResult(
        { ...ARGS, query: "left query" },
        {
          embedder: new FakeEmbedder(1536),
          storage: leftStorage,
          retrieveConfig: CFG,
          reranker: permute(["left-b", "left-a"]),
        }
      ),
      assembleRetrievalResult(
        { ...ARGS, query: "right query" },
        {
          embedder: new FakeEmbedder(1536),
          storage: rightStorage,
          retrieveConfig: CFG,
          reranker: permute(["right-b", "right-a"]),
        }
      ),
    ]);

    expect(left.chunks.map((chunk) => chunk.id)).toEqual(["left-b", "left-a"]);
    expect(right.chunks.map((chunk) => chunk.id)).toEqual([
      "right-b",
      "right-a",
    ]);
  });

  it("Host limit above candidateCap still returns limit chunks (identity rerank)", async () => {
    const storage = new SearchBackend();
    storage.searchResults = Array.from({ length: 100 }, (_, i) => vec(`c${i}`));
    const out = await assembleRetrievalResult(
      { ...ARGS, limit: 100 },
      {
        embedder: new FakeEmbedder(1536),
        storage,
        retrieveConfig: { ...CFG, candidateCap: 50 },
        reranker: {
          permute: async (_q, candidates) => candidates.map((c) => c.id),
        },
      }
    );
    expect(out.chunks).toHaveLength(100);
    expect(storage.capturedLimits[0]).toBe(100);
  });

  it("SC4: reranker throw fail-opens with degraded and original order", async () => {
    const storage = new SearchBackend();
    storage.searchResults = [vec("a"), vec("b"), vec("c")];
    const out = await assembleRetrievalResult(ARGS, {
      embedder: new FakeEmbedder(1536),
      storage,
      retrieveConfig: CFG,
      reranker: {
        permute: async () => {
          throw new Error("anthropic 500");
        },
      },
    });
    expect(out.chunks.map((c) => c.id)).toEqual(["a", "b"]);
    expect(out.degraded).toBe(true);
  });

  it("fusing path keeps the ARM_CANDIDATE_POOL fetch floor under rerank", async () => {
    const storage = new LexicalSearchBackend();
    storage.searchResults = [vec("a"), vec("b"), vec("c")];
    const out = await assembleRetrievalResult(ARGS, {
      embedder: new FakeEmbedder(1536),
      storage,
      retrieveConfig: { ...CFG, bm25Enabled: true, candidateCap: 8 },
      reranker: {
        permute: async (_q, candidates) => candidates.map((c) => c.id),
      },
    });
    expect(out.chunks).toHaveLength(2);
    expect(storage.capturedLimits[0]).toBeGreaterThanOrEqual(50);
    expect(storage.capturedLexicalLimits[0]).toBeGreaterThanOrEqual(50);
    expect(out).not.toHaveProperty("degraded");
  });

  it("embed failure still hard-fails before rerank", async () => {
    const storage = new SearchBackend();
    storage.searchResults = [vec("a")];
    const embedder: EmbeddingClient = {
      embed: async () => [],
    };
    await expect(
      assembleRetrievalResult(ARGS, {
        embedder,
        storage,
        retrieveConfig: CFG,
        reranker: permute(["a"]),
      })
    ).rejects.toBeInstanceOf(GraphragError);
  });
});
