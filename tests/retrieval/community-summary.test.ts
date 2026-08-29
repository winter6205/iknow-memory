import { describe, expect, it } from "vitest";
import { assembleRetrievalResult } from "../../src/core/retrieval/index.js";
import type {
  CommunitySummaryRow,
  CommunitySummaryStorage,
  GraphRanker,
  Neo4jArmStorage,
  RetrieveConfig,
} from "../../src/core/retrieval/types.js";
import type { EmbeddingClient } from "../../src/core/embedder.js";
import type {
  ChunkRecord,
  RetrievedChunk,
  SearchOptions,
  StorageBackend,
} from "../../src/core/types.js";

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

class SummaryBackend implements StorageBackend {
  readonly communitySummaries: CommunitySummaryStorage = {
    getCommunitySummaryByCommunityId: async (communityId) =>
      this.rows.find((row) => row.communityId === communityId),
    searchCommunitySummaries: async () => this.rows,
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

  rows: CommunitySummaryRow[] = [];
  summaryError: Error | undefined;

  async upsert(_chunks: ChunkRecord[]): Promise<string[]> {
    return [];
  }

  async search(
    _embedding: number[],
    _opts: SearchOptions
  ): Promise<RetrievedChunk[]> {
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

function summaryRow(communityId: string, summary: string): CommunitySummaryRow {
  return {
    id: `community-summary:${communityId}`,
    communityId,
    summary,
    score: 0.99,
  };
}

describe("community summary retrieve path", () => {
  it("keeps non-empty graph hits ahead of summaries and honors the limit", async () => {
    const storage = new SummaryBackend();
    storage.rows = [
      summaryRow("7", "Postgres and pgvector form one storage topic."),
    ];
    const graphRanker: GraphRanker = {
      rankEntities: async () => [
        { id: "entity-1", score: 0.9 },
        { id: "entity-2", score: 0.8 },
      ],
    };

    const result = await assembleRetrievalResult(
      { query: "storage topic", validAt: NOW, limit: 3 },
      {
        embedder: new FixedEmbedder(),
        storage,
        retrieveConfig: {
          ...BASE_CONFIG,
          preset: "tokenmax",
          graphEnabled: true,
        },
        graphRanker,
      }
    );

    expect(result.chunks).toHaveLength(3);
    expect(result.chunks.map((chunk) => chunk.id)).toEqual([
      "graph-1",
      "graph-2",
      "community-summary:7",
    ]);
    expect(result.chunks[2]).toMatchObject({
      content: "Postgres and pgvector form one storage topic.",
      metadata: { kind: "community-summary", communityId: "7" },
    });
  });

  it("leads with typed summary chunks when the preset enables summaries", async () => {
    const storage = new SummaryBackend();
    storage.rows = [
      summaryRow("7", "Postgres and pgvector form one storage topic."),
    ];

    const result = await assembleRetrievalResult(
      { query: "storage topic", validAt: NOW, limit: 2 },
      {
        embedder: new FixedEmbedder(),
        storage,
        retrieveConfig: { ...BASE_CONFIG, preset: "tokenmax" },
      }
    );

    expect(result.chunks[0]).toMatchObject({
      id: "community-summary:7",
      content: "Postgres and pgvector form one storage topic.",
      metadata: { kind: "community-summary", communityId: "7" },
    });
    expect(result.chunks.map((chunk) => chunk.id)).toEqual([
      "community-summary:7",
      "chunk-1",
    ]);
  });

  it("keeps the post-T8 order when summaries are disabled or empty", async () => {
    const storage = new SummaryBackend();
    storage.rows = [summaryRow("7", "should not be returned")];

    const disabled = await assembleRetrievalResult(
      { query: "q", validAt: NOW, limit: 2 },
      {
        embedder: new FixedEmbedder(),
        storage,
        retrieveConfig: BASE_CONFIG,
      }
    );
    storage.rows = [];
    const empty = await assembleRetrievalResult(
      { query: "q", validAt: NOW, limit: 2 },
      {
        embedder: new FixedEmbedder(),
        storage,
        retrieveConfig: { ...BASE_CONFIG, communitySummaryEnabled: true },
      }
    );

    expect(disabled.chunks.map((chunk) => chunk.id)).toEqual(["chunk-1"]);
    expect(empty.chunks.map((chunk) => chunk.id)).toEqual(["chunk-1"]);
  });

  it("fails open with degraded when the summary ledger read throws", async () => {
    const storage = new SummaryBackend();
    storage.communitySummaries = {
      searchCommunitySummaries: async () => {
        throw new Error("summary ledger unavailable");
      },
    };

    const result = await assembleRetrievalResult(
      { query: "q", validAt: NOW, limit: 2 },
      {
        embedder: new FixedEmbedder(),
        storage,
        retrieveConfig: { ...BASE_CONFIG, communitySummaryEnabled: true },
      }
    );

    expect(result.chunks.map((chunk) => chunk.id)).toEqual(["chunk-1"]);
    expect(result.degraded).toBe(true);
  });
});
