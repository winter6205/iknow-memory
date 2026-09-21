/**
 * community-summary CLI (graph-index-standard-fast T5).
 *
 * The job is ALL-OR-NOTHING: every detected community is summarized into an
 * in-memory generation FIRST; any empty/error result fails the whole job
 * with a typed error and leaves the ledger untouched. Only a fully generated
 * set is swapped into `community_summaries` inside ONE transaction
 * (BEGIN → DELETE → INSERT* → C-ready state → COMMIT), so a re-run replaces
 * the previous generation atomically — no reader ever sees a mixed state.
 *
 * The C-ready state (`community_index_state`) is the persisted 就绪 fact the
 * search-mode retrieve spec consumes as `community_summary_index_failure`;
 * a job failure moves it off `ready`, the swap moves it to `ready` in the
 * same transaction as the new rows.
 *
 * FakeClient below models MVCC for a single connection: writes inside an
 * open transaction are staged and only published on COMMIT; `readSummaryRows`
 * is the concurrent-reader view and never observes staged rows.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { COMMUNITY_SUMMARY_INDEX_FAILURE } from "../../src/core/types.js";
import type { EmbeddingClient } from "../../src/core/embedder.js";
import { GraphragError } from "../../src/core/errors.js";
import { setSettingHomeForTests } from "../../src/config.js";
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

const ENTITY_A = "11111111-1111-4111-8111-111111111111";
const ENTITY_B = "22222222-2222-4222-8222-222222222222";

const COMMUNITY: Community = { id: "7", entityIds: [ENTITY_A], level: 1 };
const COMMUNITY_B: Community = { id: "8", entityIds: [ENTITY_B], level: 1 };

const ANN_MAX_DIMENSIONS_VAR = "GRAPHRAG_MEMORY_PGVECTOR_ANN_MAX_DIMENSIONS";
const savedAnnMaxDimensions = process.env[ANN_MAX_DIMENSIONS_VAR];

beforeAll(() => {
  process.env[ANN_MAX_DIMENSIONS_VAR] = "2000";
});

afterAll(() => {
  if (savedAnnMaxDimensions === undefined)
    delete process.env[ANN_MAX_DIMENSIONS_VAR];
  else process.env[ANN_MAX_DIMENSIONS_VAR] = savedAnnMaxDimensions;
});

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
  // ADR-0006 / ADR-0007 fail-start knobs: the scrubbed baseline has no
  // Neo4j URI, rerank URL, or ES address, so the default-on switches must
  // be explicitly off or loadEnv refuses to boot before the CLI's own skip
  // path can run.
  "GRAPHRAG_MEMORY_RETRIEVAL_GRAPH_ENABLED",
  "GRAPHRAG_MEMORY_RETRIEVAL_RERANK_ENABLED",
  "GRAPHRAG_MEMORY_RETRIEVAL_RERANK_URL",
  "GRAPHRAG_MEMORY_RETRIEVAL_BM25_ENABLED",
  "GRAPHRAG_MEMORY_EMBED_DIMENSIONS",
  "GRAPHRAG_MEMORY_PGVECTOR_ANN_MAX_DIMENSIONS",
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
  process.env["GRAPHRAG_MEMORY_PGVECTOR_ANN_MAX_DIMENSIONS"] = "2000";
  // ADR-0006 / ADR-0007: this suite types a MISSING Neo4j block as the
  // CLI's own documented skip (exit 3), which is only reachable with the
  // graph switch explicitly off; default-on now refuses to boot (exit 1).
  // The community-summary CLI never runs the lexical arm, so it takes the
  // same explicit-off escape hatch for the precision layer.
  process.env["GRAPHRAG_MEMORY_RETRIEVAL_GRAPH_ENABLED"] = "false";
  process.env["GRAPHRAG_MEMORY_RETRIEVAL_RERANK_ENABLED"] = "false";
  process.env["GRAPHRAG_MEMORY_RETRIEVAL_BM25_ENABLED"] = "false";
  const settingHome = mkdtempSync(join(tmpdir(), "iknow-community-setting-"));
  setSettingHomeForTests(settingHome);
  try {
    return await fn();
  } finally {
    setSettingHomeForTests(null);
    rmSync(settingHome, { recursive: true, force: true });
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

/**
 * The swap's whole-table DELETE, exactly as swapCommunitySummaries emits it.
 * Anchored so the bootstrap's forward-compat
 * `DELETE FROM community_summaries WHERE level IS NULL RETURNING id`
 * (run over the same FakeClient by upSchemaBootstrap) is not miscounted.
 */
const SWAP_DELETE_RE = /^\s*DELETE FROM community_summaries\s*$/i;

interface FakeSummaryRow {
  community_id: string;
  summary: string;
  entity_ids: string[];
  level: number;
  embedding: string;
}

interface FakeStateRow {
  status: string;
  failure_code: string | null;
}

/**
 * Transactional fake ledger (single connection). `query` mirrors the CLI's
 * statements; COMMIT publishes staged writes, ROLLBACK discards them, and
 * `readSummaryRows` is the concurrent-reader view that never observes an
 * open transaction's staged generation — the Fake-level proof of the
 * atomic-swap rebuild.
 */
class FakeClient {
  queries: Query[] = [];
  released = 0;
  inTransaction = false;
  /** Optional hook fired while the swap transaction is open. */
  onSwapInsert?: (row: FakeSummaryRow) => void;
  /** When set, an INSERT INTO community_summaries with this id throws. */
  failSwapInsertId?: string;

  private committed: FakeSummaryRow[];
  private pendingDelete = false;
  private pendingInserts: FakeSummaryRow[] = [];
  private pendingState: FakeStateRow | null = null;
  private publishedState: FakeStateRow | null = null;

  constructor(initial: FakeSummaryRow[] = []) {
    this.committed = [...initial];
  }

  readSummaryRows(): FakeSummaryRow[] {
    return [...this.committed];
  }

  readState(): FakeStateRow | null {
    return this.publishedState;
  }

  async query(text: string, values: unknown[] = []) {
    this.queries.push({ text, values });
    if (/^\s*BEGIN\s*$/i.test(text)) {
      this.inTransaction = true;
      this.pendingDelete = false;
      this.pendingInserts = [];
      this.pendingState = null;
      return { rows: [] };
    }
    if (/^\s*COMMIT\s*$/i.test(text)) {
      if (this.pendingDelete) this.committed = [];
      this.committed.push(...this.pendingInserts);
      if (this.pendingState !== null) this.publishedState = this.pendingState;
      this.inTransaction = false;
      this.pendingDelete = false;
      this.pendingInserts = [];
      this.pendingState = null;
      return { rows: [] };
    }
    if (/^\s*ROLLBACK\s*$/i.test(text)) {
      this.inTransaction = false;
      this.pendingDelete = false;
      this.pendingInserts = [];
      this.pendingState = null;
      return { rows: [] };
    }
    if (/INSERT INTO community_summaries/.test(text)) {
      const row = {
        community_id: String(values[1]),
        summary: String(values[2]),
        entity_ids: values[3] as string[],
        level: Number(values[4]),
        embedding: String(values[5]),
      };
      if (this.inTransaction) this.onSwapInsert?.(row);
      if (this.failSwapInsertId === row.community_id) {
        throw new Error(`simulated write conflict on ${row.community_id}`);
      }
      if (this.inTransaction) this.pendingInserts.push(row);
      else this.committed.push(row);
      return { rows: [] };
    }
    if (SWAP_DELETE_RE.test(text)) {
      if (this.inTransaction) this.pendingDelete = true;
      else this.committed = [];
      return { rows: [] };
    }
    if (/INSERT INTO community_index_state/.test(text)) {
      const state = {
        status: String(values[0]),
        failure_code:
          values[1] === null || values[1] === undefined
            ? null
            : String(values[1]),
      };
      if (this.inTransaction) this.pendingState = state;
      else this.publishedState = state;
      return { rows: [] };
    }
    if (/FROM entities/.test(text)) {
      const ids = values[0] as string[];
      return {
        rows: ids
          .filter((id) => id === ENTITY_A || id === ENTITY_B)
          .map((id) => ({
            canonical_name: id === ENTITY_A ? "Postgres" : "Other",
          })),
      };
    }
    return { rows: [] };
  }

  release(): void {
    this.released += 1;
  }
}

function oldGeneration(): FakeSummaryRow[] {
  return [
    {
      community_id: "99",
      summary: "stale community summary",
      entity_ids: [ENTITY_A],
      level: 1,
      embedding: "[1]",
    },
  ];
}

/** Tag the ledger/state-relevant statements so transaction order is assertable. */
function tagged(client: FakeClient): string[] {
  const tags: string[] = [];
  for (const { text, values } of client.queries) {
    if (/^\s*BEGIN\s*$/i.test(text)) tags.push("BEGIN");
    else if (/^\s*COMMIT\s*$/i.test(text)) tags.push("COMMIT");
    else if (/^\s*ROLLBACK\s*$/i.test(text)) tags.push("ROLLBACK");
    else if (SWAP_DELETE_RE.test(text)) tags.push("DELETE");
    else if (/INSERT INTO community_summaries/.test(text))
      tags.push(`INSERT(${values[1]})`);
    else if (/INSERT INTO community_index_state/.test(text))
      tags.push(`STATE(${values[0]},${values[1] ?? "null"})`);
  }
  return tags;
}

/**
 * The swap window: from the BEGIN that precedes the ledger DELETE to the
 * first transaction-ending statement (COMMIT/ROLLBACK) after it. Bootstrap
 * runs its own BEGIN/COMMIT earlier, so anchoring on DELETE isolates the
 * swap.
 */
function swapWindow(client: FakeClient): string[] {
  const tags = tagged(client);
  const deleteIdx = tags.indexOf("DELETE");
  if (deleteIdx === -1) return [];
  const beginIdx = tags.lastIndexOf("BEGIN", deleteIdx);
  const endIdx = tags.findIndex(
    (tag, i) => i > deleteIdx && (tag === "COMMIT" || tag === "ROLLBACK")
  );
  return tags.slice(beginIdx, endIdx === -1 ? undefined : endIdx + 1);
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
    searchCommunitySummaries: async (): Promise<CommunitySummaryRow[]> =>
      this.client.readSummaryRows().map((row, index) => ({
        id: `summary-${row.community_id}`,
        communityId: row.community_id,
        summary: row.summary,
        score: 1 - index * 0.01,
      })),
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
    embedder?: EmbeddingClient;
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
      embedder: over.embedder ?? embedder,
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
  it("types a missing Neo4j URI as a documented skip without invoking Leiden", async () => {
    const stderr = captureStderr();
    try {
      const exitCode = await withMissingNeo4jEnv(() => runCliFromEnv([]));

      expect(exitCode).toBe(3);
      expect(stderr.text()).toContain(
        "community-summary skipped [COMMUNITY_SUMMARY_NEO4J_NOT_CONFIGURED]"
      );
      expect(stderr.text()).toContain("Leiden was not attempted");
      expect(stderr.text()).toContain("EXIT: 3");
      expect(vi.mocked(createNeo4jCommunityDetector)).not.toHaveBeenCalled();
    } finally {
      stderr.restore();
    }
  });

  it("swaps the whole generation in one transaction and marks C ready", async () => {
    const h = deps();

    await expect(runCli([], h.deps)).resolves.toBe(0);
    expect(h.summaries).toEqual(["Postgres"]);
    expect(h.client.readSummaryRows()).toEqual([
      {
        community_id: "7",
        summary: "Postgres storage community summary",
        entity_ids: [ENTITY_A],
        level: 1,
        embedding: "[1]",
      },
    ]);
    // The swap is one atomic unit: BEGIN first, DELETE before any INSERT,
    // the ready-state row written INSIDE the same transaction, then COMMIT.
    expect(swapWindow(h.client)).toEqual([
      "BEGIN",
      "DELETE",
      "INSERT(7)",
      "STATE(ready,null)",
      "COMMIT",
    ]);
    expect(h.client.inTransaction).toBe(false);
    expect(h.client.readState()).toEqual({
      status: "ready",
      failure_code: null,
    });
  });

  it("mid-swap readers still see the previous generation only", async () => {
    const client = new FakeClient(oldGeneration());
    const midSwap: string[][] = [];
    client.onSwapInsert = (row) => {
      midSwap.push(client.readSummaryRows().map((r) => r.community_id));
      void row;
    };
    const h = deps({
      client,
      detector: {
        async detect() {
          return [COMMUNITY, COMMUNITY_B];
        },
        async close() {},
      },
    });

    await expect(runCli([], h.deps)).resolves.toBe(0);
    // Every insert of the swap ran with the old generation still the only
    // visible one — no half-old/half-new window.
    expect(midSwap).toEqual([["99"], ["99"]]);
    expect(client.readSummaryRows().map((r) => r.community_id)).toEqual([
      "7",
      "8",
    ]);
  });

  it("replaces the previous generation completely on re-run (rebuild)", async () => {
    const client = new FakeClient(oldGeneration());
    const h = deps({ client });

    await expect(runCli([], h.deps)).resolves.toBe(0);
    await expect(runCli([], h.deps)).resolves.toBe(0);

    expect(client.readSummaryRows()).toEqual([
      {
        community_id: "7",
        summary: "Postgres storage community summary",
        entity_ids: [ENTITY_A],
        level: 1,
        embedding: "[1]",
      },
    ]);
    expect(
      client.queries.filter((query) => SWAP_DELETE_RE.test(query.text))
    ).toHaveLength(2);
  });

  it("fails with a typed non-zero job error when GDS detection fails", async () => {
    const client = new FakeClient(oldGeneration());
    const h = deps({
      client,
      detector: {
        async detect() {
          throw new Error("GDS unavailable");
        },
        async close() {},
      },
    });

    const failure = runCli([], h.deps);
    await expect(failure).rejects.toBeInstanceOf(CommunitySummaryJobError);
    await expect(failure).rejects.toMatchObject({
      code: "COMMUNITY_SUMMARY_JOB_FAILED",
      exitCode: 1,
      phase: "detection",
    });
    expect(
      client.queries.some((query) =>
        /INSERT INTO community_summaries/.test(query.text)
      )
    ).toBe(false);
    // C is not ready after a failed job, while the ledger rows stay.
    expect(client.readState()).toEqual({
      status: "failed",
      failure_code: COMMUNITY_SUMMARY_INDEX_FAILURE,
    });
    expect(client.readSummaryRows().map((r) => r.community_id)).toEqual(["99"]);
  });

  it("an LLM exception mid-generation leaves the ledger unchanged and C not ready", async () => {
    const client = new FakeClient(oldGeneration());
    const h = deps({
      client,
      detector: {
        async detect() {
          return [COMMUNITY, COMMUNITY_B];
        },
        async close() {},
      },
      summarizer: {
        async summarize(entityNames) {
          if (entityNames.includes("Other")) {
            throw new Error("LLM unavailable for this community");
          }
          return "fine summary";
        },
      },
    });

    await expect(runCli([], h.deps)).rejects.toMatchObject({
      code: "COMMUNITY_SUMMARY_JOB_FAILED",
      exitCode: 1,
      phase: "summary",
      communityId: "8",
    });
    // All-or-nothing: the first community's success is NOT persisted either.
    expect(client.readSummaryRows()).toEqual(oldGeneration());
    expect(swapWindow(client)).toEqual([]);
    expect(client.readState()).toEqual({
      status: "failed",
      failure_code: COMMUNITY_SUMMARY_INDEX_FAILURE,
    });
  });

  it("an empty summary fails the job without touching the ledger", async () => {
    const client = new FakeClient(oldGeneration());
    const h = deps({
      client,
      summarizer: {
        async summarize() {
          return "   ";
        },
      },
    });

    await expect(runCli([], h.deps)).rejects.toMatchObject({
      code: "COMMUNITY_SUMMARY_JOB_FAILED",
      exitCode: 1,
      phase: "summary",
      communityId: "7",
    });
    expect(client.readSummaryRows()).toEqual(oldGeneration());
    expect(client.readState()).toEqual({
      status: "failed",
      failure_code: COMMUNITY_SUMMARY_INDEX_FAILURE,
    });
  });

  it("a failed swap transaction rolls back and keeps the old generation", async () => {
    const client = new FakeClient(oldGeneration());
    client.failSwapInsertId = "8";
    const h = deps({
      client,
      detector: {
        async detect() {
          return [COMMUNITY, COMMUNITY_B];
        },
        async close() {},
      },
    });

    await expect(runCli([], h.deps)).rejects.toMatchObject({
      code: "COMMUNITY_SUMMARY_JOB_FAILED",
      exitCode: 1,
      phase: "persist",
    });
    // The failing INSERT(8) is still a recorded statement — real PG logs a
    // statement that errors — but ROLLBACK publishes none of the swap.
    expect(swapWindow(client)).toEqual([
      "BEGIN",
      "DELETE",
      "INSERT(7)",
      "INSERT(8)",
      "ROLLBACK",
    ]);
    expect(client.readSummaryRows()).toEqual(oldGeneration());
    expect(client.readState()).toEqual({
      status: "failed",
      failure_code: COMMUNITY_SUMMARY_INDEX_FAILURE,
    });
  });

  it("rejects a detector output with duplicate community ids before any write", async () => {
    const client = new FakeClient(oldGeneration());
    const h = deps({
      client,
      detector: {
        async detect() {
          return [COMMUNITY, { id: "7", entityIds: [ENTITY_B], level: 2 }];
        },
        async close() {},
      },
    });

    await expect(runCli([], h.deps)).rejects.toMatchObject({
      code: "COMMUNITY_SUMMARY_JOB_FAILED",
      exitCode: 1,
      phase: "detection",
    });
    // No summary-ledger write at all; only the in-progress/failed C-state
    // transitions (community_index_state) were touched.
    expect(
      client.queries.some((query) =>
        /INSERT INTO community_summaries/.test(query.text)
      )
    ).toBe(false);
    expect(client.readSummaryRows()).toEqual(oldGeneration());
    expect(client.readState()).toEqual({
      status: "failed",
      failure_code: COMMUNITY_SUMMARY_INDEX_FAILURE,
    });
  });

  it("persists summaries for every hierarchical Leiden level", async () => {
    const h = deps({
      detector: {
        async detect() {
          return [
            COMMUNITY,
            { id: "12", entityIds: [ENTITY_A, ENTITY_B], level: 2 },
          ];
        },
        async close() {},
      },
    });

    await expect(runCli([], h.deps)).resolves.toBe(0);
    expect(h.client.readSummaryRows().map((row) => row.community_id)).toEqual([
      "7",
      "12",
    ]);
    expect(swapWindow(h.client)).toEqual([
      "BEGIN",
      "DELETE",
      "INSERT(7)",
      "INSERT(12)",
      "STATE(ready,null)",
      "COMMIT",
    ]);
  });

  // community-level T1: the detector numbers 1 = finest; the ledger column
  // uses the PRODUCT scale where a LARGER integer = FINER community, so the
  // renumber happens at persist (specs/community-level.md assumption 1).
  it("stores the finest detector community with a LARGER level than its coarser siblings", async () => {
    const h = deps({
      detector: {
        async detect() {
          return [
            { id: "7", entityIds: [ENTITY_A], level: 1 },
            { id: "12", entityIds: [ENTITY_A, ENTITY_B], level: 2 },
            { id: "20", entityIds: [ENTITY_A, ENTITY_B], level: 3 },
          ];
        },
        async close() {},
      },
    });

    await expect(runCli([], h.deps)).resolves.toBe(0);
    const levelById = Object.fromEntries(
      h.client
        .readSummaryRows()
        .map((row) => [row.community_id, row.level] as const)
    );
    expect(levelById).toEqual({ "7": 3, "12": 2, "20": 1 });
  });

  it("the swap INSERT names level and binds it at position 5", async () => {
    const h = deps({
      detector: {
        async detect() {
          return [
            { id: "7", entityIds: [ENTITY_A], level: 1 },
            { id: "12", entityIds: [ENTITY_A, ENTITY_B], level: 2 },
          ];
        },
        async close() {},
      },
    });

    await expect(runCli([], h.deps)).resolves.toBe(0);
    const inserts = h.client.queries.filter((query) =>
      /INSERT INTO community_summaries/.test(query.text)
    );
    expect(inserts).toHaveLength(2);
    expect(inserts[0]!.text).toMatch(
      /\(id, community_id, summary, entity_ids, level,/
    );
    expect(inserts[0]!.text).toMatch(/VALUES \(\$1, \$2, \$3, \$4, \$5/);
    expect(inserts[0]!.values[4]).toBe(2);
    expect(inserts[1]!.values[4]).toBe(1);
  });

  it("persists a community without a detector level as the coarsest (product level 1)", async () => {
    const h = deps({
      detector: {
        async detect() {
          return [
            { id: "7", entityIds: [ENTITY_A], level: 1 },
            { id: "12", entityIds: [ENTITY_A, ENTITY_B], level: 2 },
            { id: "8", entityIds: [ENTITY_B] },
          ];
        },
        async close() {},
      },
    });

    await expect(runCli([], h.deps)).resolves.toBe(0);
    const levelById = Object.fromEntries(
      h.client
        .readSummaryRows()
        .map((row) => [row.community_id, row.level] as const)
    );
    // A level-less Community cannot claim a finer grain than the run's
    // coarsest, so it shares product level 1 with the coarsest sibling.
    expect(levelById).toEqual({ "7": 2, "12": 1, "8": 1 });
  });

  it("skips a community whose entities are all retired without failing the job", async () => {
    const h = deps({
      detector: {
        async detect() {
          return [
            COMMUNITY,
            { id: "8", entityIds: ["33333333-3333-4333-8333-333333333333"] },
          ];
        },
        async close() {},
      },
    });

    await expect(runCli([], h.deps)).resolves.toBe(0);
    expect(h.client.readSummaryRows().map((row) => row.community_id)).toEqual([
      "7",
    ]);
    expect(h.client.readState()).toEqual({
      status: "ready",
      failure_code: null,
    });
  });

  it("clears old summaries after successful empty detection so retrieval falls back", async () => {
    const client = new FakeClient(oldGeneration());
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
    expect(client.readSummaryRows()).toEqual([]);
    expect(swapWindow(client)).toEqual([
      "BEGIN",
      "DELETE",
      "STATE(ready,null)",
      "COMMIT",
    ]);

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
    const client = new FakeClient(oldGeneration());
    const session: CypherSession = {
      async run(cypher) {
        if (cypher === COMMUNITY_PROJECT_CYPHER) return [];
        if (cypher === COMMUNITY_DROP_CYPHER) return [];
        throw new Error("Leiden should not run for an empty projection");
      },
      async close() {},
    };
    const h = deps({
      client,
      detector: createCommunityDetector(session),
    });

    await expect(runCli([], h.deps)).resolves.toBe(0);
    expect(client.readSummaryRows()).toEqual([]);
    expect(
      client.queries.some((query) => SWAP_DELETE_RE.test(query.text))
    ).toBe(true);
  });

  it("preserves old summaries when community detection fails", async () => {
    const client = new FakeClient(oldGeneration());
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
    expect(client.readSummaryRows()).toEqual(oldGeneration());
    expect(
      client.queries.some((query) => SWAP_DELETE_RE.test(query.text))
    ).toBe(false);
  });

  it("--dry-run does not bootstrap, write the schema, or touch C state", async () => {
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
    expect(
      h.client.queries.some((query) => /INSERT INTO/.test(query.text))
    ).toBe(false);
    expect(h.client.readState()).toBeNull();
  });

  // ─── T6: the community-summary embedding class ────────────────────────
  //
  // ADR 0058 class 3: the summary TEXT is embedded at index time inside the
  // rebuild, one vector per community, and the swap INSERT carries exactly
  // that vector — never a re-embed at query time (retrieve only compares the
  // QUERY vector against the stored one). Failure posture is the T5
  // all-or-nothing one: an embedder error is a typed summary-phase job fail
  // with C not-ready, NOT the sealed per-node skip the entity-description
  // class (T6/enrich) takes.

  it("embeds each community's trimmed summary exactly once and stores that vector", async () => {
    const calls: string[][] = [];
    const recording: EmbeddingClient = {
      async embed(texts: string[]) {
        calls.push([...texts]);
        return texts.map(() => [0.5]);
      },
    };
    const h = deps({
      embedder: recording,
      summarizer: {
        async summarize() {
          return "  padded community summary  ";
        },
      },
    });

    await expect(runCli([], h.deps)).resolves.toBe(0);
    // Exact input composition: the TRIMMED summary text alone, one batched
    // call per community — two communities would be two such calls, and the
    // swap never embeds again (no double-embedding elsewhere).
    expect(calls).toEqual([["padded community summary"]]);
    expect(h.client.readSummaryRows()[0]!.embedding).toBe("[0.5]");
  });

  it("an embedder failure is a typed summary-phase fail with the previous generation intact", async () => {
    const client = new FakeClient(oldGeneration());
    const failing: EmbeddingClient = {
      async embed() {
        throw new GraphragError(
          "embedding request failed: boom",
          "EMBEDDING_FAILED"
        );
      },
    };
    const h = deps({ client, embedder: failing });

    await expect(runCli([], h.deps)).rejects.toMatchObject({
      code: "COMMUNITY_SUMMARY_JOB_FAILED",
      phase: "summary",
    });
    // All-or-nothing: nothing was swapped, the stale rows stay, and C moves
    // off ready with the fin-pinned failure token.
    expect(client.readSummaryRows()).toEqual(oldGeneration());
    expect(client.readState()).toEqual({
      status: "failed",
      failure_code: COMMUNITY_SUMMARY_INDEX_FAILURE,
    });
  });
});
