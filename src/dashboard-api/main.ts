/**
 * dashboard-api bin entry — loadEnv + same boot helpers as MCP, then listen.
 */
import { Pool } from "pg";

import { ConfigError, loadEnv, type GraphragEnv } from "../config.js";
import { createLogger, writeStderr } from "../logging.js";
import { buildRetrieveDeps, buildRetrieveReranker } from "../index.js";
import { NineRouterEmbedder, UnavailableEmbedder } from "../core/embedder.js";
import { createSlotEmbeddingSource } from "../core/embed-slots.js";
import { MemoryBackend } from "../core/storage/memory-backend.js";
import { ElasticsearchPrecisionLayer } from "../core/storage/elasticsearch-precision.js";
import { createNeo4jPprRanker } from "../core/graph/neo4j-ppr.js";
import { connectNeo4j } from "../core/graph/neo4j-writer.js";
import type { StorageBackend, StorageReadPort } from "../core/types.js";

import { createDashboardServer, readDashboardConfig } from "./index.js";
import { createNeo4jSessionFactory } from "./graph-session.js";
import type {
  BackfillPool,
  DrainPool,
  ExtractPool,
} from "./handlers/writes.js";

const EXIT_CODES = {
  FATAL_RUNTIME: 1,
  BAD_CONFIG: 2,
} as const;

async function buildStorage(
  env: GraphragEnv
): Promise<StorageBackend & StorageReadPort> {
  if (env.storage !== "pgvector") {
    return new MemoryBackend(env.embedDimensions);
  }
  if (env.dbUrl === undefined) {
    throw new ConfigError(
      "GRAPHRAG_MEMORY_DB_URL is required when GRAPHRAG_MEMORY_STORAGE=pgvector"
    );
  }
  let mod: typeof import("../core/storage/pgvector-backend.js");
  try {
    mod = await import("../core/storage/pgvector-backend.js");
  } catch (err) {
    throw new ConfigError(
      `GRAPHRAG_MEMORY_STORAGE=pgvector requires the optional "pg" dependency — \`npm install pg\` (${(err as Error).message})`
    );
  }
  const backend = new mod.PgvectorBackend(
    env.dbUrl,
    env.embedDimensions,
    undefined,
    {},
    env.embedModel
  );
  // The generation boot guard inside initialize() replaces the retired
  // drop-and-add dim align: desired ≠ active without an open rotate is a
  // typed ConfigError boot failure, never a DROP of the live column.
  await backend.initialize();
  return backend;
}

function buildEmbedder(env: GraphragEnv) {
  if (!env.embedApiKey) return new UnavailableEmbedder();
  if (env.embedBaseUrl === undefined || env.embedModel === undefined) {
    throw new ConfigError(
      "GRAPHRAG_MEMORY_EMBED_BASE_URL and GRAPHRAG_MEMORY_EMBED_MODEL are required when an embedding API key is configured"
    );
  }
  return new NineRouterEmbedder({
    baseUrl: env.embedBaseUrl,
    model: env.embedModel,
    apiKey: env.embedApiKey,
    dimensions: env.embedDimensions,
  });
}

export async function main(): Promise<void> {
  let env: GraphragEnv;
  let host: string;
  let port: number;
  try {
    env = loadEnv();
    ({ host, port } = readDashboardConfig());
  } catch (err) {
    if (err instanceof ConfigError) {
      writeStderr(`dashboard config error: ${err.message}\n`);
      process.exit(EXIT_CODES.BAD_CONFIG);
    }
    throw err;
  }
  const logger = createLogger(env.logLevel);
  const storage = await buildStorage(env);
  const embedder = buildEmbedder(env);
  const slotEmbedding = createSlotEmbeddingSource(
    {
      apiKey: env.embedApiKey,
      baseUrl: env.embedBaseUrl,
      model: env.embedModel,
      dimensions: env.embedDimensions,
    },
    embedder
  );
  const precision =
    env.elasticsearch === undefined
      ? undefined
      : new ElasticsearchPrecisionLayer(env.elasticsearch, {
          k1: env.retrieval.k1,
          b: env.retrieval.b,
        });
  const reranker = buildRetrieveReranker(env);
  const graphRanker =
    env.neo4j !== undefined ? createNeo4jPprRanker(env.neo4j) : undefined;
  const retrieveDeps = buildRetrieveDeps(
    {
      embedder,
      slotEmbedding,
      storage,
      ...(precision !== undefined ? { precision } : {}),
      retrieval: env.retrieval,
      ...(graphRanker !== undefined ? { graphRanker } : {}),
      ...(reranker !== undefined ? { reranker } : {}),
    },
    process.env.DEBUG === "1"
  );

  const openGraphSession =
    env.neo4j !== undefined ? createNeo4jSessionFactory(env.neo4j) : undefined;

  // T8 — wire the thin-write deps (operator-console T8). Ingest and
  // invalidate only need storage + embedder, so they stay available
  // even in memory mode. Extract needs LLM/embedding credentials +
  // Postgres; graph backfill/drain need a Postgres pool + Neo4j.
  // When the env does not provide them the dashboard-api still
  // boots; the corresponding routes register as typed-503 stubs.
  const pgPoolRaw =
    env.dbUrl !== undefined && env.storage === "pgvector"
      ? new Pool({
          connectionString: env.dbUrl,
        })
      : undefined;
  const pgPool: (ExtractPool & BackfillPool & DrainPool) | undefined =
    pgPoolRaw !== undefined
      ? (pgPoolRaw as unknown as ExtractPool & BackfillPool & DrainPool)
      : undefined;
  const writes: Parameters<typeof createDashboardServer>[0]["writes"] = {
    ingest: {
      embedder,
      slotEmbedding,
      storage,
      ...(precision !== undefined ? { precision } : {}),
      logger,
    },
    invalidate: {
      embedder,
      storage,
      ...(precision !== undefined ? { precision } : {}),
    },
    ...(pgPool !== undefined && env.embedApiKey !== undefined
      ? {
          extract: {
            llmEnv: {
              authToken: process.env.ANTHROPIC_AUTH_TOKEN,
              baseUrl: process.env.GRAPHRAG_MEMORY_ANTHROPIC_BASE_URL,
              model: process.env.GRAPHRAG_MEMORY_ANTHROPIC_MODEL,
            },
            embedderEnv: {
              apiKey: env.embedApiKey,
              baseUrl: env.embedBaseUrl,
              model: env.embedModel,
              dimensions: env.embedDimensions,
            },
            pool: pgPool,
            ...(precision !== undefined ? { precision } : {}),
            logger,
          },
        }
      : {}),
    ...(pgPool !== undefined && env.neo4j !== undefined
      ? {
          graphBackfill: {
            pool: pgPool,
            logger,
            connectGraph: () => connectNeo4j(env.neo4j!),
          },
          graphDrain: {
            pool: pgPool,
            logger,
            connectGraph: () => connectNeo4j(env.neo4j!),
          },
        }
      : {}),
  };

  const server = createDashboardServer({
    storage,
    embedder,
    retrieval: { retrieveConfig: env.retrieval },
    ...(retrieveDeps.lexical !== undefined
      ? { lexical: retrieveDeps.lexical }
      : {}),
    ...(retrieveDeps.entityLexical !== undefined
      ? { entityLexical: retrieveDeps.entityLexical }
      : {}),
    ...(graphRanker !== undefined ? { graphRanker } : {}),
    ...(reranker !== undefined ? { reranker } : {}),
    ...(openGraphSession !== undefined ? { openGraphSession } : {}),
    writes,
    storageMode: env.storage,
    version: "0.0.0",
    host,
    port,
  });

  server.listen(port, host, () => {
    logger.info("dashboard-api listening", {
      host,
      port,
      storage: env.storage,
    });
  });
}

const isMain = (() => {
  if (typeof process === "undefined") return false;
  const arg1 = process.argv[1];
  if (!arg1) return false;
  return (
    arg1.endsWith("dashboard-api/main.ts") ||
    arg1.endsWith("dashboard-api/main.js")
  );
})();

if (isMain) {
  main().catch((err) => {
    writeStderr(`dashboard fatal: ${(err as Error).message ?? err}\n`);
    process.exit(EXIT_CODES.FATAL_RUNTIME);
  });
}
