/**
 * Search-mode defensive matrix (specs/search-mode-retrieve.md).
 *
 * Five boundary classes over the `filters.search_mode` dispatch seam, all
 * against pure fake seams — no live Postgres/ES/Neo4j. Format follows
 * tests/defensive/retrieval-defensive.test.ts.
 *
 * Coverage policy (the `lexical`/`global` arms already own their arm-level
 * detail):
 *   - a healthy lexical miss vs typed: tests/retrieval/mode-a-arm.test.ts
 *     ("leaves a lexical miss an un-degraded empty answer");
 *   - global ready-zero-summaries healthy miss:
 *     tests/retrieval/mode-c-arm.test.ts ("treats a ready generation with
 *     zero summaries as a healthy miss");
 *   - lexical limit-after-dedup:        mode-a-arm.test.ts (overflow class);
 *   - global report cap at limit:       mode-c-arm.test.ts (drop section);
 *   - invalid mode typed:               tests/retrieve.test.ts (T1 block);
 *   - global not-ready typed:           tests/retrieve.test.ts +
 *     mode-c-arm.test.ts readiness-gate block;
 *   - graph summary-ledger fail-open (alone): tests/retrieval/
 *     community-summary.test.ts — NOT weakened here; this file adds the
 *     graph-vs-global contrast on ONE dead-ledger backend.
 * What is NEW here: the `sql` 档's typed `real_db_not_wired` exit when no
 * ledger is provisioned (empty/corpus-full/limit variants, zero backend
 * contact, DECLARED token so the host reads it as structure), the per-档
 * isolation when every route plus single-letter rejections are in flight,
 * and the fail-open-vs-typed exception contrast. No duplicated
 * healthy-miss. The provisioned sql arm surface lives in
 * tests/retrieval/mode-d-arm.test.ts.
 */
import { describe, it, expect } from "vitest";
import { createRetrieveHandler } from "../../src/tools/retrieve.js";
import { FakeEmbedder } from "../../src/core/embedder.js";
import type { EmbeddingClient } from "../../src/core/embedder.js";
import { MemoryBackend } from "../../src/core/storage/memory-backend.js";
import { GraphragError } from "../../src/core/errors.js";
import {
  COMMUNITY_INDEX_STATUS,
  COMMUNITY_SUMMARY_INDEX_FAILURE,
} from "../../src/core/types.js";
import type { ChunkRecord, StorageBackend } from "../../src/core/types.js";
import {
  INVALID_SEARCH_MODE_REASON,
  REAL_DB_NOT_WIRED_REASON,
} from "../../src/core/retrieval/search-mode.js";
import type { RetrieveConfig } from "../../src/core/retrieval/types.js";
import type { ToolResult } from "../../src/tools/registry.js";

const TEST_DIM = 8;

/** Deterministic unit embedding — the vector arm finds it by cosine rank. */
function unitEmbedding(): number[] {
  const v = new Array<number>(TEST_DIM).fill(0);
  v[0] = 1;
  return v;
}

function chunkRecord(id: string): ChunkRecord {
  return {
    id,
    content: `content of ${id}`,
    embedding: unitEmbedding(),
    source_ref: `src/${id}`,
    metadata: {},
    valid_from: "2024-01-01T00:00:00Z",
    valid_until: null,
    created_at: "2024-01-01T00:00:00Z",
  };
}

/** Minimal wire-body view: ids + the two optional envelope members used here. */
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

/** Embedder double that counts provider calls — proves sql never embeds. */
class CountingEmbedder implements EmbeddingClient {
  readonly available = true;
  calls = 0;

  constructor(private readonly inner: EmbeddingClient) {}

  async embed(texts: string[]): Promise<number[][]> {
    this.calls += 1;
    return this.inner.embed(texts);
  }
}

/**
 * Storage proxy that records every property the dispatch touched. The `sql`
 * 档 must leave the list empty: typed before a single read, i.e. no SQL
 * (fake or real) runs over chunks on this route.
 */
function storageProbe(target: StorageBackend): {
  storage: StorageBackend;
  touched: string[];
} {
  const touched: string[] = [];
  const storage = new Proxy(target, {
    get(obj, prop, receiver) {
      if (typeof prop === "string") touched.push(prop);
      const value = Reflect.get(obj, prop, receiver);
      return typeof value === "function" ? value.bind(obj) : value;
    },
  });
  return { storage, touched };
}

/** The minimal config that turns on the graph 档's optional community-summary read. */
const SUMMARY_ON_CONFIG: RetrieveConfig = {
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
  communitySummaryEnabled: true,
};

// ======================================================================
// empty — no children / no summaries on an empty corpus
// ======================================================================

describe("search-mode empty boundary", () => {
  it("an omitted search_mode and an explicit graph answer an empty corpus identically", async () => {
    // Omission is the default route, so on an empty corpus it must look
    // exactly like the token it defaults to: a plain `{ chunks: [] }` with
    // no degradation flag and no rejection.
    const handler = createRetrieveHandler({
      embedder: new FakeEmbedder(TEST_DIM),
      storage: new MemoryBackend(TEST_DIM),
    });
    const omitted = parseBody(await handler({ query: "anything" }));
    const explicitGraph = parseBody(
      await handler({ query: "anything", filters: { search_mode: "graph" } })
    );
    expect(omitted).toEqual(explicitGraph);
    expect(omitted.chunks).toEqual([]);
    expect(omitted).not.toHaveProperty("degraded");
  });

  it("an empty corpus keeps lexical a healthy miss but sql still typed (emptiness never masks 未接)", async () => {
    // The global-side empty contrast — READY generation, zero summaries —
    // is pinned in mode-c-arm.test.ts; not re-run here. What must be pinned
    // at the seam: the `sql` refusal is a property of the 档, not of the
    // data, so a `{ chunks: [] }` success is unreachable for it on ANY
    // corpus.
    const handler = createRetrieveHandler({
      embedder: new FakeEmbedder(TEST_DIM),
      storage: new MemoryBackend(TEST_DIM),
    });
    const lexicalBody = parseBody(
      await handler({ query: "anything", filters: { search_mode: "lexical" } })
    );
    expect(lexicalBody.chunks).toEqual([]);
    expect(lexicalBody).not.toHaveProperty("degraded");
    await expect(
      handler({ query: "anything", filters: { search_mode: "sql" } })
    ).rejects.toBeInstanceOf(GraphragError);
  });
});

// ======================================================================
// negative — sql not provisioned; global not-ready / invalid mode referenced
// ======================================================================

describe("search-mode negative boundary", () => {
  // Invalid mode → typed INVALID_INPUT and global-not-ready → typed
  // community_summary_index_failure are pinned end-to-end in
  // tests/retrieve.test.ts (T1 block) — confirmed, not duplicated.

  it("sql types real_db_not_wired even when every other 档's seam could answer", async () => {
    // A full fixture: vector rows, a ready community index with a summary.
    // `sql` still exits typed when no business ledger is provisioned —
    // it cannot borrow another 档's seams to fake a document-table answer
    // (spec SC5: document tables stay on `graph`).
    const base = new MemoryBackend(TEST_DIM);
    await base.upsert([chunkRecord("b-1")]);
    await base.setCommunityIndexState({
      status: COMMUNITY_INDEX_STATUS.READY,
      failure_code: null,
    });
    const storage = Object.create(base, {
      communitySummaries: {
        enumerable: true,
        configurable: true,
        writable: true,
        value: {
          getCommunitySummaryByCommunityId: async () => undefined,
          searchCommunitySummaries: async () => [
            {
              id: "sum-1",
              communityId: "com-1",
              summary: "the one report row",
              score: 0.9,
            },
          ],
        },
      },
    }) as MemoryBackend;
    const handler = createRetrieveHandler({
      embedder: new FakeEmbedder(TEST_DIM),
      storage,
    });
    let thrown: unknown;
    try {
      await handler({ query: "anything", filters: { search_mode: "sql" } });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(GraphragError);
    const error = thrown as GraphragError;
    // Routing-time exit, the fin `named_failures` 400 class: nothing was
    // read, so this is not a storage failure. After T7 the token is
    // DECLARED, not only in the message — that is what serializes it as a
    // structured {"error": …} instead of prose (spec §7.1).
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.failureToken).toBe(REAL_DB_NOT_WIRED_REASON);
    expect(error.message).toContain(REAL_DB_NOT_WIRED_REASON);
    expect(error.message).toContain("search_mode");
  });
});

// ======================================================================
// overflow — limit behaviour across lexical/global/sql
// ======================================================================

describe("search-mode overflow boundary (limit)", () => {
  // The lexical limit-applies-after-parent-dedup and the global hard cap at
  // limit are pinned in mode-a-arm.test.ts / mode-c-arm.test.ts
  // (overflow/drop sections). The limit-DEPENDENT sql behaviour (bound
  // parameter, cap at SQL_MAX_ROWS) is pinned in
  // tests/retrieval/mode-d-arm.test.ts. What stays pinned HERE: with no
  // ledger provisioned the exit is identical at either schema bound — a
  // schema bound must not change a not-provisioned fact.
  it("sql answers identically at limit=1 and limit=100 with zero embedder and storage contact", async () => {
    for (const limit of [1, 100]) {
      const embedder = new CountingEmbedder(new FakeEmbedder(TEST_DIM));
      const { storage, touched } = storageProbe(new MemoryBackend(TEST_DIM));
      const handler = createRetrieveHandler({
        embedder,
        storage,
      });
      let thrown: unknown;
      try {
        await handler({
          query: "anything",
          filters: { search_mode: "sql" },
          limit,
        });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(GraphragError);
      expect((thrown as GraphragError).failureToken).toBe(
        REAL_DB_NOT_WIRED_REASON
      );
      expect((thrown as GraphragError).message).toContain(
        REAL_DB_NOT_WIRED_REASON
      );
      expect(embedder.calls).toBe(0);
      expect(touched).toEqual([]);
    }
  });
});

// ======================================================================
// concurrent — one handler, every route plus letter rejections in flight
// ======================================================================

describe("search-mode concurrent boundary", () => {
  it("every 档 in flight answers only its own arm; letters reject without poisoning siblings", async () => {
    const base = new MemoryBackend(TEST_DIM);
    await base.upsert([chunkRecord("b-1")]);
    await base.setCommunityIndexState({
      status: COMMUNITY_INDEX_STATUS.READY,
      failure_code: null,
    });
    const storage = Object.create(base, {
      communitySummaries: {
        enumerable: true,
        configurable: true,
        writable: true,
        value: {
          getCommunitySummaryByCommunityId: async () => undefined,
          searchCommunitySummaries: async () => [
            {
              id: "sum-1",
              communityId: "com-1",
              summary: "the one report row",
              score: 0.9,
            },
          ],
        },
      },
    }) as MemoryBackend;
    const handler = createRetrieveHandler({
      embedder: new FakeEmbedder(TEST_DIM),
      storage,
    });
    const [lexical, graph, global, sql, sqlAgain, letterB, letterC] =
      await Promise.allSettled([
        handler({ query: "anything", filters: { search_mode: "lexical" } }),
        handler({ query: "anything", filters: { search_mode: "graph" } }),
        handler({
          query: "anything",
          filters: { search_mode: "global", c_drop_windows: "0" },
        }),
        handler({ query: "anything", filters: { search_mode: "sql" } }),
        handler({ query: "anything", filters: { search_mode: "sql" } }),
        handler({ query: "anything", filters: { search_mode: "B" } }),
        handler({ query: "anything", filters: { search_mode: "C" } }),
      ]);

    expect(lexical.status).toBe("fulfilled");
    expect(graph.status).toBe("fulfilled");
    expect(global.status).toBe("fulfilled");
    if (
      lexical.status !== "fulfilled" ||
      graph.status !== "fulfilled" ||
      global.status !== "fulfilled"
    )
      throw new Error("unexpected rejection in concurrent batch");

    // Each 档 cites only its own artifact; no answer crosses.
    expect(parseBody(lexical.value).chunks.map((chunk) => chunk.id)).toEqual(
      []
    );
    expect(parseBody(graph.value).chunks.map((chunk) => chunk.id)).toEqual([
      "b-1",
    ]);
    expect(parseBody(global.value).chunks.map((chunk) => chunk.id)).toEqual([
      "sum-1",
    ]);
    // `sql` rejects — twice, the same typed way: the not-provisioned exit
    // is stateless and never poisons the concurrent siblings.
    for (const attempt of [sql, sqlAgain]) {
      expect(attempt.status).toBe("rejected");
      const reason = (attempt as PromiseRejectedResult).reason as GraphragError;
      expect(reason).toBeInstanceOf(GraphragError);
      expect(reason.failureToken).toBe(REAL_DB_NOT_WIRED_REASON);
      expect(reason.message).toContain(REAL_DB_NOT_WIRED_REASON);
    }
    // A single letter rejects the same isolated way, typed invalid with its
    // own stable token, never borrowing a neighbouring 档's route.
    for (const attempt of [letterB, letterC]) {
      expect(attempt.status).toBe("rejected");
      const reason = (attempt as PromiseRejectedResult).reason as GraphragError;
      expect(reason).toBeInstanceOf(GraphragError);
      expect(reason.code).toBe("INVALID_INPUT");
      expect(reason.message).toContain(INVALID_SEARCH_MODE_REASON);
    }
  });
});

// ======================================================================
// exception — fail-open (graph) vs typed (global) on ONE dead-ledger backend
// ======================================================================

describe("search-mode exception boundary", () => {
  it("every community read throwing keeps graph fail-open but global and sql typed, each with its own token", async () => {
    // The contrast the spec pins (specs/retrieve-community.md read
    // fail-open vs specs/search-mode-retrieve.md global must not look like
    // a healthy miss). The graph-side alone stays covered by
    // tests/retrieval/community-summary.test.ts; here it must HOLD while
    // the same backend makes global type out.
    const base = new MemoryBackend(TEST_DIM);
    await base.upsert([chunkRecord("b-1")]);
    const storage = Object.create(base, {
      communitySummaries: {
        enumerable: true,
        configurable: true,
        writable: true,
        value: {
          getCommunitySummaryByCommunityId: async () => {
            throw new Error("summary ledger down");
          },
          searchCommunitySummaries: async () => {
            throw new Error("summary ledger down");
          },
        },
      },
      getCommunityIndexState: {
        enumerable: true,
        configurable: true,
        writable: true,
        value: async () => {
          throw new Error("state read down");
        },
      },
    }) as MemoryBackend;
    const handler = createRetrieveHandler({
      embedder: new FakeEmbedder(TEST_DIM),
      storage,
      retrieveConfig: SUMMARY_ON_CONFIG,
    });

    // graph: the ledger throw costs the optional summary arm only — the
    // vector rows still answer, marked degraded, never a rejection.
    const graphBody = parseBody(await handler({ query: "anything" }));
    expect(graphBody.chunks.map((chunk) => chunk.id)).toEqual(["b-1"]);
    expect(graphBody.degraded).toBe(true);

    // global: the same broken backend is the TYPED readiness failure, not a
    // degraded envelope and not an empty answer.
    let thrownGlobal: unknown;
    try {
      await handler({ query: "anything", filters: { search_mode: "global" } });
    } catch (err) {
      thrownGlobal = err;
    }
    expect(thrownGlobal).toBeInstanceOf(GraphragError);
    expect((thrownGlobal as GraphragError).message).toContain(
      COMMUNITY_SUMMARY_INDEX_FAILURE
    );

    // sql: typed not-provisioned — a THIRD distinct fact on the same
    // backend, and its message never borrows global's token.
    let thrownSql: unknown;
    try {
      await handler({ query: "anything", filters: { search_mode: "sql" } });
    } catch (err) {
      thrownSql = err;
    }
    expect(thrownSql).toBeInstanceOf(GraphragError);
    const sqlError = thrownSql as GraphragError;
    expect(sqlError.failureToken).toBe(REAL_DB_NOT_WIRED_REASON);
    const sqlMessage = sqlError.message;
    expect(sqlMessage).toContain(REAL_DB_NOT_WIRED_REASON);
    expect(sqlMessage).not.toContain(COMMUNITY_SUMMARY_INDEX_FAILURE);
  });
});
