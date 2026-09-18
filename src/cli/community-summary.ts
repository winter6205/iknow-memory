/**
 * Index-time community summary CLI.
 *
 * The flow is hierarchical GDS Leiden (T2) → load live entity names from
 * Postgres → summarize EVERY community with the configured LLM into an
 * in-memory generation FIRST → swap the whole generation into the Postgres
 * ledger in ONE transaction. Neo4j is read-only here.
 *
 * All-or-nothing (graph-index-standard-fast T5, spec assumption 10): any
 * community that errors or yields an empty summary fails the job with a
 * typed error BEFORE any ledger write, and moves the corpus-level C-ready
 * row (`community_index_state`) to `failed` / `community_summary_index_failure`
 * so the previous report set is never served as current C. A re-run that
 * succeeds replaces the previous generation atomically: readers see either
 * the old set or the complete new set plus its `ready` state — never a mix.
 * A community whose entities are ALL retired is deterministically omitted
 * from the new generation; nothing exists to summarize, so it is not a
 * failure.
 *
 * Exit-code map:
 *   0 successful summary run
 *   1 configuration / fatal error, including a typed job failure
 *   2 usage error
 *   3 documented skip — no Neo4j URI, so Leiden is not attempted
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
import { upSchemaBootstrap } from "../core/storage/schema-bootstrap.js";
import {
  COMMUNITY_INDEX_STATUS,
  COMMUNITY_SUMMARY_INDEX_FAILURE,
  type CommunityIndexStatus,
} from "../core/types.js";

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
    super(`${NEO4J_URI_VAR} is not configured; Leiden was not attempted`);
    this.name = "CommunitySummarySkipError";
  }
}

/**
 * Failure phases of the summary job. `detection` covers a broken or
 * unavailable Leiden run (including malformed output), `summary` covers
 * generation (names lookup, LLM, embedder), `persist` covers the ledger
 * swap transaction itself.
 */
export type CommunitySummaryJobFailurePhase =
  | "detection"
  | "summary"
  | "persist";

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
    return await runSummaryJob(client, deps, parsed.flags.dryRun);
  } catch (err) {
    // EXIT: a typed job failure moves C off `ready` before the process
    // exits non-zero; the state write is best-effort so it never masks the
    // primary error. Dry-run reports only — it must not move C state.
    if (
      !parsed.flags.dryRun &&
      err instanceof CommunitySummaryJobError
    ) {
      await markStateBestEffort(
        client,
        deps.logger,
        COMMUNITY_INDEX_STATUS.FAILED,
        COMMUNITY_SUMMARY_INDEX_FAILURE
      );
    }
    throw err;
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

async function runSummaryJob(
  client: CommunitySummaryDbClient,
  deps: CommunitySummaryDeps,
  dryRun: boolean
): Promise<number> {
  if (!dryRun) {
    await upSchemaBootstrap(client, deps.dimensions);
    // Rebuild-in-progress is C-not-ready: a job that dies before its swap
    // leaves `in_progress`, so the previous set is not served until a
    // successful rerun publishes the new generation.
    await markStateBestEffort(
      client,
      deps.logger,
      COMMUNITY_INDEX_STATUS.IN_PROGRESS,
      null
    );
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
  if (dryRun) {
    deps.logger.info("community-summary-plan", {
      communities: communities.length,
    });
    return 0;
  }
  assertUniqueCommunityIds(communities);
  // Generation first, writes last: nothing touches the ledger until every
  // summary exists, which is what makes the job all-or-nothing. An empty
  // detection result is a complete (empty) generation and clears the ledger.
  const pending = await generatePendingSummaries(client, communities, deps);
  try {
    await swapCommunitySummaries(client, pending);
  } catch (err) {
    throw new CommunitySummaryJobError("persist", errorMessage(err), err);
  }
  deps.logger.info("community-summary-complete", {
    communities: communities.length,
    stored: pending.length,
    skipped: communities.length - pending.length,
  });
  return 0;
}

/**
 * Leiden's hierarchy numbers communities globally, and the ledger UNIQUEs
 * `community_id`; a duplicate is malformed detector output and must fail as
 * a typed detection error, never as a mid-swap constraint violation.
 */
function assertUniqueCommunityIds(communities: readonly Community[]): void {
  const seen = new Set<string>();
  for (const community of communities) {
    if (seen.has(community.id)) {
      throw new CommunitySummaryJobError(
        "detection",
        `duplicate community id "${community.id}" in detector output`,
        undefined,
        community.id
      );
    }
    seen.add(community.id);
  }
}

interface PendingSummary {
  communityId: string;
  entityIds: string[];
  summary: string;
  embedding: number[];
}

async function generatePendingSummaries(
  client: CommunitySummaryDbClient,
  communities: readonly Community[],
  deps: CommunitySummaryDeps
): Promise<PendingSummary[]> {
  const pending: PendingSummary[] = [];
  for (const community of communities) {
    try {
      const names = await loadEntityNames(client, community.entityIds);
      if (names.length === 0) {
        // EXIT: fully retired community — nothing to summarize; the row is
        // deterministically absent from the new generation, not a failure.
        deps.logger.warn("community-summary-skipped-retired", {
          communityId: community.id,
        });
        continue;
      }
      const summary = (await deps.summarizer.summarize(names)).trim();
      if (summary === "")
        throw new Error("summary client returned empty text");
      const [embedding] = await deps.embedder.embed([summary]);
      if (embedding === undefined || embedding.length === 0) {
        throw new Error("summary embedder returned no vector");
      }
      pending.push({
        communityId: community.id,
        entityIds: [...community.entityIds],
        summary,
        embedding,
      });
    } catch (err) {
      // EXIT: all-or-nothing — the first empty/error aborts the job before
      // any ledger write; the previous generation stays intact but C moves
      // to not-ready (runCli's typed-failure path).
      throw new CommunitySummaryJobError(
        "summary",
        errorMessage(err),
        err,
        community.id
      );
    }
  }
  return pending;
}

/**
 * Atomically replace the whole report generation: DELETE + INSERTs + the
 * `ready` state write share one transaction, so concurrent readers observe
 * either the previous set (with its previous state) or the complete new set
 * marked ready — never a half-old/half-new mix. A plain INSERT (no upsert)
 * is deliberate: after the in-transaction DELETE any conflict is a real
 * error that rolls the whole swap back.
 */
async function swapCommunitySummaries(
  client: CommunitySummaryDbClient,
  pending: readonly PendingSummary[]
): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query("DELETE FROM community_summaries", []);
    for (const row of pending) {
      await client.query(
        `INSERT INTO community_summaries
           (id, community_id, summary, entity_ids, embedding)
         VALUES ($1, $2, $3, $4, $5::vector)`,
        [
          randomUUID(),
          row.communityId,
          row.summary,
          row.entityIds,
          toVectorLiteral(row.embedding),
        ]
      );
    }
    await markCommunityIndexState(
      client,
      COMMUNITY_INDEX_STATUS.READY,
      null
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

/**
 * The singleton C-ready row (see `COMMUNITY_INDEX_STATUS` in core/types).
 * Called inside the swap transaction for `ready`, and outside it (via
 * `markStateBestEffort`) for the in-progress / failed transitions.
 */
async function markCommunityIndexState(
  client: CommunitySummaryDbClient,
  status: CommunityIndexStatus,
  failureCode: string | null
): Promise<void> {
  await client.query(
    `INSERT INTO community_index_state (id, status, failure_code, updated_at)
     VALUES (1, $1, $2, now())
     ON CONFLICT (id) DO UPDATE SET
       status = EXCLUDED.status,
       failure_code = EXCLUDED.failure_code,
       updated_at = now()`,
    [status, failureCode]
  );
}

async function markStateBestEffort(
  client: CommunitySummaryDbClient,
  logger: Logger,
  status: CommunityIndexStatus,
  failureCode: string | null
): Promise<void> {
  try {
    await markCommunityIndexState(client, status, failureCode);
  } catch (err) {
    // EXIT: observability metadata must not replace the primary failure;
    // mirrors push.ts's secondary status-write posture.
    logger.warn("community-index-state-write-failed", {
      status,
      error: errorMessage(err),
    });
  }
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
