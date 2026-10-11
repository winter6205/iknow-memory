/**
 * Durable index-job worker — claims queued job rows and runs each one through
 * the existing graph-index stages.
 *
 * `submit_index_job` only queues; this process is what turns a queue entry into
 * a terminal state. The stages are composed, not copied: extract runs the core
 * pipeline, and the two stages that shipped as operator CLIs are called through
 * their own exported `runCli(argv, deps)` in this process, so their exit-code
 * and typed-error vocabularies stay where they are defined.
 *
 * Durability: the ledger marks a claimed row running (`started_at`), so a worker
 * that dies mid-stage leaves that row reclaimable once its lease window passes
 * (`--stalled-after`) instead of losing the request. Text stays searchable
 * throughout — nothing here touches `source_documents.status`.
 *
 * Modes (one per run):
 *   (default)               drain the queue, then exit
 *   --once                  claim and run at most one job
 *   --stalled-after <ms>    lease window after which a running job is reclaimable
 *
 * Exit-code map (mirrors graph-drain / community-summary):
 *   0 the queue answered empty and every claimed job settled
 *   1 config / fatal — missing GRAPHRAG_MEMORY_DB_URL or credentials, a
 *     Postgres or lock fault, or a job whose outcome could not be published
 *   2 usage error (unknown or malformed flag)
 */
import { Pool } from "pg";

import {
  ConfigError,
  loadEnv,
  readIngestBatchLimit,
  type GraphragEnv,
} from "../config.js";
import { resolveMemoryHome } from "../config/memory-home.js";
import { publishProcessReport } from "../config/process-fingerprint.js";
import {
  createLogger,
  redactDiagnostic,
  writeStderr,
  type Logger,
} from "../logging.js";
import {
  IndexJobStageError,
  runIndexJob,
  type IndexJobExtractOutcome,
  type IndexJobRunnerDeps,
  type IndexJobSourceVersion,
  type IndexJobStagePorts,
} from "../core/index-job.js";
import { buildPersistingExtractionClients } from "../core/extraction/clients.js";
import {
  INVALID_EXTRACT_METHOD_CODE,
  invalidExtractMethodMessage,
  isExtractMethod,
} from "../core/extraction/method.js";
import {
  notIndexed,
  processBatch,
  selectPendingChunksBySourceRef,
  type ExtractPipelineDeps,
} from "../core/extraction/pipeline.js";
import { createSlotSourceFromGraphragEnv } from "../core/embed-slots.js";
import {
  COMMUNITY_SUMMARY_INDEX_FAILURE,
  type ExtractMethod,
  type IndexJobRecord,
  type IndexJobStore,
} from "../core/types.js";
import { AnthropicCommunitySummaryClient } from "../core/graph/community-summary-llm.js";
import { createNeo4jCommunityDetector } from "../core/graph/neo4j-community.js";
import { openConfiguredNeo4j } from "../core/graph/neo4j-writer.js";
import { GRAPH_UNAVAILABLE_CODE } from "../core/graph/types.js";
import {
  createPrecisionLayer,
  type ElasticsearchPrecisionLayer,
} from "../core/storage/elasticsearch-precision.js";
import { advisoryLockKey } from "../core/storage/schema-lock.js";
import { PgvectorBackend } from "../core/storage/pgvector-backend.js";
import {
  CommunitySummaryJobError,
  runCli as runCommunitySummary,
  type CommunitySummaryDeps,
  type CommunitySummaryPool,
} from "./community-summary.js";
import {
  GRAPH_DRAIN_LOUD_SKIP_EXIT,
  runCli as runGraphDrain,
  type DrainDeps,
  type DrainPool,
} from "./graph-drain.js";

/** The projection stage did not finish, for any reason but a loud re-run. */
export const PROJECTION_DRAIN_FAILURE = "PROJECTION_DRAIN_FAILURE";

/** The extract stage hit its round ceiling with pending chunks still behind. */
export const INDEX_JOB_EXTRACT_INCOMPLETE = "INDEX_JOB_EXTRACT_INCOMPLETE";

/**
 * The deployment cannot run the summary stage at all: the worker builds the
 * stage's deps only from a configured Neo4j plus the summarizer credential.
 * The runner owns this literal because the stage has no name to forward —
 * `community-summary` answers a missing credential as prose plus exit 1 inside
 * `runCliFromEnv`, which this env-free `runCli(argv, deps)` seam never reaches,
 * and its typed `COMMUNITY_SUMMARY_NEO4J_NOT_CONFIGURED` skip names the
 * unconfigured-Neo4j case, which never gets here: the drain stage fails that
 * deployment first, with its own code.
 */
export const COMMUNITY_SUMMARY_NOT_CONFIGURED =
  "COMMUNITY_SUMMARY_NOT_CONFIGURED";

/**
 * One key for every job, so two worker processes never interleave a partial
 * summary generation: the community-summary swap publishes corpus-level C only
 * for the graph it saw, and an interleaved second job would make that claim
 * about "the current graph" false.
 */
export const JOB_SERIALIZATION_KEY = "iknow-memory:index-job";

/**
 * WHY a ceiling: a chunk whose write leg rolled back stays pending, so a broken
 * source can keep answering "more remain" forever. Stopping quietly would
 * publish `ready` over an unindexed remainder, so the stage refuses with a
 * typed code instead and the operator sees an incomplete job.
 */
export const EXTRACT_ROUND_CEILING = 100;

const DEFAULT_STALLED_AFTER_MS = 15 * 60 * 1000;

/**
 * The job serialization lock, as the worker takes it: a session-scoped advisory
 * lock on one dedicated connection. Exported because the gold suite holds THIS
 * lock to make a contended handoff observable — a copy of the statement would
 * let that test keep passing if the mechanism changed. `$1` is the shared
 * `advisoryLockKey(name)` bigint (as a decimal string), not the name: one
 * derivation for every advisory lock in the repo, 64-bit and independent of
 * the PostgreSQL major version.
 */
export const LOCK_ACQUIRE_SQL = "SELECT pg_advisory_lock($1::bigint)";
export const LOCK_RELEASE_SQL = "SELECT pg_advisory_unlock($1::bigint)";

const USAGE = "usage: index-job-worker [--once] [--stalled-after <ms>]";

/** Minimal pg surface the stages and the lock need, shared with test fakes. */
export interface WorkerClient {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
  /** An error argument makes the pool discard the client instead of reusing it. */
  release(err?: Error): void;
}

export interface WorkerPool {
  connect(): Promise<WorkerClient>;
  end(): Promise<void>;
}

/** A held serialization lock. */
export interface IndexJobLockHandle {
  release(): Promise<void>;
}

export interface IndexJobLock {
  acquire(key: string): Promise<IndexJobLockHandle>;
}

export interface IndexJobWorkerDeps extends IndexJobRunnerDeps {
  lock: IndexJobLock;
  extractionFingerprint?: string;
}

interface WorkerOptions {
  once: boolean;
  stalledAfterMs: number;
}

type ParsedArgs =
  { ok: true; options: WorkerOptions } | { ok: false; error: string };

export function parseArgs(argv: string[]): ParsedArgs {
  const options: WorkerOptions = {
    once: false,
    stalledAfterMs: DEFAULT_STALLED_AFTER_MS,
  };
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;
    if (arg === "--once") options.once = true;
    else if (arg === "--stalled-after") {
      const raw = argv[i + 1];
      const ms = Number(raw);
      if (raw === undefined || !Number.isInteger(ms) || ms <= 0) {
        return {
          ok: false,
          error: `--stalled-after requires a positive integer of milliseconds`,
        };
      }
      options.stalledAfterMs = ms;
      i += 1;
    } else {
      return { ok: false, error: `unknown flag: "${arg}"` };
    }
    i += 1;
  }
  return { ok: true, options };
}

/** Top-level entry, testable: claim, run, settle, repeat until the queue is empty. */
export async function runCli(
  argv: string[],
  deps: IndexJobWorkerDeps
): Promise<number> {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    writeStderr(`${USAGE}\nindex-job-worker: ${parsed.error}\n`);
    return 2;
  }
  const options = parsed.options;
  let claimed = 0;
  let unsettled = 0;
  for (;;) {
    if (options.once && claimed > 0) break;
    try {
      const job = await claimNext(deps, options);
      if (job === null) break;
      claimed += 1;
      if (!(await runClaimedJob(deps, job))) unsettled += 1;
    } catch (err) {
      // EXIT: the claim, the lock, or the release itself faulted — no further
      // job can be claimed safely, so this ends the run loudly.
      reportFatal(deps.logger, err);
      return 1;
    }
  }
  deps.logger.info("index-job-worker-drained", { claimed, unsettled });
  if (unsettled > 0) {
    writeStderr(
      `index-job-worker: ${unsettled} job(s) ended without a published outcome; ` +
        `their rows stay running and are reclaimable after ${options.stalledAfterMs}ms\n`
    );
    return 1;
  }
  return 0;
}

export class ExtractionFingerprintStampError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class MissingExtractionFingerprintError extends ExtractionFingerprintStampError {
  constructor() {
    super("missing extraction fingerprint");
  }
}

export class IndexJobStampUnavailableError extends ExtractionFingerprintStampError {
  constructor() {
    super("index job store cannot stamp extraction fingerprint");
  }
}

async function stampClaimedExtraction(
  deps: IndexJobWorkerDeps,
  job: IndexJobRecord
): Promise<void> {
  const fingerprint = deps.extractionFingerprint;
  if (fingerprint === undefined || fingerprint === "") {
    throw new MissingExtractionFingerprintError();
  }
  const store: Partial<Pick<IndexJobStore, "stampExtractionFingerprint">> =
    deps.store;
  if (store.stampExtractionFingerprint === undefined) {
    throw new IndexJobStampUnavailableError();
  }
  await store.stampExtractionFingerprint({
    jobId: job.job_id,
    sourceRef: job.source_ref,
    fingerprint,
  });
}

async function claimNext(
  deps: IndexJobWorkerDeps,
  options: WorkerOptions
): Promise<IndexJobRecord | null> {
  const startedAt = (deps.clock?.() ?? new Date()).toISOString();
  const stalledBefore = new Date(
    Date.parse(startedAt) - options.stalledAfterMs
  ).toISOString();
  return await deps.store.claimNextJob({ startedAt, stalledBefore });
}

/**
 * Run one claimed job under the serialization lock and answer whether the
 * ledger carries its terminal outcome.
 */
async function runClaimedJob(
  deps: IndexJobWorkerDeps,
  job: IndexJobRecord
): Promise<boolean> {
  const handle = await deps.lock.acquire(JOB_SERIALIZATION_KEY);
  try {
    await stampClaimedExtraction(deps, job);
    await runIndexJob(deps, job);
    return true;
  } catch (err) {
    if (err instanceof ExtractionFingerprintStampError) throw err;
    // EXIT: an untyped stage fault writes no terminal state on purpose, so the
    // stalled-lease arm re-claims the row; one bad job never ends the run for
    // the rest of the queue.
    deps.logger.error("index-job-unsettled", {
      jobId: job.job_id,
      error: redactDiagnostic(err instanceof Error ? err.message : err),
    });
    return false;
  } finally {
    await handle.release();
  }
}

export interface StageAdapterDeps {
  pool: WorkerPool;
  pipelineDeps: ExtractPipelineDeps;
  batchLimit: number;
  drainDeps: DrainDeps;
  /** Undefined when the deployment gives the stage nothing to run with — no
   * projection target or no summarizer credential. The stage then answers the
   * runner's own `COMMUNITY_SUMMARY_NOT_CONFIGURED`. */
  summaryDeps: CommunitySummaryDeps | undefined;
}

export function createIndexJobStagePorts(
  deps: StageAdapterDeps
): IndexJobStagePorts {
  return {
    readSourceVersion: (sourceRef) => readSourceVersion(deps.pool, sourceRef),
    runExtract: (sourceRef, method) => runExtractStage(deps, sourceRef, method),
    drainProjection: () => drainStage(deps.drainDeps),
    summarizeCommunities: () => summarizeStage(deps.summaryDeps),
  };
}

/** The two 资料 fields the runner decides on, read by the worker's own seam. */
async function readSourceVersion(
  pool: WorkerPool,
  sourceRef: string
): Promise<IndexJobSourceVersion | null> {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT content_identity, extract_method FROM source_documents
        WHERE source_ref = $1`,
      [sourceRef]
    );
    const row = rows[0] as
      | { content_identity: string | null; extract_method: string | null }
      | undefined;
    if (row === undefined) return null;
    const recorded = row.extract_method;
    // WHY forwarded and not folded: a recorded value outside {standard, fast}
    // can be re-extracted by no method, so nulling it would silently reroute the
    // leg onto `standard`. The vocabulary rule and the code it answers with are
    // `method.ts`'s; the runner names nothing of its own here.
    if (recorded !== null && !isExtractMethod(recorded)) {
      throw new IndexJobStageError(
        INVALID_EXTRACT_METHOD_CODE,
        invalidExtractMethodMessage(recorded)
      );
    }
    return {
      contentIdentity: row.content_identity ?? null,
      extractMethod: recorded,
    };
  } finally {
    client.release();
  }
}

async function runExtractStage(
  deps: StageAdapterDeps,
  sourceRef: string,
  method: ExtractMethod | null
): Promise<IndexJobExtractOutcome> {
  const client = await deps.pool.connect();
  try {
    let processed = 0;
    let failed = 0;
    let writeFailures = 0;
    const failureCodes: string[] = [];
    for (let round = 0; ; round += 1) {
      if (round >= EXTRACT_ROUND_CEILING) {
        throw new IndexJobStageError(
          INDEX_JOB_EXTRACT_INCOMPLETE,
          `pending chunks for ${sourceRef} still remained after ${EXTRACT_ROUND_CEILING} batches of ${deps.batchLimit}`
        );
      }
      const scan = await selectPendingChunksBySourceRef(
        client,
        sourceRef,
        deps.batchLimit
      );
      if (scan.chunks.length === 0) break;
      const summary = await processBatch(
        deps.pipelineDeps,
        client,
        scan.chunks,
        {
          batchSize: deps.batchLimit,
          ...(method === null ? {} : { method }),
        }
      );
      processed += summary.processed;
      // The two not-indexed legs stay apart: a rolled-back leg sealed no record
      // and so carries no code of its own, which is why the stage's failure
      // code comes from `batchFailureCode` and not from a count here. They share
      // one reason to stop the rescan — neither indexed anything, and a
      // rolled-back chunk is still pending, so a rescan would hand back the same
      // batch instead of draining it. The job records this attempt; the chunk
      // waits for the next extract run.
      failed += summary.failed;
      writeFailures += summary.writeFailures;
      failureCodes.push(...summary.failureCodes);
      // EXIT: the first leg that indexed nothing ends the stage.
      if (notIndexed(summary) > 0 || !scan.hasMore) break;
    }
    return { processed, failed, writeFailures, failureCodes };
  } finally {
    client.release();
  }
}

async function drainStage(deps: DrainDeps): Promise<void> {
  // Re-arm first: a previous run's `failed` intent stays out of the pending
  // scan, so a drain over an empty queue would exit 0 and let this job publish
  // `ready` while an earlier projection leg never landed.
  const rearmed = await runGraphDrain(["--retry-failed"], deps);
  if (rearmed !== 0) {
    throw new IndexJobStageError(
      PROJECTION_DRAIN_FAILURE,
      `projection outbox re-arm exited ${rearmed}`
    );
  }
  const exit = await runGraphDrain([], deps);
  if (exit === 0) return;
  // WHY the split: exit 3 is the drain's own "Neo4j unreachable, queue intact,
  // re-run safe" answer, so the projection's name for that fault is the honest
  // one; any other non-zero exit means this job's projection did not land.
  throw new IndexJobStageError(
    exit === GRAPH_DRAIN_LOUD_SKIP_EXIT
      ? GRAPH_UNAVAILABLE_CODE
      : PROJECTION_DRAIN_FAILURE,
    `projection drain exited ${exit}`
  );
}

async function summarizeStage(
  deps: CommunitySummaryDeps | undefined
): Promise<void> {
  const code = await communitySummaryFault(deps);
  if (code === null) return;
  throw new IndexJobStageError(
    code,
    "community detect + summarize + swap did not complete"
  );
}

/** The summary job's outcome mapped to a code, null when it published its swap. */
async function communitySummaryFault(
  deps: CommunitySummaryDeps | undefined
): Promise<string | null> {
  if (deps === undefined) return COMMUNITY_SUMMARY_NOT_CONFIGURED;
  let exit: number;
  try {
    exit = await runCommunitySummary([], deps);
  } catch (err) {
    if (err instanceof CommunitySummaryJobError) {
      return COMMUNITY_SUMMARY_INDEX_FAILURE;
    }
    throw err;
  }
  if (exit === 0) return null;
  // EXIT: `runCli` answers non-zero only for a usage error, and this call site
  // passes no argv, so a non-zero here is a worker bug rather than a stage
  // outcome — naming it as one would let a defect read as a product failure.
  throw new Error(`community summary CLI exited ${exit}`);
}

/**
 * A session-level advisory lock on a dedicated connection, held for the whole
 * job. Session scope is the point: the lock must outlive every statement of
 * every stage, which a transaction-scoped lock cannot do.
 */
export function createSessionAdvisoryLock(
  pool: WorkerPool,
  logger: Logger
): IndexJobLock {
  return {
    async acquire(key: string): Promise<IndexJobLockHandle> {
      const lockKey = advisoryLockKey(key).toString();
      const client = await pool.connect();
      try {
        await client.query(LOCK_ACQUIRE_SQL, [lockKey]);
      } catch (err) {
        client.release();
        throw err;
      }
      return {
        async release(): Promise<void> {
          try {
            await client.query(LOCK_RELEASE_SQL, [lockKey]);
            client.release();
          } catch (err) {
            // EXIT: a session lock survives its connection being returned to
            // the pool, so a failed unlock ends the connection instead — that
            // is what actually drops the lock. The error argument is what makes
            // pg discard the client rather than queue it for reuse: `end()` on a
            // pooled client leaves the pool's own bookkeeping holding a slot
            // that no longer serves, and `pool.end()` then never resolves.
            logger.warn("index-job-lock-unlock-failed", {
              error: redactDiagnostic(err instanceof Error ? err.message : err),
            });
            client.release(
              new Error("index-job lock release: advisory unlock failed")
            );
          }
        },
      };
    },
  };
}

interface WorkerParts {
  env: GraphragEnv;
  pool: Pool;
  store: PgvectorBackend;
  precision: ElasticsearchPrecisionLayer | undefined;
  logger: Logger;
}

/** Real stage wiring: one pool, the pipeline clients the extract tool uses,
 * and the two sibling CLIs' own dep shapes. */
function buildWorkerDeps(parts: WorkerParts): IndexJobWorkerDeps {
  const { env, pool, store, precision, logger } = parts;
  const { llm, embedder } = buildPersistingExtractionClients(env);
  const slotEmbedding = createSlotSourceFromGraphragEnv(env, embedder);
  const pipelineDeps: ExtractPipelineDeps = {
    llm,
    embedder,
    logger,
    slotEmbedding,
    writeTimeSupersede: env.extractWriteTimeSupersede,
    ...(precision === undefined ? {} : { precision }),
  };
  const summaryLlm = env.llm.summary;
  const summaryDeps: CommunitySummaryDeps | undefined =
    env.neo4j === undefined || summaryLlm.apiKey === undefined
      ? undefined
      : {
          pool: pool as unknown as CommunitySummaryPool,
          detector: createNeo4jCommunityDetector(env.neo4j),
          summarizer: new AnthropicCommunitySummaryClient({
            apiKey: summaryLlm.apiKey,
            model: summaryLlm.model,
            baseUrl: summaryLlm.baseUrl,
          }),
          embedder,
          dimensions: env.embedDimensions,
          logger,
          slotEmbedding,
          summaryIndexer: precision,
        };
  const workerPool = pool as unknown as WorkerPool;
  const drainDeps: DrainDeps = {
    pool: pool as unknown as DrainPool,
    logger,
    connectGraph: () =>
      openConfiguredNeo4j(env.neo4j, "to drain the projection outbox"),
  };
  return {
    store,
    ports: createIndexJobStagePorts({
      pool: workerPool,
      pipelineDeps,
      // The cap is the shared GRAPHRAG_MEMORY_INGEST_BATCH_LIMIT, read from its
      // own owner: the same ceiling the extract tool caps a batch at.
      batchLimit: readIngestBatchLimit(),
      drainDeps,
      summaryDeps,
    }),
    logger,
    lock: createSessionAdvisoryLock(workerPool, logger),
  };
}

function reportFatal(logger: Logger, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  writeStderr(`index-job-worker fatal: ${message}\n`);
  logger.error("index-job-worker-fatal", { error: redactDiagnostic(message) });
}

function reportConfigError(err: unknown): number {
  if (!(err instanceof ConfigError)) throw err;
  writeStderr(`index-job-worker config error: ${err.message}\n`);
  return 1;
}

/** Wire real deps from env and run; used by main(). */
export async function runCliFromEnv(argv: string[]): Promise<number> {
  let env: GraphragEnv;
  try {
    env = loadEnv();
  } catch (err) {
    return reportConfigError(err);
  }
  if (env.dbUrl === undefined) {
    writeStderr(
      "index-job-worker config error: GRAPHRAG_MEMORY_DB_URL is required\n"
    );
    return 1;
  }
  const logger = createLogger(env.logLevel);
  const pool = new Pool({ connectionString: env.dbUrl });
  const store = new PgvectorBackend(env.dbUrl, env.embedDimensions, {
    embedModel: env.embedModel,
    embedBaseUrl: env.embedBaseUrl,
  });
  const precision = createPrecisionLayer(env);
  try {
    // Deps before the store: the credential guards are pure construction, so a
    // keyless worker reports its config fault without dialling Postgres.
    const deps = buildWorkerDeps({ env, pool, store, precision, logger });
    await store.initialize();
    const fingerprints = await publishProcessReport(
      "index-worker",
      env,
      resolveMemoryHome({
        iknowMemoryHome: process.env.IKNOW_MEMORY_HOME,
        osHome: process.env.HOME,
      })
    );
    return await runCli(argv, {
      ...deps,
      extractionFingerprint: fingerprints.extraction,
    });
  } catch (err) {
    return reportConfigError(err);
  } finally {
    if (precision !== undefined) await precision.close();
    await store.close();
    await pool.end();
  }
}

/** Top-level entry: wire real deps, exit with the CLI exit code. */
export async function main(): Promise<void> {
  process.exit(await runCliFromEnv(process.argv.slice(2)));
}

const isMain = (() => {
  const arg1 = process.argv[1];
  return (
    arg1 !== undefined &&
    (arg1.endsWith("cli/index-job-worker.ts") ||
      arg1.endsWith("cli/index-job-worker.js"))
  );
})();

if (isMain) {
  main().catch((err) => {
    writeStderr(
      `index-job-worker fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`
    );
    process.exit(1);
  });
}
