/**
 * Unit tests for the graph arm (spec-3 p0-integration T3).
 *
 * Uses fake seams only — no live Postgres. The caller supplies the query
 * embedding (G5 lever (a) — the arm never embeds); `FakeStorage` returns
 * preset rows or throws on demand. Also asserts the query-builder SQL shape
 * (single-hop hard limit per Success Criterion #8, soft-merge survivor-only
 * per #13).
 */
import { describe, it, expect } from "vitest";
import { runGraphArm } from "../../src/core/retrieval/graph-arm.js";
import {
  buildSeedEntitiesSql,
  buildOneHopChunksSql,
} from "../../src/core/retrieval/query-builder.js";
import type {
  GraphArmStorage,
  RetrieveConfig,
} from "../../src/core/retrieval/types.js";

/** Fixed config: k seeds, cap candidates, floor g. */
const CFG: RetrieveConfig = {
  w_vec: 1,
  w_graph: 1,
  entityLinkTopK: 8,
  candidateCap: 50,
  graphArmFloor: 3,
};

/** Query embedding the orchestrator hands to the arm. */
const QUERY_VEC = [0.1, 0.2, 0.3];

/** Fake storage returning preset rows / seeds; can be told to throw. */
class FakeStorage implements GraphArmStorage {
  seedEntities: Array<{ id: string; canonical_name: string }> = [];
  rows: Array<{
    id: string;
    content: string;
    source_ref: string;
    valid_from: string;
    valid_until: string | null;
  }> = [];
  seedError: Error | null = null;
  rowError: Error | null = null;
  seedCalls: Array<{ embedding: number[]; topK: number }> = [];
  oneHopCalls: Array<{ seedIds: string[]; validAt: string; limit: number }> =
    [];

  async seedEntitiesByEmbedding(
    embedding: number[],
    topK: number
  ): Promise<Array<{ id: string; canonical_name: string }>> {
    this.seedCalls.push({ embedding, topK });
    if (this.seedError) throw this.seedError;
    return this.seedEntities;
  }

  async chunksByOneHopFromEntities(
    seedIds: string[],
    validAt: string,
    limit: number
  ): Promise<
    Array<{
      id: string;
      content: string;
      source_ref: string;
      valid_from: string;
      valid_until: string | null;
    }>
  > {
    this.oneHopCalls.push({ seedIds, validAt, limit });
    if (this.rowError) throw this.rowError;
    return this.rows;
  }
}

function row(id: string): {
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

describe("runGraphArm", () => {
  it("returns a degraded result when seedEntitiesByEmbedding throws", async () => {
    const storage = new FakeStorage();
    storage.seedError = new Error("seed boom");
    const out = await runGraphArm(
      QUERY_VEC,
      { storage, config: CFG },
      new Date("2024-01-01T00:00:00Z")
    );
    expect(out.arm).toBe("graph");
    expect(out.hits).toEqual([]);
    expect(out.belowFloor).toBe(true);
    expect(out.failureReason).toContain("seed boom");
  });

  it("flags belowFloor when seeds is empty (K=0)", async () => {
    const storage = new FakeStorage();
    storage.seedEntities = [];
    const out = await runGraphArm(
      QUERY_VEC,
      { storage, config: CFG },
      new Date("2024-01-01T00:00:00Z")
    );
    // Floor counts chunks: empty seeds yield 0 one-hop rows < floor 3.
    expect(out.belowFloor).toBe(true);
    expect(out.hits).toEqual([]);
    // oneHop is still called with the empty seed list (storage decides how to
    // handle it; pgvector's chunksByOneHopFromEntities short-circuits on
    // empty seedIds, FakeStorage returns preset rows).
  });

  it("flags belowFloor when one-hop rows < graphArmFloor", async () => {
    const storage = new FakeStorage();
    storage.seedEntities = [{ id: "e1", canonical_name: "E1" }];
    storage.rows = []; // 0 chunks returned by the one-hop query
    const out = await runGraphArm(
      QUERY_VEC,
      {
        storage,
        config: { ...CFG, graphArmFloor: 3 },
      },
      new Date("2024-01-01T00:00:00Z")
    );
    expect(out.belowFloor).toBe(true);
    expect(out.hits).toEqual([]);
    expect(out.failureReason).toMatch(/yielded 0 chunk.*< floor 3/);
  });

  it("returns hits from chunksByOneHopFromEntities when rows >= floor", async () => {
    const storage = new FakeStorage();
    storage.seedEntities = [
      { id: "e1", canonical_name: "E1" },
      { id: "e2", canonical_name: "E2" },
      { id: "e3", canonical_name: "E3" },
    ];
    // 3 chunks satisfies the default floor of 3.
    storage.rows = [row("c1"), row("c2"), row("c3")];
    const out = await runGraphArm(
      QUERY_VEC,
      { storage, config: CFG },
      new Date("2024-01-01T00:00:00Z")
    );
    expect(out.belowFloor).toBe(false);
    expect(out.hits).toHaveLength(3);
    expect(out.hits[0]).toMatchObject({
      id: "c1",
      arm: "graph",
      rank: 1,
      content: "content-c1",
      source_ref: "src/c1",
      valid_window: ["2024-01-01T00:00:00.000Z", null],
    });
    expect(out.hits[1]?.rank).toBe(2);
  });

  it("passes candidateCap as the one-hop limit", async () => {
    const storage = new FakeStorage();
    storage.seedEntities = [
      { id: "e1", canonical_name: "E1" },
      { id: "e2", canonical_name: "E2" },
      { id: "e3", canonical_name: "E3" },
    ];
    storage.rows = [row("c1")];
    await runGraphArm(
      QUERY_VEC,
      {
        storage,
        config: { ...CFG, candidateCap: 7 },
      },
      new Date("2024-01-01T00:00:00Z")
    );
    expect(storage.oneHopCalls).toHaveLength(1);
    expect(storage.oneHopCalls[0]?.limit).toBe(7);
    expect(storage.oneHopCalls[0]?.seedIds).toEqual(["e1", "e2", "e3"]);
  });

  it("returns a degraded result when chunksByOneHopFromEntities throws", async () => {
    const storage = new FakeStorage();
    storage.seedEntities = [
      { id: "e1", canonical_name: "E1" },
      { id: "e2", canonical_name: "E2" },
      { id: "e3", canonical_name: "E3" },
    ];
    storage.rowError = new Error("row boom");
    const out = await runGraphArm(
      QUERY_VEC,
      { storage, config: CFG },
      new Date("2024-01-01T00:00:00Z")
    );
    expect(out.belowFloor).toBe(true);
    expect(out.hits).toEqual([]);
    expect(out.failureReason).toContain("row boom");
  });

  it("passes entityLinkTopK to seedEntitiesByEmbedding", async () => {
    const storage = new FakeStorage();
    storage.seedEntities = [
      { id: "e1", canonical_name: "E1" },
      { id: "e2", canonical_name: "E2" },
      { id: "e3", canonical_name: "E3" },
    ];
    storage.rows = [];
    await runGraphArm(
      [0.5, 0.5, 0.5],
      { storage, config: { ...CFG, entityLinkTopK: 4 } },
      new Date("2024-01-01T00:00:00Z")
    );
    expect(storage.seedCalls).toHaveLength(1);
    expect(storage.seedCalls[0]?.topK).toBe(4);
    expect(storage.seedCalls[0]?.embedding).toEqual([0.5, 0.5, 0.5]);
  });

  it("SC12a: forwards the caller's query embedding verbatim, never re-embedding", async () => {
    const storage = new FakeStorage();
    storage.seedEntities = [{ id: "e1", canonical_name: "E1" }];
    storage.rows = [row("c1"), row("c2"), row("c3")];
    // The arm has no embedder dependency at all (G5 lever (a)): the only
    // vector it can reach storage with is the one the orchestrator embedded.
    await runGraphArm(
      QUERY_VEC,
      { storage, config: CFG },
      new Date("2024-01-01T00:00:00Z")
    );
    expect(storage.seedCalls.map((c) => c.embedding)).toEqual([QUERY_VEC]);
  });

  it("passes the ISO timestamp as validAt into the one-hop call", async () => {
    const storage = new FakeStorage();
    storage.seedEntities = [
      { id: "e1", canonical_name: "E1" },
      { id: "e2", canonical_name: "E2" },
      { id: "e3", canonical_name: "E3" },
    ];
    storage.rows = [];
    await runGraphArm(
      QUERY_VEC,
      { storage, config: CFG },
      new Date("2024-06-15T12:30:45.000Z")
    );
    expect(storage.oneHopCalls[0]?.validAt).toBe("2024-06-15T12:30:45.000Z");
  });
});

describe("query-builder", () => {
  it("builds a single-hop SQL with exactly one JOIN chunks and no recursion/UNION", () => {
    const { sql, paramCount } = buildOneHopChunksSql(3);
    expect(sql.toUpperCase().split("JOIN CHUNKS").length - 1).toBe(1);
    expect(/WITH RECURSIVE/i.test(sql)).toBe(false);
    expect(/\bUNION\b/i.test(sql)).toBe(false);
    expect(paramCount).toBe(3);
    // Seed array bind + two-sided valid_window filter present.
    expect(sql).toContain("ANY($1::uuid[])");
    expect(sql).toContain("t.valid_window @> $2::timestamptz");
    expect(sql).toContain("c.valid_window @> $2::timestamptz");
    expect(sql).toContain("ORDER BY t.confidence DESC");
    expect(sql).toContain("LIMIT $3");
  });

  it("builds a soft-merge survivor-only seed query with cosine ordering", () => {
    const { sql, paramCount } = buildSeedEntitiesSql(3);
    expect(sql).toContain("ORDER BY embedding <=> $1::vector");
    expect(sql).toContain("LIMIT $2");
    expect(sql).toContain("merged_into IS NULL");
    expect(sql).toContain("retired = false");
    expect(paramCount).toBe(2);
  });
});
