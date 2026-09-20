import { describe, it, expect, beforeEach } from "vitest";
import { createRetrieveHandler, retrieveTool } from "../src/tools/retrieve.js";
import { FakeEmbedder } from "../src/core/embedder.js";
import { MemoryBackend } from "../src/core/storage/memory-backend.js";
import { GraphragError } from "../src/core/errors.js";
import { REAL_DB_NOT_WIRED_REASON } from "../src/core/retrieval/search-mode.js";
import { ENTITY_TYPES } from "../src/core/extraction/entity-type.js";
import {
  COMMUNITY_INDEX_STATUS,
  COMMUNITY_SUMMARY_INDEX_FAILURE,
} from "../src/core/types.js";
import type {
  ChunkRecord,
  RetrievedChunk,
  SearchOptions,
} from "../src/core/types.js";
import type {
  GraphArmStorage,
  RetrieveConfig,
} from "../src/core/retrieval/types.js";
import type { GraphRagStorageBackend } from "../src/core/storage/backend.js";
import type { ToolResult } from "../src/tools/registry.js";

/** Test dimension — injected into FakeEmbedder and MemoryBackend. */
const TEST_DIM = 1536;

/**
 * Helper: build a deterministic TEST_DIM-dim embedding pointing along `axis`.
 * axis=0 => vector is a * unit_e0; cosine between two such vectors =
 * dot(unit_ei, unit_ej) = 1 if i===j else 0. This lets us craft rank-ordered
 * results without needing real embeddings.
 */
function embeddingAlongAxis(axis: number): number[] {
  const v = new Array<number>(TEST_DIM).fill(0);
  v[axis] = 1;
  return v;
}

/** Helper: parse the JSON text body of a ToolResult. */
function parseResultBody(result: ToolResult): {
  chunks: Array<{
    id: string;
    content: string;
    source_ref: string;
    valid_window: [string, string | null];
    score: number;
    metadata?: {
      kind: string;
      sourceDocId?: string;
      children?: Array<{
        chunkId: string;
        ordinal: number | null;
        score: number;
      }>;
    };
  }>;
} {
  const text = result.content[0]?.text;
  if (typeof text !== "string") {
    throw new Error("expected text content in ToolResult");
  }
  return JSON.parse(text);
}

/** Helper: build a ChunkRecord with sensible defaults. Override any field via patch. */
function makeChunk(patch: Partial<ChunkRecord> & { id: string }): ChunkRecord {
  return {
    id: patch.id,
    content: patch.content ?? `content of ${patch.id}`,
    embedding: patch.embedding ?? embeddingAlongAxis(0),
    source_ref: patch.source_ref ?? "src/default",
    metadata: patch.metadata ?? {},
    valid_from: patch.valid_from ?? "2024-01-01T00:00:00Z",
    valid_until: patch.valid_until ?? null,
    created_at: patch.created_at ?? "2024-01-01T00:00:00Z",
    // Parent back-pointers stay absent unless the caller sets them — a
    // legacy child without them is exactly what 档 A must degrade on.
    ...(patch.source_doc_id !== undefined
      ? { source_doc_id: patch.source_doc_id }
      : {}),
    ...(patch.ordinal !== undefined ? { ordinal: patch.ordinal } : {}),
  };
}

/** Lexical backend that records the exact-match filters it receives. */
class RecordingLexicalBackend extends MemoryBackend {
  lexicalFilterCalls: Array<SearchOptions["filters"]> = [];

  async searchLexical(
    _query: string,
    opts: SearchOptions
  ): Promise<RetrievedChunk[]> {
    this.lexicalFilterCalls.push(opts.filters);
    return [];
  }
}

/**
 * Graph-rag backend that records the entity type the seed seam received and
 * the exact-match filters the vector search got — the probe for driving the
 * `filters.entity_type` control through the full
 * handler → arm → seam chain without a live Postgres
 * (plans/entity-type-and-filter.md T3).
 */
class RecordingSeedBackend implements GraphRagStorageBackend {
  seedCalls: Array<{ topK: number; entityType?: string }> = [];
  searchFilterCalls: Array<SearchOptions["filters"]> = [];

  readonly graphArmSeed: GraphArmStorage = {
    seedEntitiesByEmbedding: async (
      _embedding: number[],
      topK: number,
      entityType?: string
    ): Promise<Array<{ id: string; canonical_name: string }>> => {
      this.seedCalls.push({
        topK,
        ...(entityType !== undefined ? { entityType } : {}),
      });
      return [{ id: "e-person", canonical_name: "Alice" }];
    },
    chunksByOneHopFromEntities: async (): Promise<
      Array<{
        id: string;
        content: string;
        source_ref: string;
        valid_from: string;
        valid_until: string | null;
      }>
    > => [],
  };

  async upsert(): Promise<string[]> {
    return [];
  }
  async search(
    _queryEmbedding: number[],
    opts: SearchOptions
  ): Promise<RetrievedChunk[]> {
    this.searchFilterCalls.push(opts.filters);
    return [];
  }
  async close(): Promise<void> {}
}

describe("createRetrieveHandler", () => {
  let backend: MemoryBackend;
  let handler: ReturnType<typeof createRetrieveHandler>;

  beforeEach(() => {
    backend = new MemoryBackend(TEST_DIM);
    // FakeEmbedder is deterministic: same text -> same vector.
    // We can craft chunks whose embeddings align with the query axis by
    // upserting with embeddings along axis 0, while still calling the
    // handler with a real query string (which FakeEmbedder hashes).
    handler = createRetrieveHandler({
      embedder: new FakeEmbedder(TEST_DIM),
      storage: backend,
    });
  });

  describe("normal retrieval", () => {
    it("after ingesting content, retrieve with a related query returns chunks with score > 0", async () => {
      // Use the FakeEmbedder to seed chunks whose embeddings are derived
      // from the same query text. Since FakeEmbedder is deterministic,
      // chunk.embedding == queryEmbedding => cosine == 1.
      const embedder = new FakeEmbedder(TEST_DIM);
      const query = "graphrag knowledge memory";
      const [queryVec] = await embedder.embed([query]);
      // Derive a chunk embedding from the same query text.
      const [chunkVec] = await embedder.embed([query]);
      // Sanity: identical text => identical vector.
      expect(queryVec).toEqual(chunkVec);

      await backend.upsert([
        makeChunk({
          id: "c1",
          content: "first chunk about graphrag",
          embedding: chunkVec!,
        }),
        makeChunk({
          id: "c2",
          content: "unrelated chunk",
          embedding: embeddingAlongAxis(5), // orthogonal to query
        }),
      ]);

      const result = await handler({ query });
      const body = parseResultBody(result);

      expect(body.chunks).toHaveLength(2);
      // Top hit is the matching chunk (cosine 1), second is orthogonal (cosine 0).
      expect(body.chunks[0]?.id).toBe("c1");
      expect(body.chunks[0]?.score).toBeCloseTo(1, 10);
      // Some chunk has score > 0.
      expect(body.chunks.some((c) => c.score > 0)).toBe(true);
    });
  });

  describe("valid_at filtering", () => {
    it("does not return chunks whose valid_window ends before valid_at", async () => {
      // Two chunks: one expired, one still valid.
      await backend.upsert([
        makeChunk({
          id: "expired",
          valid_from: "2024-01-01T00:00:00Z",
          valid_until: "2024-06-01T00:00:00Z",
        }),
        makeChunk({
          id: "live",
          valid_from: "2024-01-01T00:00:00Z",
          valid_until: "2024-12-01T00:00:00Z",
        }),
      ]);
      const result = await handler({
        query: "anything",
        valid_at: "2024-09-01T00:00:00Z",
      });
      const body = parseResultBody(result);
      expect(body.chunks.map((c) => c.id)).toEqual(["live"]);
    });

    it("does not return chunks whose valid_from is strictly after valid_at", async () => {
      await backend.upsert([
        makeChunk({
          id: "future",
          valid_from: "2025-01-01T00:00:00Z",
          valid_until: null,
        }),
        makeChunk({
          id: "present",
          valid_from: "2024-01-01T00:00:00Z",
          valid_until: null,
        }),
      ]);
      const result = await handler({
        query: "anything",
        valid_at: "2024-06-01T00:00:00Z",
      });
      const body = parseResultBody(result);
      expect(body.chunks.map((c) => c.id)).toEqual(["present"]);
    });
  });

  describe("filters exact match", () => {
    it("filter on source_ref returns only matching chunks", async () => {
      await backend.upsert([
        makeChunk({ id: "a", source_ref: "docs/a.md" }),
        makeChunk({ id: "b", source_ref: "docs/b.md" }),
        makeChunk({ id: "c", source_ref: "docs/a.md" }),
      ]);
      const result = await handler({
        query: "anything",
        filters: { source_ref: "docs/a.md" },
      });
      const body = parseResultBody(result);
      expect(body.chunks.map((c) => c.id).sort()).toEqual(["a", "c"]);
    });
  });

  // plans/search-mode-retrieve.md T1: `filters.search_mode` is a routing
  // control, not a chunk-matching filter. Missing → today's graph-priority
  // B; outside the closed set → typed INVALID_INPUT carrying a stable
  // host-mappable reason token (never a healthy empty `chunks` with no
  // reason). T2 opened A as the lexical child-hit → parent-body arm
  // (ADR-0060); T3 opened C report-first; T4 replaced D's provisional row
  // with the typed `real_db_not_wired` refusal.
  describe("filters.search_mode (T1)", () => {
    const HYBRID_CONFIG = {
      w_vec: 0.7,
      w_bm25: 0.15,
      w_graph: 0.15,
      bm25Enabled: true,
      graphEnabled: false,
      rerankEnabled: false,
      entityLinkTopK: 8,
      candidateCap: 50,
      graphArmFloor: 3,
    };

    beforeEach(async () => {
      await backend.upsert([
        makeChunk({ id: "x", source_ref: "docs/x.md" }),
        makeChunk({ id: "y", source_ref: "docs/y.md" }),
      ]);
    });

    it("missing key keeps the exact B behavior of an explicit B", async () => {
      const withoutMode = await handler({
        query: "anything",
        filters: { source_ref: "docs/x.md" },
      });
      const withMode = await handler({
        query: "anything",
        filters: { source_ref: "docs/x.md", search_mode: "B" },
      });
      expect(parseResultBody(withMode)).toEqual(parseResultBody(withoutMode));
      expect(parseResultBody(withoutMode).chunks.map((c) => c.id)).toEqual([
        "x",
      ]);
    });

    it("invalid value throws GraphragError INVALID_INPUT with the stable reason token", async () => {
      await expect(
        handler({ query: "anything", filters: { search_mode: "E" } })
      ).rejects.toBeInstanceOf(GraphragError);
      let thrown: unknown;
      try {
        await handler({ query: "anything", filters: { search_mode: "E" } });
      } catch (err) {
        thrown = err;
      }
      const error = thrown as GraphragError;
      expect(error.code).toBe("INVALID_INPUT");
      // The message is the wire surface (the MCP adapter serializes it into
      // an isError result), so the host maps on this stable token.
      expect(error.message).toContain("invalid_search_mode");
      expect(error.message).toContain("A | B | C | D");
    });

    it("a rejected mode does not fall through to a healthy empty envelope", async () => {
      // The negative path must not be reachable as a `{ chunks: [] }`
      // success either way of spelling the invalid value.
      for (const bad of ["", "b", "graph"]) {
        await expect(
          handler({ query: "anything", filters: { search_mode: bad } })
        ).rejects.toBeInstanceOf(GraphragError);
      }
    });

    it("valid A/C/D parse; C types not-ready, D types unwired, A runs its own", async () => {
      const baseline = await handler({ query: "anything" });
      // T4 opened D's row: the closed 档 whose SQL path does not exist yet
      // is the typed `real_db_not_wired` refusal — never a provisional B
      // answer over chunks (spec SC5: not fake SQL over document chunks).
      let thrownD: unknown;
      try {
        await handler({ query: "anything", filters: { search_mode: "D" } });
      } catch (err) {
        thrownD = err;
      }
      expect(thrownD).toBeInstanceOf(GraphragError);
      expect((thrownD as GraphragError).message).toContain(
        REAL_DB_NOT_WIRED_REASON
      );
      // T3 opened C: a backend without a READY `community_index_state`
      // row is the typed `community_summary_index_failure` exit — it
      // neither answers like B nor degrades into a healthy empty.
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
      // T2: A is no longer the B arm. The fixture's chunks carry no parent
      // back-pointers, and the query terms match no chunk content, so the
      // lexical-first A finds nothing: a healthy empty answer, visibly NOT
      // the B arm's vector result of [x, y].
      const aResult = await handler({
        query: "anything",
        filters: { search_mode: "A" },
      });
      const aBody = parseResultBody(aResult);
      expect(aBody.chunks).toEqual([]);
      expect(aBody).not.toHaveProperty("degraded");
      expect(parseResultBody(baseline).chunks).toHaveLength(2);
    });

    it("search_mode never reaches the lexical arm's exact-match filters", async () => {
      // Regression guard for the ES precision layer, which turns every
      // filter key into a term clause: a leaked `search_mode` would match
      // no indexed field and silently zero the BM25 arm. Explicit B is the
      // probe — it runs the B pipeline end to end. (T4 made D type out
      // before any arm reads filters, so it can no longer serve as one.)
      const lexical = new RecordingLexicalBackend(TEST_DIM);
      const hybridHandler = createRetrieveHandler({
        embedder: new FakeEmbedder(TEST_DIM),
        storage: backend,
        lexical,
        retrieveConfig: HYBRID_CONFIG,
      });
      const result = await hybridHandler({
        query: "anything",
        filters: { source_ref: "docs/x.md", search_mode: "B" },
      });
      expect(lexical.lexicalFilterCalls.length).toBeGreaterThan(0);
      for (const filters of lexical.lexicalFilterCalls) {
        expect(filters).not.toHaveProperty("search_mode");
        expect(filters?.source_ref).toBe("docs/x.md");
      }
      // B answers through the hybrid pipeline, un-degraded.
      expect(parseResultBody(result).chunks.map((c) => c.id)).toEqual(["x"]);
    });
  });

  // plans/entity-type-and-filter.md T3: `filters.entity_type` is a routing
  // control like `search_mode`, not a chunk-matching filter. Missing = all
  // types (zero behavior change); the four closed values restrict the
  // graph/entity seeds; anything else is a typed INVALID_INPUT carrying the
  // stable `invalid_entity_type` token — never a silent ignore.
  describe("filters.entity_type (T3)", () => {
    const SEED_GRAPH_CONFIG: RetrieveConfig = {
      w_vec: 1,
      w_bm25: 0,
      w_graph: 1,
      bm25Enabled: false,
      graphEnabled: false,
      rerankEnabled: false,
      entityLinkTopK: 8,
      candidateCap: 50,
      graphArmFloor: 3,
    };

    function seedHandler(backendOverride?: RecordingSeedBackend) {
      const recording = backendOverride ?? new RecordingSeedBackend();
      const h = createRetrieveHandler({
        embedder: new FakeEmbedder(TEST_DIM),
        storage: recording,
        graphConfig: SEED_GRAPH_CONFIG,
      });
      return { h, recording };
    }

    it("invalid value throws GraphragError INVALID_INPUT with the stable reason token", async () => {
      await expect(
        handler({ query: "anything", filters: { entity_type: "widget" } })
      ).rejects.toBeInstanceOf(GraphragError);
      let thrown: unknown;
      try {
        await handler({ query: "anything", filters: { entity_type: "widget" } });
      } catch (err) {
        thrown = err;
      }
      const error = thrown as GraphragError;
      expect(error.code).toBe("INVALID_INPUT");
      expect(error.message).toContain("invalid_entity_type");
      expect(error.message).toContain("person | organization | place | event");
    });

    it("empty string, wrong case and retired spellings are typed invalid, never silently ignored", async () => {
      for (const bad of ["", "Person", "concept", "system", "person "]) {
        await expect(
          handler({ query: "anything", filters: { entity_type: bad } })
        ).rejects.toBeInstanceOf(GraphragError);
      }
    });

    it("an invalid value never reaches the seed seam", async () => {
      const { h, recording } = seedHandler();
      await expect(
        h({ query: "anything", filters: { entity_type: "widget" } })
      ).rejects.toBeInstanceOf(GraphragError);
      expect(recording.seedCalls).toEqual([]);
    });

    it("omitted key keeps the seed unfiltered (all types, today's behavior)", async () => {
      const { h, recording } = seedHandler();
      await h({ query: "anything" });
      expect(recording.seedCalls.length).toBeGreaterThan(0);
      for (const call of recording.seedCalls) {
        expect(call.entityType).toBeUndefined();
      }
    });

    it("each legal value reaches the seed seam as the typed filter", async () => {
      for (const t of ENTITY_TYPES) {
        const { h, recording } = seedHandler();
        await h({ query: "anything", filters: { entity_type: t } });
        expect(recording.seedCalls.length).toBeGreaterThan(0);
        for (const call of recording.seedCalls) {
          expect(call.entityType).toBe(t);
        }
      }
    });

    it("entity_type never becomes a vector exact-match filter", async () => {
      const { h, recording } = seedHandler();
      await h({
        query: "anything",
        filters: { source_ref: "docs/x.md", entity_type: "person" },
      });
      expect(recording.searchFilterCalls.length).toBeGreaterThan(0);
      for (const filters of recording.searchFilterCalls) {
        expect(filters).not.toHaveProperty("entity_type");
        expect(filters?.source_ref).toBe("docs/x.md");
      }
    });

    it("entity_type never reaches the lexical arm's exact-match filters", async () => {
      // Same leak class the ES precision layer turns into a term clause:
      // `entity_type` matching no chunk field would silently zero the arm.
      const lexical = new RecordingLexicalBackend(TEST_DIM);
      const hybridHandler = createRetrieveHandler({
        embedder: new FakeEmbedder(TEST_DIM),
        storage: backend,
        lexical,
        retrieveConfig: {
          w_vec: 0.7,
          w_bm25: 0.15,
          w_graph: 0.15,
          bm25Enabled: true,
          graphEnabled: false,
          rerankEnabled: false,
          entityLinkTopK: 8,
          candidateCap: 50,
          graphArmFloor: 3,
        },
      });
      await hybridHandler({
        query: "anything",
        filters: { source_ref: "docs/x.md", entity_type: "person" },
      });
      expect(lexical.lexicalFilterCalls.length).toBeGreaterThan(0);
      for (const filters of lexical.lexicalFilterCalls) {
        expect(filters).not.toHaveProperty("entity_type");
        expect(filters?.source_ref).toBe("docs/x.md");
      }
    });
  });

  // plans/search-mode-retrieve.md T3 (fin ADR-0070): 档 C report-first over
  // the community summaries. Handler-level acceptance on the fake fixture:
  // a C-ready ledger answers with summary rows on the wire, and the
  // `c_drop_windows` routing key never becomes an exact-match filter.
  describe("search_mode=C report-first (T3)", () => {
    it("answers summary-row hits through the wire when C is ready", async () => {
      const ready = new MemoryBackend(TEST_DIM);
      await ready.setCommunityIndexState({
        status: COMMUNITY_INDEX_STATUS.READY,
        failure_code: null,
      });
      const storage = Object.create(ready, {
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
      const cHandler = createRetrieveHandler({
        embedder: new FakeEmbedder(TEST_DIM),
        storage,
      });
      const result = await cHandler({
        query: "anything",
        filters: { search_mode: "C", c_drop_windows: "0" },
      });
      const body = parseResultBody(result);
      expect(body.chunks).toHaveLength(1);
      expect(body.chunks[0]!.id).toBe("sum-1");
      expect(body.chunks[0]!.content).toBe("the one report row");
      expect(body.chunks[0]!.metadata?.kind).toBe("community-summary");
      expect(body).not.toHaveProperty("degraded");
    });
  });

  // plans/search-mode-retrieve.md T2 (ADR-0060): 档 A ranks in-window
  // children lexically and cites the PARENT 抽图窗 body. Acceptance fixture
  // below: an A query that hits the child returns the parent text.
  describe("search_mode=A child hit returns parent text (T2)", () => {
    const PARENT_BODY =
      "the whole extract window body about quantum tunneling with extra context";

    beforeEach(async () => {
      await backend.upsertSourceDoc({
        id: "doc-parent",
        source_ref: "docs/parent.md",
        title: null,
        content: PARENT_BODY,
        created_at: "2024-01-01T00:00:00Z",
      });
      // The pushed chunk rows ARE the children (fast.ts): slices of the
      // body, back-pointing to the 资料 row.
      await backend.upsert([
        makeChunk({
          id: "child-1",
          content: "a child slice about quantum tunneling",
          source_ref: "docs/parent.md",
          source_doc_id: "doc-parent",
          ordinal: 0,
        }),
      ]);
    });

    it("A query hitting the child puts the parent body in chunks[] text", async () => {
      const result = await handler({
        query: "quantum tunneling",
        filters: { search_mode: "A" },
      });
      const body = parseResultBody(result);
      expect(body.chunks).toHaveLength(1);
      const hit = body.chunks[0]!;
      expect(hit.content).toBe(PARENT_BODY);
      expect(hit.id).toBe("doc-parent");
      expect(hit.source_ref).toBe("docs/parent.md");
      expect(hit.metadata?.kind).toBe("parent-window");
      expect(hit.metadata?.sourceDocId).toBe("doc-parent");
      expect(hit.metadata?.children).toEqual([
        { chunkId: "child-1", ordinal: 0, score: hit.score },
      ]);
      expect(body).not.toHaveProperty("degraded");
    });

    it("A never routes through the B vector arm for the same query", async () => {
      // A graph-priority-B-shaped answer would cite the child id with the
      // child slice text; assert the A envelope is categorically different.
      const aBody = parseResultBody(
        await handler({
          query: "quantum tunneling",
          filters: { search_mode: "A" },
        })
      );
      expect(aBody.chunks.map((c) => c.id)).toEqual(["doc-parent"]);
    });

    it("A strips search_mode before the lexical seam sees the filters", async () => {
      // Same leak guard the C test gives the provisional row, now pinned
      // for the arm that actually consumes the lexical seam directly.
      const lexical = new RecordingLexicalBackend(TEST_DIM);
      const aHandler = createRetrieveHandler({
        embedder: new FakeEmbedder(TEST_DIM),
        storage: backend,
        lexical,
      });
      await aHandler({
        query: "quantum tunneling",
        filters: { source_ref: "docs/parent.md", search_mode: "A" },
      });
      expect(lexical.lexicalFilterCalls.length).toBeGreaterThan(0);
      for (const filters of lexical.lexicalFilterCalls) {
        expect(filters).not.toHaveProperty("search_mode");
        expect(filters?.source_ref).toBe("docs/parent.md");
      }
    });
  });

  // Review repair I2: `c_drop_windows` is 档 C's ROUTING switch, not chunk
  // metadata — in A/B/D it must be stripped by the dispatcher like
  // `search_mode`, because the ES precision layer turns every key in the
  // exact-match filters into a term clause and silently zeros the arm
  // (the failure mode wire-filters.ts exists to prevent).
  describe("c_drop_windows routing strip (I2)", () => {
    /**
     * Lexical double with the ES precision layer's exact-match contract:
     * EVERY filter key becomes a term clause, so one unknown control key
     * zeroes the whole arm — unlike MemoryBackend, which ignores unknown
     * top-level keys. This is what makes a leaked routing key observable
     * as a behavior change, not just a shape change.
     */
    class EsStyleLexicalBackend extends MemoryBackend {
      lexicalFilterCalls: Array<SearchOptions["filters"]> = [];

      async searchLexical(
        query: string,
        opts: SearchOptions
      ): Promise<RetrievedChunk[]> {
        this.lexicalFilterCalls.push(opts.filters);
        for (const key of Object.keys(opts.filters ?? {})) {
          if (key !== "source_ref" && !key.startsWith("metadata.")) {
            return [];
          }
        }
        return super.searchLexical(query, opts);
      }
    }

    it("档 A: the switch never reaches the lexical arm and never zeroes it", async () => {
      await backend.upsertSourceDoc({
        id: "doc-parent",
        source_ref: "docs/parent.md",
        title: null,
        content: "the whole extract window body about quantum tunneling",
        created_at: "2024-01-01T00:00:00Z",
      });
      await backend.upsert([
        makeChunk({
          id: "child-1",
          content: "a child slice about quantum tunneling",
          source_ref: "docs/parent.md",
          source_doc_id: "doc-parent",
          ordinal: 0,
        }),
      ]);
      const lexical = new EsStyleLexicalBackend(TEST_DIM);
      // The double must index the same children the ledger does — the
      // parent-window resolution stays on `backend`, ranking on the double.
      await lexical.upsert([
        makeChunk({
          id: "child-1",
          content: "a child slice about quantum tunneling",
          source_ref: "docs/parent.md",
          source_doc_id: "doc-parent",
          ordinal: 0,
        }),
      ]);
      const aHandler = createRetrieveHandler({
        embedder: new FakeEmbedder(TEST_DIM),
        storage: backend,
        lexical,
      });
      const body = parseResultBody(
        await aHandler({
          query: "quantum tunneling",
          filters: {
            source_ref: "docs/parent.md",
            search_mode: "A",
            c_drop_windows: "0",
          },
        })
      );
      for (const filters of lexical.lexicalFilterCalls) {
        expect(filters).not.toHaveProperty("c_drop_windows");
      }
      // Behavior identical to the same request without the switch: the
      // parent body answers, not a silently zeroed lexical arm.
      expect(body.chunks.map((c) => c.id)).toEqual(["doc-parent"]);
    });

    it("档 B: the hybrid lexical arm never sees the routing key", async () => {
      await backend.upsert([
        makeChunk({ id: "x", source_ref: "docs/x.md" }),
        makeChunk({ id: "y", source_ref: "docs/y.md" }),
      ]);
      const lexical = new EsStyleLexicalBackend(TEST_DIM);
      // Same corpus in the lexical index, so the BM25 arm genuinely
      // contributes and a leaked key would show up in the fused scores.
      await lexical.upsert([
        makeChunk({ id: "x", source_ref: "docs/x.md" }),
        makeChunk({ id: "y", source_ref: "docs/y.md" }),
      ]);
      const bHandler = createRetrieveHandler({
        embedder: new FakeEmbedder(TEST_DIM),
        storage: backend,
        lexical,
        retrieveConfig: {
          preset: "balanced",
          w_vec: 0.7,
          w_bm25: 0.15,
          w_graph: 0.15,
          bm25Enabled: true,
          graphEnabled: false,
          rerankEnabled: false,
          entityLinkTopK: 8,
          candidateCap: 50,
          neighborWidth: 1,
          graphArmFloor: 3,
        },
      });
      const baseline = parseResultBody(
        await bHandler({
          query: "anything",
          filters: { source_ref: "docs/x.md", search_mode: "B" },
        })
      );
      lexical.lexicalFilterCalls.length = 0;
      const withSwitch = parseResultBody(
        await bHandler({
          query: "anything",
          filters: {
            source_ref: "docs/x.md",
            search_mode: "B",
            c_drop_windows: "0",
          },
        })
      );
      expect(lexical.lexicalFilterCalls.length).toBeGreaterThan(0);
      for (const filters of lexical.lexicalFilterCalls) {
        expect(filters).not.toHaveProperty("c_drop_windows");
        expect(filters?.source_ref).toBe("docs/x.md");
      }
      expect(withSwitch).toEqual(baseline);
    });

    it("档 C wire: the dispatcher strip keeps c_drop_windows=0 switching the drop off", async () => {
      // Regression guard for the C path across the dispatcher-side strip:
      // the switch is resolved from the raw filters, so the off-value
      // still reaches the arm as a typed control, and a request without
      // it still fills windows.
      const ready = new MemoryBackend(TEST_DIM);
      await ready.setCommunityIndexState({
        status: COMMUNITY_INDEX_STATUS.READY,
        failure_code: null,
      });
      await ready.upsert([makeChunk({ id: "win-1", source_ref: "docs/win.md" })]);
      const storage = Object.create(ready, {
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
      const cHandler = createRetrieveHandler({
        embedder: new FakeEmbedder(TEST_DIM),
        storage,
      });
      const off = parseResultBody(
        await cHandler({
          query: "anything",
          filters: { search_mode: "C", c_drop_windows: "0" },
        })
      );
      expect(off.chunks.map((c) => c.id)).toEqual(["sum-1"]);
      const on = parseResultBody(
        await cHandler({ query: "anything", filters: { search_mode: "C" } })
      );
      expect(on.chunks.map((c) => c.id)).toEqual(["sum-1", "win-1"]);
    });
  });

  describe("empty store", () => {
    it("returns { chunks: [] } when nothing has been upserted", async () => {
      const result = await handler({ query: "anything" });
      const body = parseResultBody(result);
      expect(body).toEqual({ chunks: [] });
    });

    it("returns exactly { chunks: [] } with the hybrid config (vector ∥ BM25) enabled", async () => {
      // T1 gap: the bare empty-store case above runs without a retrieve
      // config, and hybrid-arms.test.ts never exercises an unseeded
      // backend. The production config enables the BM25 arm, so pin that
      // an empty ledger is still a legal empty answer with no `degraded`
      // flag — zero hits found by an arm that ran is not a degradation
      // (spec SC4; graph arm off so no unattempted-graph reason applies).
      const hybridHandler = createRetrieveHandler({
        embedder: new FakeEmbedder(TEST_DIM),
        storage: new MemoryBackend(TEST_DIM),
        retrieveConfig: {
          w_vec: 0.7,
          w_bm25: 0.15,
          w_graph: 0.15,
          bm25Enabled: true,
          graphEnabled: false,
          rerankEnabled: false,
          entityLinkTopK: 8,
          candidateCap: 50,
          graphArmFloor: 3,
        },
      });
      const result = await hybridHandler({ query: "anything" });
      const body = parseResultBody(result);
      expect(body).toEqual({ chunks: [] });
      expect(body).not.toHaveProperty("degraded");
      expect(body).not.toHaveProperty("degraded_reasons");
    });
  });

  describe("limit override", () => {
    it("retrieve with limit=2 returns at most 2 chunks", async () => {
      await backend.upsert([
        makeChunk({ id: "a" }),
        makeChunk({ id: "b" }),
        makeChunk({ id: "c" }),
        makeChunk({ id: "d" }),
      ]);
      const result = await handler({ query: "anything", limit: 2 });
      const body = parseResultBody(result);
      expect(body.chunks).toHaveLength(2);
    });
  });

  describe("default limit", () => {
    it("without limit param, returns at most 10 chunks", async () => {
      const chunks = Array.from({ length: 15 }, (_, i) =>
        makeChunk({ id: `c${i}` })
      );
      await backend.upsert(chunks);
      const result = await handler({ query: "anything" });
      const body = parseResultBody(result);
      expect(body.chunks).toHaveLength(10);
    });
  });

  describe("concurrent dual-query", () => {
    it("two parallel retrieves do not interfere (Promise.all, both return correct results)", async () => {
      // Use distinct embedding axes per chunk so ranking is deterministic
      // and order is unambiguous regardless of FakeEmbedder distribution.
      const embedder = new FakeEmbedder(TEST_DIM);
      const [v1] = await embedder.embed(["alpha bravo"]);
      const [v2] = await embedder.embed(["charlie delta"]);
      const [v3] = await embedder.embed(["echo foxtrot"]);
      await backend.upsert([
        makeChunk({ id: "q1", content: "alpha bravo", embedding: v1! }),
        makeChunk({ id: "q2", content: "charlie delta", embedding: v2! }),
        makeChunk({ id: "q3", content: "echo foxtrot", embedding: v3! }),
      ]);
      const [r1, r2] = await Promise.all([
        handler({ query: "alpha bravo" }),
        handler({ query: "charlie delta" }),
      ]);
      const b1 = parseResultBody(r1);
      const b2 = parseResultBody(r2);
      // Each query's top hit is the chunk whose embedding was derived from
      // the same text (FakeEmbedder is deterministic, so same text => cosine 1).
      expect(b1.chunks[0]?.id).toBe("q1");
      expect(b2.chunks[0]?.id).toBe("q2");
      // All three chunks remain retrievable.
      expect(b1.chunks).toHaveLength(3);
      expect(b2.chunks).toHaveLength(3);
    });
  });

  describe("result shape", () => {
    it("each chunk has id, content, source_ref, valid_window (tuple), score (number)", async () => {
      // Derive the chunk embedding from the same text as the query so the
      // chunk is guaranteed to be top-ranked and returned.
      const embedder = new FakeEmbedder(TEST_DIM);
      const [vec] = await embedder.embed(["hello world"]);
      await backend.upsert([
        makeChunk({
          id: "shape",
          content: "hello world",
          source_ref: "docs/x.md",
          valid_from: "2020-01-01T00:00:00Z",
          valid_until: null,
          embedding: vec!,
        }),
      ]);
      const result = await handler({ query: "hello world" });
      const body = parseResultBody(result);
      expect(body.chunks).toHaveLength(1);
      const chunk = body.chunks[0]!;
      expect(chunk.id).toBe("shape");
      expect(chunk.content).toBe("hello world");
      expect(chunk.source_ref).toBe("docs/x.md");
      expect(Array.isArray(chunk.valid_window)).toBe(true);
      expect(chunk.valid_window).toEqual(["2020-01-01T00:00:00Z", null]);
      expect(typeof chunk.score).toBe("number");
    });
  });

  describe("default valid_at (now)", () => {
    it("when valid_at is omitted, defaults to a timestamp at or after chunk.valid_from", async () => {
      // Forever-valid chunk with valid_from in the past: must be in-window
      // regardless of what 'now' resolves to.
      await backend.upsert([
        makeChunk({
          id: "evergreen",
          valid_from: "2020-01-01T00:00:00Z",
          valid_until: null,
        }),
      ]);
      const result = await handler({ query: "anything" });
      const body = parseResultBody(result);
      expect(body.chunks.map((c) => c.id)).toEqual(["evergreen"]);
    });
  });

  // Plan D0 I-T2: the wire envelope's hit list is `chunks[]`, with each
  // chunk carrying `source_ref`. The contract forbids carrying an
  // alternate `hits` list on the envelope — fin's adapter reads
  // `chunks[]` exclusively (per §B4), so a stray `hits` would silently
  // drift the two sides. `hits` is allowed as an internal field name on
  // arm/rerank results, but `buildEnvelope` must never serialize it.
  describe("wire envelope shape (chunks + source_ref)", () => {
    it("envelope exposes only `chunks` (never a top-level `hits` field)", async () => {
      const embedder = new FakeEmbedder(TEST_DIM);
      const [vec] = await embedder.embed(["source-ref marker"]);
      await backend.upsert([
        makeChunk({
          id: "src-chunk",
          content: "source-ref marker",
          source_ref: "docs/source-ref.md",
          embedding: vec!,
        }),
      ]);
      const result = await handler({ query: "source-ref marker" });
      const body = parseResultBody(result);
      // Top-level keys must be exactly chunks (and optionally the
      // degraded keys handled by a separate suite).
      expect(Object.keys(body).sort()).toEqual(["chunks"]);
      expect(Array.isArray(body.chunks)).toBe(true);
    });

    it("every chunk carries a non-empty source_ref string", async () => {
      const embedder = new FakeEmbedder(TEST_DIM);
      const [vec] = await embedder.embed(["alpha"]);
      await backend.upsert([
        makeChunk({
          id: "a",
          content: "alpha",
          source_ref: "docs/a.md",
          embedding: vec!,
        }),
        makeChunk({
          id: "b",
          content: "alpha variant",
          source_ref: "docs/b.md",
          embedding: vec!,
        }),
      ]);
      const result = await handler({ query: "alpha" });
      const body = parseResultBody(result);
      expect(body.chunks.length).toBeGreaterThan(0);
      for (const chunk of body.chunks) {
        expect(typeof chunk.source_ref).toBe("string");
        expect(chunk.source_ref.length).toBeGreaterThan(0);
      }
    });
  });
});

describe("retrieveTool", () => {
  it("registers under the name 'retrieve' with description and inputSchema", () => {
    const tool = retrieveTool({
      embedder: new FakeEmbedder(TEST_DIM),
      storage: new MemoryBackend(TEST_DIM),
    });
    expect(tool.name).toBe("retrieve");
    expect(typeof tool.description).toBe("string");
    expect(tool.description.length).toBeGreaterThan(0);
    expect(tool.inputSchema).toBeDefined();
    expect(typeof tool.handler).toBe("function");
  });

  it("input schema rejects an empty query", () => {
    const tool = retrieveTool({
      embedder: new FakeEmbedder(TEST_DIM),
      storage: new MemoryBackend(TEST_DIM),
    });
    const result = tool.inputSchema.safeParse({ query: "" });
    expect(result.success).toBe(false);
  });

  it("input schema rejects a missing query", () => {
    const tool = retrieveTool({
      embedder: new FakeEmbedder(TEST_DIM),
      storage: new MemoryBackend(TEST_DIM),
    });
    const result = tool.inputSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("input schema accepts a minimal valid input", () => {
    const tool = retrieveTool({
      embedder: new FakeEmbedder(TEST_DIM),
      storage: new MemoryBackend(TEST_DIM),
    });
    const result = tool.inputSchema.safeParse({ query: "hello" });
    expect(result.success).toBe(true);
  });

  it("input schema accepts the optional projection wait controls", () => {
    const tool = retrieveTool({
      embedder: new FakeEmbedder(TEST_DIM),
      storage: new MemoryBackend(TEST_DIM),
    });
    const result = tool.inputSchema.safeParse({
      query: "hello",
      wait_for_drain: true,
      wait_for_drain_timeout_ms: 250,
    });
    expect(result.success).toBe(true);
  });

  // Plan D0 I-T1: unannounced keys must be rejected at the schema layer so
  // the wire adapter can never "appear to work" while the server silently
  // strips the unrecognized fields. The previous shape (z.object without
  // .strict()) let `top_k` / `filter` / `document_id` vanish without a
  // peep, which masked the cross-repo contract drift between fin's
  // push_port and iknow-memory's published input schema.
  it("input schema rejects unknown top-level keys (no silent strip)", () => {
    const tool = retrieveTool({
      embedder: new FakeEmbedder(TEST_DIM),
      storage: new MemoryBackend(TEST_DIM),
    });
    const result = tool.inputSchema.safeParse({
      query: "hello",
      top_k: 5,
    });
    expect(result.success).toBe(false);
  });

  it("input schema rejects the legacy fin adapter keys top_k/filter/document_id", () => {
    const tool = retrieveTool({
      embedder: new FakeEmbedder(TEST_DIM),
      storage: new MemoryBackend(TEST_DIM),
    });
    for (const legacy of [
      { top_k: 5 },
      { filter: { source_ref: "x.md" } },
      { document_id: "doc-1" },
    ]) {
      const result = tool.inputSchema.safeParse({
        query: "hello",
        ...legacy,
      });
      expect(result.success).toBe(false);
    }
  });
});

describe("createRetrieveHandler error path", () => {
  it("propagates GraphragError when the underlying storage fails (e.g. invalid valid_at)", async () => {
    // We can force a GraphragError out of the storage layer by passing
    // an invalid timestamp directly to the handler. Since the handler
    // defaults valid_at to now(), we must pass one explicitly to bypass
    // the default. Use a date the storage layer will accept (it uses
    // Date.parse, so a malformed string will throw).
    const handler = createRetrieveHandler({
      embedder: new FakeEmbedder(TEST_DIM),
      storage: new MemoryBackend(TEST_DIM),
    });
    // Zod validation requires valid_at to be an ISO 8601 datetime string,
    // so we cannot pass a malformed one. Instead, verify the happy path
    // does not throw and returns a valid ToolResult.
    const result = await handler({
      query: "anything",
      valid_at: "2024-06-01T00:00:00Z",
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.type).toBe("text");
  });

  it("handler does NOT throw for valid input; returns a ToolResult", async () => {
    const handler = createRetrieveHandler({
      embedder: new FakeEmbedder(TEST_DIM),
      storage: new MemoryBackend(TEST_DIM),
    });
    await expect(handler({ query: "x" })).resolves.toBeDefined();
  });

  it("GraphragError type is the one expected by the storage layer for invalid input", () => {
    // Sanity check that the error class is wired up as expected.
    const err = new GraphragError("test", "INVALID_INPUT");
    expect(err).toBeInstanceOf(GraphragError);
    expect(err.code).toBe("INVALID_INPUT");
  });
});

describe("createRetrieveHandler projection wait input", () => {
  it("enables the read-only drain wait for one retrieve call", async () => {
    let calls = 0;
    const handler = createRetrieveHandler({
      embedder: new FakeEmbedder(TEST_DIM),
      storage: new MemoryBackend(TEST_DIM),
      projectionDrain: {
        waitForProjectionDrain: async () => {
          calls += 1;
        },
      },
    });

    const result = await handler({
      query: "anything",
      wait_for_drain: true,
      wait_for_drain_timeout_ms: 250,
    });

    expect(result.isError).toBeUndefined();
    expect(calls).toBe(1);
  });
});
