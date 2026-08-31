/**
 * Neo4j graph arm — pure orchestration (specs/neo4j-graph-arm.md T4).
 *
 * The arm is three steps: Postgres seeds → Neo4j PPR ranking → Postgres
 * chunks via `triples.source_chunk_id`. This suite drives all three through
 * fakes, so it needs neither a graph nor a database.
 *
 * Two contracts get most of the attention:
 *   - **ranking**: a chunk inherits the rank of the best-ranked entity that
 *     reaches it, so the PPR order survives the hop back into Postgres;
 *   - **fail-open**: any step throwing yields an empty degraded `ArmResult`,
 *     never a rejection (SC8), while a step that legitimately finds nothing
 *     yields an empty NON-degraded one (SC5's "contributes nothing" case).
 */
import { describe, it, expect, vi } from "vitest";

import { runNeo4jGraphArm } from "../../src/core/retrieval/neo4j-graph-arm.js";
import type {
  EntityChunkRow,
  GraphRanker,
  Neo4jArmStorage,
  RankedEntity,
  RetrieveConfig,
} from "../../src/core/retrieval/types.js";

const NOW = "2026-08-01T00:00:00.000Z";
const EMBEDDING = [0.1, 0.2, 0.3, 0.4];

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

function chunkRow(
  entityId: string,
  chunkId: string,
  patch: Partial<EntityChunkRow> = {}
): EntityChunkRow {
  return {
    entity_id: entityId,
    id: chunkId,
    content: `content-${chunkId}`,
    source_ref: `src/${chunkId}`,
    valid_from: "2026-01-01T00:00:00.000Z",
    valid_until: null,
    ...patch,
  };
}

/** Scriptable Postgres side of the arm; records every call it receives. */
class FakeArmStorage implements Neo4jArmStorage {
  seeds: Array<{ id: string; canonical_name: string }> = [];
  rows: EntityChunkRow[] = [];
  seedCalls: Array<{ embedding: number[]; topK: number }> = [];
  chunkCalls: Array<{ ids: string[]; validAt: string; limit: number }> = [];
  seedError: unknown;
  chunkError: unknown;

  async seedEntitiesByEmbedding(
    embedding: number[],
    topK: number
  ): Promise<Array<{ id: string; canonical_name: string }>> {
    this.seedCalls.push({ embedding, topK });
    if (this.seedError !== undefined) throw this.seedError;
    return this.seeds;
  }

  async chunksByEntityIds(
    entityIds: readonly string[],
    validAt: string,
    limit: number
  ): Promise<EntityChunkRow[]> {
    this.chunkCalls.push({ ids: [...entityIds], validAt, limit });
    if (this.chunkError !== undefined) throw this.chunkError;
    return this.rows;
  }
}

/** Scriptable graph side: returns a fixed ranking, or throws. */
class FakeRanker implements GraphRanker {
  ranked: RankedEntity[] = [];
  calls: Array<{ seedIds: string[]; limit: number }> = [];
  error: unknown;

  async rankEntities(
    seedEntityIds: readonly string[],
    limit: number
  ): Promise<RankedEntity[]> {
    this.calls.push({ seedIds: [...seedEntityIds], limit });
    if (this.error !== undefined) throw this.error;
    return this.ranked;
  }
}

/** Storage + ranker wired for the happy path: 2 seeds, 3 ranked entities. */
function happyPath(): { storage: FakeArmStorage; ranker: FakeRanker } {
  const storage = new FakeArmStorage();
  storage.seeds = [
    { id: "e-seed", canonical_name: "Seed" },
    { id: "e-other", canonical_name: "Other" },
  ];
  storage.rows = [
    chunkRow("e-far", "c-far"),
    chunkRow("e-seed", "c-near"),
    chunkRow("e-mid", "c-mid"),
  ];
  const ranker = new FakeRanker();
  ranker.ranked = [
    { id: "e-seed", score: 0.9 },
    { id: "e-mid", score: 0.5 },
    { id: "e-far", score: 0.1 },
  ];
  return { storage, ranker };
}

describe("runNeo4jGraphArm — seed → PPR → chunks", () => {
  it("returns graph-arm hits ordered by the PPR rank of the entity that reached them", async () => {
    const { storage, ranker } = happyPath();

    const result = await runNeo4jGraphArm(
      EMBEDDING,
      { storage, ranker, config: CFG },
      NOW
    );

    expect(result.arm).toBe("graph");
    expect(result.belowFloor).toBe(false);
    expect(result.hits.map((h) => h.id)).toEqual(["c-near", "c-mid", "c-far"]);
    expect(result.hits.map((h) => h.rank)).toEqual([1, 2, 3]);
    expect(result.hits[0]).toMatchObject({
      arm: "graph",
      content: "content-c-near",
      source_ref: "src/c-near",
      valid_window: ["2026-01-01T00:00:00.000Z", null],
    });
  });

  it("passes the embedding and entityLinkTopK straight to the seed query", async () => {
    const { storage, ranker } = happyPath();

    await runNeo4jGraphArm(
      EMBEDDING,
      { storage, ranker, config: { ...CFG, entityLinkTopK: 3 } },
      NOW
    );

    expect(storage.seedCalls).toEqual([{ embedding: EMBEDDING, topK: 3 }]);
  });

  it("ranks the graph with the seed ids and caps it at candidateCap", async () => {
    const { storage, ranker } = happyPath();

    await runNeo4jGraphArm(
      EMBEDDING,
      { storage, ranker, config: { ...CFG, candidateCap: 7 } },
      NOW
    );

    expect(ranker.calls).toEqual([
      { seedIds: ["e-seed", "e-other"], limit: 7 },
    ]);
  });

  it("looks chunks up by the RANKED entities, in rank order, at validAt", async () => {
    const { storage, ranker } = happyPath();

    await runNeo4jGraphArm(
      EMBEDDING,
      { storage, ranker, config: { ...CFG, candidateCap: 7 } },
      NOW
    );

    // Ranked entities, not seeds: the whole point of PPR is reaching
    // entities the embedding seed never named.
    expect(storage.chunkCalls).toEqual([
      { ids: ["e-seed", "e-mid", "e-far"], validAt: NOW, limit: 7 },
    ]);
  });

  it("gives a chunk reachable from several entities its best entity's rank", async () => {
    const { storage, ranker } = happyPath();
    storage.rows = [
      chunkRow("e-far", "c-shared"),
      chunkRow("e-mid", "c-mid"),
      chunkRow("e-seed", "c-shared"),
    ];

    const result = await runNeo4jGraphArm(
      EMBEDDING,
      { storage, ranker, config: CFG },
      NOW
    );

    // c-shared is reached from the top-ranked entity too, so it outranks
    // the chunk that only the mid entity reaches — and appears once.
    expect(result.hits.map((h) => h.id)).toEqual(["c-shared", "c-mid"]);
  });

  it("breaks a same-entity tie on chunk id so the order is deterministic", async () => {
    const { storage, ranker } = happyPath();
    storage.rows = [
      chunkRow("e-seed", "c-b"),
      chunkRow("e-seed", "c-a"),
      chunkRow("e-seed", "c-c"),
    ];

    const result = await runNeo4jGraphArm(
      EMBEDDING,
      { storage, ranker, config: CFG },
      NOW
    );

    expect(result.hits.map((h) => h.id)).toEqual(["c-a", "c-b", "c-c"]);
  });

  it("carries the PPR score onto the hit without letting it drive the order", async () => {
    const { storage, ranker } = happyPath();

    const result = await runNeo4jGraphArm(
      EMBEDDING,
      { storage, ranker, config: CFG },
      NOW
    );

    // Projected for inspection (#57: confidence/score may be shown, must
    // not become the ranking algorithm) — RRF still fuses on `rank`.
    expect(result.hits.map((h) => h.score)).toEqual([0.9, 0.5, 0.1]);
  });

  it("drops a row whose entity the ranking never named", async () => {
    const { storage, ranker } = happyPath();
    storage.rows = [
      chunkRow("e-unranked", "c-ghost"),
      chunkRow("e-mid", "c-mid"),
    ];

    const result = await runNeo4jGraphArm(
      EMBEDDING,
      { storage, ranker, config: CFG },
      NOW
    );

    expect(result.hits.map((h) => h.id)).toEqual(["c-mid"]);
  });

  it("truncates the hit list at candidateCap", async () => {
    const { storage, ranker } = happyPath();
    storage.rows = Array.from({ length: 5 }, (_, i) =>
      chunkRow("e-seed", `c-${i}`)
    );

    const result = await runNeo4jGraphArm(
      EMBEDDING,
      { storage, ranker, config: { ...CFG, candidateCap: 2 } },
      NOW
    );

    expect(result.hits).toHaveLength(2);
  });
});

describe("runNeo4jGraphArm — nothing to contribute is not a degradation", () => {
  it("skips the graph entirely when the ledger has no seed entities", async () => {
    const storage = new FakeArmStorage();
    const ranker = new FakeRanker();

    const result = await runNeo4jGraphArm(
      EMBEDDING,
      { storage, ranker, config: CFG },
      NOW
    );

    expect(result).toEqual({ arm: "graph", hits: [], belowFloor: false });
    expect(ranker.calls).toEqual([]);
  });

  it("skips the chunk lookup when PPR ranks nothing", async () => {
    const { storage, ranker } = happyPath();
    ranker.ranked = [];

    const result = await runNeo4jGraphArm(
      EMBEDDING,
      { storage, ranker, config: CFG },
      NOW
    );

    expect(result).toEqual({ arm: "graph", hits: [], belowFloor: false });
    expect(storage.chunkCalls).toEqual([]);
  });

  it("stays non-degraded when the ranked entities map to no chunk", async () => {
    const { storage, ranker } = happyPath();
    storage.rows = [];

    const result = await runNeo4jGraphArm(
      EMBEDDING,
      { storage, ranker, config: CFG },
      NOW
    );

    expect(result).toEqual({ arm: "graph", hits: [], belowFloor: false });
  });

  // The archived SQL arm degrades below `graphArmFloor` chunks. This arm
  // does not carry that knob: a sparse graph is a thin answer, not a
  // broken one, and flagging it would make `degraded` meaningless on a
  // production server whose graph is still filling up.
  it("ignores graphArmFloor — one hit under a floor of three is fine", async () => {
    const { storage, ranker } = happyPath();
    storage.rows = [chunkRow("e-seed", "c-only")];

    const result = await runNeo4jGraphArm(
      EMBEDDING,
      { storage, ranker, config: { ...CFG, graphArmFloor: 3 } },
      NOW
    );

    expect(result.hits).toHaveLength(1);
    expect(result.belowFloor).toBe(false);
    expect(result.failureReason).toBeUndefined();
  });
});

describe("runNeo4jGraphArm — fail-open (SC8)", () => {
  it("does not return or emit a BOLT password from a degraded error", async () => {
    const secret = "neo4j-bolt-secret";
    const { storage, ranker } = happyPath();
    ranker.error = new Error(
      `Neo4j at bolt://neo4j-user:${secret}@db.example.test:7687 is unreachable`
    );
    const output: string[] = [];
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown) => {
        output.push(String(chunk));
        return true;
      });

    let result;
    try {
      result = await runNeo4jGraphArm(
        EMBEDDING,
        { storage, ranker, config: CFG },
        NOW
      );
    } finally {
      stderr.mockRestore();
    }

    expect(result.failureReason).not.toContain(secret);
    expect(output.join("")).not.toContain(secret);
  });

  it("degrades instead of rejecting when the seed query throws", async () => {
    const { storage, ranker } = happyPath();
    storage.seedError = new Error("entities table is gone");

    const result = await runNeo4jGraphArm(
      EMBEDDING,
      { storage, ranker, config: CFG },
      NOW
    );

    expect(result.hits).toEqual([]);
    expect(result.belowFloor).toBe(true);
    expect(result.failureReason).toContain("entities table is gone");
    expect(ranker.calls).toEqual([]);
  });

  it("degrades instead of rejecting when PPR throws", async () => {
    const { storage, ranker } = happyPath();
    ranker.error = new Error("no procedure gds.pageRank.stream");

    const result = await runNeo4jGraphArm(
      EMBEDDING,
      { storage, ranker, config: CFG },
      NOW
    );

    expect(result.belowFloor).toBe(true);
    expect(result.failureReason).toContain("gds.pageRank.stream");
    expect(storage.chunkCalls).toEqual([]);
  });

  it("degrades instead of rejecting when the chunk lookup throws", async () => {
    const { storage, ranker } = happyPath();
    storage.chunkError = new Error("chunks join failed");

    const result = await runNeo4jGraphArm(
      EMBEDDING,
      { storage, ranker, config: CFG },
      NOW
    );

    expect(result.belowFloor).toBe(true);
    expect(result.failureReason).toContain("chunks join failed");
  });

  it("survives a non-Error throw from any step", async () => {
    for (const thrown of ["a bare string", { unexpected: true }, 42]) {
      const { storage, ranker } = happyPath();
      ranker.error = thrown;
      const result = await runNeo4jGraphArm(
        EMBEDDING,
        { storage, ranker, config: CFG },
        NOW
      );
      expect(result.belowFloor).toBe(true);
      expect(result.failureReason).toBeTruthy();
    }
  });
});
