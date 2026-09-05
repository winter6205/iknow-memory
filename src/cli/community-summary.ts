/**
 * Index-time community summary CLI.
 *
 * The flow is GDS Louvain → load live entity names from Postgres → summarize
 * with the configured LLM → embed the summary → upsert the Postgres ledger
 * row. Neo4j is read-only here. A failed detector or failed individual
 * summary fails the job; individual summary failures do not abort the batch.
 *
 * Exit-code map:
 *   0 successful summary run
 *   1 configuration / fatal error, including a typed job failure
 *   2 usage error
 *   3 documented skip — no Neo4j URI, so Louvain is not attempted
 */
import { randomUUID } from "node:crypto";
import { Pool } from "pg";

import {
  ConfigError,
  loadEnv,
  NEO4J_URI_VAR,
  type GraphragEnv,
} from "../config.js";
import { createLogger, type Logger, writeStderr } from "../logging.js";
import { NineRouterEmbedder, type EmbeddingClient } from "../core/embedder.js";
import {
  createNeo4jCommunityDetector,
  type Community,
  type CommunityDetector,
} from "../core/graph/neo4j-community.js";
import {
  AnthropicCommunitySummaryClient,
  type CommunitySummaryClient,
} from "../core/graph/community-summary-llm.js";
import { upSchemaP0 } from "../core/storage/schema-p0.js";

export type {
  Community,
  CommunityDetector,
} from "../core/graph/neo4j-community.js";
export type { CommunitySummaryClient } from "../core/graph/community-summary-llm.js";

export interface CommunitySummaryDbClient {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
  release(): void;
}

export interface CommunitySummaryPool {
  connect(): Promise<CommunitySummaryDbClient>;
  end(): Promise<void>;
}

export interface CommunitySummaryDeps {
  pool: CommunitySummaryPool;
  detector: CommunityDetector;
  summarizer: CommunitySummaryClient;
  embedder: EmbeddingClient;
  dimensions: number;
  logger: Logger;
}

interface Flags {
  dryRun: boolean;
}

export const COMMUNITY_SUMMARY_SKIP_EXIT = 3;
export const COMMUNITY_SUMMARY_JOB_EXIT = 1;

export class CommunitySummarySkipError extends Error {
  readonly code = "COMMUNITY_SUMMARY_NEO4J_NOT_CONFIGURED" as const;
  readonly exitCode = COMMUNITY_SUMMARY_SKIP_EXIT;

  constructor() {
    super(`${NEO4J_URI_VAR} is not configured; Louvain was not attempted`);
    this.name = "CommunitySummarySkipError";
  }
}

export type CommunitySummaryJobFailurePhase = "detection" | "summary";

export class CommunitySummaryJobError extends Error {
  readonly code = "COMMUNITY_SUMMARY_JOB_FAILED" as const;
  readonly exitCode = COMMUNITY_SUMMARY_JOB_EXIT;

  constructor(
    readonly phase: CommunitySummaryJobFailurePhase,
    message: string,
    readonly cause: unknown,
    readonly communityId?: string
  ) {
    super(`community summary ${phase} failed: ${message}`, { cause });
    this.name = "CommunitySummaryJobError";
  }
}

const USAGE = "usage: community-summary [--dry-run]";

export function parseArgs(
  argv: string[]
): { ok: true; flags: Flags } | { ok: false; error: string } {
  const flags: Flags = { dryRun: false };
  for (const arg of argv) {
    if (arg === "--dry-run") flags.dryRun = true;
    else return { ok: false, error: `unknown flag: "${arg}"` };
  }
  return { ok: true, flags };
}

export async function runCli(
  argv: string[],
  deps: CommunitySummaryDeps
): Promise<number> {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    writeStderr(`${USAGE}\ncommunity-summary: ${parsed.error}\n`);
    return 2;
  }
  const client = await deps.pool.connect();
  try {
    if (!parsed.flags.dryRun) {
      await upSchemaP0(client, deps.dimensions);
    }
    let communities: Community[];
    try {
      communities = await deps.detector.detect();
    } catch (err) {
      deps.logger.warn("community-detection-failed", {
        error: errorMessage(err),
      });
      throw new CommunitySummaryJobError("detection", errorMessage(err), err);
    }
    if (parsed.flags.dryRun) {
      deps.logger.info("community-summary-plan", {
        communities: communities.length,
      });
      return 0;
    }

    if (communities.length === 0) {
      await clearCommunitySummaries(client);
      deps.logger.info("community-summaries-cleared", {
        reason: "community-detection-returned-empty",
      });
      return 0;
    }

    let stored = 0;
    let failed = 0;
    let firstFailure: CommunitySummaryJobError | undefined;
    for (const community of communities) {
      try {
        const names = await loadEntityNames(client, community.entityIds);
        if (names.length === 0) continue;
        const summary = (await deps.summarizer.summarize(names)).trim();
        if (summary === "")
          throw new Error("summary client returned empty text");
        const [embedding] = await deps.embedder.embed([summary]);
        if (embedding === undefined || embedding.length === 0) {
          throw new Error("summary embedder returned no vector");
        }
        await upsertSummary(client, community, summary, embedding);
        stored += 1;
      } catch (err) {
        // EXIT: 单个 community 失败仅记录并继续批处理，不阻断其他摘要。
        failed += 1;
        firstFailure ??= new CommunitySummaryJobError(
          "summary",
          errorMessage(err),
          err,
          community.id
        );
        deps.logger.warn("community-summary-failed", {
          communityId: community.id,
          error: errorMessage(err),
        });
      }
    }
    deps.logger.info("community-summary-complete", {
      communities: communities.length,
      stored,
      failed,
    });
    if (firstFailure !== undefined) throw firstFailure;
    return 0;
  } finally {
    client.release();
    try {
      await deps.detector.close();
    } catch (err) {
      deps.logger.warn("community-detector-close-failed", {
        error: errorMessage(err),
      });
    }
  }
}

async function clearCommunitySummaries(
  client: CommunitySummaryDbClient
): Promise<void> {
  await client.query("DELETE FROM community_summaries", []);
}

async function loadEntityNames(
  client: CommunitySummaryDbClient,
  entityIds: readonly string[]
): Promise<string[]> {
  if (entityIds.length === 0) return [];
  const result = await client.query(
    `SELECT canonical_name FROM entities
      WHERE id = ANY($1::uuid[]) AND retired = false
      ORDER BY id`,
    [[...entityIds]]
  );
  return result.rows
    .map((row) => row.canonical_name)
    .filter((name): name is string => typeof name === "string" && name !== "");
}

async function upsertSummary(
  client: CommunitySummaryDbClient,
  community: Community,
  summary: string,
  embedding: number[]
): Promise<void> {
  await client.query(
    `INSERT INTO community_summaries
       (id, community_id, summary, entity_ids, embedding)
     VALUES ($1, $2, $3, $4, $5::vector)
     ON CONFLICT (community_id) DO UPDATE SET
       summary = EXCLUDED.summary,
       entity_ids = EXCLUDED.entity_ids,
       embedding = EXCLUDED.embedding,
       updated_at = now()`,
    [
      randomUUID(),
      community.id,
      summary,
      [...community.entityIds],
      toVectorLiteral(embedding),
    ]
  );
}

function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function runCliFromEnv(argv: string[]): Promise<number> {
  let env: GraphragEnv;
  try {
    env = loadEnv();
  } catch (err) {
    if (err instanceof ConfigError) {
      writeStderr(`community-summary config error: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
  if (env.dbUrl === undefined) {
    writeStderr(
      "community-summary config error: GRAPHRAG_MEMORY_DB_URL is required\n"
    );
    return 1;
  }
  let neo4j: NonNullable<GraphragEnv["neo4j"]>;
  try {
    if (env.neo4j === undefined) throw new CommunitySummarySkipError();
    neo4j = env.neo4j;
  } catch (err) {
    if (!(err instanceof CommunitySummarySkipError)) throw err;
    writeStderr(
      `community-summary skipped [${err.code}]: ${err.message}; EXIT: ${err.exitCode}\n`
    );
    return err.exitCode;
  }
  if (env.rerank === undefined || env.embedApiKey === undefined) {
    writeStderr(
      "community-summary config error: Anthropic and embedding credentials are required\n"
    );
    return 1;
  }

  const pool = new Pool({ connectionString: env.dbUrl });
  const deps: CommunitySummaryDeps = {
    pool: pool as unknown as CommunitySummaryPool,
    detector: createNeo4jCommunityDetector(neo4j),
    summarizer: new AnthropicCommunitySummaryClient({
      apiKey: env.rerank.apiKey,
      model: env.rerank.model,
      baseUrl: env.rerank.baseUrl,
    }),
    embedder: new NineRouterEmbedder({
      baseUrl: env.embedBaseUrl!,
      model: env.embedModel!,
      apiKey: env.embedApiKey,
      dimensions: env.embedDimensions,
    }),
    dimensions: env.embedDimensions,
    logger: createLogger(env.logLevel),
  };
  try {
    return await runCli(argv, deps);
  } finally {
    await pool.end();
  }
}

export async function main(): Promise<void> {
  process.exit(await runCliFromEnv(process.argv.slice(2)));
}

const isMain = (() => {
  const arg1 = process.argv[1];
  return (
    arg1 !== undefined &&
    (arg1.endsWith("cli/community-summary.ts") ||
      arg1.endsWith("cli/community-summary.js"))
  );
})();

if (isMain) {
  main().catch((err) => {
    writeStderr(`community-summary fatal: ${errorMessage(err)}\n`);
    process.exit(1);
  });
}
