/**
 * iknow-memory MCP server entry.
 *
 * Wires the tool registry into a stdio MCP server. The catalog is the
 * Host-facing contract frozen by specs/mcp-tool-surface.md: ingest, push,
 * invalidate, extract, retrieve.
 *
 * Decoupling contract (per map #33 / ticket #35):
 *   - No import from iknow (`src/shared/schema.ts`, `src/config/`, etc.).
 *   - Provider key env-var names are looked up by NAME, never stored
 *     in code.
 *   - All logging goes to stderr; stdout is reserved for the MCP
 *     stdio JSON-RPC transport.
 *
 * SDK: `@modelcontextprotocol/server@^2.0.0` (v2 split-package line) +
 * `@modelcontextprotocol/client@^2.0.0` (for the host-smoke test harness).
 * Uses the high-level `McpServer.registerTool` API. The low-level `Server`
 * + `setRequestHandler` and the deprecated `tool(...)` method are
 * deliberately avoided.
 */
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

import { ConfigError, loadEnv, type GraphragEnv } from "./config.js";
import { createLogger, redactDiagnostic, writeStderr } from "./logging.js";
import { parseStdioEntry } from "./cli/stdio-entry.js";
import {
  buildRegistry,
  textResult,
  type ToolRegistration,
} from "./tools/registry.js";
import { ingestTool } from "./tools/ingest.js";
import { invalidationTool } from "./tools/invalidation.js";
import { pushTool } from "./tools/push.js";
import { retrieveTool, type RetrieveDeps } from "./tools/retrieve.js";
import {
  extractTool,
  type ExtractDeps,
  type ExtractPool,
} from "./tools/extract.js";
import {
  NineRouterEmbedder,
  UnavailableEmbedder,
  type EmbeddingClient,
} from "./core/embedder.js";
import { MemoryBackend } from "./core/storage/memory-backend.js";
import {
  ElasticsearchPrecisionLayer,
  type PrecisionIndexer,
} from "./core/storage/elasticsearch-precision.js";
import {
  createNeo4jPprRanker,
  type PprRanker,
} from "./core/graph/neo4j-ppr.js";
import { createHttpChunkReranker } from "./core/rerank/http-reranker.js";
import { createAnthropicChunkReranker } from "./core/rerank/anthropic-reranker.js";
import type { StorageBackend } from "./core/types.js";
import type { SearchOptions } from "./core/types.js";
import type { LexicalStorageBackend } from "./core/storage/backend.js";

const SERVER_NAME = "iknow-memory";
const SERVER_VERSION = "0.0.0";

/**
 * Process exit codes (single source of truth — referenced by the fatal-error
 * catch in the isMain block). Anything outside this table is a bug;
 * documenting it here makes host-side scripts (Claude Code, systemd, k8s)
 * able to reason about what kind of failure happened without parsing stderr.
 *
 *   FATAL_RUNTIME    1   uncaught exception in main() — see stderr stack
 *   BAD_CONFIG       2   loadEnv() rejected the environment (ConfigError)
 *
 * BAD_CONFIG returned in T7 alongside the first real config-rejection
 * surface (unknown storage mode / pgvector without a DB URL). It had been
 * removed in stage 0 when the transport knob went away — see
 * `tests/config.test.ts` and
 * `docs/handoff/2026-07-29-graphrag-mcp-host-acceptance.md`.
 */
const EXIT_CODES = {
  FATAL_RUNTIME: 1,
  BAD_CONFIG: 2,
} as const;

/** Everything the ingest/retrieve handlers need, built once per server. */
interface ServerDeps {
  embedder: EmbeddingClient;
  storage: StorageBackend;
  /** Optional Elasticsearch precision layer for derived indexes. */
  precision?: PrecisionIndexer;
  /**
   * Retrieval pipeline config. Always present — loadEnv() always returns
   * it. Structural type from GraphragEnv so this file never imports
   * src/core/retrieval/* (the isolation guard in
   * tests/cli/isolation-retrieval.test.ts enforces that).
   *
   * Reaches the retrieve tool as `retrieveConfig`, never as `graphConfig`:
   * see `buildRetrieveDeps`.
   */
  retrieval: GraphragEnv["retrieval"];
  /**
   * Neo4j PPR ranker for the production graph arm, built only when a
   * sidecar URI is configured. Undefined is passed on as an ABSENT key,
   * allowing retrieval to mark the default-on graph capability unattempted.
   * See `buildRetrieveDeps`.
   */
  graphRanker?: PprRanker;
  /** Retrieve rerank adapter: dedicated HTTP URL, else MiniMax LLM. */
  reranker?: {
    permute(
      query: string,
      candidates: readonly { id: string; content: string }[]
    ): Promise<readonly string[]>;
  };
}

/**
 * Assemble the retrieve tool's dependencies for the default server path.
 *
 * The loaded retrieval config travels as `retrieveConfig`, which is what
 * arms BM25 alongside the vector arm on the stock server (#59 / #66).
 *
 * It deliberately does NOT travel as `graphConfig`: the SQL one-hop graph
 * arm is **archived off production** (#58 / #62), and
 * `assembleRetrievalResult` gates that arm on receiving a `graphConfig`,
 * so the archive is expressed here as an absence — this function never
 * builds the key. PgvectorBackend still exposes `graphArmSeed` and
 * `graph-arm.ts` still compiles — tests that want the arm inject
 * `graphConfig` themselves — but no operator gets one-hop JOIN results
 * from the stock server. A real graph arm belongs on a native graph
 * engine; see `docs/runbooks/sql-graph-arm-archived.md`.
 *
 * The Neo4j PPR arm (#70) is wired the opposite way round: it IS the
 * production third arm, so the ranker travels whenever one was built —
 * that is, whenever the operator configured a sidecar URI. No URI means no
 * ranker, which lets `assembleRetrievalResult` report the default-on
 * capability as unattempted (`degraded: true`).
 *
 * Exported so both halves are directly assertable without a live Postgres
 * (tests/index.test.ts); reintroducing `graphConfig` here, or dropping
 * `retrieveConfig`, fails that test.
 */
export function buildRetrieveDeps(
  deps: Pick<
    ServerDeps,
    | "embedder"
    | "storage"
    | "precision"
    | "retrieval"
    | "graphRanker"
    | "reranker"
  >,
  debug: boolean
): RetrieveDeps {
  return {
    embedder: deps.embedder,
    storage: deps.storage,
    ...(deps.precision !== undefined
      ? {
          lexical: lexicalAdapterFromPrecision(deps.precision),
          entityLexical: deps.precision,
        }
      : {}),
    retrieveConfig: deps.retrieval,
    ...(deps.graphRanker !== undefined
      ? { graphRanker: deps.graphRanker }
      : {}),
    ...(deps.reranker !== undefined ? { reranker: deps.reranker } : {}),
    debug,
  };
}

/**
 * Pick the retrieve rerank adapter the production server actually calls.
 * Dedicated HTTP URL wins when present (quality-stack T2); otherwise the
 * MiniMax/Anthropic LLM adapter from slice 0. Neither → no adapter (fail-start
 * already refused a default-on boot without one of these).
 */
export function buildRetrieveReranker(
  env: Pick<GraphragEnv, "rerankUrl" | "rerank">
): ServerDeps["reranker"] {
  if (env.rerankUrl !== undefined) {
    return createHttpChunkReranker(env.rerankUrl);
  }
  if (env.rerank !== undefined) {
    return createAnthropicChunkReranker(env.rerank);
  }
  return undefined;
}

/**
 * Adapt a `PrecisionIndexer` to the `LexicalStorageBackend` shape consumed by
 * the BM25 arm.
 *
 * `PrecisionIndexer` is the broader derived-index port (chunks + entities
 * + invalidation); the lexical arm only ever reads `searchLexical`. Wrapping
 * keeps `LexicalStorageBackend` — which the BM25 arm and several tests
 * consume — unchanged while letting the same `PrecisionIndexer` instance
 * double as the seed-finding entity port (entityLexical).
 *
 * `upsert` / `search` / `close` are intentionally unimplemented: the lexical
 * arm never calls them, and the orchestrator picks `deps.storage` for vector
 * searches via the standard path. A call here would mean a wiring bug.
 */
function lexicalAdapterFromPrecision(
  precision: PrecisionIndexer
): LexicalStorageBackend {
  return {
    upsert: () =>
      Promise.reject(
        new ConfigError(
          "precision-derived lexical backend does not implement upsert; " +
            "use storage.upsert for authoritative writes"
        )
      ),
    search: () =>
      Promise.reject(
        new ConfigError(
          "precision-derived lexical backend does not implement vector search; " +
            "use storage.search for vector recall"
        )
      ),
    searchLexical: (query: string, opts: SearchOptions) =>
      precision.searchLexical(query, opts),
    close: () => precision.close(),
  };
}

/**
 * Build the storage + embedding dependencies for one server instance.
 *
 * Embedder selection is key-presence-driven rather than an explicit mode
 * knob: an operator who supplies an embedding API key wants real embeddings,
 * and one who does not cannot get them anyway. The production server uses an
 * unavailable typed embedder in that case: ingest fails visibly and retrieve
 * can skip the vector arm without manufacturing evidence.
 *
 * Storage selection: pgvector (T8) is dynamically imported so a memory-mode
 * user never pays for the `pg` dependency. The dynamic import is wrapped in
 * a try so a missing optional dependency surfaces as ConfigError with a
 * clear "install pg" hint instead of an opaque module-not-found at startup.
 */
async function buildDeps(env: GraphragEnv): Promise<ServerDeps> {
  let storage: StorageBackend;
  if (env.storage === "pgvector") {
    if (env.dbUrl === undefined) {
      // config.loadEnv already enforces this, but defense-in-depth:
      // buildDeps is also exported-style callable for tests.
      throw new ConfigError(
        "GRAPHRAG_MEMORY_DB_URL is required when GRAPHRAG_MEMORY_STORAGE=pgvector"
      );
    }
    let mod: typeof import("./core/storage/pgvector-backend.js");
    try {
      mod = await import("./core/storage/pgvector-backend.js");
    } catch (err) {
      throw new ConfigError(
        `GRAPHRAG_MEMORY_STORAGE=pgvector requires the optional "pg" dependency — \`npm install pg\` (${(err as Error).message})`
      );
    }
    const backend = new mod.PgvectorBackend(env.dbUrl, env.embedDimensions);
    // Fail before the stdio transport opens: dimension and ANN-index
    // bootstrap errors are server-startup failures, not tool responses.
    await backend.initialize();
    storage = backend;
  } else {
    storage = new MemoryBackend(env.embedDimensions);
  }

  const precision =
    env.elasticsearch === undefined
      ? undefined
      : new ElasticsearchPrecisionLayer(env.elasticsearch, {
          k1: env.retrieval.k1,
          b: env.retrieval.b,
        });

  // Both branches always pass `dimensions` through; the dim value is always
  // required by config so this is just plumbing.
  let embedder: EmbeddingClient;
  if (env.embedApiKey) {
    // loadEnv already enforces both when a key is present; defense-in-depth
    // mirrors the dbUrl check above (buildDeps is also callable from tests).
    if (env.embedBaseUrl === undefined || env.embedModel === undefined) {
      throw new ConfigError(
        "GRAPHRAG_MEMORY_EMBED_BASE_URL and GRAPHRAG_MEMORY_EMBED_MODEL are required when an embedding API key is configured"
      );
    }
    embedder = new NineRouterEmbedder({
      baseUrl: env.embedBaseUrl,
      model: env.embedModel,
      apiKey: env.embedApiKey,
      dimensions: env.embedDimensions,
    });
  } else embedder = new UnavailableEmbedder();

  // Thread the validated retrieval config into the server deps so
  // createServer() can pass it as retrieveConfig to retrieveTool.
  //
  // The ranker is constructed, not connected: `createNeo4jPprRanker` dials
  // Neo4j on the first ranking, so an unreachable sidecar degrades one
  // retrieve instead of stopping the server from starting.
  const reranker = buildRetrieveReranker(env);
  return {
    embedder,
    storage,
    ...(precision !== undefined ? { precision } : {}),
    retrieval: env.retrieval,
    ...(env.neo4j !== undefined
      ? { graphRanker: createNeo4jPprRanker(env.neo4j) }
      : {}),
    ...(reranker !== undefined ? { reranker } : {}),
  };
}

/**
 * Build the extract tool's dependencies from the loaded env.
 *
 * Pool lifecycle: the pg.Pool is created LAZILY on the first extract call
 * that dials the database (`import("pg")` mirrors the memory-mode posture
 * of buildDeps — a server that never calls extract never loads the driver).
 * A server without GRAPHRAG_MEMORY_DB_URL gets no pool at all: extract
 * answers a typed per-call configuration error and the server still boots.
 * Once created, the pool lives for the server's lifetime — the same
 * process-scoped posture as the pgvector backend's pool, so there is no
 * per-call pool to leak (extract runs inside the caller's await, not in a
 * detached task).
 *
 * LLM credentials ride the parsed ANTHROPIC block (`env.rerank` — the same
 * ANTHROPIC_AUTH_TOKEN / GRAPHRAG_MEMORY_ANTHROPIC_* family the extract CLI
 * reads raw from process.env, here already trimmed and defaulted by
 * loadEnv). Embedding credentials come straight from the embed block.
 * Missing credentials do NOT fail the build: extract reports a typed
 * per-call error instead (SC9 — never a fake client), which keeps the
 * offline server booting for the other tools.
 *
 * Precision: the server's ONE ElasticsearchPrecisionLayer — the one
 * `buildDeps` already constructed from `env.elasticsearch` — is threaded
 * in by the caller, so a single ES client is shared by every tool on this
 * server (never rebuilt from env here). Absent when ES is unconfigured;
 * extract's ES mirror is fail-open inside the core pipeline either way.
 *
 * Exported so the wiring is directly assertable without Postgres
 * (tests/index.test.ts).
 */
export function buildExtractDeps(
  env: GraphragEnv,
  logger: ReturnType<typeof createLogger>,
  precision?: PrecisionIndexer
): ExtractDeps {
  // The extraction LLM credentials ride the parsed ANTHROPIC block: despite
  // its historical name, `env.rerank` IS the ANTHROPIC_AUTH_TOKEN /
  // GRAPHRAG_MEMORY_ANTHROPIC_* family the extract CLI reads raw from
  // process.env. The config field name and env vars are frozen; the local
  // alias keeps the dual role readable at the use site.
  const anthropicLlmCreds = env.rerank;
  return {
    llmEnv: {
      authToken: anthropicLlmCreds?.apiKey,
      baseUrl: anthropicLlmCreds?.baseUrl,
      model: anthropicLlmCreds?.model,
    },
    embedderEnv: {
      apiKey: env.embedApiKey,
      baseUrl: env.embedBaseUrl,
      model: env.embedModel,
      dimensions: env.embedDimensions,
    },
    ...(env.dbUrl !== undefined
      ? { pool: createLazyPgExtractPool(env.dbUrl) }
      : {}),
    ...(precision !== undefined ? { precision } : {}),
    // Write-time supersede switch: the MCP tool path reads the same
    // validated env field the offline CLI does, so one operator setting
    // governs both entry points. Defaults ON in loadEnv (ADR-0009);
    // explicit off is the test/escape hatch.
    writeTimeSupersede: env.extractWriteTimeSupersede,
    logger,
  };
}

/**
 * A pool placeholder that pays for the pg driver only when extract actually
 * dials the database. The memoized promise keeps concurrent first calls from
 * constructing two pools (the ??= check is synchronous, so JS's
 * single-threaded event loop makes it atomic).
 */
function createLazyPgExtractPool(connectionString: string): ExtractPool {
  let pool: Promise<import("pg").Pool> | undefined;
  return {
    connect: () => {
      pool ??= import("pg").then(({ Pool }) => new Pool({ connectionString }));
      return pool.then((p) => p.connect());
    },
  };
}

export async function createServer(): Promise<McpServer> {
  const env = loadEnv();
  const logger = createLogger(env.logLevel);
  const deps = await buildDeps(env);
  // Debug gate: DEBUG=1 surfaces the retrieve envelope's `debug` payload.
  // Absent → no debug key.
  const debug = process.env.DEBUG === "1";
  const registry = buildRegistry([
    ingestTool({ ...deps, logger }),
    invalidationTool(deps),
    pushTool({ ...deps, logger }),
    // buildDeps' single ES precision layer is threaded through so extract
    // shares it instead of constructing a second ES client from env.
    extractTool(buildExtractDeps(env, logger, deps.precision)),
    retrieveTool(buildRetrieveDeps(deps, debug)),
  ]);

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } }
  );

  for (const tool of registry.values()) {
    registerOne(server, tool, logger);
  }

  logger.info("server constructed", {
    name: SERVER_NAME,
    version: SERVER_VERSION,
    tools: Array.from(registry.keys()),
    storage: env.storage,
    // Never log the key itself — only whether one was supplied.
    embedder: env.embedApiKey ? "9router" : "unavailable",
  });
  return server;
}

function registerOne(
  server: McpServer,
  tool: ToolRegistration,
  logger: ReturnType<typeof createLogger>
): void {
  // The SDK accepts a Zod object schema directly via McpServer.registerTool;
  // it converts to JSON Schema internally. We pass the full schema (not
  // `.shape`) so the SDK's own validation stays the source of truth.
  server.registerTool(
    tool.name,
    {
      description: tool.description,
      inputSchema: tool.inputSchema,
    },
    async (input) => {
      try {
        return await tool.handler(input);
      } catch (err) {
        // Mirror v2's internal `createToolError` shape: a plain text
        // content block with isError:true. v2's SDK would do this for us
        // (server/src/server/mcp.ts createToolError), but we keep the
        // try/catch to also surface stderr via the logger — hosts without
        // structured logging benefit from the observation.
        const message = redactDiagnostic(
          err instanceof Error ? err.message : err
        );
        logger.error("handler threw", { tool: tool.name, error: message });
        return textResult(message, true);
      }
    }
  );
}

export async function main(argv?: readonly string[]): Promise<void> {
  // Plan D0 I-T3: argv is validated up front so an operator typo can't
  // silently spin up a stdio MCP session that just hangs. The argv
  // parameter is injectable for tests; production callers leave it
  // undefined and we read process.argv.slice(2).
  const parsed = parseStdioEntry(argv ?? process.argv.slice(2));
  if (!parsed.ok) {
    writeStderr(`iknow-memory: ${parsed.error}\n`);
    process.exit(EXIT_CODES.BAD_CONFIG);
  }

  // Config first, and on its own: a ConfigError is an operator mistake, not
  // a crash, so it exits with BAD_CONFIG and a one-line message rather than
  // the stack trace the FATAL_RUNTIME path prints. createServer() re-reads
  // the env (it is a pure function of process.env), so this call both
  // validates early and gives us a logger before the transport opens.
  let env: GraphragEnv;
  try {
    env = loadEnv();
  } catch (err) {
    if (err instanceof ConfigError) {
      // stderr only; stdout is reserved for the MCP transport.
      writeStderr(`iknow-memory config error: ${err.message}\n`);
      process.exit(EXIT_CODES.BAD_CONFIG);
    }
    throw err;
  }
  const logger = createLogger(env.logLevel);

  // Stage 0 is stdio-only (map #33 defers HTTP to T-005/#36). Transport is
  // not a runtime knob, so there is no transport-rejection path here.
  let server: McpServer;
  try {
    server = await createServer();
  } catch (err) {
    if (err instanceof ConfigError) {
      writeStderr(`iknow-memory config error: ${err.message}\n`);
      process.exit(EXIT_CODES.BAD_CONFIG);
    }
    throw err;
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("stdio transport connected", { server: SERVER_NAME });
}

// Run only when invoked directly (not when imported for tests).
const isMain = (() => {
  if (typeof process === "undefined") return false;
  const arg1 = process.argv[1];
  if (!arg1) return false;
  // ESM entry path ends with /src/index.ts (dev) or /dist/index.js (prod).
  return arg1.endsWith("index.ts") || arg1.endsWith("index.js");
})();

if (isMain) {
  main().catch((err) => {
    // stderr only; never write to stdout (reserved for MCP transport).
    writeStderr(`iknow-memory fatal: ${redactDiagnostic(err)}\n`);
    process.exit(EXIT_CODES.FATAL_RUNTIME);
  });
}
