/**
 * Unit tests for PgvectorBackend's graph-arm implementation
 * (spec-3 p0-integration T4): `graphArmSeed` exposing
 * `seedEntitiesByEmbedding` + `chunksByOneHopFromEntities`.
 *
 * Uses a fake PgPool injected via the private `pool` field — no live
 * Postgres. The SQL emitted by the two methods is asserted against the
 * query-builder contract locked in T3 (single JOIN chunks, no recursion,
 * two-sided valid_window @>).
 */
import { describe, it, expect } from "vitest";

import { PgvectorBackend } from "../../src/core/storage/pgvector-backend.js";
import { GraphragError } from "../../src/core/errors.js";
import type {
  CommunitySummaryStorage,
  GraphArmStorage,
} from "../../src/core/retrieval/types.js";

/**
 * Minimal structural pool shape the class expects (query + connect + end).
 * The fake only needs `query`; connect/end are never invoked because
 * `ensureReady()` is bypassed via the injected pool.
 */
interface PgPoolShape {
  query: (text: string, values: unknown[]) => Promise<{ rows: unknown[] }>;
  connect: () => Promise<{ query: Function; release: () => void }>;
  end: () => Promise<void>;
}

/** Fake query fn that records every (sql, params) call. */
function makeQuery(
  rows: unknown[] = [],
  error?: Error
): {
  fn: (text: string, values: unknown[]) => Promise<{ rows: unknown[] }>;
  calls: Array<[string, unknown[]]>;
} {
  const calls: Array<[string, unknown[]]> = [];
  const fn = async (
    sql: string,
    params: unknown[]
  ): Promise<{ rows: unknown[] }> => {
    calls.push([sql, params]);
    if (error) throw error;
    return { rows };
  };
  return { fn, calls };
}

/** Build a backend with an injected fake pool (avoids the pg module). */
function makeBackend(
  rows: unknown[] = [],
  error?: Error
): {
  backend: PgvectorBackend;
  calls: Array<[string, unknown[]]>;
  fakeQuery: (text: string, values: unknown[]) => Promise<{ rows: unknown[] }>;
} {
  const backend = new PgvectorBackend("postgres://x", 1536);
  const { fn, calls } = makeQuery(rows, error);
  const fakePool: PgPoolShape = {
    query: fn,
    connect: async () => ({
      query: async () => ({ rows: [] }),
      release: () => undefined,
    }),
    end: async () => undefined,
  };
  // ensureReady() memoizes `this.pool`; injecting it skips the dynamic
  // `import("pg")` entirely. Cast via unknown to keep the public API
  // surface stable — the field is intentionally private.
  (backend as unknown as { pool: PgPoolShape }).pool = fakePool;
  return { backend, calls, fakeQuery: fn };
}

function entityRow(id: string, canonical_name: string) {
  return { id, canonical_name };
}

function chunkRow(id: string, validFrom: Date, validUntil: Date | null) {
  return {
    id,
    content: `content-${id}`,
    source_ref: `src/${id}`,
    valid_from: validFrom,
    valid_until: validUntil,
  };
}

describe("PgvectorBackend.graphArmSeed", () => {
  it("exposes graphArmSeed as an optional GraphArmStorage seam", () => {
    const { backend } = makeBackend();
    expect(backend.graphArmSeed).toBeDefined();
    // Structurally consumable as GraphArmStorage (the T5 retrieve wiring
    // guards with `if (storage.graphArmSeed)` before calling).
    const seam: GraphArmStorage = backend.graphArmSeed!;
    expect(typeof seam.seedEntitiesByEmbedding).toBe("function");
    expect(typeof seam.chunksByOneHopFromEntities).toBe("function");
  });

  describe("seedEntitiesByEmbedding", () => {
    it("maps entity rows to {id, canonical_name} and passes vector + topK", async () => {
      const { backend, calls } = makeBackend([
        entityRow("e1", "E1"),
        entityRow("e2", "E2"),
      ]);
      const out = await backend.graphArmSeed!.seedEntitiesByEmbedding(
        [0.1, 0.2],
        8
      );
      expect(out).toEqual([
        { id: "e1", canonical_name: "E1" },
        { id: "e2", canonical_name: "E2" },
      ]);
      const [sql, params] = calls[0]!;
      expect(sql).toContain("FROM entities");
      expect(sql).toContain("ORDER BY embedding <=> $1::vector");
      expect(sql).toContain("LIMIT $2");
      // Soft-merge survivor-only filter (T3 success criterion #13).
      expect(sql).toContain("merged_into IS NULL");
      expect(sql).toContain("retired = false");
      // Vector literal + topK binding.
      expect(params[0]).toBe("[0.1,0.2]");
      expect(params[1]).toBe(8);
    });

    it("returns [] when the query yields no rows", async () => {
      const { backend } = makeBackend([]);
      const out = await backend.graphArmSeed!.seedEntitiesByEmbedding(
        [0.1, 0.2],
        8
      );
      expect(out).toEqual([]);
    });

    it("rejects with GraphragError STORAGE_ERROR when the query throws", async () => {
      const { backend } = makeBackend([], new Error("seed boom"));
      await expect(
        backend.graphArmSeed!.seedEntitiesByEmbedding([0.1, 0.2], 8)
      ).rejects.toBeInstanceOf(GraphragError);
      await expect(
        backend.graphArmSeed!.seedEntitiesByEmbedding([0.1, 0.2], 8)
      ).rejects.toMatchObject({ code: "STORAGE_ERROR" });
    });
  });

  describe("chunksByOneHopFromEntities", () => {
    it("maps chunk rows to ISO strings with exactly one JOIN chunks", async () => {
      const { backend, calls } = makeBackend([
        chunkRow("c1", new Date("2024-01-01T00:00:00Z"), null),
        chunkRow(
          "c2",
          new Date("2024-02-01T00:00:00Z"),
          new Date("2024-03-01T00:00:00Z")
        ),
      ]);
      const out = await backend.graphArmSeed!.chunksByOneHopFromEntities(
        ["e1", "e2"],
        "2024-06-15T12:30:45.000Z",
        50
      );
      expect(out).toEqual([
        {
          id: "c1",
          content: "content-c1",
          source_ref: "src/c1",
          valid_from: "2024-01-01T00:00:00.000Z",
          valid_until: null,
        },
        {
          id: "c2",
          content: "content-c2",
          source_ref: "src/c2",
          valid_from: "2024-02-01T00:00:00.000Z",
          valid_until: "2024-03-01T00:00:00.000Z",
        },
      ]);
      const [sql, params] = calls[0]!;
      // Single-hop hard limit (T3 Success Criterion #8).
      expect(sql.toUpperCase().split("JOIN CHUNKS").length - 1).toBe(1);
      expect(/WITH RECURSIVE/i.test(sql)).toBe(false);
      expect(/\bUNION\b/i.test(sql)).toBe(false);
      // Two-sided temporal filter (T3 Success Criteria #2 / #3).
      expect(sql).toContain("ANY($1::uuid[])");
      expect(sql).toContain("t.valid_window @> $2::timestamptz");
      expect(sql).toContain("c.valid_window @> $2::timestamptz");
      expect(sql).toContain("LIMIT $3");
      expect(params[0]).toEqual(["e1", "e2"]);
      expect(params[1]).toBe("2024-06-15T12:30:45.000Z");
      expect(params[2]).toBe(50);
    });

    it("returns [] without querying when seedIds is empty", async () => {
      const { backend, calls } = makeBackend([]);
      const out = await backend.graphArmSeed!.chunksByOneHopFromEntities(
        [],
        "2024-06-15T12:30:45.000Z",
        50
      );
      expect(out).toEqual([]);
      // ANY($1::uuid[]) over an empty array yields zero rows but the
      // Postgres type inference for `uuid[]` from an empty JS array is
      // ambiguous; short-circuit before the round-trip.
      expect(calls).toHaveLength(0);
    });

    it("rejects with GraphragError STORAGE_ERROR when the query throws", async () => {
      const { backend } = makeBackend([], new Error("one-hop boom"));
      await expect(
        backend.graphArmSeed!.chunksByOneHopFromEntities(
          ["e1"],
          "2024-06-15T12:30:45.000Z",
          50
        )
      ).rejects.toBeInstanceOf(GraphragError);
      await expect(
        backend.graphArmSeed!.chunksByOneHopFromEntities(
          ["e1"],
          "2024-06-15T12:30:45.000Z",
          50
        )
      ).rejects.toMatchObject({ code: "STORAGE_ERROR" });
    });
  });
});

describe("PgvectorBackend.communitySummaries", () => {
  it("reads one summary by community id under the level cap", async () => {
    const { backend, calls } = makeBackend([
      {
        id: "summary-1",
        community_id: "7",
        summary: "storage topic",
        level: 2,
        score: 0.8,
      },
    ]);

    await expect(
      backend.communitySummaries.getCommunitySummaryByCommunityId("7", 2)
    ).resolves.toEqual({
      id: "summary-1",
      communityId: "7",
      summary: "storage topic",
      level: 2,
    });

    const [sql, params] = calls[0]!;
    expect(sql).toContain("FROM community_summaries");
    expect(sql).toContain("WHERE community_id = $1");
    expect(sql).toContain("level <= $2");
    expect(params).toEqual(["7", 2]);
  });

  it("returns undefined for an empty or missing community id", async () => {
    const empty = makeBackend([]);
    await expect(
      empty.backend.communitySummaries.getCommunitySummaryByCommunityId("", 2)
    ).resolves.toBeUndefined();
    expect(empty.calls).toHaveLength(0);

    const missing = makeBackend([]);
    await expect(
      missing.backend.communitySummaries.getCommunitySummaryByCommunityId(
        "missing",
        2
      )
    ).resolves.toBeUndefined();
    expect(missing.calls).toHaveLength(1);
  });

  it("converts a community-id read failure to GraphragError", async () => {
    const { backend } = makeBackend([], new Error("summary table unavailable"));
    await expect(
      backend.communitySummaries.getCommunitySummaryByCommunityId("7", 2)
    ).rejects.toMatchObject({ code: "STORAGE_ERROR" });
  });

  it("maps summary rows and queries Postgres by the supplied embedding", async () => {
    const { backend, calls } = makeBackend([
      {
        id: "summary-1",
        community_id: "7",
        summary: "storage topic",
        level: 2,
        score: 0.8,
      },
    ]);
    const seam: CommunitySummaryStorage = backend.communitySummaries;

    await expect(
      seam.searchCommunitySummaries([0.1, 0.2], 5, 2)
    ).resolves.toEqual([
      {
        id: "summary-1",
        communityId: "7",
        summary: "storage topic",
        level: 2,
        score: 0.8,
      },
    ]);
    const [sql, params] = calls[0]!;
    expect(sql).toContain("FROM community_summaries");
    expect(sql).toContain("embedding <=> $1::vector");
    expect(sql).toContain("level <= $3");
    expect(params).toEqual(["[0.1,0.2]", 5, 2]);
  });

  it("converts a summary ledger failure to GraphragError", async () => {
    const { backend } = makeBackend([], new Error("summary table unavailable"));
    await expect(
      backend.communitySummaries.searchCommunitySummaries([0.1], 5, 2)
    ).rejects.toMatchObject({ code: "STORAGE_ERROR" });
  });
});
