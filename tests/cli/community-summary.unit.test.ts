import { describe, expect, it, vi } from "vitest";
import {
  runCli,
  runCliFromEnv,
  CommunitySummaryJobError,
  type CommunitySummaryClient,
  type CommunitySummaryDeps,
  type CommunitySummaryPool,
} from "../../src/cli/community-summary.js";
import { assembleRetrievalResult } from "../../src/core/retrieval/index.js";
import type {
  Community,
  CommunityDetector,
} from "../../src/core/graph/neo4j-community.js";
import {
  COMMUNITY_DROP_CYPHER,
  COMMUNITY_PROJECT_CYPHER,
  createCommunityDetector,
  createNeo4jCommunityDetector,
  type CypherSession,
} from "../../src/core/graph/neo4j-community.js";
import type {
  CommunitySummaryRow,
  RetrieveConfig,
} from "../../src/core/retrieval/types.js";
import type { EmbeddingClient } from "../../src/core/embedder.js";
import type {
  ChunkRecord,
  RetrievedChunk,
  SearchOptions,
  StorageBackend,
} from "../../src/core/types.js";

vi.mock("../../src/core/graph/neo4j-community.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/core/graph/neo4j-community.js")
  >("../../src/core/graph/neo4j-community.js");
  return {
    ...actual,
    createNeo4jCommunityDetector: vi.fn(actual.createNeo4jCommunityDetector),
  };
});

const COMMUNITY: Community = {
  id: "7",
  entityIds: ["11111111-1111-4111-8111-111111111111"],
};

const embedder: EmbeddingClient = {
  async embed() {
    return [[1]];
  },
};

const COMMUNITY_SUMMARY_ENV_KEYS = [
  "GRAPHRAG_MEMORY_DB_URL",
  "GRAPHRAG_MEMORY_NEO4J_URI",
  "GRAPHRAG_MEMORY_NEO4J_USER",
  "GRAPHRAG_MEMORY_NEO4J_PASSWORD",
  "GRAPHRAG_MEMORY_EMBED_DIMENSIONS",
  "GRAPHRAG_MEMORY_EMBED_BASE_URL",
  "GRAPHRAG_MEMORY_EMBED_MODEL",
  "GRAPHRAG_MEMORY_EMBED_API_KEY",
  "GRAPHRAG_MEMORY_EMBED_API_KEY_ENV",
  "GRAPHRAG_MEMORY_VECTOR_API_KEY",
  "GRAPHRAG_MEMORY_ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
] as const;

async function withMissingNeo4jEnv<T>(fn: () => Promise<T>): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const key of COMMUNITY_SUMMARY_ENV_KEYS) {
    saved.set(key, process.env[key]);
    process.env[key] = "";
  }
  process.env["GRAPHRAG_MEMORY_DB_URL"] = "postgres://localhost:5432/test";
  process.env["GRAPHRAG_MEMORY_EMBED_DIMENSIONS"] = "1536";
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function captureStderr(): { text: () => string; restore: () => void } {
  let output = "";
  const spy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: unknown) => {
      output += String(chunk);
      return true;
    });
  return { text: () => output, restore: () => spy.mockRestore() };
}

interface Query {
  text: string;
  values: unknown[];
}

class FakeClient {
  queries: Query[] = [];
  released = 0;

  constructor(public summaryRows: CommunitySummaryRow[] = []) {}

  async query(text: string, values: unknown[] = []) {
    this.queries.push({ text, values });
    if (/DELETE FROM community_summaries/.test(text)) {
      this.summaryRows = [];
      return { rows: [] };
    }
    if (/FROM entities/.test(text)) {
      const ids = values[0] as string[];
      return {
        rows: [
          {
            id: ids[0],
            canonical_name:
              ids[0] === COMMUNITY.entityIds[0] ? "Postgres" : "Other",
          },
        ],
      };
    }
    return { rows: [] };
  }

  release(): void {
    this.released += 1;
  }
}

const RETRIEVE_CONFIG: RetrieveConfig = {
  preset: "tokenmax",
  w_vec: 1,
  w_bm25: 1,
  w_graph: 1,
  bm25Enabled: false,
  graphEnabled: false,
  rerankEnabled: false,
  communitySummaryEnabled: true,
  entityLinkTopK: 8,
  candidateCap: 50,
  neighborWidth: 0,
  graphArmFloor: 3,
};

class LedgerBackedStorage implements StorageBackend {
  readonly communitySummaries = {
    searchCommunitySummaries: async () => this.client.summaryRows,
  };

  constructor(private readonly client: FakeClient) {}

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
        valid_window: ["2026-08-28T00:00:00.000Z", null],
        score: 1,
      },
    ];
  }

  async close(): Promise<void> {}
}

function deps(
  over: {
    detector?: CommunityDetector;
    summarizer?: CommunitySummaryClient;
    client?: FakeClient;
  } = {}
): {
  deps: CommunitySummaryDeps;
  client: FakeClient;
  summaries: string[];
} {
  const client = over.client ?? new FakeClient();
  const summaries: string[] = [];
  const detector = over.detector ?? {
    async detect() {
      return [COMMUNITY];
    },
    async close() {},
  };
  const summarizer = over.summarizer ?? {
    async summarize(entityNames: readonly string[]) {
      summaries.push(entityNames.join(","));
      return "Postgres storage community summary";
    },
  };
  const pool: CommunitySummaryPool = {
    async connect() {
      return client;
    },
    async end() {},
  };
  return {
    deps: {
      pool,
      detector,
      summarizer,
      embedder,
      dimensions: 1,
      logger: {
        level: "error",
        debug() {},
        info() {},
        warn() {},
        error() {},
      },
    },
    client,
    summaries,
  };
}

describe("community summary index CLI", () => {
  it("types a missing Neo4j URI as a documented skip without invoking Louvain", async () => {
    const stderr = captureStderr();
    try {
      const exitCode = await withMissingNeo4jEnv(() => runCliFromEnv([]));

      expect(exitCode).toBe(3);
      expect(stderr.text()).toContain(
        "community-summary skipped [COMMUNITY_SUMMARY_NEO4J_NOT_CONFIGURED]"
      );
      expect(stderr.text()).toContain("Louvain was not attempted");
      expect(stderr.text()).toContain("EXIT: 3");
      expect(vi.mocked(createNeo4jCommunityDetector)).not.toHaveBeenCalled();
    } finally {
      stderr.restore();
    }
  });

  it("stores one generated summary per detected community", async () => {
    const h = deps();

    await expect(runCli([], h.deps)).resolves.toBe(0);
    expect(h.summaries).toEqual(["Postgres"]);
    const write = h.client.queries.find((query) =>
      /INSERT INTO community_summaries/.test(query.text)
    );
    expect(write).toBeDefined();
    expect(write?.values).toEqual([
      expect.any(String),
      "7",
      "Postgres storage community summary",
      ["11111111-1111-4111-8111-111111111111"],
      "[1]",
    ]);
  });

  it("fails with a typed non-zero job error when GDS detection fails", async () => {
    const h = deps({
      detector: {
        async detect() {
          throw new Error("GDS unavailable");
        },
        async close() {},
      },
    });

    const failure = runCli([], h.deps);
    await expect(failure).rejects.toBeInstanceOf(
      CommunitySummaryJobError
    );
    await expect(failure).rejects.toMatchObject({
      code: "COMMUNITY_SUMMARY_JOB_FAILED",
      exitCode: 1,
      phase: "detection",
    });
    expect(
      h.client.queries.some((query) => /INSERT INTO/.test(query.text))
    ).toBe(false);
  });

  it("clears old summaries after successful empty detection so retrieval falls back", async () => {
    const client = new FakeClient([
      {
        id: "summary-7",
        communityId: "7",
        summary: "stale community summary",
        score: 0.99,
      },
    ]);
    const h = deps({
      client,
      detector: {
        async detect() {
          return [];
        },
        async close() {},
      },
    });

    await expect(runCli([], h.deps)).resolves.toBe(0);
    expect(client.summaryRows).toEqual([]);
    expect(
      client.queries.some((query) =>
        /DELETE FROM community_summaries/.test(query.text)
      )
    ).toBe(true);

    const result = await assembleRetrievalResult(
      {
        query: "storage topic",
        validAt: "2026-08-28T00:00:00.000Z",
        limit: 2,
      },
      {
        embedder,
        storage: new LedgerBackedStorage(client),
        retrieveConfig: RETRIEVE_CONFIG,
      }
    );
    expect(result.chunks.map((chunk) => chunk.id)).toEqual(["chunk-1"]);
  });

  it("clears old summaries when the Neo4j projection has no Entity rows", async () => {
    const oldRows: CommunitySummaryRow[] = [
      {
        id: "summary-7",
        communityId: "7",
        summary: "stale community summary",
        score: 0.99,
      },
    ];
    const client = new FakeClient(oldRows);
    const session: CypherSession = {
      async run(cypher) {
        if (cypher === COMMUNITY_PROJECT_CYPHER) return [];
        if (cypher === COMMUNITY_DROP_CYPHER) return [];
        throw new Error("Louvain should not run for an empty projection");
      },
      async close() {},
    };
    const h = deps({
      client,
      detector: createCommunityDetector(session),
    });

    await expect(runCli([], h.deps)).resolves.toBe(0);
    expect(client.summaryRows).toEqual([]);
    expect(
      client.queries.some((query) =>
        /DELETE FROM community_summaries/.test(query.text)
      )
    ).toBe(true);
  });

  it("preserves old summaries when community detection fails", async () => {
    const oldRows: CommunitySummaryRow[] = [
      {
        id: "summary-7",
        communityId: "7",
        summary: "stale community summary",
        score: 0.99,
      },
    ];
    const client = new FakeClient(oldRows);
    const h = deps({
      client,
      detector: {
        async detect() {
          throw new Error("GDS unavailable");
        },
        async close() {},
      },
    });

    await expect(runCli([], h.deps)).rejects.toMatchObject({
      code: "COMMUNITY_SUMMARY_JOB_FAILED",
      exitCode: 1,
      phase: "detection",
    });
    expect(client.summaryRows).toEqual(oldRows);
    expect(
      client.queries.some((query) =>
        /DELETE FROM community_summaries/.test(query.text)
      )
    ).toBe(false);
  });

  it("--dry-run does not bootstrap or write the schema", async () => {
    const h = deps();

    await expect(runCli(["--dry-run"], h.deps)).resolves.toBe(0);
    expect(h.client.queries).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ text: "BEGIN" })])
    );
    expect(
      h.client.queries.some((query) =>
        /CREATE TABLE|CREATE EXTENSION/.test(query.text)
      )
    ).toBe(false);
  });

  it("continues the batch but fails with a typed non-zero job error after an LLM failure", async () => {
    const h = deps({
      detector: {
        async detect() {
          return [
            COMMUNITY,
            { id: "8", entityIds: ["22222222-2222-4222-8222-222222222222"] },
          ];
        },
        async close() {},
      },
      summarizer: {
        async summarize(entityNames) {
          if (entityNames.includes("Postgres")) {
            throw new Error("LLM unavailable for this community");
          }
          return "other community";
        },
      },
    });

    await expect(runCli([], h.deps)).rejects.toMatchObject({
      code: "COMMUNITY_SUMMARY_JOB_FAILED",
      exitCode: 1,
      phase: "summary",
      communityId: "7",
    });
    expect(
      h.client.queries.filter((query) =>
        /INSERT INTO community_summaries/.test(query.text)
      )
    ).toHaveLength(1);
  });
});
