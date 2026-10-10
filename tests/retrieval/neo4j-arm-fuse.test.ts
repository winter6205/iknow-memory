/**
 * Orchestrator-level retrieval with the Neo4j PPR arm: vector ∥ BM25 ∥ graph
 * (specs/neo4j-graph-arm.md T4 — SC5, SC7–SC10; specs/retrieve-graph-priority.md
 * SC1–SC7).
 *
 * The arm under test is wired the way production wires it: a `graphRanker`
 * port (the Neo4j GDS adapter in the real server) plus a backend exposing
 * the `neo4jArmSeed` seam. Everything here is a fake, so the suite proves
 * the ORCHESTRATION contract — who runs, who degrades, who ranks — without
 * a graph or a database.
 *
 * Ranking is GRAPH-PRIORITY, not a weighted three-arm vote: when the Neo4j
 * arm returns chunks they occupy the front of `chunks[]` in the arm's own
 * order, and vector+BM25 `rrfFuse` (k=60) only fills whatever `limit` slots
 * are left, deduped by chunk id. An empty graph arm is not a third voter —
 * the list is then exactly the vector+BM25 fusion.
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

/** Production defaults. */
const CFG: RetrieveConfig = {
  w_vec: 0.7,
  w_bm25: 0.15,
  w_graph: 0.15,
  bm25Enabled: true,
  graphEnabled: true,
  rerankEnabled: false,
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

/** A one-hop row for the ARCHIVED SQL arm, which carries no entity id. */
function oneHopRow(chunkId: string): {
  id: string;
  content: string;
  source_ref: string;
  valid_from: string;
  valid_until: string | null;
} {
  return {
    id: chunkId,
    content: `content-${chunkId}`,
    source_ref: `src/${chunkId}`,
    valid_from: "2026-01-01T00:00:00.000Z",
    valid_until: null,
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
    // The graph reaches the chunk the vector arm ranks LAST. Graph priority
    // must lift it above the chunk only the vector arm knows.
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

describe("assembleRetrievalResult — graph-priority ranking (SC1–SC3)", () => {
  it("SC1: leads with the graph arm's order, ahead of the vector arm's top hit", async () => {
    const { storage, ranker } = seededGraph();
    // The vector arm ranks B first and an unrelated C second; the graph
    // arm ranks A then B. A weighted vote would have kept B on top —
    // graph priority puts the graph's own order in front instead.
    storage.vectorHits = [chunk("B"), chunk("C")];
    storage.rows = [row("e1", "A"), row("e2", "B")];

    const out = await assembleRetrievalResult(
      { query: "q", validAt: NOW, limit: 10 },
      { embedder, storage, retrieveConfig: CFG, graphRanker: ranker }
    );

    expect(out.chunks.map((c) => c.id)).toEqual(["A", "B", "C"]);
  });

  it("SC2: fills the leftover slots from vector+BM25 and lists a shared chunk once", async () => {
    const { storage, ranker } = seededGraph();
    storage.vectorHits = [chunk("X"), chunk("Y"), chunk("Z")];
    // Z is reached by both the graph arm and the vector arm; Q only by the
    // graph. Two graph hits lead, so exactly one fill slot is left at
    // limit 3 — and Z must not consume both its graph and its vector slot.
    storage.rows = [row("e1", "Z"), row("e2", "Q")];

    const out = await assembleRetrievalResult(
      { query: "q", validAt: NOW, limit: 3 },
      { embedder, storage, retrieveConfig: CFG, graphRanker: ranker }
    );

    expect(out.chunks.map((c) => c.id)).toEqual(["Z", "Q", "X"]);
  });

  it("SC3: an empty graph arm ranks exactly as vector+BM25 alone, not degraded", async () => {
    const { storage, ranker } = seededGraph();
    storage.vectorHits = [chunk("v1"), chunk("v2")];
    storage.lexicalHits = [chunk("v2")];
    // Seeds and a PPR ranking exist, but no chunk hangs off the ranked
    // entities: an empty contribution, not a failed one.
    storage.rows = [];

    const withGraph = await assembleRetrievalResult(
      { query: "q", validAt: NOW, limit: 10 },
      {
        embedder,
        storage,
        retrieveConfig: CFG,
        graphRanker: ranker,
        debug: true,
      }
    );
    const withoutGraph = await assembleRetrievalResult(
      { query: "q", validAt: NOW, limit: 10 },
      {
        embedder,
        storage,
        retrieveConfig: { ...CFG, graphEnabled: false },
        graphRanker: ranker,
      }
    );

    expect(withGraph.chunks).toEqual(withoutGraph.chunks);
    expect(Object.hasOwn(withGraph, "degraded")).toBe(false);
    // Ran and found nothing — distinguishable from never having run.
    expect(withGraph.debug?.graphHits).toBe(0);
  });

  it("scores the graph-led chunk above the remainder, keeping order and score aligned", async () => {
    const { storage, ranker } = seededGraph();
    storage.vectorHits = [chunk("v1"), chunk("v2")];
    storage.lexicalHits = [chunk("v2")];
    storage.rows = [row("e1", "g1")];

    const out = await assembleRetrievalResult(
      { query: "q", validAt: NOW, limit: 10 },
      { embedder, storage, retrieveConfig: CFG, graphRanker: ranker }
    );

    expect(out.chunks.map((c) => c.id)).toEqual(["g1", "v2", "v1"]);
    // The remainder is a genuine vector+BM25 fusion at k=60 — v2 is worth
    // both arms, v1 only the vector arm, and `w_graph` buys no vote here.
    expect(out.chunks[1]?.score).toBeCloseTo(0.7 / 62 + 0.15 / 61, 12);
    expect(out.chunks[2]?.score).toBeCloseTo(0.7 / 61, 12);
    // A Host that re-sorts by score must not undo the graph's lead.
    const scores = out.chunks.map((c) => c.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it("truncates a graph list longer than the limit and adds no fill", async () => {
    const { storage, ranker } = seededGraph();
    storage.vectorHits = [chunk("v1")];
    storage.rows = [row("e1", "g1"), row("e1", "g2"), row("e2", "g3")];

    const out = await assembleRetrievalResult(
      { query: "q", validAt: NOW, limit: 2 },
      { embedder, storage, retrieveConfig: CFG, graphRanker: ranker }
    );

    expect(out.chunks.map((c) => c.id)).toEqual(["g1", "g2"]);
  });

  it("returns no chunks for a non-positive limit even when the graph arm hit", async () => {
    const { storage, ranker } = seededGraph();

    const out = await assembleRetrievalResult(
      { query: "q", validAt: NOW, limit: 0 },
      { embedder, storage, retrieveConfig: CFG, graphRanker: ranker }
    );

    expect(out.chunks).toEqual([]);
  });
});

describe("assembleRetrievalResult — no sidecar configured (T10)", () => {
  it("does not attempt the arm but marks the default-on capability unattempted", async () => {
    const { storage } = seededGraph();

    const out = await assembleRetrievalResult(
      { query: "q", validAt: NOW, limit: 10 },
      // No graphRanker: exactly what the server wires when
      // GRAPHRAG_MEMORY_NEO4J_URI is unset.
      { embedder, storage, retrieveConfig: CFG, debug: true }
    );

    expect(out.degraded).toBe(true);
    expect(out.degraded_reasons).toContain("graph_ppr:unattempted");
    // Not attempted: the seed query never ran, and the debug payload has
    // no graph key at all — "the arm found nothing" would be `graphHits: 0`.
    expect(storage.seedCalls).toBe(0);
    expect(Object.hasOwn(out.debug ?? {}, "graphHits")).toBe(false);
    expect(out.chunks.map((c) => c.id)).toEqual(["v1", "v2"]);
  });

  it("marks the default-on capability when the backend has no neo4jArmSeed seam", async () => {
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

    expect(out.degraded).toBe(true);
    expect(out.degraded_reasons).toContain("graph_ppr:unattempted");
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

  it("does not hand the archived SQL arm the graph-priority lead", async () => {
    const storage = new ThreeArmBackend();
    storage.vectorHits = [chunk("v1")];
    const sqlOnly = Object.assign(storage, {
      graphArmSeed: {
        seedEntitiesByEmbedding: async () => storage.seeds,
        // Three rows clear `graphArmFloor`, so the archive contributes
        // without degrading the envelope.
        chunksByOneHopFromEntities: async () => [
          oneHopRow("s1"),
          oneHopRow("s2"),
          oneHopRow("s3"),
        ],
      },
    });

    const out = await assembleRetrievalResult(
      { query: "q", validAt: NOW, limit: 10 },
      // No graphRanker, so the Neo4j arm cannot run and the injected
      // archive is what answers to the arm name "graph".
      { embedder, storage: sqlOnly, retrieveConfig: CFG, graphConfig: CFG }
    );

    // Priority is bound to the NEO4J arm's result, never to the arm NAME:
    // the archive keeps voting at w_graph, so 0.7/61 still beats 0.15/61.
    expect(out.chunks.map((c) => c.id)).toEqual(["v1", "s1", "s2", "s3"]);
    expect(Object.hasOwn(out, "degraded")).toBe(false);
  });
});
