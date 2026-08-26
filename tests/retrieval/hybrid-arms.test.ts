/**
 * Orchestrator-level hybrid retrieval: vector ∥ BM25 (#66).
 *
 * Covers the contract `assembleRetrievalResult` owes the retrieve tool:
 *   SC8   BM25 disabled → envelope is EXACTLY `{ chunks: [...] }`; a
 *         config switch is not a degradation
 *   SC9   BM25 throws → vector chunks still returned with
 *         `degraded: true`, and the call does not reject
 *   SC10  MemoryBackend + BM25 enabled → fused results without Postgres
 * plus the concurrency seam (both arms in flight together, not serial)
 * and the standing rule that an embed failure is a hard failure, never
 * fail-open.
 */
import { describe, it, expect } from "vitest";
import { assembleRetrievalResult } from "../../src/core/retrieval/index.js";
import type { RetrieveConfig } from "../../src/core/retrieval/types.js";
import { MemoryBackend } from "../../src/core/storage/memory-backend.js";
import type { LexicalStorageBackend } from "../../src/core/storage/backend.js";
import type { EmbeddingClient } from "../../src/core/embedder.js";
import type {
  ChunkRecord,
  SearchOptions,
  StorageBackend,
} from "../../src/core/types.js";
import { GraphragError } from "../../src/core/errors.js";

const DIM = 4;
const NOW = "2024-06-01T00:00:00Z";

/** Production defaults: vector 0.8 / BM25 0.2, BM25 on. */
const CFG: RetrieveConfig = {
  w_vec: 0.8,
  w_bm25: 0.2,
  w_graph: 1,
  bm25Enabled: true,
  entityLinkTopK: 8,
  candidateCap: 50,
  graphArmFloor: 3,
};

/** Every query and chunk embeds to the same vector — see makeChunk. */
class ConstantEmbedder implements EmbeddingClient {
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => new Array<number>(DIM).fill(0.5));
  }
}

class ThrowingEmbedder implements EmbeddingClient {
  async embed(): Promise<number[][]> {
    throw new GraphragError("provider down", "EMBEDDING_FAILED");
  }
}

function makeChunk(id: string, content: string): ChunkRecord {
  return {
    id,
    content,
    embedding: new Array<number>(DIM).fill(0.5),
    source_ref: `src/${id}`,
    metadata: {},
    valid_from: "2024-01-01T00:00:00Z",
    valid_until: null,
    created_at: "2024-01-01T00:00:00Z",
  };
}

async function seeded(...chunks: ChunkRecord[]): Promise<MemoryBackend> {
  const backend = new MemoryBackend(DIM);
  await backend.upsert(chunks);
  return backend;
}

/** Wraps a real backend, swapping in scripted behaviour for one arm. */
function withLexical(
  base: MemoryBackend,
  searchLexical: LexicalStorageBackend["searchLexical"]
): LexicalStorageBackend {
  return {
    upsert: (c) => base.upsert(c),
    search: (v, o) => base.search(v, o),
    close: () => base.close(),
    searchLexical,
  };
}

/** A chunk-only backend: no lexical seam at all. */
function withoutLexical(base: MemoryBackend): StorageBackend {
  return {
    upsert: (c) => base.upsert(c),
    search: (v, o) => base.search(v, o),
    close: () => base.close(),
  };
}

const embedder = new ConstantEmbedder();

describe("assembleRetrievalResult — BM25 arm enabled (SC10)", () => {
  it("fuses vector and BM25 hits over MemoryBackend, no Postgres needed", async () => {
    const storage = await seeded(
      makeChunk("lex", "the zubrowka protocol governs billing"),
      makeChunk("other", "unrelated notes about the weather")
    );
    const out = await assembleRetrievalResult(
      { query: "zubrowka", validAt: NOW, limit: 10 },
      { embedder, storage, retrieveConfig: CFG, debug: true }
    );
    // Every chunk embeds identically, so the vector arm cannot separate
    // them — only the lexical arm can, and it must lift "lex" to the top.
    expect(out.chunks.map((c) => c.id)).toContain("lex");
    expect(out.chunks[0]?.id).toBe("lex");
    expect(out.debug?.bm25Hits).toBe(1);
    expect(out.debug?.vectorHits).toBe(2);
    expect(Object.hasOwn(out, "degraded")).toBe(false);
  });

  it("still returns vector-only chunks when BM25 matches nothing", async () => {
    const storage = await seeded(makeChunk("a", "unrelated notes"));
    const out = await assembleRetrievalResult(
      { query: "xyzzyplugh", validAt: NOW, limit: 10 },
      { embedder, storage, retrieveConfig: CFG }
    );
    expect(out.chunks.map((c) => c.id)).toEqual(["a"]);
    // An arm that legitimately found nothing has not degraded.
    expect(Object.hasOwn(out, "degraded")).toBe(false);
  });

  it("scores a chunk found by both arms above one found by a single arm", async () => {
    const storage = await seeded(
      makeChunk("both", "zubrowka appears here"),
      makeChunk("vector-only", "nothing in common")
    );
    const out = await assembleRetrievalResult(
      { query: "zubrowka", validAt: NOW, limit: 10 },
      { embedder, storage, retrieveConfig: CFG }
    );
    const both = out.chunks.find((c) => c.id === "both")!;
    const vectorOnly = out.chunks.find((c) => c.id === "vector-only")!;
    expect(both.score).toBeGreaterThan(vectorOnly.score);
  });

  // The whole point of a lexical arm is recall the vector arm does not
  // have. If each arm only ever fetched `limit` rows, a chunk the vector
  // arm ranks below the cut could never be fused at all: BM25 would
  // contribute it as a lexical-only hit worth w_bm25/(k+1) = 0.0033,
  // which cannot outrank a vector-only hit at w_vec/(k+1) = 0.013. The
  // arms therefore draw from a deeper candidate pool and only the FUSED
  // list is cut to `limit`.
  it("surfaces a chunk the vector arm ranks below the limit", async () => {
    // Identical embeddings ⇒ the vector arm ranks by insertion order,
    // so seeding the target last puts it out of reach of a limit-2
    // vector fetch. Only BM25 knows it is the right answer.
    const storage = await seeded(
      ...Array.from({ length: 8 }, (_, i) =>
        makeChunk(`filler-${i}`, `unrelated note number ${i}`)
      ),
      makeChunk("target", "the zubrowka runbook")
    );

    const out = await assembleRetrievalResult(
      { query: "zubrowka", validAt: NOW, limit: 2 },
      { embedder, storage, retrieveConfig: CFG, debug: true }
    );
    expect(out.chunks).toHaveLength(2);
    expect(out.chunks.map((c) => c.id)).toContain("target");
    expect(out.debug?.vectorHits).toBeGreaterThan(2);
  });

  it("truncates the fused list to the requested limit", async () => {
    const storage = await seeded(
      makeChunk("a", "zubrowka one"),
      makeChunk("b", "zubrowka two"),
      makeChunk("c", "zubrowka three")
    );
    const out = await assembleRetrievalResult(
      { query: "zubrowka", validAt: NOW, limit: 2 },
      { embedder, storage, retrieveConfig: CFG }
    );
    expect(out.chunks).toHaveLength(2);
  });

  it("runs the two arms concurrently rather than one after the other", async () => {
    const base = await seeded(makeChunk("a", "zubrowka here"));
    const order: string[] = [];
    let releaseVector: () => void = () => {};
    const vectorGate = new Promise<void>((r) => {
      releaseVector = r;
    });

    const storage = withLexical(
      {
        ...base,
        search: async (v: number[], o: SearchOptions) => {
          order.push("vector:start");
          await vectorGate;
          order.push("vector:end");
          return base.search(v, o);
        },
      } as unknown as MemoryBackend,
      async (q, o) => {
        order.push("bm25:start");
        // The lexical arm reaching this point while the vector arm is
        // still parked proves the two were started together. If they ran
        // serially this would deadlock until the test timed out.
        releaseVector();
        return base.searchLexical(q, o);
      }
    );

    await assembleRetrievalResult(
      { query: "zubrowka", validAt: NOW, limit: 10 },
      { embedder, storage, retrieveConfig: CFG }
    );
    expect(order.slice(0, 2).sort()).toEqual(["bm25:start", "vector:start"]);
    expect(order).toContain("vector:end");
  });
});

describe("assembleRetrievalResult — BM25 disabled (SC8)", () => {
  it("returns exactly { chunks } with no degraded or debug key", async () => {
    const storage = await seeded(makeChunk("a", "zubrowka here"));
    const out = await assembleRetrievalResult(
      { query: "zubrowka", validAt: NOW, limit: 10 },
      {
        embedder,
        storage,
        retrieveConfig: { ...CFG, bm25Enabled: false },
        // Even with the debug gate open: a disabled arm has nothing to
        // report, and the wire shape must stay the stage-1 exact shape.
        debug: true,
      }
    );
    expect(Object.keys(out)).toEqual(["chunks"]);
    expect(out.chunks.map((c) => c.id)).toEqual(["a"]);
  });

  it("preserves plain vector ranking when the arm is off", async () => {
    const storage = await seeded(
      makeChunk("a", "zubrowka zubrowka zubrowka"),
      makeChunk("b", "no shared terms at all")
    );
    const off = await assembleRetrievalResult(
      { query: "zubrowka", validAt: NOW, limit: 10 },
      { embedder, storage, retrieveConfig: { ...CFG, bm25Enabled: false } }
    );
    // Identical embeddings ⇒ identical cosine ⇒ insertion order, and the
    // scores are raw cosine values rather than RRF scores.
    expect(off.chunks.map((c) => c.id)).toEqual(["a", "b"]);
    expect(off.chunks[0]?.score).toBeCloseTo(1, 6);
  });

  it("returns exactly { chunks } when the backend has no lexical seam", async () => {
    // Not a degradation either: a chunk-only backend never attempted BM25.
    const base = await seeded(makeChunk("a", "zubrowka here"));
    const out = await assembleRetrievalResult(
      { query: "zubrowka", validAt: NOW, limit: 10 },
      { embedder, storage: withoutLexical(base), retrieveConfig: CFG }
    );
    expect(Object.keys(out)).toEqual(["chunks"]);
  });

  it("returns exactly { chunks } when no retrieve config is supplied at all", async () => {
    const storage = await seeded(makeChunk("a", "zubrowka here"));
    const out = await assembleRetrievalResult(
      { query: "zubrowka", validAt: NOW, limit: 10 },
      { embedder, storage }
    );
    expect(Object.keys(out)).toEqual(["chunks"]);
  });
});

describe("assembleRetrievalResult — BM25 fail-open (SC9)", () => {
  it("returns vector chunks with degraded: true when the arm throws", async () => {
    const base = await seeded(
      makeChunk("a", "zubrowka here"),
      makeChunk("b", "another chunk")
    );
    const storage = withLexical(base, async () => {
      throw new GraphragError("lexical index unavailable", "STORAGE_ERROR");
    });

    const out = await assembleRetrievalResult(
      { query: "zubrowka", validAt: NOW, limit: 10 },
      { embedder, storage, retrieveConfig: CFG }
    );
    expect(out.degraded).toBe(true);
    expect(out.chunks.map((c) => c.id).sort()).toEqual(["a", "b"]);
  });

  it("does not reject, whatever the arm throws", async () => {
    const base = await seeded(makeChunk("a", "zubrowka here"));
    for (const thrown of [
      new Error("boom"),
      "a bare string",
      { unexpected: true },
    ]) {
      const storage = withLexical(base, async () => {
        throw thrown;
      });
      const out = await assembleRetrievalResult(
        { query: "zubrowka", validAt: NOW, limit: 10 },
        { embedder, storage, retrieveConfig: CFG }
      );
      expect(out.degraded).toBe(true);
      expect(out.chunks).toHaveLength(1);
    }
  });

  it("surfaces the failure reason under the debug gate", async () => {
    const base = await seeded(makeChunk("a", "zubrowka here"));
    const storage = withLexical(base, async () => {
      throw new Error("tsquery exploded");
    });
    const out = await assembleRetrievalResult(
      { query: "zubrowka", validAt: NOW, limit: 10 },
      { embedder, storage, retrieveConfig: CFG, debug: true }
    );
    expect(out.debug?.bm25FailureReason).toContain("tsquery exploded");
    expect(out.debug?.bm25Hits).toBe(0);
  });

  it("keeps an embed failure a hard failure — never fail-open", async () => {
    const storage = await seeded(makeChunk("a", "zubrowka here"));
    await expect(
      assembleRetrievalResult(
        { query: "zubrowka", validAt: NOW, limit: 10 },
        { embedder: new ThrowingEmbedder(), storage, retrieveConfig: CFG }
      )
    ).rejects.toThrow(/provider down/);
  });

  it("keeps a vector-arm failure a hard failure even with BM25 healthy", async () => {
    const base = await seeded(makeChunk("a", "zubrowka here"));
    const storage = withLexical(
      {
        ...base,
        search: async () => {
          throw new GraphragError("vector store down", "STORAGE_ERROR");
        },
      } as unknown as MemoryBackend,
      async (q, o) => base.searchLexical(q, o)
    );
    await expect(
      assembleRetrievalResult(
        { query: "zubrowka", validAt: NOW, limit: 10 },
        { embedder, storage, retrieveConfig: CFG }
      )
    ).rejects.toThrow(/vector store down/);
  });
});

describe("retrieve tool — BM25 wiring", () => {
  it("passes its retrieveConfig through to the orchestrator", async () => {
    const { createRetrieveHandler } = await import(
      "../../src/tools/retrieve.js"
    );
    const storage = await seeded(
      makeChunk("lex", "zubrowka protocol"),
      makeChunk("other", "unrelated")
    );
    const handler = createRetrieveHandler({
      embedder,
      storage,
      retrieveConfig: CFG,
      debug: true,
    });
    const result = await handler({ query: "zubrowka" });
    const body = JSON.parse(
      (result.content as Array<{ type: string; text?: string }>)
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("")
    ) as { chunks: Array<{ id: string }>; debug?: Record<string, unknown> };
    expect(body.debug?.bm25Hits).toBe(1);
    expect(body.chunks[0]?.id).toBe("lex");
  });
});