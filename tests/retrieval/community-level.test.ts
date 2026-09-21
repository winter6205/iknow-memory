/**
 * Community-level retrieve cap (specs/community-level.md T2): every read of
 * `community_summaries` applies `level <= N`. `filters.community_level` is
 * the override — missing → 2, a positive integer string → that N, anything
 * else (non-integer, zero, negative, empty) → typed INVALID_INPUT that never
 * reaches an arm and never rides the degraded channel. The same parsed N is
 * used by every summary read in one request; a graph-arm-only fixture is
 * order-identical with and without the cap code path.
 */
import { describe, expect, it } from "vitest";
import { createRetrieveHandler } from "../../src/tools/retrieve.js";
import { assembleRetrievalResult } from "../../src/core/retrieval/index.js";
import {
  COMMUNITY_LEVEL_FILTER_KEY,
  DEFAULT_COMMUNITY_LEVEL_CAP,
  INVALID_COMMUNITY_LEVEL_REASON,
  invalidCommunityLevelMessage,
  parseCommunityLevelFilter,
  stripCommunityLevelFilter,
} from "../../src/core/retrieval/wire-filters.js";
import { GraphragError } from "../../src/core/errors.js";
import type { ToolResult } from "../../src/tools/registry.js";
import type { EmbeddingClient } from "../../src/core/embedder.js";
import type {
  ChunkRecord,
  RetrievedChunk,
  SearchOptions,
  StorageBackend,
} from "../../src/core/types.js";
import type {
  CommunitySummaryRow,
  CommunitySummaryStorage,
  GraphRanker,
  Neo4jArmStorage,
  RetrieveConfig,
} from "../../src/core/retrieval/types.js";

const NOW = "2026-08-28T00:00:00.000Z";

const BASE_CONFIG: RetrieveConfig = {
  preset: "balanced",
  w_vec: 1,
  w_bm25: 1,
  w_graph: 1,
  bm25Enabled: false,
  graphEnabled: false,
  rerankEnabled: false,
  entityLinkTopK: 8,
  candidateCap: 50,
  neighborWidth: 0,
  graphArmFloor: 3,
};

class FixedEmbedder implements EmbeddingClient {
  async embed(_texts: string[]): Promise<number[][]> {
    return [[1]];
  }
}

function summaryRow(
  communityId: string,
  level: number,
  summary = `report ${communityId}`
): CommunitySummaryRow {
  return {
    id: `sum-${communityId}`,
    communityId,
    summary,
    level,
    score: 0.9,
  };
}

/**
 * Ledger double honouring the cap contract: the seam receives the request's
 * N and returns only rows at or above coarseness (level <= N), recording
 * each N it was handed.
 */
class CappedSummaryBackend implements StorageBackend {
  readonly summaryCalls: number[] = [];
  readonly searchFilterCalls: Array<SearchOptions["filters"]> = [];
  rows: CommunitySummaryRow[] = [];
  readonly communitySummaries: CommunitySummaryStorage = {
    getCommunitySummaryByCommunityId: async (communityId, maxLevel) => {
      this.summaryCalls.push(maxLevel);
      return this.rows.find(
        (row) => row.communityId === communityId && row.level <= maxLevel
      );
    },
    searchCommunitySummaries: async (_embedding, _limit, maxLevel) => {
      this.summaryCalls.push(maxLevel);
      return this.rows.filter((row) => row.level <= maxLevel);
    },
  };
  readonly neo4jArmSeed: Neo4jArmStorage = {
    seedEntitiesByEmbedding: async () => [
      { id: "entity-1", canonical_name: "Entity 1" },
      { id: "entity-2", canonical_name: "Entity 2" },
    ],
    chunksByEntityIds: async () => [
      {
        entity_id: "entity-1",
        id: "graph-1",
        content: "graph hit one",
        source_ref: "source/graph",
        valid_from: NOW,
        valid_until: null,
      },
      {
        entity_id: "entity-2",
        id: "graph-2",
        content: "graph hit two",
        source_ref: "source/graph",
        valid_from: NOW,
        valid_until: null,
      },
    ],
  };

  async upsert(_chunks: ChunkRecord[]): Promise<string[]> {
    return [];
  }

  async search(
    _embedding: number[],
    opts: SearchOptions
  ): Promise<RetrievedChunk[]> {
    this.searchFilterCalls.push(opts.filters);
    return [
      {
        id: "chunk-1",
        content: "ordinary chunk",
        source_ref: "source/1",
        valid_window: [NOW, null],
        score: 1,
      },
    ];
  }

  async close(): Promise<void> {}
}

function parseBody(result: ToolResult): {
  chunks: Array<{ id: string }>;
  degraded?: boolean;
} {
  const text = result.content[0]?.text;
  if (typeof text !== "string") {
    throw new Error("expected text content in ToolResult");
  }
  return JSON.parse(text);
}

function parseCases(): void {
  describe("parseCommunityLevelFilter", () => {
    it("resolves the default cap when filters are absent", () => {
      expect(parseCommunityLevelFilter(undefined)).toEqual({
        kind: "resolved",
        level: DEFAULT_COMMUNITY_LEVEL_CAP,
      });
      expect(DEFAULT_COMMUNITY_LEVEL_CAP).toBe(2);
    });

    it("resolves the default cap when the key is absent", () => {
      expect(parseCommunityLevelFilter({ source_ref: "docs/a.md" })).toEqual({
        kind: "resolved",
        level: DEFAULT_COMMUNITY_LEVEL_CAP,
      });
    });

    it("resolves positive integer strings to that cap", () => {
      for (const [value, level] of [
        ["1", 1],
        ["2", 2],
        ["7", 7],
      ] as const) {
        expect(
          parseCommunityLevelFilter({ [COMMUNITY_LEVEL_FILTER_KEY]: value })
        ).toEqual({ kind: "resolved", level });
      }
    });

    it("reports invalid for empty, zero, negative, non-integer and overflow", () => {
      for (const bad of ["abc", "0", "-1", "", "  ", "1.5", "2 "]) {
        expect(
          parseCommunityLevelFilter({ [COMMUNITY_LEVEL_FILTER_KEY]: bad })
        ).toEqual({ kind: "invalid", value: bad });
      }
      expect(
        parseCommunityLevelFilter({
          [COMMUNITY_LEVEL_FILTER_KEY]: "99999999999999999999",
        })
      ).toEqual({ kind: "invalid", value: "99999999999999999999" });
    });

    it("does not mutate the caller's filters", () => {
      const filters = {
        source_ref: "docs/a.md",
        [COMMUNITY_LEVEL_FILTER_KEY]: "abc",
      };
      expect(parseCommunityLevelFilter(filters)).toEqual({
        kind: "invalid",
        value: "abc",
      });
      expect(filters.source_ref).toBe("docs/a.md");
    });
  });

  describe("invalidCommunityLevelMessage", () => {
    it("carries the stable reason token, the key and the offending value", () => {
      const message = invalidCommunityLevelMessage("abc");
      expect(message).toContain(INVALID_COMMUNITY_LEVEL_REASON);
      expect(message).toContain(COMMUNITY_LEVEL_FILTER_KEY);
      expect(message).toContain("abc");
    });
  });
}

function handlerCapCases(): void {
  describe("retrieve handler cap plumbing (fake store)", () => {
    function handlerFor(storage: CappedSummaryBackend, graph = false) {
      return createRetrieveHandler({
        embedder: new FixedEmbedder(),
        storage,
        retrieveConfig: {
          ...BASE_CONFIG,
          communitySummaryEnabled: true,
          ...(graph ? { graphEnabled: true } : {}),
        },
      });
    }

    it("applies the default cap: returned summaries are all level <= 2", async () => {
      const storage = new CappedSummaryBackend();
      storage.rows = [
        summaryRow("a", 1),
        summaryRow("b", 2),
        summaryRow("c", 3),
      ];
      const body = parseBody(
        await handlerFor(storage)({ query: "q", limit: 5 })
      );
      expect(storage.summaryCalls).toContain(DEFAULT_COMMUNITY_LEVEL_CAP);
      expect(body.chunks.map((chunk) => chunk.id)).toEqual([
        "sum-a",
        "sum-b",
        "chunk-1",
      ]);
    });

    it("an explicit positive override reaches the seam as that N", async () => {
      const storage = new CappedSummaryBackend();
      storage.rows = [summaryRow("a", 1), summaryRow("c", 3)];
      const body = parseBody(
        await handlerFor(storage)({
          query: "q",
          limit: 5,
          filters: { [COMMUNITY_LEVEL_FILTER_KEY]: "3" },
        })
      );
      expect(storage.summaryCalls).toContain(3);
      expect(body.chunks.map((chunk) => chunk.id)).toEqual([
        "sum-a",
        "sum-c",
        "chunk-1",
      ]);
    });

    it("a finer-only fixture returns no summaries under the default cap", async () => {
      const storage = new CappedSummaryBackend();
      storage.rows = [summaryRow("z", 4)];
      const body = parseBody(
        await handlerFor(storage)({ query: "q", limit: 5 })
      );
      expect(body.chunks.map((chunk) => chunk.id)).toEqual(["chunk-1"]);
    });

    for (const bad of ["abc", "0", "-2", ""]) {
      it(`refuses the typed INVALID_INPUT for "${bad}" before any summary read`, async () => {
        const storage = new CappedSummaryBackend();
        storage.rows = [summaryRow("a", 1)];
        await expect(
          handlerFor(storage)({
            query: "q",
            filters: { [COMMUNITY_LEVEL_FILTER_KEY]: bad },
          })
        ).rejects.toBeInstanceOf(GraphragError);
        await expect(
          handlerFor(storage)({
            query: "q",
            filters: { [COMMUNITY_LEVEL_FILTER_KEY]: bad },
          })
        ).rejects.toMatchObject({ code: "INVALID_INPUT" });
        expect(storage.summaryCalls).toHaveLength(0);
      });
    }

    it("keeps a graph-arm-only fixture order-identical with vs without the cap path", async () => {
      const graphRanker: GraphRanker = {
        rankEntities: async () => [
          { id: "entity-1", score: 0.9 },
          { id: "entity-2", score: 0.8 },
        ],
      };
      const storage = new CappedSummaryBackend();
      const capped = await assembleRetrievalResult(
        { query: "q", validAt: NOW, limit: 3, communityLevel: 1 },
        {
          embedder: new FixedEmbedder(),
          storage,
          retrieveConfig: {
            ...BASE_CONFIG,
            graphEnabled: true,
            communitySummaryEnabled: true,
          },
          graphRanker,
        }
      );
      const noCapPath = await assembleRetrievalResult(
        { query: "q", validAt: NOW, limit: 3 },
        {
          embedder: new FixedEmbedder(),
          storage,
          retrieveConfig: {
            ...BASE_CONFIG,
            graphEnabled: true,
            communitySummaryEnabled: false,
          },
          graphRanker,
        }
      );
      expect(capped.chunks.map((chunk) => chunk.id)).toEqual(
        noCapPath.chunks.map((chunk) => chunk.id)
      );
    });
  });
}

function stripCases(): void {
  describe("stripCommunityLevelFilter (T3)", () => {
    it("passes undefined through unchanged", () => {
      expect(stripCommunityLevelFilter(undefined)).toBeUndefined();
    });

    it("returns the same object when no community_level key exists", () => {
      const filters = { source_ref: "docs/a.md", "metadata.k": "v" };
      expect(stripCommunityLevelFilter(filters)).toBe(filters);
    });

    it("removes only the community_level key", () => {
      expect(
        stripCommunityLevelFilter({
          [COMMUNITY_LEVEL_FILTER_KEY]: "3",
          source_ref: "docs/a.md",
        })
      ).toEqual({ source_ref: "docs/a.md" });
    });

    it("yields undefined when community_level was the only key", () => {
      expect(
        stripCommunityLevelFilter({ [COMMUNITY_LEVEL_FILTER_KEY]: "2" })
      ).toBeUndefined();
    });

    it("does not mutate the caller's object", () => {
      const filters = { [COMMUNITY_LEVEL_FILTER_KEY]: "2" };
      stripCommunityLevelFilter(filters);
      expect(filters).toEqual({ [COMMUNITY_LEVEL_FILTER_KEY]: "2" });
    });
  });
}

function handlerStripCases(): void {
  describe("handler strip point (T3)", () => {
    function handlerFor(storage: CappedSummaryBackend) {
      return createRetrieveHandler({
        embedder: new FixedEmbedder(),
        storage,
        retrieveConfig: {
          ...BASE_CONFIG,
          communitySummaryEnabled: true,
        },
      });
    }

    it("community_level never reaches the exact-match chunk filters", async () => {
      const storage = new CappedSummaryBackend();
      storage.rows = [summaryRow("a", 1)];
      await handlerFor(storage)({
        query: "q",
        filters: { source_ref: "docs/x.md", [COMMUNITY_LEVEL_FILTER_KEY]: "3" },
      });
      expect(storage.searchFilterCalls.length).toBeGreaterThan(0);
      for (const filters of storage.searchFilterCalls) {
        expect(filters).not.toHaveProperty(COMMUNITY_LEVEL_FILTER_KEY);
        expect(filters?.source_ref).toBe("docs/x.md");
      }
      // and the routing value still reached the summary seam as the cap
      expect(storage.summaryCalls).toContain(3);
    });

    it("a lone community_level leaves no chunk filters at all", async () => {
      const storage = new CappedSummaryBackend();
      await handlerFor(storage)({
        query: "q",
        filters: { [COMMUNITY_LEVEL_FILTER_KEY]: "2" },
      });
      for (const filters of storage.searchFilterCalls) {
        expect(filters).toBeUndefined();
      }
    });
  });
}

describe("community level cap (retrieve T2)", () => {
  parseCases();
  handlerCapCases();
  stripCases();
  handlerStripCases();
});
