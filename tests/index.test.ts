import { describe, it, expect } from "vitest";
import assert from "node:assert/strict";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import {
  buildRetrieveDeps,
  buildRetrieveReranker,
  createServer,
} from "../src/index.ts";
import { FakeEmbedder } from "../src/core/embedder.ts";
import { MemoryBackend } from "../src/core/storage/memory-backend.ts";

/**
 * Construct a server with the stage 1 env vars forced to their defaults.
 *
 * Why: `loadEnv()` reads `process.env` at construction time, and a developer
 * machine (or CI secret) may well have a real embedding key exported. If we
 * let that through, `createServer()` builds a NineRouterEmbedder and these
 * tests silently start making paid network calls — which is both slow and a
 * false signal. Clearing the vars for the duration of the call pins the
 * memory + UnavailableEmbedder path required when credentials are absent.
 *
 * All embedding key knobs must be scrubbed, not just the legacy
 * `NINE_ROUTER_KEY`: direct key values and
 * `GRAPHRAG_MEMORY_EMBED_API_KEY_ENV` can all select a real embedder. Leaving
 * any in place also drags in the key-coupled BASE_URL / MODEL required check,
 * so `createServer()` throws ConfigError instead of running offline.
 */
const ENV_KEYS = [
  "GRAPHRAG_MEMORY_STORAGE",
  "GRAPHRAG_MEMORY_DB_URL",
  "GRAPHRAG_MEMORY_EMBED_DIMENSIONS",
  "GRAPHRAG_MEMORY_PGVECTOR_ANN_MAX_DIMENSIONS",
  "GRAPHRAG_MEMORY_EMBED_BASE_URL",
  "GRAPHRAG_MEMORY_EMBED_MODEL",
  "GRAPHRAG_MEMORY_EMBED_API_KEY",
  "GRAPHRAG_MEMORY_EMBED_API_KEY_ENV",
  "GRAPHRAG_MEMORY_VECTOR_API_KEY",
  "NINE_ROUTER_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "GRAPHRAG_MEMORY_RERANK_API_KEY_ENV",
  "MINIMAX_API_KEY",
  "GRAPHRAG_MEMORY_ANTHROPIC_API_KEY",
  "GRAPHRAG_MEMORY_RETRIEVAL_RERANK_ENABLED",
  "GRAPHRAG_MEMORY_RETRIEVAL_BM25_ENABLED",
] as const;

async function createOfflineServer(): Promise<ReturnType<typeof createServer>> {
  const saved = new Map<string, string | undefined>();
  for (const k of ENV_KEYS) {
    saved.set(k, process.env[k]);
    // `readEnv` treats a PRESENT (even blank) process key as explicit and
    // only falls back to `.env.local` for ABSENT keys. Blanking therefore
    // masks a developer's `.env.local`; `delete` would re-open the fallback
    // and let `GRAPHRAG_MEMORY_STORAGE=pgvector` or a stray
    // `ANTHROPIC_AUTH_TOKEN` bleed into these tests. Mirror the
    // `maskDotenvLocal` convention in `tests/config.test.ts` (T-007).
    process.env[k] = "";
  }
  // Dimensions is always required by the memory backend.
  process.env["GRAPHRAG_MEMORY_EMBED_DIMENSIONS"] = "1536";
  process.env["GRAPHRAG_MEMORY_PGVECTOR_ANN_MAX_DIMENSIONS"] = "2000";
  // ADR-0006 / ADR-0007 fail-start: the scrubbed baseline has no Neo4j URI,
  // rerank URL, or ES address, which a default-on graph/rerank/lexical boot
  // now refuses. These tests exercise offline tool wiring, not the arms, so
  // switch them off — the explicit-off path stays legal without the deps.
  process.env["GRAPHRAG_MEMORY_RETRIEVAL_GRAPH_ENABLED"] = "false";
  process.env["GRAPHRAG_MEMORY_RETRIEVAL_RERANK_ENABLED"] = "false";
  process.env["GRAPHRAG_MEMORY_RETRIEVAL_BM25_ENABLED"] = "false";
  try {
    return await createServer();
  } finally {
    // Faithfully restore the ORIGINAL value: absent stays absent (delete),
    // a real value goes back verbatim. Using `""` here would lie about the
    // pre-test state and could mask a real `.env.local` leak in a later run.
    for (const [k, v] of saved) {
      if (v !== undefined) process.env[k] = v;
      else delete process.env[k];
    }
  }
}

describe("createServer", () => {
  it("returns a constructed McpServer with a connect() method", async () => {
    const server = await createOfflineServer();
    expect(server).toBeDefined();
    assert.equal(
      typeof (server as unknown as { connect: unknown }).connect,
      "function"
    );
  });

  it("returns a fresh server on each call (no shared mutable state)", async () => {
    const a = await createOfflineServer();
    const b = await createOfflineServer();
    assert.notEqual(a, b);
  });
});

/**
 * T7 wiring: the tool set the server actually advertises and serves.
 *
 * Why an in-process linked transport instead of spawning dist/index.js
 * (the host-smoke pattern): these tests assert the wiring inside a single
 * `createServer()` instance. Storage is a per-instance `MemoryBackend`, so
 * ingest -> retrieve only round-trips when the client and server share one
 * process. Spawning would also require a build step per run.
 *
 * Default env (no NINE_ROUTER_KEY, no GRAPHRAG_MEMORY_STORAGE) puts the
 * server in memory + UnavailableEmbedder mode, so nothing here touches the
 * network and embedding-dependent ingest is rejected explicitly.
 */
async function connectInProcess(): Promise<{
  client: Client;
  close: () => Promise<void>;
}> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = await createOfflineServer();
  await server.connect(serverTransport);

  const client = new Client(
    { name: "index-test", version: "0.0.0" },
    { capabilities: {} }
  );
  await client.connect(clientTransport);

  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** Concatenate the text content blocks of a tools/call result. */
function textOf(result: { content: unknown }): string {
  return (result.content as Array<{ type: string; text?: string }>)
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("");
}

describe("createServer — registered tool set (T7)", () => {
  it("tools/list advertises ingest, invalidate, push, extract, and retrieve", async () => {
    // specs/mcp-tool-surface.md Catalog: the Host-facing tool set is
    // exactly ingest + invalidate + push + extract + retrieve. `echo` is
    // archived and the invalidation tool answers to `invalidate`.
    const { client, close } = await connectInProcess();
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual([
        "extract",
        "ingest",
        "invalidate",
        "push",
        "retrieve",
      ]);
      // The archived names are gone from the wire, not merely shadowed.
      expect(names).not.toContain("echo");
      expect(names).not.toContain("invalidation");
      for (const tool of tools) {
        expect((tool.inputSchema as { type?: string }).type).toBe("object");
      }
    } finally {
      await close();
    }
  });

  it("tool descriptions are Host-readable (no internal jargon)", async () => {
    // specs/mcp-tool-surface.md assumption 12: descriptions on tools/list
    // are for any Host. No "stage 0", no fin-port wire names.
    const { client, close } = await connectInProcess();
    try {
      const { tools } = await client.listTools();
      for (const tool of tools) {
        expect(tool.description).not.toMatch(
          /stage 0|fin\b|_port|invalidation_port/i
        );
      }
    } finally {
      await close();
    }
  });

  it("tools/call ingest reports missing embedding credentials", async () => {
    const { client, close } = await connectInProcess();
    try {
      const result = await client.callTool({
        name: "ingest",
        arguments: {
          content: "The capital of France is Paris.",
          source_ref: "test://ingest-round-trip",
        },
      });
      // T12 removes the production FakeEmbedder fallback. Ingest cannot
      // manufacture vectors when the embedding credentials are absent.
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(
        /embedding credentials are not configured/
      );
    } finally {
      await close();
    }
  });

  it("tools/call extract reports the typed no-database configuration error", async () => {
    // The offline server has no GRAPHRAG_MEMORY_DB_URL, so the extract
    // tool answers a typed configuration error instead of crashing the
    // server or pretending to run (specs/mcp-tool-surface.md: extract
    // persists, so it cannot run without a database — the other tools
    // stay usable).
    const { client, close } = await connectInProcess();
    try {
      const result = await client.callTool({
        name: "extract",
        arguments: { source_ref: "test://extract-no-db" },
      });
      expect(result.isError).toBe(true);
      const text = textOf(result);
      expect(text).toMatch(/GRAPHRAG_MEMORY_DB_URL/);
      // The core guards' CLI-flag wording must not reach the Host.
      expect(text).not.toMatch(/--dry-run/);
    } finally {
      await close();
    }
  });

  it("tools/call extract rejects both selectors at once", async () => {
    // v2 wraps input-validation failures as a CallToolResult with
    // isError:true — the xor selector rule rides the zod superRefine.
    const { client, close } = await connectInProcess();
    try {
      const result = await client.callTool({
        name: "extract",
        arguments: {
          chunk_ids: ["0f0a3f8e-1c2b-4d5e-8f90-1a2b3c4d5e6f"],
          source_ref: "test://both-selectors",
        },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/exactly one selector/i);
    } finally {
      await close();
    }
  });

  it("tools/call retrieve returns a chunks array", async () => {
    const { client, close } = await connectInProcess();
    try {
      const result = await client.callTool({
        name: "retrieve",
        arguments: { query: "anything at all" },
      });
      expect(result.isError).not.toBe(true);

      // Empty store: the shape must still be well-formed (empty array),
      // not an error — "no results" is a valid answer, not a failure.
      const payload = JSON.parse(textOf(result)) as { chunks: unknown[] };
      expect(Array.isArray(payload.chunks)).toBe(true);
      expect(payload.chunks).toEqual([]);
    } finally {
      await close();
    }
  });

  it("ingest does not create pseudo-vector-backed data without credentials", async () => {
    const { client, close } = await connectInProcess();
    try {
      const content = "GraphRAG stores chunks with temporal validity windows.";
      const ingested = await client.callTool({
        name: "ingest",
        arguments: { content, source_ref: "test://e2e", metadata: { k: "v" } },
      });
      // T12 requires server wiring to reject ingest rather than use
      // deterministic pseudo-vectors as a production substitute.
      expect(ingested.isError).toBe(true);
      expect(textOf(ingested)).toMatch(
        /embedding credentials are not configured/
      );
    } finally {
      await close();
    }
  });

  it("each server instance owns its storage (no cross-instance leakage)", async () => {
    const first = await connectInProcess();
    try {
      await first.client.callTool({
        name: "ingest",
        arguments: { content: "isolated payload", source_ref: "test://iso" },
      });
    } finally {
      await first.close();
    }

    const second = await connectInProcess();
    try {
      const result = await second.client.callTool({
        name: "retrieve",
        arguments: { query: "isolated payload" },
      });
      const { chunks } = JSON.parse(textOf(result)) as { chunks: unknown[] };
      expect(chunks).toEqual([]);
    } finally {
      await second.close();
    }
  });

  it("ingest surfaces handler errors as isError results", async () => {
    const { client, close } = await connectInProcess();
    try {
      // valid_from >= valid_until is a semantic (not schema) violation, so
      // it reaches the handler and comes back through registerOne's catch.
      const result = await client.callTool({
        name: "ingest",
        arguments: {
          content: "reversed window",
          source_ref: "test://bad-window",
          valid_from: "2030-01-02T00:00:00.000Z",
          valid_until: "2030-01-01T00:00:00.000Z",
        },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/valid_from must be strictly before/);
    } finally {
      await close();
    }
  });
});

/**
 * SQL one-hop graph arm archived off the production path (#58 / #62).
 *
 * `assembleRetrievalResult` runs the graph arm only when the retrieve tool
 * is handed BOTH a backend exposing `graphArmSeed` (PgvectorBackend does)
 * and a `graphConfig`. Server wiring owns the second half, so withholding
 * `graphConfig` is the whole archive: no code is deleted, and a test that
 * injects `graphConfig` explicitly still exercises the arm.
 *
 * This asserts the wiring directly so the guard runs without Postgres and
 * lands in the fast CI tier. `tests/cli/extract-e2e-graph.test.ts` Case 4
 * carries the end-to-end proof against a real pgvector backend holding
 * traversable graph data.
 */
describe("buildRetrieveDeps — SQL graph arm archived (#58/#62)", () => {
  const embedder = new FakeEmbedder(1536);
  const storage = new MemoryBackend(1536);
  const retrieval = {
    w_vec: 0.7,
    w_bm25: 0.15,
    w_graph: 0.15,
    bm25Enabled: true,
    graphEnabled: true,
    rerankEnabled: false,
    entityLinkTopK: 8,
    candidateCap: 50,
    graphArmFloor: 3,
  };

  it("omits graphConfig entirely from the default retrieve deps", () => {
    const deps = buildRetrieveDeps({ embedder, storage, retrieval }, false);
    // `Object.hasOwn` rather than `=== undefined`: an explicit
    // `graphConfig: undefined` would read as "wired, currently empty" and
    // would let a later refactor fill it in without tripping this guard.
    expect(Object.hasOwn(deps, "graphConfig")).toBe(false);
    expect(deps.graphConfig).toBeUndefined();
  });

  // The same config object that used to arrive as `graphConfig` now
  // arrives as `retrieveConfig`, which is what turns the BM25 arm on for
  // the stock server (#66). Losing this key would silently ship a
  // vector-only server that still passes every arm-level unit test.
  it("supplies the loaded retrieval config as retrieveConfig", () => {
    const deps = buildRetrieveDeps({ embedder, storage, retrieval }, false);
    expect(deps.retrieveConfig).toBe(retrieval);
  });

  it("still threads the embedder, storage, and debug gate through", () => {
    expect(buildRetrieveDeps({ embedder, storage, retrieval }, true)).toEqual({
      embedder,
      storage,
      retrieveConfig: retrieval,
      debug: true,
    });
  });
});

/**
 * Neo4j PPR arm wiring (#70 T4) — the mirror image of the archive above.
 *
 * The Neo4j arm IS production, so the ranker travels whenever one was
 * built. Whether one was built is decided by `loadEnv().neo4j`, i.e. by
 * whether the operator configured a sidecar URI; withholding the key leaves
 * the default-on graph capability unattempted, which the orchestrator marks
 * as degraded (T10 / §B3 rule 1).
 */
describe("buildRetrieveDeps — Neo4j graph arm wiring (#70)", () => {
  const embedder = new FakeEmbedder(1536);
  const storage = new MemoryBackend(1536);
  const retrieval = {
    w_vec: 0.7,
    w_bm25: 0.15,
    w_graph: 0.15,
    bm25Enabled: true,
    graphEnabled: true,
    rerankEnabled: false,
    entityLinkTopK: 8,
    candidateCap: 50,
    graphArmFloor: 3,
  };
  const graphRanker = {
    rankEntities: async () => [],
    close: async () => {},
  };

  it("omits graphRanker entirely when no sidecar is configured", () => {
    const deps = buildRetrieveDeps({ embedder, storage, retrieval }, false);
    // An explicit `graphRanker: undefined` would read as "wired, currently
    // empty"; absence is the wire signal for "no Neo4j here".
    expect(Object.hasOwn(deps, "graphRanker")).toBe(false);
  });

  it("passes the ranker through when one was built", () => {
    const deps = buildRetrieveDeps(
      { embedder, storage, retrieval, graphRanker },
      false
    );
    expect(deps.graphRanker).toBe(graphRanker);
  });
});

describe("buildRetrieveDeps — temporary LLM rerank wiring", () => {
  const embedder = new FakeEmbedder(1536);
  const storage = new MemoryBackend(1536);
  const retrieval = {
    w_vec: 0.7,
    w_bm25: 0.15,
    w_graph: 0.15,
    bm25Enabled: true,
    graphEnabled: true,
    rerankEnabled: true,
    entityLinkTopK: 8,
    candidateCap: 50,
    graphArmFloor: 3,
  };
  const reranker = {
    permute: async () => [],
  };

  it("omits reranker entirely when none was built", () => {
    const deps = buildRetrieveDeps({ embedder, storage, retrieval }, false);
    expect(Object.hasOwn(deps, "reranker")).toBe(false);
  });

  it("passes the reranker through when one was built", () => {
    const deps = buildRetrieveDeps(
      { embedder, storage, retrieval, reranker },
      false
    );
    expect(deps.reranker).toBe(reranker);
  });
});

describe("buildRetrieveReranker — HTTP URL or MiniMax LLM creds", () => {
  const llm = {
    apiKey: "test-key-not-a-real-secret",
    model: "MiniMax-M3",
    baseUrl: "https://api.minimaxi.com/anthropic",
  };

  it("omits the adapter when neither HTTP URL nor LLM creds exist", () => {
    expect(
      buildRetrieveReranker({ rerankUrl: undefined, rerank: undefined })
    ).toBeUndefined();
  });

  it("builds an LLM adapter when MiniMax creds exist and no HTTP URL is set", () => {
    const built = buildRetrieveReranker({
      rerankUrl: undefined,
      rerank: llm,
    });
    expect(built).toBeDefined();
    expect(typeof built?.permute).toBe("function");
  });

  it("builds an HTTP adapter when a rerank URL is set, even if LLM creds also exist", () => {
    const built = buildRetrieveReranker({
      rerankUrl: "https://rerank.example.test/v1/",
      rerank: llm,
    });
    expect(built).toBeDefined();
    expect(typeof built?.permute).toBe("function");
  });
});
