/**
 * T5 retrieve graph-arm integration tests (spec-3 p0-integration).
 *
 * Drives the full `createRetrieveHandler` → `assembleRetrievalResult`
 * pipeline through a fake GraphRagStorageBackend seam — no live Postgres.
 * Covers the envelope contract: empty-DB / vector-only paths emit EXACTLY
 * `{ chunks: [...] }` (no `degraded` / `debug` keys, Success Criterion #4);
 * the graph-arm under-floor path emits `degraded: true`; the graph-arm
 * satisfied path omits `degraded`; and the RRF fusion marks both-arm hits.
 */
import { describe, it, expect } from "vitest";
import {
  createRetrieveHandler,
  RetrieveInputSchema,
} from "../../src/tools/retrieve.js";
import { FakeEmbedder } from "../../src/core/embedder.js";
import { MemoryBackend } from "../../src/core/storage/memory-backend.js";
import { loadEnv, ConfigError } from "../../src/config.js";
import { RetrieveConfigError } from "../../src/core/retrieval/types.js";
import type { EmbeddingClient } from "../../src/core/embedder.js";
import type {
  GraphArmStorage,
  RetrieveConfig,
} from "../../src/core/retrieval/types.js";
import type { GraphRagStorageBackend } from "../../src/core/storage/backend.js";
import type { RetrievedChunk, SearchOptions } from "../../src/core/types.js";
import type { ToolResult } from "../../src/tools/registry.js";

const TEST_DIM = 1536;

/** Default RetrieveConfig the handler tests run under. */
const CFG: RetrieveConfig = {
  preset: "balanced",
  w_vec: 1,
  w_bm25: 1,
  w_graph: 1,
  bm25Enabled: false,
  graphEnabled: false,
  rerankEnabled: false,
  entityLinkTopK: 8,
  candidateCap: 50,
  neighborWidth: 1,
  graphArmFloor: 3,
};

/**
 * Fake backend implementing the graph-rag seam. Vector search returns preset
 * RetrievedChunks; the graph arm returns preset seeds / one-hop rows. Both
 * are controllable per test; the embedder's actual vector is ignored.
 */
class FakeGraphBackend implements GraphRagStorageBackend {
  searchResults: RetrievedChunk[] = [];
  seeds: Array<{ id: string; canonical_name: string }> = [];
  oneHopRows: Array<{
    id: string;
    content: string;
    source_ref: string;
    valid_from: string;
    valid_until: string | null;
  }> = [];
  searchCalls: SearchOptions[] = [];
  seedTopKs: number[] = [];
  oneHopSeedIds: string[][] = [];

  readonly graphArmSeed: GraphArmStorage = {
    seedEntitiesByEmbedding: async (
      _embedding: number[],
      topK: number
    ): Promise<Array<{ id: string; canonical_name: string }>> => {
      this.seedTopKs.push(topK);
      return this.seeds;
    },
    chunksByOneHopFromEntities: async (
      seedIds: string[],
      _validAt: string,
      _limit: number
    ): Promise<
      Array<{
        id: string;
        content: string;
        source_ref: string;
        valid_from: string;
        valid_until: string | null;
      }>
    > => {
      this.oneHopSeedIds.push(seedIds);
      return this.oneHopRows;
    },
  };

  async upsert(): Promise<string[]> {
    return [];
  }
  async search(
    _queryEmbedding: number[],
    opts: SearchOptions
  ): Promise<RetrievedChunk[]> {
    this.searchCalls.push(opts);
    return this.searchResults.slice(0, opts.limit);
  }
  async searchLexical(
    _query: string,
    opts: SearchOptions
  ): Promise<RetrievedChunk[]> {
    return this.searchResults.slice(0, opts.limit);
  }
  async close(): Promise<void> {}
}

/** A preset RetrievedChunk for the vector arm. */
function vecChunk(id: string, score = 1): RetrievedChunk {
  return {
    id,
    content: `content-${id}`,
    source_ref: `src/${id}`,
    valid_window: ["2024-01-01T00:00:00Z", null],
    score,
  };
}

/** A preset one-hop row for the graph arm. */
function graphRow(id: string): {
  id: string;
  content: string;
  source_ref: string;
  valid_from: string;
  valid_until: string | null;
} {
  return {
    id,
    content: `content-${id}`,
    source_ref: `src/${id}`,
    valid_from: "2024-01-01T00:00:00Z",
    valid_until: null,
  };
}

/** Parse the JSON text body of a ToolResult. */
function parseBody(result: ToolResult): Record<string, unknown> {
  const text = result.content[0]?.text;
  if (typeof text !== "string") throw new Error("expected text content");
  return JSON.parse(text) as Record<string, unknown>;
}

/** Build a handler wired to a FakeGraphBackend + given config. */
function makeGraphHandler(opts: {
  backend?: FakeGraphBackend;
  graphConfig?: RetrieveConfig;
  debug?: boolean;
}) {
  return createRetrieveHandler({
    embedder: new FakeEmbedder(TEST_DIM),
    storage: opts.backend ?? new FakeGraphBackend(),
    graphConfig: opts.graphConfig,
    debug: opts.debug,
  });
}

describe("retrieve graph-arm envelope (T5)", () => {
  it("retrieve input schema rejects an unknown preset", () => {
    expect(
      RetrieveInputSchema.safeParse({ query: "q", preset: "fast" }).success
    ).toBe(false);
  });

  it("unknown direct retrieve input is rejected with a typed error", async () => {
    const handler = createRetrieveHandler({
      embedder: new FakeEmbedder(TEST_DIM),
      storage: new MemoryBackend(TEST_DIM),
    });
    await expect(
      handler({ query: "q", preset: "fast" } as never)
    ).rejects.toBeInstanceOf(RetrieveConfigError);
  });

  it("input preset narrows the rerank candidate window", async () => {
    const backend = new FakeGraphBackend();
    backend.searchResults = Array.from({ length: 60 }, (_, i) =>
      vecChunk(`preset-${i}`)
    );
    const rerankCandidates: number[] = [];
    const handler = createRetrieveHandler({
      embedder: new FakeEmbedder(TEST_DIM),
      storage: backend,
      retrieveConfig: {
        ...CFG,
        bm25Enabled: true,
        rerankEnabled: true,
      },
      reranker: {
        async permute(_query, candidates) {
          rerankCandidates.push(candidates.length);
          return candidates.map((candidate) => candidate.id);
        },
      },
    });

    await handler({ query: "q", preset: "conservative" });

    expect(backend.searchCalls[0]?.limit).toBe(25);
    expect(rerankCandidates).toEqual([25]);
  });

  it("empty P0 DB + MemoryBackend (no graphArmSeed, no graphConfig) → exactly { chunks: [] }", async () => {
    const handler = createRetrieveHandler({
      embedder: new FakeEmbedder(TEST_DIM),
      storage: new MemoryBackend(TEST_DIM),
    });
    const body = parseBody(await handler({ query: "anything" }));
    expect(body).toEqual({ chunks: [] });
    expect(body).not.toHaveProperty("degraded");
    expect(body).not.toHaveProperty("debug");
  });

  it("graphArmSeed present but graph arm below floor → degraded: true", async () => {
    const backend = new FakeGraphBackend();
    // Vector returns one chunk; graph arm yields 0 one-hop chunks (defaults).
    // Spec §Boundaries: "if chunksByOneHopFromEntities returns < graphArmFloor
    // hits, set degraded: true" — the floor counts chunks, not seed entities.
    backend.searchResults = [vecChunk("v1")];
    backend.seeds = [{ id: "e1", canonical_name: "E1" }];
    const handler = makeGraphHandler({
      backend,
      graphConfig: CFG,
    });
    const body = parseBody(await handler({ query: "q" }));
    expect(body.degraded).toBe(true);
    // Vector results still flow through (fail-open, not fail-closed).
    expect(body.chunks).toHaveLength(1);
    expect(body.chunks[0]).toMatchObject({ id: "v1" });
  });

  it("graph arm satisfies floor → degraded is absent", async () => {
    const backend = new FakeGraphBackend();
    backend.searchResults = [vecChunk("v1")];
    backend.seeds = [
      { id: "e1", canonical_name: "E1" },
      { id: "e2", canonical_name: "E2" },
      { id: "e3", canonical_name: "E3" },
    ];
    // Floor counts chunks; 3 one-hop rows >= floor 3.
    backend.oneHopRows = [graphRow("g1"), graphRow("g2"), graphRow("g3")];
    const handler = makeGraphHandler({ backend, graphConfig: CFG });
    const body = parseBody(await handler({ query: "q" }));
    expect(body).not.toHaveProperty("degraded");
    expect(body.chunks).toHaveLength(4);
  });

  it("graphArmSeed undefined (MemoryBackend) + graphConfig → vector-only fallback, no degraded", async () => {
    const backend = new MemoryBackend(TEST_DIM);
    await backend.upsert([
      {
        id: "c1",
        content: "content-c1",
        embedding: new Array<number>(TEST_DIM).fill(0.01),
        source_ref: "src/c1",
        metadata: {},
        valid_from: "2024-01-01T00:00:00Z",
        valid_until: null,
        created_at: "2024-01-01T00:00:00Z",
      },
    ]);
    const handler = createRetrieveHandler({
      embedder: new FakeEmbedder(TEST_DIM),
      storage: backend,
      graphConfig: CFG,
    });
    const body = parseBody(await handler({ query: "anything" }));
    expect(body).not.toHaveProperty("degraded");
    expect(body).not.toHaveProperty("debug");
    expect(body.chunks).toHaveLength(1);
    expect(body.chunks[0]).toMatchObject({ id: "c1" });
  });

  it("same chunk hit by both arms → RRF score sums, arms marks both", async () => {
    const backend = new FakeGraphBackend();
    // Vector arm: chunk "shared" is rank 1. Graph arm: also returns "shared"
    // as rank-1 one-hop (plus graph-only "g2" and "g3"). 3 one-hop rows
    // satisfy the default floor of 3 so the graph arm participates in RRF.
    backend.searchResults = [vecChunk("shared")];
    backend.seeds = [
      { id: "e1", canonical_name: "E1" },
      { id: "e2", canonical_name: "E2" },
      { id: "e3", canonical_name: "E3" },
    ];
    backend.oneHopRows = [graphRow("shared"), graphRow("g2"), graphRow("g3")];
    const handler = makeGraphHandler({ backend, graphConfig: CFG });
    const body = parseBody(await handler({ query: "q" }));
    // shared = 1/61 (vec rank1) + 1/61 (graph rank1) = 2/61; ranked first.
    const shared = body.chunks.find((c) => c.id === "shared");
    expect(shared).toBeDefined();
    expect(shared.score).toBeCloseTo(2 / 61, 10);
    expect(body.chunks[0].id).toBe("shared");
    // g2 is graph-only, rank 2 → 1/62.
    const g2 = body.chunks.find((c) => c.id === "g2");
    expect(g2.score).toBeCloseTo(1 / 62, 10);
  });

  it("debug gate off → no debug key even when graph arm active", async () => {
    const backend = new FakeGraphBackend();
    backend.searchResults = [vecChunk("v1")];
    backend.seeds = [
      { id: "e1", canonical_name: "E1" },
      { id: "e2", canonical_name: "E2" },
      { id: "e3", canonical_name: "E3" },
    ];
    backend.oneHopRows = [graphRow("g1"), graphRow("g2"), graphRow("g3")];
    const handler = makeGraphHandler({ backend, graphConfig: CFG }); // debug undefined
    const body = parseBody(await handler({ query: "q" }));
    expect(body).not.toHaveProperty("debug");
  });

  it("debug gate on → diagnostics stay out of the wire envelope", async () => {
    const backend = new FakeGraphBackend();
    backend.searchResults = [vecChunk("v1")];
    backend.seeds = [
      { id: "e1", canonical_name: "E1" },
      { id: "e2", canonical_name: "E2" },
      { id: "e3", canonical_name: "E3" },
    ];
    backend.oneHopRows = [graphRow("g1"), graphRow("g2"), graphRow("g3")];
    const handler = makeGraphHandler({
      backend,
      graphConfig: CFG,
      debug: true,
    });
    const body = parseBody(await handler({ query: "q" }));
    expect(Object.keys(body)).toEqual(["chunks"]);
    expect(body).not.toHaveProperty("debug");
  });
});

/** Counting embedder local to this suite — records every embed batch. */
class CountingEmbedder implements EmbeddingClient {
  readonly batches: string[][] = [];

  async embed(texts: string[]): Promise<number[][]> {
    this.batches.push([...texts]);
    return texts.map(() => new Array<number>(TEST_DIM).fill(0.02));
  }
}

describe("retrieve embed budget (T7 G5)", () => {
  it("SC12a: exactly one embedder call per retrieve invocation when the graph arm is active", async () => {
    const backend = new FakeGraphBackend();
    backend.searchResults = [vecChunk("v1")];
    backend.seeds = [
      { id: "e1", canonical_name: "E1" },
      { id: "e2", canonical_name: "E2" },
      { id: "e3", canonical_name: "E3" },
    ];
    backend.oneHopRows = [graphRow("g1"), graphRow("g2"), graphRow("g3")];
    const embedder = new CountingEmbedder();
    const handler = createRetrieveHandler({
      embedder,
      storage: backend,
      graphConfig: CFG,
    });
    const body = parseBody(await handler({ query: "q" }));
    expect(embedder.batches).toEqual([["q"]]);
    expect(body).not.toHaveProperty("degraded");
  });
});

// --- Config boundary validation (spec §Boundaries → ConfigError) ---

const RETRIEVAL_VARS = [
  "GRAPHRAG_MEMORY_RETRIEVAL_W_VEC",
  "GRAPHRAG_MEMORY_RETRIEVAL_W_BM25",
  "GRAPHRAG_MEMORY_RETRIEVAL_W_GRAPH",
  "GRAPHRAG_MEMORY_RETRIEVAL_BM25_ENABLED",
  "GRAPHRAG_MEMORY_RETRIEVAL_GRAPH_ENABLED",
  "GRAPHRAG_MEMORY_RETRIEVAL_NODE_EMBEDDING_ENABLED",
  "GRAPHRAG_MEMORY_RETRIEVAL_PRESET",
  "GRAPHRAG_MEMORY_RETRIEVAL_ENTITY_LINK_TOP_K",
  "GRAPHRAG_MEMORY_RETRIEVAL_CANDIDATE_CAP",
  "GRAPHRAG_MEMORY_RETRIEVAL_GRAPH_ARM_FLOOR",
] as const;

/** Run fn with retrieval vars scrubbed, then patched. Keeps dimensions defaulted. */
function withRetrievalEnv(
  patch: Record<string, string | undefined>,
  fn: () => void
) {
  const kevs = [
    ...RETRIEVAL_VARS,
    "GRAPHRAG_MEMORY_EMBED_DIMENSIONS" as string,
  ];
  const saved = new Map<string, string | undefined>();
  for (const k of kevs) {
    saved.set(k, process.env[k]);
    delete process.env[k];
  }
  process.env["GRAPHRAG_MEMORY_EMBED_DIMENSIONS"] = "1536";
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe("retrieve config boundary validation (T5)", () => {
  it("defaults to the three-arm production hybrid plus the seed knobs when unset", () => {
    withRetrievalEnv({}, () => {
      const env = loadEnv();
      expect(env.retrieval).toEqual({
        // Production hybrid (#69/#70): vector 0.7 / BM25 0.15 / graph
        // 0.15, both partner arms on. The per-knob assertions live in
        // tests/config.test.ts; this case pins the exact field SET so a
        // new knob cannot appear without the graph-arm suite noticing.
        w_vec: 0.7,
        w_bm25: 0.15,
        w_graph: 0.15,
        bm25Enabled: true,
        graphEnabled: true,
        nodeEmbeddingEnabled: false,
        rerankEnabled: false,
        preset: "balanced",
        rrfK: 60,
        // Seed / traversal knobs keep their P0 values.
        entityLinkTopK: 8,
        candidateCap: 50,
        neighborWidth: 1,
        graphArmFloor: 3,
        waitForDrainEnabled: false,
        waitForDrainTimeoutMs: 5000,
      });
    });
  });

  it("rejects a negative w_vec", () => {
    withRetrievalEnv({ GRAPHRAG_MEMORY_RETRIEVAL_W_VEC: "-1" }, () => {
      expect(() => loadEnv()).toThrow(ConfigError);
      expect(() => loadEnv()).toThrow(/GRAPHRAG_MEMORY_RETRIEVAL_W_VEC/);
    });
  });

  it("rejects a zero w_graph", () => {
    withRetrievalEnv({ GRAPHRAG_MEMORY_RETRIEVAL_W_GRAPH: "0" }, () => {
      expect(() => loadEnv()).toThrow(ConfigError);
      expect(() => loadEnv()).toThrow(/GRAPHRAG_MEMORY_RETRIEVAL_W_GRAPH/);
    });
  });

  it("rejects a zero entityLinkTopK", () => {
    withRetrievalEnv(
      { GRAPHRAG_MEMORY_RETRIEVAL_ENTITY_LINK_TOP_K: "0" },
      () => {
        expect(() => loadEnv()).toThrow(ConfigError);
        expect(() => loadEnv()).toThrow(
          /GRAPHRAG_MEMORY_RETRIEVAL_ENTITY_LINK_TOP_K/
        );
      }
    );
  });

  it("rejects candidateCap < entityLinkTopK", () => {
    withRetrievalEnv(
      {
        GRAPHRAG_MEMORY_RETRIEVAL_ENTITY_LINK_TOP_K: "10",
        GRAPHRAG_MEMORY_RETRIEVAL_CANDIDATE_CAP: "5",
      },
      () => {
        expect(() => loadEnv()).toThrow(ConfigError);
        expect(() => loadEnv()).toThrow(
          /GRAPHRAG_MEMORY_RETRIEVAL_CANDIDATE_CAP/
        );
      }
    );
  });

  it("rejects a zero graphArmFloor", () => {
    withRetrievalEnv({ GRAPHRAG_MEMORY_RETRIEVAL_GRAPH_ARM_FLOOR: "0" }, () => {
      expect(() => loadEnv()).toThrow(ConfigError);
      expect(() => loadEnv()).toThrow(
        /GRAPHRAG_MEMORY_RETRIEVAL_GRAPH_ARM_FLOOR/
      );
    });
  });
});
