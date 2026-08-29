import { describe, expect, it } from "vitest";
import { assembleRetrievalResult } from "../../src/core/retrieval/index.js";
import { FakeEmbedder } from "../../src/core/embedder.js";
import type {
  RetrievedChunk,
  SearchOptions,
  StorageBackend,
} from "../../src/core/types.js";
import { createHttpChunkReranker } from "../../src/core/rerank/http-reranker.js";

const CFG = {
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

class SearchBackend implements StorageBackend {
  constructor(private readonly results: RetrievedChunk[]) {}

  async upsert(): Promise<string[]> {
    return [];
  }

  async search(
    _embedding: number[],
    _opts: SearchOptions
  ): Promise<RetrievedChunk[]> {
    return this.results;
  }

  async close(): Promise<void> {}
}

function chunk(id: string): RetrievedChunk {
  return {
    id,
    content: `content of ${id}`,
    source_ref: `source/${id}`,
    valid_window: ["2024-01-01T00:00:00.000Z", null],
    score: 0.9,
  };
}

describe("createHttpChunkReranker", () => {
  it("posts query and candidates, then returns the response permutation", async () => {
    let requestUrl = "";
    let requestBody: unknown;
    const reranker = createHttpChunkReranker("https://rerank.example.test", {
      fetch: async (url, init) => {
        requestUrl = String(url);
        requestBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ chunks: ["b", "a"] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    await expect(
      reranker.permute("find it", [
        { id: "a", content: "A" },
        { id: "b", content: "B" },
      ])
    ).resolves.toEqual(["b", "a"]);
    expect(requestUrl).toBe("https://rerank.example.test");
    expect(requestBody).toEqual({
      query: "find it",
      chunks: [
        { id: "a", content: "A" },
        { id: "b", content: "B" },
      ],
    });
  });

  it("rejects HTTP errors and malformed envelopes", async () => {
    const httpError = createHttpChunkReranker("https://rerank.example.test", {
      fetch: async () => new Response("down", { status: 503 }),
    });
    await expect(
      httpError.permute("q", [{ id: "a", content: "A" }])
    ).rejects.toThrow(/HTTP 503/);

    const malformed = createHttpChunkReranker("https://rerank.example.test", {
      fetch: async () =>
        new Response(JSON.stringify({ result: ["a"] }), { status: 200 }),
    });
    await expect(
      malformed.permute("q", [{ id: "a", content: "A" }])
    ).rejects.toThrow(/chunks/);
  });

  it("uses the fake HTTP permutation before the retrieve limit", async () => {
    const storage = new SearchBackend([chunk("a"), chunk("b"), chunk("c")]);
    const reranker = createHttpChunkReranker("https://rerank.example.test", {
      fetch: async () =>
        new Response(JSON.stringify({ chunks: ["c", "b", "a"] }), {
          status: 200,
        }),
    });

    const out = await assembleRetrievalResult(
      {
        query: "q",
        validAt: "2024-06-01T00:00:00.000Z",
        limit: 2,
      },
      {
        embedder: new FakeEmbedder(1536),
        storage,
        retrieveConfig: CFG,
        reranker,
      }
    );

    expect(out.chunks.map((item) => item.id)).toEqual(["c", "b"]);
    expect(out).not.toHaveProperty("degraded");
  });

  it("fail-opens with degraded when HTTP rejects", async () => {
    const storage = new SearchBackend([chunk("a"), chunk("b")]);
    const reranker = createHttpChunkReranker("https://rerank.example.test", {
      fetch: async () => {
        throw new Error("connection refused");
      },
    });

    const out = await assembleRetrievalResult(
      {
        query: "q",
        validAt: "2024-06-01T00:00:00.000Z",
        limit: 2,
      },
      {
        embedder: new FakeEmbedder(1536),
        storage,
        retrieveConfig: CFG,
        reranker,
      }
    );

    expect(out.chunks.map((item) => item.id)).toEqual(["a", "b"]);
    expect(out.degraded).toBe(true);
  });
});
