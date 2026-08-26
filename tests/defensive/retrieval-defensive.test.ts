/**
 * Defensive-contract tests for the spec-3 retrieval pipeline (T7).
 *
 * Maps to Success Criterion #16: every public function (`runGraphArm`,
 * `rrfFuse`, `assembleRetrievalResult`) is exercised against each of the
 * five boundary classes:
 *   empty      → K = 0, no arms active, empty-vec, empty-graph, and an empty
 *                query embedding (typed GraphragError, never fail-open)
 *   negative   → K = -1, limit = -1
 *   overflow   → K = 1e9, limit = 1e9
 *   concurrent → two parallel calls produce deterministic non-interfering
 *                results (pure-function concurrency). The real-Postgres
 *                two-CLI concurrent batch-id assertion (Success Criterion
 *                #12) lives in tests/cli/extract-e2e-graph.test.ts case
 *                #5, which is the documented merge target — the unit-level
 *                concurrency here proves the pipeline functions are pure
 *                and share no mutable state.
 *   exception  → graph-arm storage throws mid-call → assembleRetrievalResult
 *                degrades (degraded:true + vector-only), never propagates.
 *
 * All tests use fake seams only — no live Postgres. The FakeStorage +
 * FakeEmbedder patterns mirror tests/retrieval/graph-arm.unit.test.ts.
 */
import { describe, it, expect } from "vitest";
import { runGraphArm } from "../../src/core/retrieval/graph-arm.js";
import { rrfFuse } from "../../src/core/retrieval/rrf.js";
import { assembleRetrievalResult } from "../../src/core/retrieval/index.js";
import { FakeEmbedder } from "../../src/core/embedder.js";
import { GraphragError } from "../../src/core/errors.js";
import type { EmbeddingClient } from "../../src/core/embedder.js";
import type {
  ArmHit,
  ArmResult,
  GraphArmStorage,
  RetrieveConfig,
} from "../../src/core/retrieval/types.js";
import type { RetrievedChunk, SearchOptions } from "../../src/core/types.js";
import type { GraphRagStorageBackend } from "../../src/core/storage/backend.js";

const TEST_DIM = 1536;

/** Query embedding the orchestrator hands to the graph arm (G5 lever (a)). */
const QUERY_VEC = [0.1, 0.2, 0.3];

/** Default RetrieveConfig the defensive tests run under. */
const CFG: RetrieveConfig = {
  w_vec: 1,
  w_bm25: 1,
  w_graph: 1,
  bm25Enabled: false,
  entityLinkTopK: 8,
  candidateCap: 50,
  graphArmFloor: 3,
};

/** Single vector hit builder — deterministic rank/score. */
function hit(patch: Partial<ArmHit> & { id: string }): ArmHit {
  return {
    arm: patch.arm ?? "vector",
    rank: patch.rank ?? 1,
    score: patch.score ?? 0,
    content: patch.content ?? `content of ${patch.id}`,
    source_ref: patch.source_ref ?? `src/${patch.id}`,
    valid_window: patch.valid_window ?? ["2024-01-01T00:00:00Z", null],
    id: patch.id,
  };
}

/** Single vector ArmResult builder. */
function armResult(arm: "vector" | "graph", hits: ArmHit[]): ArmResult {
  return { arm, hits, belowFloor: false };
}

/**
 * Fake backend implementing the graph-rag seam. Vector search returns preset
 * rows; graph-arm calls honor preset seeds / rows and can be told to throw.
 * Captures every topK/limit to prove the boundary value flows through.
 */
class FakeGraphBackend implements GraphRagStorageBackend {
  seedEntities: Array<{ id: string; canonical_name: string }> = [];
  rows: Array<{
    id: string;
    content: string;
    source_ref: string;
    valid_from: string;
    valid_until: string | null;
  }> = [];
  searchResults: RetrievedChunk[] = [];
  seedError: Error | null = null;
  rowError: Error | null = null;
  seedTopKs: number[] = [];
  oneHopLimits: number[] = [];
  /** Vectors handed to `search` — empty when the vector arm never started. */
  searchEmbeddings: unknown[] = [];

  readonly graphArmSeed: GraphArmStorage = {
    seedEntitiesByEmbedding: async (
      _embedding: number[],
      topK: number
    ): Promise<Array<{ id: string; canonical_name: string }>> => {
      this.seedTopKs.push(topK);
      if (this.seedError) throw this.seedError;
      return this.seedEntities;
    },
    chunksByOneHopFromEntities: async (
      _seedIds: string[],
      _validAt: string,
      limit: number
    ): Promise<
      Array<{
        id: string;
        content: string;
        source_ref: string;
        valid_from: string;
        valid_until: string | null;
      }>
    > => {
      this.oneHopLimits.push(limit);
      if (this.rowError) throw this.rowError;
      return this.rows;
    },
  };

  async upsert(): Promise<string[]> {
    return [];
  }
  async search(
    queryEmbedding: number[],
    opts: SearchOptions
  ): Promise<RetrievedChunk[]> {
    this.searchEmbeddings.push(queryEmbedding);
    return this.searchResults.slice(0, opts.limit);
  }
  async close(): Promise<void> {}
}

/**
 * Embedder that resolves with a caller-chosen batch — used to drive the
 * empty-embedding boundary (`[]`, `[[]]`) without throwing, so the test
 * proves the orchestrator's own guard fires rather than a rejection it
 * merely forwards.
 */
class EmptyBatchEmbedder implements EmbeddingClient {
  calls = 0;

  constructor(private readonly batch: number[][]) {}

  async embed(_texts: string[]): Promise<number[][]> {
    this.calls += 1;
    return this.batch;
  }
}

/** Helper: wrap a chunk result for the vector arm. */
function vecChunk(id: string): RetrievedChunk {
  return {
    id,
    content: `content-${id}`,
    source_ref: `src/${id}`,
    valid_window: ["2024-01-01T00:00:00Z", null],
    score: 1,
  };
}

/** Helper: wrap a one-hop row for the graph arm. */
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
    valid_from: "2024-01-01T00:00:00.000Z",
    valid_until: null,
  };
}

// ======================================================================
// runGraphArm — 5 boundary classes
// ======================================================================

describe("runGraphArm — empty boundary (K=0)", () => {
  it("entityLinkTopK=0 → storage receives topK=0, returns belowFloor, zero hits, no one-hop call", async () => {
    const storage = new FakeGraphBackend();
    const out = await runGraphArm(
      QUERY_VEC,
      {
        storage: storage.graphArmSeed,
        config: { ...CFG, entityLinkTopK: 0 },
      },
      new Date("2024-01-01T00:00:00Z")
    );
    expect(out.arm).toBe("graph");
    expect(out.belowFloor).toBe(true);
    expect(out.hits).toEqual([]);
    expect(storage.seedTopKs).toEqual([0]);
    expect(storage.oneHopLimits).toEqual([]);
  });
});

describe("runGraphArm — negative boundary (K=-1)", () => {
  it("entityLinkTopK=-1 (runtime out-of-bounds via type assertion) → fail-open, no throw, belowFloor", async () => {
    // Startup validation rejects topK < 1 (config.ts → ConfigError); this
    // test exercises the runtime guard: a negative K that bypassed startup
    // validation (test seam) must still degrade, never throw.
    const storage = new FakeGraphBackend();
    const out = await runGraphArm(
      QUERY_VEC,
      {
        storage: storage.graphArmSeed,
        // Cast bypasses the TS type; the runtime guard must still hold.
        config: { ...CFG, entityLinkTopK: -1 } as RetrieveConfig,
      },
      new Date("2024-01-01T00:00:00Z")
    );
    expect(out.belowFloor).toBe(true);
    expect(out.hits).toEqual([]);
    expect(storage.seedTopKs).toEqual([-1]);
    expect(storage.oneHopLimits).toEqual([]);
  });
});

describe("runGraphArm — overflow boundary (K=1e9)", () => {
  it("entityLinkTopK=1e9 → no throw, returns empty, storage receives the huge K unchanged", async () => {
    const storage = new FakeGraphBackend();
    // Seed + row enough to clear the floor so the huge K is the only
    // variable under test (no throw on the huge topK; K passes through
    // unchanged; floor satisfied by 3 rows).
    storage.seedEntities = [
      { id: "e1", canonical_name: "E1" },
      { id: "e2", canonical_name: "E2" },
      { id: "e3", canonical_name: "E3" },
    ];
    storage.rows = [graphRow("g1"), graphRow("g2"), graphRow("g3")];
    const huge = 1e9;
    const out = await runGraphArm(
      QUERY_VEC,
      {
        storage: storage.graphArmSeed,
        config: { ...CFG, entityLinkTopK: huge } as RetrieveConfig,
      },
      new Date("2024-01-01T00:00:00Z")
    );
    expect(out.arm).toBe("graph");
    expect(out.belowFloor).toBe(false);
    expect(storage.seedTopKs).toEqual([huge]);
    expect(out.hits).toHaveLength(3);
  });
});

describe("runGraphArm — concurrent boundary", () => {
  it("parallel runGraphArm calls produce deterministic, non-interfering results", async () => {
    const storage = new FakeGraphBackend();
    storage.seedEntities = [
      { id: "e1", canonical_name: "E1" },
      { id: "e2", canonical_name: "E2" },
      { id: "e3", canonical_name: "E3" },
    ];
    storage.rows = [graphRow("g1"), graphRow("g2"), graphRow("g3")];
    const cfg: GraphArmStorage = storage.graphArmSeed;
    const [a, b, c] = await Promise.all([
      runGraphArm(
        [0.1, 0.1, 0.1],
        { storage: cfg, config: CFG },
        new Date("2024-01-01T00:00:00Z")
      ),
      runGraphArm(
        [0.2, 0.2, 0.2],
        { storage: cfg, config: CFG },
        new Date("2024-01-01T00:00:00Z")
      ),
      runGraphArm(
        [0.3, 0.3, 0.3],
        { storage: cfg, config: CFG },
        new Date("2024-01-01T00:00:00Z")
      ),
    ]);
    for (const r of [a, b, c]) {
      expect(r.hits).toHaveLength(3);
      expect(r.belowFloor).toBe(false);
    }
    expect(storage.seedTopKs).toEqual([8, 8, 8]);
    expect(storage.oneHopLimits).toEqual([50, 50, 50]);
  });
});

describe("runGraphArm — exception boundary (storage throws)", () => {
  it("seedEntitiesByEmbedding throws → degraded with failureReason, never propagates", async () => {
    const storage = new FakeGraphBackend();
    storage.seedError = new Error("seed boom");
    const out = await runGraphArm(
      QUERY_VEC,
      {
        storage: storage.graphArmSeed,
        config: CFG,
      },
      new Date("2024-01-01T00:00:00Z")
    );
    expect(out.belowFloor).toBe(true);
    expect(out.hits).toEqual([]);
    expect(out.failureReason).toContain("seed boom");
  });

  it("chunksByOneHopFromEntities throws → degraded with failureReason", async () => {
    const storage = new FakeGraphBackend();
    storage.seedEntities = [
      { id: "e1", canonical_name: "E1" },
      { id: "e2", canonical_name: "E2" },
      { id: "e3", canonical_name: "E3" },
    ];
    storage.rowError = new Error("row boom");
    const out = await runGraphArm(
      QUERY_VEC,
      {
        storage: storage.graphArmSeed,
        config: CFG,
      },
      new Date("2024-01-01T00:00:00Z")
    );
    expect(out.belowFloor).toBe(true);
    expect(out.failureReason).toContain("row boom");
  });
});

// ======================================================================
// rrfFuse — 5 boundary classes
// ======================================================================

describe("rrfFuse — empty boundary (limit<=0)", () => {
  it("limit=0 → returns []", () => {
    const out = rrfFuse(
      [armResult("vector", [hit({ id: "a" })]), armResult("graph", [])],
      CFG,
      0
    );
    expect(out).toEqual([]);
  });

  it("empty-vec + empty-graph + limit=10 → returns []", () => {
    expect(
      rrfFuse([armResult("vector", []), armResult("graph", [])], CFG, 10)
    ).toEqual([]);
  });
});

describe("rrfFuse — negative boundary (limit=-1)", () => {
  it("limit=-1 → returns [], never throws", () => {
    const out = rrfFuse(
      [
        armResult("vector", [hit({ id: "a" })]),
        armResult("graph", [hit({ id: "b", arm: "graph" })]),
      ],
      CFG,
      -1
    );
    expect(out).toEqual([]);
  });
});

describe("rrfFuse — overflow boundary (limit=1e9)", () => {
  it("limit=1e9 against a small input → returns all hits, no slice crash", () => {
    const out = rrfFuse(
      [
        armResult("vector", [
          hit({ id: "a", rank: 1 }),
          hit({ id: "b", rank: 2 }),
        ]),
        armResult("graph", [hit({ id: "c", rank: 1, arm: "graph" })]),
      ],
      CFG,
      1e9
    );
    // a (vec rank1) and c (graph rank1) tie at 1/61; vec-first ∥ id asc → a,c; b (1/62) last.
    expect(out.map((f) => f.id)).toEqual(["a", "c", "b"]);
  });
});

describe("rrfFuse — concurrent boundary", () => {
  it("parallel rrfFuse calls over disjoint inputs produce disjoint outputs (no shared accumulator)", async () => {
    const vecA = armResult("vector", [hit({ id: "a", rank: 1 })]);
    const vecB = armResult("vector", [hit({ id: "b", rank: 1 })]);
    const vecC = armResult("vector", [hit({ id: "c", rank: 1 })]);
    const [oa, ob, oc] = await Promise.all([
      Promise.resolve(rrfFuse([vecA, armResult("graph", [])], CFG, 10)),
      Promise.resolve(rrfFuse([vecB, armResult("graph", [])], CFG, 10)),
      Promise.resolve(rrfFuse([vecC, armResult("graph", [])], CFG, 10)),
    ]);
    expect(oa.map((f) => f.id)).toEqual(["a"]);
    expect(ob.map((f) => f.id)).toEqual(["b"]);
    expect(oc.map((f) => f.id)).toEqual(["c"]);
  });
});

describe("rrfFuse — exception boundary (pure function)", () => {
  it("skips hits with rank<1 (boundary invalid input ignored, no throw)", () => {
    const out = rrfFuse(
      [
        armResult("vector", [
          hit({ id: "bad", rank: 0 }),
          hit({ id: "neg", rank: -5 }),
          hit({ id: "ok", rank: 1 }),
        ]),
        armResult("graph", []),
      ],
      CFG,
      10
    );
    expect(out.map((f) => f.id)).toEqual(["ok"]);
  });
});

// ======================================================================
// assembleRetrievalResult — 5 boundary classes
// ======================================================================

async function runAssemble(opts: {
  backend: FakeGraphBackend;
  graphConfig?: RetrieveConfig;
  debug?: boolean;
  embedder?: EmbeddingClient;
}) {
  return assembleRetrievalResult(
    { query: "anything", validAt: "2024-06-01T00:00:00.000Z", limit: 10 },
    {
      embedder: opts.embedder ?? new FakeEmbedder(TEST_DIM),
      storage: opts.backend,
      graphConfig: opts.graphConfig,
      debug: opts.debug,
    }
  );
}

describe("assembleRetrievalResult — empty boundary (no graphConfig)", () => {
  it("no graphConfig → vector-only, exactly { chunks: [...] } (Success Criterion #4)", async () => {
    const backend = new FakeGraphBackend();
    backend.searchResults = [vecChunk("v1"), vecChunk("v2")];
    const out = await runAssemble({ backend });
    expect(out.chunks.map((c) => c.id)).toEqual(["v1", "v2"]);
    expect(out).not.toHaveProperty("degraded");
    expect(out).not.toHaveProperty("debug");
  });

  it("empty DB + graph arm configured → graph arm belowFloor, degraded:true", async () => {
    const backend = new FakeGraphBackend();
    backend.searchResults = [];
    const out = await runAssemble({ backend, graphConfig: CFG });
    expect(out.chunks).toEqual([]);
    expect(out.degraded).toBe(true);
    expect(out).not.toHaveProperty("debug");
  });
});

describe("assembleRetrievalResult — empty boundary (empty query embedding)", () => {
  it("embedder returns [] → typed GraphragError(EMBEDDING_FAILED), not a downstream TypeError", async () => {
    const backend = new FakeGraphBackend();
    backend.searchResults = [vecChunk("v1")];
    const err = await runAssemble({
      backend,
      graphConfig: CFG,
      embedder: new EmptyBatchEmbedder([]),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GraphragError);
    expect((err as GraphragError).code).toBe("EMBEDDING_FAILED");
    expect(err).not.toBeInstanceOf(TypeError);
  });

  it("embedder returns a zero-length vector → same typed EMBEDDING_FAILED", async () => {
    const backend = new FakeGraphBackend();
    const err = await runAssemble({
      backend,
      graphConfig: CFG,
      embedder: new EmptyBatchEmbedder([[]]),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GraphragError);
    expect((err as GraphragError).code).toBe("EMBEDDING_FAILED");
  });

  it("empty embedding throws before either arm starts — vector-only path too", async () => {
    const backend = new FakeGraphBackend();
    backend.searchResults = [vecChunk("v1")];
    // No graphConfig: the vector-only path must reject rather than hand
    // `undefined` to storage.search and search on a garbage vector.
    await expect(
      runAssemble({ backend, embedder: new EmptyBatchEmbedder([]) })
    ).rejects.toBeInstanceOf(GraphragError);
    expect(backend.searchEmbeddings).toEqual([]);
    expect(backend.seedTopKs).toEqual([]);
  });
});

describe("assembleRetrievalResult — negative boundary (graphConfig with K=-1)", () => {
  it("graphConfig.entityLinkTopK=-1 → degrades, never throws, vector-only results flow through", async () => {
    const backend = new FakeGraphBackend();
    backend.searchResults = [vecChunk("v1")];
    const out = await runAssemble({
      backend,
      graphConfig: { ...CFG, entityLinkTopK: -1 } as RetrieveConfig,
    });
    expect(out.chunks).toHaveLength(1);
    expect(out.chunks[0]).toMatchObject({ id: "v1" });
    expect(out.degraded).toBe(true);
  });
});

describe("assembleRetrievalResult — overflow boundary (graphConfig with K=1e9)", () => {
  it("graphConfig.entityLinkTopK=1e9 → no throw, empty graph arm (fake returns []), vector-only path", async () => {
    const backend = new FakeGraphBackend();
    backend.searchResults = [vecChunk("v1")];
    const out = await runAssemble({
      backend,
      graphConfig: { ...CFG, entityLinkTopK: 1e9 } as RetrieveConfig,
    });
    expect(out.chunks).toHaveLength(1);
    expect(backend.seedTopKs).toEqual([1e9]);
  });
});

describe("assembleRetrievalResult — concurrent boundary", () => {
  it("two parallel assembleRetrievalResult calls produce independent envelopes (no shared state)", async () => {
    const backend = new FakeGraphBackend();
    backend.searchResults = [vecChunk("v1"), vecChunk("v2")];
    // Seed 3 entities + 3 one-hop rows so the graph arm clears the floor
    // (counts chunks) in both parallel calls — otherwise degraded:true
    // would mask the concurrency assertion.
    backend.seedEntities = [
      { id: "e1", canonical_name: "E1" },
      { id: "e2", canonical_name: "E2" },
      { id: "e3", canonical_name: "E3" },
    ];
    backend.rows = [graphRow("g1"), graphRow("g2"), graphRow("g3")];
    const [a, b] = await Promise.all([
      runAssemble({ backend, graphConfig: CFG }),
      runAssemble({ backend, graphConfig: CFG }),
    ]);
    // Graph arm clears the floor (3 rows >= 3) and participates in RRF, so
    // the envelope fuses vector + graph hits. RRF order: v1 & g1 tie at
    // rank-1 score (1/61) with vector-first tie-break, then v2 & g2 tie at
    // 1/62, then g3 at 1/63. Both parallel calls must agree (deterministic,
    // no shared accumulator across invocations).
    expect(a.chunks.map((c) => c.id)).toEqual(["v1", "g1", "v2", "g2", "g3"]);
    expect(b.chunks.map((c) => c.id)).toEqual(["v1", "g1", "v2", "g2", "g3"]);
    expect(a).not.toHaveProperty("degraded");
    expect(b).not.toHaveProperty("degraded");
  });
});

describe("assembleRetrievalResult — exception boundary (PG storage throws mid-call)", () => {
  it("chunksByOneHopFromEntities throws GraphragError(STORAGE_ERROR) → degraded:true + vector-only results", async () => {
    const backend = new FakeGraphBackend();
    backend.searchResults = [vecChunk("v1"), vecChunk("v2")];
    backend.seedEntities = [
      { id: "e1", canonical_name: "E1" },
      { id: "e2", canonical_name: "E2" },
      { id: "e3", canonical_name: "E3" },
    ];
    backend.rowError = new GraphragError("storage down", "STORAGE_ERROR");
    const out = await runAssemble({ backend, graphConfig: CFG });
    expect(out.chunks.map((c) => c.id)).toEqual(["v1", "v2"]);
    expect(out.degraded).toBe(true);
    expect(out).not.toHaveProperty("debug");
  });

  it("seedEntitiesByEmbedding throws → degraded:true + vector-only (fail-open survives earlier failure too)", async () => {
    const backend = new FakeGraphBackend();
    backend.searchResults = [vecChunk("v1")];
    backend.seedError = new Error("seed connection lost");
    const out = await runAssemble({ backend, graphConfig: CFG });
    expect(out.chunks).toHaveLength(1);
    expect(out.degraded).toBe(true);
  });
});
