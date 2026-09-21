/**
 * Search-mode defensive matrix (plans/search-mode-retrieve.md T4).
 *
 * Five boundary classes over the `filters.search_mode` dispatch seam, all
 * against pure fake seams — no live Postgres/ES/Neo4j. Format follows
 * tests/defensive/retrieval-defensive.test.ts.
 *
 * Coverage policy (the 档 A/C arms already own their arm-level detail):
 *   - A healthy-miss vs typed:  tests/retrieval/mode-a-arm.test.ts
 *     ("leaves a lexical miss an un-degraded empty answer");
 *   - C ready-zero-summaries healthy miss: tests/retrieval/mode-c-arm.test.ts
 *     ("treats a ready generation with zero summaries as a healthy miss");
 *   - A limit-after-dedup:      mode-a-arm.test.ts (overflow class);
 *   - C report cap at limit:    mode-c-arm.test.ts (drop section);
 *   - invalid mode typed:       tests/retrieve.test.ts (T1 block);
 *   - C not-ready typed:        tests/retrieve.test.ts + mode-c-arm.test.ts
 *     readiness-gate block;
 *   - B summary-ledger fail-open (alone): tests/retrieval/
 *     community-summary.test.ts — NOT weakened here; this file adds the
 *     B-vs-C contrast on ONE dead-ledger backend.
 * What is NEW here: D's typed `real_db_not_wired` exit (empty/corpus-full/
 * limit variants, zero backend contact), the letter-vs-alias concurrency
 * isolation across every 档 in flight, and the fail-open-vs-typed exception
 * contrast. No duplicated healthy-miss.
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
import { REAL_DB_NOT_WIRED_REASON } from "../../src/core/retrieval/search-mode.js";
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

/** Embedder double that counts provider calls — proves D never embeds. */
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
 * Storage proxy that records every property the dispatch touched. D must
 * leave the list empty: typed before a single read, i.e. no SQL (fake or
 * real) runs over chunks on this 档.
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

/** The minimal config that turns on B's optional community-summary read. */
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
    const lasting = parseBody(
      await handler({ query: "anything", filters: { search_mode: "graph" } })
    );
    expect(omitted).toEqual(lasting);
    expect(omitted.chunks).toEqual([]);
    expect(omitted).not.toHaveProperty("degraded");
  });

  it("an empty corpus keeps A a healthy miss but D still typed (emptiness never masks 未接)", async () => {
    // The C-side empty contrast — READY generation, zero summaries — is
    // pinned in mode-c-arm.test.ts; not re-run here. What must be pinned
    // at the seam: D's refusal is a property of the 档, not of the data,
    // so a `{ chunks: [] }` success is unreachable for D on ANY corpus.
    const handler = createRetrieveHandler({
      embedder: new FakeEmbedder(TEST_DIM),
      storage: new MemoryBackend(TEST_DIM),
    });
    const aBody = parseBody(
      await handler({ query: "anything", filters: { search_mode: "A" } })
    );
    expect(aBody.chunks).toEqual([]);
    expect(aBody).not.toHaveProperty("degraded");
    await expect(
      handler({ query: "anything", filters: { search_mode: "D" } })
    ).rejects.toBeInstanceOf(GraphragError);
  });
});

// ======================================================================
// negative — D unwired (new); C not-ready / invalid mode referenced
// ======================================================================

describe("search-mode negative boundary", () => {
  // Invalid mode → typed INVALID_INPUT and C-not-ready → typed
  // community_summary_index_failure are pinned end-to-end in
  // tests/retrieve.test.ts (T1 block) — confirmed, not duplicated.

  it("D types real_db_not_wired even when every other 档's seam could answer", async () => {
    // A full fixture: vector rows, a ready community index with a summary.
    // D must still refuse — it cannot borrow another 档's seams to fake a
    // document-table answer (spec SC5: document tables stay B).
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
      await handler({ query: "anything", filters: { search_mode: "D" } });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(GraphragError);
    const error = thrown as GraphragError;
    // Routing-time refusal, the fin `named_failures` 400 class: nothing
    // was read, so this is not a storage failure — the stable token in
    // the message is what the host maps on through MCP isError.
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.message).toContain(REAL_DB_NOT_WIRED_REASON);
    expect(error.message).toContain("search_mode");
  });
});

// ======================================================================
// overflow — limit behaviour across A/C/D
// ======================================================================

describe("search-mode overflow boundary (limit)", () => {
  // A's limit-applies-after-parent-dedup and C's hard cap at limit are
  // pinned in mode-a-arm.test.ts / mode-c-arm.test.ts (overflow/drop
  // sections). D is limit-INDEPENDENT: it types out before any arm reads
  // the request, so the schema bounds must not change the exit.
  it("D answers identically at limit=1 and limit=100 with zero embedder and storage contact", async () => {
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
          filters: { search_mode: "D" },
          limit,
        });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(GraphragError);
      expect((thrown as GraphragError).message).toContain(
        REAL_DB_NOT_WIRED_REASON
      );
      expect(embedder.calls).toBe(0);
      expect(touched).toEqual([]);
    }
  });
});

// ======================================================================
// concurrent — one handler, four 档 in flight, no crossed answers
// ======================================================================

describe("search-mode concurrent boundary", () => {
  it("every 档 in flight at once answers only its own arm; aliases never cross; D rejects independently", async () => {
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
    const [a, b, graph, c, global, d, dAgain] = await Promise.allSettled([
      handler({ query: "anything", filters: { search_mode: "A" } }),
      handler({ query: "anything", filters: { search_mode: "B" } }),
      handler({ query: "anything", filters: { search_mode: "graph" } }),
      handler({
        query: "anything",
        filters: { search_mode: "C", c_drop_windows: "0" },
      }),
      handler({
        query: "anything",
        filters: { search_mode: "global", c_drop_windows: "0" },
      }),
      handler({ query: "anything", filters: { search_mode: "D" } }),
      handler({ query: "anything", filters: { search_mode: "D" } }),
    ]);

    expect(a.status).toBe("fulfilled");
    expect(b.status).toBe("fulfilled");
    expect(graph.status).toBe("fulfilled");
    expect(c.status).toBe("fulfilled");
    expect(global.status).toBe("fulfilled");
    if (
      a.status !== "fulfilled" ||
      b.status !== "fulfilled" ||
      graph.status !== "fulfilled" ||
      c.status !== "fulfilled" ||
      global.status !== "fulfilled"
    )
      throw new Error("unexpected rejection in concurrent batch");

    // Each 档 cites only its own artifact; no answer crosses.
    expect(parseBody(a.value).chunks.map((chunk) => chunk.id)).toEqual([]);
    expect(parseBody(b.value).chunks.map((chunk) => chunk.id)).toEqual([
      "b-1",
    ]);
    expect(parseBody(c.value).chunks.map((chunk) => chunk.id)).toEqual([
      "sum-1",
    ]);
    // The lasting token and the retired letter are the same arm: an alias may
    // not pick up a behavior of its own while a host migrates.
    expect(parseBody(graph.value)).toEqual(parseBody(b.value));
    expect(parseBody(global.value)).toEqual(parseBody(c.value));
    // D rejects — twice, the same typed way: the refusal is stateless and
    // never poisons the concurrent siblings.
    for (const attempt of [d, dAgain]) {
      expect(attempt.status).toBe("rejected");
      const reason = (attempt as PromiseRejectedResult).reason as GraphragError;
      expect(reason).toBeInstanceOf(GraphragError);
      expect(reason.message).toContain(REAL_DB_NOT_WIRED_REASON);
    }
  });
});

// ======================================================================
// exception — fail-open (B) vs typed (C) on ONE dead-ledger backend
// ======================================================================

describe("search-mode exception boundary", () => {
  it("every community read throwing keeps B fail-open but C and D typed, each with its own token", async () => {
    // The contrast the spec pins (specs/retrieve-community.md read
    // fail-open vs specs/search-mode-retrieve.md C must not look like a
    // healthy miss). The B-side alone stays covered by
    // tests/retrieval/community-summary.test.ts; here it must HOLD while
    // the same backend makes C type out.
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

    // B: the ledger throw costs the optional summary arm only — the
    // vector rows still answer, marked degraded, never a rejection.
    const bBody = parseBody(await handler({ query: "anything" }));
    expect(bBody.chunks.map((chunk) => chunk.id)).toEqual(["b-1"]);
    expect(bBody.degraded).toBe(true);

    // C: the same broken backend is the TYPED readiness failure, not a
    // degraded envelope and not an empty answer.
    let thrownC: unknown;
    try {
      await handler({ query: "anything", filters: { search_mode: "C" } });
    } catch (err) {
      thrownC = err;
    }
    expect(thrownC).toBeInstanceOf(GraphragError);
    expect((thrownC as GraphragError).message).toContain(
      COMMUNITY_SUMMARY_INDEX_FAILURE
    );

    // D: typed 未接 — a THIRD distinct fact on the same backend, and its
    // message never borrows C's token.
    let thrownD: unknown;
    try {
      await handler({ query: "anything", filters: { search_mode: "D" } });
    } catch (err) {
      thrownD = err;
    }
    expect(thrownD).toBeInstanceOf(GraphragError);
    const dMessage = (thrownD as GraphragError).message;
    expect(dMessage).toContain(REAL_DB_NOT_WIRED_REASON);
    expect(dMessage).not.toContain(COMMUNITY_SUMMARY_INDEX_FAILURE);
  });
});
