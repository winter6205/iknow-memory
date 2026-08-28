/**
 * G5 retrieval latency levers (spec p0-wiring-closure ASSUMPTION 12, T7).
 *
 * Lever (a) SC12a — one query embed per retrieve: `assembleRetrievalResult`
 * embeds once and hands the same vector to both arms.
 * Lever (b) SC12b — the arms run concurrently: the graph arm starts while the
 * vector search is still pending (deferred-promise seam on `search`).
 *
 * Fake seams only — no live Postgres. The counting embedder is local to this
 * file so the production `FakeEmbedder` keeps its deterministic contract.
 */
import { describe, it, expect } from "vitest";
import { assembleRetrievalResult } from "../../src/core/retrieval/index.js";
import { GraphragError } from "../../src/core/errors.js";
import type { EmbeddingClient } from "../../src/core/embedder.js";
import type {
  GraphArmStorage,
  RetrieveConfig,
} from "../../src/core/retrieval/types.js";
import type { GraphRagStorageBackend } from "../../src/core/storage/backend.js";
import type { RetrievedChunk, SearchOptions } from "../../src/core/types.js";

/** Default RetrieveConfig these tests run under (floor 3). */
const CFG: RetrieveConfig = {
  w_vec: 1,
  w_bm25: 1,
  w_graph: 1,
  bm25Enabled: false,
  graphEnabled: false,
  rerankEnabled: false,
  entityLinkTopK: 8,
  candidateCap: 50,
  graphArmFloor: 3,
};

const ARGS = {
  query: "how does fusion work",
  validAt: "2024-06-01T00:00:00.000Z",
  limit: 10,
};

type OneHopRow = {
  id: string;
  content: string;
  source_ref: string;
  valid_from: string;
  valid_until: string | null;
};

/** A promise plus its resolver — the test-side release valve. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Resolve after `ms` — the losing side of the start-order race. */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Counting embedder: records every batch it is asked to embed. */
class CountingEmbedder implements EmbeddingClient {
  readonly batches: string[][] = [];

  constructor(private readonly vector: number[] = [0.11, 0.22, 0.33]) {}

  async embed(texts: string[]): Promise<number[][]> {
    this.batches.push([...texts]);
    return texts.map(() => [...this.vector]);
  }
}

/** Embedder that resolves with an empty batch — no vector, no rejection. */
class EmptyBatchEmbedder implements EmbeddingClient {
  async embed(_texts: string[]): Promise<number[][]> {
    return [];
  }
}

/**
 * Fake graph-rag backend that records which vector each arm received and can
 * hold `search` open until the test releases `searchGate`.
 */
class ProbeGraphBackend implements GraphRagStorageBackend {
  searchResults: RetrievedChunk[] = [];
  seeds: Array<{ id: string; canonical_name: string }> = [];
  oneHopRows: OneHopRow[] = [];
  searchEmbeddings: number[][] = [];
  seedEmbeddings: number[][] = [];
  searchError: Error | null = null;
  /** When set, `search` stays pending until this resolves. */
  searchGate: Promise<void> | null = null;

  private readonly graphArmStart = deferred();

  /** Resolves the first time the graph arm reaches storage. */
  get graphArmStarted(): Promise<void> {
    return this.graphArmStart.promise;
  }

  readonly graphArmSeed: GraphArmStorage = {
    seedEntitiesByEmbedding: async (
      embedding: number[],
      _topK: number
    ): Promise<Array<{ id: string; canonical_name: string }>> => {
      this.seedEmbeddings.push(embedding);
      this.graphArmStart.resolve();
      return this.seeds;
    },
    chunksByOneHopFromEntities: async (): Promise<OneHopRow[]> =>
      this.oneHopRows,
  };

  async upsert(): Promise<string[]> {
    return [];
  }

  async search(
    queryEmbedding: number[],
    opts: SearchOptions
  ): Promise<RetrievedChunk[]> {
    this.searchEmbeddings.push(queryEmbedding);
    if (this.searchGate !== null) await this.searchGate;
    if (this.searchError) throw this.searchError;
    return this.searchResults.slice(0, opts.limit);
  }

  async close(): Promise<void> {}
}

function oneHopRow(id: string): OneHopRow {
  return {
    id,
    content: `content-${id}`,
    source_ref: `src/${id}`,
    valid_from: "2024-01-01T00:00:00.000Z",
    valid_until: null,
  };
}

function vecChunk(id: string): RetrievedChunk {
  return {
    id,
    content: `content-${id}`,
    source_ref: `src/${id}`,
    valid_window: ["2024-01-01T00:00:00Z", null],
    score: 1,
  };
}

/** Backend whose graph arm clears the floor (3 one-hop chunks). */
function activeGraphBackend(): ProbeGraphBackend {
  const backend = new ProbeGraphBackend();
  backend.searchResults = [vecChunk("v1")];
  backend.seeds = [
    { id: "e1", canonical_name: "E1" },
    { id: "e2", canonical_name: "E2" },
    { id: "e3", canonical_name: "E3" },
  ];
  backend.oneHopRows = [oneHopRow("g1"), oneHopRow("g2"), oneHopRow("g3")];
  return backend;
}

describe("assembleRetrievalResult — single query embed (SC12a)", () => {
  it("SC12a: embeds the query exactly once per retrieve when the graph arm is active", async () => {
    const backend = activeGraphBackend();
    const embedder = new CountingEmbedder();
    const out = await assembleRetrievalResult(ARGS, {
      embedder,
      storage: backend,
      graphConfig: CFG,
    });
    expect(embedder.batches).toEqual([["how does fusion work"]]);
    expect(out).not.toHaveProperty("degraded");
  });

  it("SC12a: both arms receive the same query embedding", async () => {
    const backend = activeGraphBackend();
    const embedder = new CountingEmbedder([0.5, 0.25, 0.125]);
    await assembleRetrievalResult(ARGS, {
      embedder,
      storage: backend,
      graphConfig: CFG,
    });
    expect(backend.searchEmbeddings).toEqual([[0.5, 0.25, 0.125]]);
    expect(backend.seedEmbeddings).toEqual(backend.searchEmbeddings);
  });
});

describe("assembleRetrievalResult — empty query embedding", () => {
  it("an embedder yielding no vector fails typed before either arm receives it", async () => {
    const backend = activeGraphBackend();
    const err = await assembleRetrievalResult(ARGS, {
      embedder: new EmptyBatchEmbedder(),
      storage: backend,
      graphConfig: CFG,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GraphragError);
    expect((err as GraphragError).code).toBe("EMBEDDING_FAILED");
    // The single-embed lever must not turn a missing vector into an
    // `undefined` both arms then search on.
    expect(backend.searchEmbeddings).toEqual([]);
    expect(backend.seedEmbeddings).toEqual([]);
  });
});

describe("assembleRetrievalResult — concurrent arms (SC12b)", () => {
  it("SC12b: the graph arm starts while the vector search is still pending", async () => {
    const backend = activeGraphBackend();
    const gate = deferred();
    backend.searchGate = gate.promise;
    const pending = assembleRetrievalResult(ARGS, {
      embedder: new CountingEmbedder(),
      storage: backend,
      graphConfig: CFG,
    });
    // Sequential arms can never win this race: the graph arm would only be
    // reached after `search` resolves, and `search` is held by the gate.
    const startedConcurrently = await Promise.race([
      backend.graphArmStarted.then(() => true),
      sleep(50).then(() => false),
    ]);
    gate.resolve();
    const out = await pending;
    expect(startedConcurrently).toBe(true);
    expect(out.chunks.map((c) => c.id)).toContain("v1");
  });

  it("SC12b: a vector-arm rejection still propagates while the graph arm runs", async () => {
    const backend = activeGraphBackend();
    backend.searchError = new Error("vector down");
    await expect(
      assembleRetrievalResult(ARGS, {
        embedder: new CountingEmbedder(),
        storage: backend,
        graphConfig: CFG,
      })
    ).rejects.toThrow("vector down");
  });
});
