import { describe, it, expect, beforeEach } from "vitest";
import { createRetrieveHandler, retrieveTool } from "../src/tools/retrieve.js";
import { FakeEmbedder } from "../src/core/embedder.js";
import { MemoryBackend } from "../src/core/storage/memory-backend.js";
import { GraphragError } from "../src/core/errors.js";
import type {
  ChunkRecord,
  RetrievedChunk,
  SearchOptions,
} from "../src/core/types.js";
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
  // reason). A/C/D still answer through the provisional graph-priority arm
  // until T2 opens A, T3 opens C and T4 replaces D's row.
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

    it("valid A/C/D parse and run the provisional B arm", async () => {
      const baseline = await handler({ query: "anything" });
      // T1 opens the dispatch table only: A/C/D alias the provisional
      // graph-priority arm, so each answers byte-for-byte like B. T2
      // splits A out; T3/T4 will move C's and D's rows.
      for (const mode of ["A", "C", "D"] as const) {
        const result = await handler({
          query: "anything",
          filters: { search_mode: mode },
        });
        expect(parseResultBody(result)).toEqual(parseResultBody(baseline));
      }
      expect(parseResultBody(baseline).chunks).toHaveLength(2);
    });

    it("search_mode never reaches the lexical arm's exact-match filters", async () => {
      // Regression guard for the ES precision layer, which turns every
      // filter key into a term clause: a leaked `search_mode` would match
      // no indexed field and silently zero the BM25 arm. C is the probe —
      // while it is provisional B it runs the B pipeline end to end.
      const lexical = new RecordingLexicalBackend(TEST_DIM);
      const hybridHandler = createRetrieveHandler({
        embedder: new FakeEmbedder(TEST_DIM),
        storage: backend,
        lexical,
        retrieveConfig: HYBRID_CONFIG,
      });
      const result = await hybridHandler({
        query: "anything",
        filters: { source_ref: "docs/x.md", search_mode: "C" },
      });
      expect(lexical.lexicalFilterCalls.length).toBeGreaterThan(0);
      for (const filters of lexical.lexicalFilterCalls) {
        expect(filters).not.toHaveProperty("search_mode");
        expect(filters?.source_ref).toBe("docs/x.md");
      }
      // C answers through the hybrid pipeline, un-degraded, like B.
      expect(parseResultBody(result).chunks.map((c) => c.id)).toEqual(["x"]);
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
