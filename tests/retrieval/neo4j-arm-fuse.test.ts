/**
 * Orchestrator-level three-arm retrieval: vector ∥ BM25 ∥ Neo4j PPR
 * (specs/neo4j-graph-arm.md T4 — SC5, SC7–SC10).
 *
 * The arm under test is wired the way production wires it: a `graphRanker`
 * port (the Neo4j GDS adapter in the real server) plus a backend exposing
 * the `neo4jArmSeed` seam. Everything here is a fake, so the suite proves
 * the ORCHESTRATION contract — who runs, who degrades, who fuses — without
 * a graph or a database.
 *
 * The three envelope rules the spec separates and this file keeps separate:
 *   SC7  no sidecar configured → the arm is not ATTEMPTED, and the envelope
 *        carries no `degraded` key. Cannot attempt ≠ failed attempt.
 *   SC8  configured and failing → `degraded: true`, other arms still answer.
 *   SC9  switched off by config → two arms, and again no `degraded`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

import { assembleRetrievalResult } from "../../src/core/retrieval/index.js";
import type {
  EntityChunkRow,
  GraphRanker,
  Neo4jArmStorage,
  RankedEntity,
  RetrieveConfig,
} from "../../src/core/retrieval/types.js";
import type { GraphRagStorageBackend } from "../../src/core/storage/backend.js";
import type { EmbeddingClient } from "../../src/core/embedder.js";
import type { RetrievedChunk, SearchOptions } from "../../src/core/types.js";

const NOW = "2026-08-01T00:00:00.000Z";
const DIM = 4;

/** Production defaults (#69/#70). */
const CFG: RetrieveConfig = {
  w_vec: 0.7,
  w_bm25: 0.15,
  w_graph: 0.15,
  bm25Enabled: true,
  graphEnabled: true,
  entityLinkTopK: 8,
  candidateCap: 50,
  graphArmFloor: 3,
};

class ConstantEmbedder implements EmbeddingClient {
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => new Array<number>(DIM).fill(0.5));
  }
}

const embedder = new ConstantEmbedder();

function chunk(id: string, score = 1): RetrievedChunk {
  return {
    id,
    content: `content-${id}`,
    source_ref: `src/${id}`,
    valid_window: ["2026-01-01T00:00:00.000Z", null],
    score,
  };
}

function row(entityId: string, chunkId: string): EntityChunkRow {
  return {
    entity_id: entityId,
    id: chunkId,
    content: `content-${chunkId}`,
    source_ref: `src/${chunkId}`,
    valid_from: "2026-01-01T00:00:00.000Z",
    valid_until: null,
  };
}

/**
 * A backend carrying all three seams: vector search, lexical search and
 * the Neo4j arm's Postgres side. Every result list is scriptable and every
 * call is recorded, which is how the "not attempted" cases are asserted.
 */
class ThreeArmBackend implements GraphRagStorageBackend {
  vectorHits: RetrievedChunk[] = [];
  lexicalHits: RetrievedChunk[] = [];
  seeds: Array<{ id: string; canonical_name: string }> = [
    { id: "e1", canonical_name: "E1" },
  ];
  rows: EntityChunkRow[] = [];
  seedCalls = 0;

  readonly neo4jArmSeed: Neo4jArmStorage = {
    seedEntitiesByEmbedding: async () => {
      this.seedCalls += 1;
      return this.seeds;
    },
    chunksByEntityIds: async () => this.rows,
  };

  async upsert(): Promise<string[]> {
    return [];
  }
  async search(
    _embedding: number[],
    opts: SearchOptions
  ): Promise<RetrievedChunk[]> {
    return this.vectorHits.slice(0, opts.limit);
  }
  async searchLexical(
    _query: string,
    opts: SearchOptions
  ): Promise<RetrievedChunk[]> {
    return this.lexicalHits.slice(0, opts.limit);
  }
  async close(): Promise<void> {}
}

/** A ranker that returns a fixed ranking (or throws) and counts its calls. */
class FakeRanker implements GraphRanker {
  calls = 0;
  error: unknown;
  constructor(private readonly ranked: RankedEntity[] = []) {}
  async rankEntities(): Promise<RankedEntity[]> {
    this.calls += 1;
    if (this.error !== undefined) throw this.error;
    return this.ranked;
  }
}

/** Backend + ranker where the graph arm reaches two chunks. */
function seededGraph(): { storage: ThreeArmBackend; ranker: FakeRanker } {
  const storage = new ThreeArmBackend();
  storage.vectorHits = [chunk("v1"), chunk("v2")];
  storage.rows = [row("e1", "g1"), row("e2", "g2")];
  const ranker = new FakeRanker([
    { id: "e1", score: 0.9 },
    { id: "e2", score: 0.3 },
  ]);
  return { storage, ranker };
}

describe("assembleRetrievalResult — Neo4j graph arm contributes (SC5)", () => {
  it("adds graph-only chunks the other arms never saw", async () => {
    const { storage, ranker } = seededGraph();

    const out = await assembleRetrievalResult(
      { query: "q", validAt: NOW, limit: 10 },
      {
        embedder,
        storage,
        retrieveConfig: CFG,
        graphRanker: ranker,
        debug: true,
      }
    );

    expect(out.chunks.map((c) => c.id).sort()).toEqual([
      "g1",
      "g2",
      "v1",
      "v2",
    ]);
    expect(out.debug?.graphHits).toBe(2);
    expect(Object.hasOwn(out, "degraded")).toBe(false);
  });

  it("changes the ranking versus the same call with the graph arm off (SC5)", async () => {
    const { storage, ranker } = seededGraph();
    // The graph reaches the chunk the vector arm ranks LAST. Fusing the
    // two arms must lift it above the chunk only the vector arm knows.
    storage.vectorHits = [chunk("top"), chunk("graph-favoured")];
    storage.rows = [row("e1", "graph-favoured")];

    const enabled = await assembleRetrievalResult(
      { query: "q", validAt: NOW, limit: 10 },
      { embedder, storage, retrieveConfig: CFG, graphRanker: ranker }
    );
    const disabled = await assembleRetrievalResult(
      { query: "q", validAt: NOW, limit: 10 },
      {
        embedder,
        storage,
        retrieveConfig: { ...CFG, graphEnabled: false },
        graphRanker: ranker,
      }
    );

    expect(disabled.chunks.map((c) => c.id)).toEqual(["top", "graph-favoured"]);
    expect(enabled.chunks.map((c) => c.id)).toEqual(["graph-favoured", "top"]);
  });

  it("starts all three arms together rather than one after another", async () => {
    const { storage } = seededGraph();
    const order: string[] = [];
    let releaseVector: () => void = () => {};
    const vectorGate = new Promise<void>((resolve) => {
      releaseVector = resolve;
    });
    const vectorHits = storage.vectorHits;
    storage.search = async () => {
      order.push("vector:start");
      await vectorGate;
      order.push("vector:end");
      return vectorHits;
    };
    storage.searchLexical = async () => {
      order.push("bm25:start");
      return [];
    };
    const ranker: GraphRanker = {
      rankEntities: async () => {
        // Reaching this while the vector arm is parked proves the arms
        // were launched together; a serial pipeline would deadlock.
        order.push("graph:start");
        releaseVector();
        return [];
      },
    };

    await assembleRetrievalResult(
      { query: "q", validAt: NOW, limit: 10 },
      { embedder, storage, retrieveConfig: CFG, graphRanker: ranker }
    );

    expect(order.slice(0, 3).sort()).toEqual([
      "bm25:start",
      "graph:start",
      "vector:start",
    ]);
    expect(order).toContain("vector:end");
  });
});

describe("assembleRetrievalResult — three-arm RRF soft merge (SC10)", () => {
  it("sums the three weights on a chunk every arm found, at k=60", async () => {
    const { storage, ranker } = seededGraph();
    storage.vectorHits = [chunk("shared"), chunk("v-only")];
    storage.lexicalHits = [chunk("shared")];
    storage.rows = [row("e1", "shared")];

    const out = await assembleRetrievalResult(
      { query: "q", validAt: NOW, limit: 10 },
      { embedder, storage, retrieveConfig: CFG, graphRanker: ranker }
    );

    const shared = out.chunks.find((c) => c.id === "shared")!;
    // (0.7 + 0.15 + 0.15) / (60 + 1) — the whole weight budget on one hit.
    expect(shared.score).toBeCloseTo(1 / 61, 12);
    const vOnly = out.chunks.find((c) => c.id === "v-only")!;
    expect(vOnly.score).toBeCloseTo(0.7 / 62, 12);
    expect(out.chunks[0]?.id).toBe("shared");
  });

  it("keeps the graph arm a weighted arm, not a re-ranker", async () => {
    const { storage, ranker } = seededGraph();
    storage.vectorHits = [chunk("v1")];
    storage.lexicalHits = [];
    storage.rows = [row("e1", "g1"), row("e2", "g2")];

    const out = await assembleRetrievalResult(
      { query: "q", validAt: NOW, limit: 10 },
      { embedder, storage, retrieveConfig: CFG, graphRanker: ranker }
    );

    // Graph-only hits are worth w_graph/(k+rank); the vector-only hit at
    // rank 1 still leads because 0.7/61 > 0.15/61.
    expect(out.chunks.map((c) => c.id)).toEqual(["v1", "g1", "g2"]);
    expect(out.chunks[1]?.score).toBeCloseTo(0.15 / 61, 12);
    expect(out.chunks[2]?.score).toBeCloseTo(0.15 / 62, 12);
  });
});

describe("assembleRetrievalResult — no sidecar configured (SC7)", () => {
  it("does not attempt the arm and emits no degraded key", async () => {
    const { storage } = seededGraph();

    const out = await assembleRetrievalResult(
      { query: "q", validAt: NOW, limit: 10 },
      // No graphRanker: exactly what the server wires when
      // GRAPHRAG_MEMORY_NEO4J_URI is unset.
      { embedder, storage, retrieveConfig: CFG, debug: true }
    );

    expect(Object.hasOwn(out, "degraded")).toBe(false);
    // Not attempted: the seed query never ran, and the debug payload has
    // no graph key at all — "the arm found nothing" would be `graphHits: 0`.
    expect(storage.seedCalls).toBe(0);
    expect(Object.hasOwn(out.debug ?? {}, "graphHits")).toBe(false);
    expect(out.chunks.map((c) => c.id)).toEqual(["v1", "v2"]);
  });

  it("does not attempt the arm when the backend has no neo4jArmSeed seam", async () => {
    const { ranker } = seededGraph();
    const chunkOnly = {
      upsert: async () => [],
      search: async () => [chunk("v1")],
      close: async () => {},
    };

    const out = await assembleRetrievalResult(
      { query: "q", validAt: NOW, limit: 10 },
      {
        embedder,
        storage: chunkOnly,
        retrieveConfig: CFG,
        graphRanker: ranker,
        debug: true,
      }
    );

    expect(Object.hasOwn(out, "degraded")).toBe(false);
    expect(ranker.calls).toBe(0);
  });
});

describe("assembleRetrievalResult — configured but failing (SC8)", () => {
  it("returns the other arms' chunks with degraded: true", async () => {
    const { storage, ranker } = seededGraph();
    ranker.error = new Error("Neo4j at bolt://localhost:7687 is unreachable");

    const out = await assembleRetrievalResult(
      { query: "q", validAt: NOW, limit: 10 },
      { embedder, storage, retrieveConfig: CFG, graphRanker: ranker }
    );

    expect(out.degraded).toBe(true);
    expect(out.chunks.map((c) => c.id)).toEqual(["v1", "v2"]);
  });

  it("does not reject, whatever the ranker throws", async () => {
    for (const thrown of [new Error("boom"), "a bare string", { odd: true }]) {
      const { storage, ranker } = seededGraph();
      ranker.error = thrown;
      const out = await assembleRetrievalResult(
        { query: "q", validAt: NOW, limit: 10 },
        { embedder, storage, retrieveConfig: CFG, graphRanker: ranker }
      );
      expect(out.degraded).toBe(true);
      expect(out.chunks).toHaveLength(2);
    }
  });

  it("names the failure under the debug gate, on both the new and legacy keys", async () => {
    const { storage, ranker } = seededGraph();
    ranker.error = new Error("gds.graph.project is not available");

    const out = await assembleRetrievalResult(
      { query: "q", validAt: NOW, limit: 10 },
      {
        embedder,
        storage,
        retrieveConfig: CFG,
        graphRanker: ranker,
        debug: true,
      }
    );

    expect(out.debug?.graphHits).toBe(0);
    expect(out.debug?.graphFailureReason).toContain("gds.graph.project");
    // Legacy key the p0 runbooks and graph-arm e2e suites still read.
    expect(out.debug?.failureReason).toContain("gds.graph.project");
  });
});

describe("assembleRetrievalResult — graph arm disabled (SC9)", () => {
  it("runs vector + BM25 only, with no degraded key", async () => {
    const { storage, ranker } = seededGraph();
    storage.lexicalHits = [chunk("v2")];

    const out = await assembleRetrievalResult(
      { query: "q", validAt: NOW, limit: 10 },
      {
        embedder,
        storage,
        retrieveConfig: { ...CFG, graphEnabled: false },
        graphRanker: ranker,
        debug: true,
      }
    );

    expect(Object.hasOwn(out, "degraded")).toBe(false);
    expect(ranker.calls).toBe(0);
    expect(storage.seedCalls).toBe(0);
    expect(out.debug?.bm25Hits).toBe(1);
    expect(Object.hasOwn(out.debug ?? {}, "graphHits")).toBe(false);
  });

  it("returns exactly { chunks } when both partner arms are off", async () => {
    const { storage, ranker } = seededGraph();

    const out = await assembleRetrievalResult(
      { query: "q", validAt: NOW, limit: 10 },
      {
        embedder,
        storage,
        retrieveConfig: { ...CFG, bm25Enabled: false, graphEnabled: false },
        graphRanker: ranker,
        debug: true,
      }
    );

    expect(Object.keys(out)).toEqual(["chunks"]);
  });
});

describe("three-arm assembly stays in-repo (SC11)", () => {
  it("adds no graph-orchestration framework to package.json", () => {
    const manifest = JSON.parse(
      readFileSync(
        join(import.meta.dirname, "..", "..", "package.json"),
        "utf8"
      )
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const declared = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
    ];
    // The arms are three promises and a weighted sum; a framework would be
    // a second orchestration model to keep in sync with this file.
    expect(declared.filter((name) => /langgraph/i.test(name))).toEqual([]);
  });
});

describe("assembleRetrievalResult — the archived SQL arm stays archived", () => {
  it("never runs the SQL one-hop arm alongside the Neo4j arm", async () => {
    const { storage, ranker } = seededGraph();
    let oneHopCalls = 0;
    const dual = Object.assign(storage, {
      graphArmSeed: {
        seedEntitiesByEmbedding: async () => storage.seeds,
        chunksByOneHopFromEntities: async () => {
          oneHopCalls += 1;
          return [];
        },
      },
    });

    const out = await assembleRetrievalResult(
      { query: "q", validAt: NOW, limit: 10 },
      {
        embedder,
        storage: dual,
        retrieveConfig: CFG,
        // A caller opting into the archive gets the production arm
        // instead: two arms both named "graph" would collide in the
        // debug payload and double-weight the same chunk.
        graphConfig: CFG,
        graphRanker: ranker,
        debug: true,
      }
    );

    expect(oneHopCalls).toBe(0);
    expect(out.debug?.graphHits).toBe(2);
  });
});
