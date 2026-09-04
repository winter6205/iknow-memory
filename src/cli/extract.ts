/**
 * Extraction CLI — offline trigger for the LLM triple-extraction + merge
 * pipeline (T6). Never an MCP tool: the server stays ingest+retrieve only.
 *
 * Pipeline: scan `chunks` with no `succeeded` extraction_records row → batch →
 * per-chunk transaction (record + entities + triples) → out.
 *
 * Exit-code map (spec's "exit codes 0/1/2" contract):
 *   0 success — incl. `--dry-run`, `--list-unmapped`, `--list-failed`,
 *     `--backfill-embeddings`, and mark-and-continue batches where SOME
 *     chunks failed extraction (Success Criterion #6).
 *   1 config / fatal — bad DB URL, Postgres unreachable, ConfigError.
 *   2 usage error (unknown / malformed / mutually exclusive flags) OR a
 *     write-partial-failure (a chunk's transaction rolled back — distinct
 *     from the expected per-chunk extraction failures mark-and-continue
 *     absorbs).
 *
 * LLM client: `AnthropicLLMClient` when ANTHROPIC_AUTH_TOKEN is
 * set. With the key unset, `FakeLLMClient` (canned ok) is only used by the
 * non-extraction flags `--dry-run`, `--list-unmapped`, `--list-failed` and
 * `--backfill-embeddings`; a *real* extraction with no key throws ConfigError
 * (exit 1) instead of silently writing canned triples (CR High #1).
 *
 * Embedder: the same guard on the embedding half. `FakeEmbedder` is legal
 * only for the read-only flags (`--dry-run`, `--list-unmapped`,
 * `--list-failed`) and for injected `CliDeps`; a path that PERSISTS a vector
 * (real extraction, `--backfill-embeddings`) with no embedding credentials
 * throws ConfigError (exit 1) rather than storing fake vectors a real
 * embedder can never be compared against (CR High #3).
 */
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";

import {
  loadEnv,
  ConfigError,
  DEFAULT_LLM_BASE_URL,
  DEFAULT_LLM_MODEL,
  type GraphragEnv,
} from "../config.js";
import { createLogger, type Logger, writeStderr } from "../logging.js";
import { ElasticsearchPrecisionLayer } from "../core/storage/elasticsearch-precision.js";
import { upSchemaP0 } from "../core/storage/schema-p0.js";
import {
  emitProjectionIntents,
  type ProjectionSubject,
} from "../core/storage/projection-outbox.js";
import { extractChunk, type ChunkInput } from "../core/extraction/extract.js";
import type { ExtractionOutput } from "../core/extraction/types.js";
import {
  AnthropicLLMClient,
  FakeLLMClient,
  type LLMClient,
} from "../core/extraction/llm-client.js";
import { upsertTriple } from "../core/extraction/dedup.js";
import {
  normalizeRelation,
  DEFAULT_THRESHOLD,
  UNMAPPED,
} from "../core/extraction/normalize.js";
import { ALLOWED } from "../core/extraction/vocabulary.js";
import {
  insertRecord,
  listFailed,
  markSucceeded,
  markFailed,
  newRecordId,
  SELF_LOOP_REJECTED_CODE,
  type Queryable,
} from "../core/extraction/records.js";
import {
  mergeEntitiesWithGating,
  normalizeAlias,
  type CandidateEntity,
  type IncomingEntity,
} from "../core/entities/merge.js";
import { resolveCanonicalId } from "../core/entities/resolve.js";
import { computeEntityEmbeddingText } from "../core/entities/embedding.js";
import { GraphragError } from "../core/errors.js";
import {
  FakeEmbedder,
  NineRouterEmbedder,
  type EmbeddingClient,
} from "../core/embedder.js";
import { normalizeEntityType } from "./entity-type.js";
import { fetchEntityProjection } from "../core/storage/entity-projection.js";

export interface CliFlags {
  batchSize: number;
  dryRun: boolean;
  since: string | null;
  onlyFailed: boolean;
  listUnmapped: boolean;
  listFailed: boolean;
  /** `--list-failed` batch filter; null means "every batch". */
  batchId: string | null;
  /** A9 repair mode; never set by a normal extraction run. */
  backfillEmbeddings: boolean;
}

const DEFAULT_FLAGS: CliFlags = {
  batchSize: 64,
  dryRun: false,
  since: null,
  onlyFailed: false,
  listUnmapped: false,
  listFailed: false,
  batchId: null,
  backfillEmbeddings: false,
};

const USAGE = `usage: extract [--batch-size N] [--dry-run] [--since ISO8601] [--only-failed] [--list-unmapped] [--list-failed [--batch-id UUID]] [--backfill-embeddings]`;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Minimal client surface accepted by both pg.PoolClient and test fakes. */
export interface CliClient {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
  release(): void;
}

/** Minimal pool: one leased connection per run + shutdown. */
export interface CliPool {
  connect(): Promise<CliClient>;
  end(): Promise<void>;
}

export interface CliDeps {
  pool: CliPool;
  llm: LLMClient;
  embedder: EmbeddingClient;
  dims: number;
  logger: Logger;
  /** Injectable clock for deterministic started_at in tests. */
  now?: () => string;
  /**
   * Optional ES derived-index writer. Mirrors the `push` tool pattern
   * (src/tools/push.ts): authority writes always win, ES write failures
   * log `keyword_bm25:attempted-and-failed` and never abort the chunk
   * transaction. Absent when no precision layer is configured.
   */
  precision?: import("../core/storage/elasticsearch-precision.js").PrecisionIndexer;
}

type ParsedArgs = { ok: true; flags: CliFlags } | { ok: false; error: string };

/**
 * Parse CLI flags manually (no new dep). Value flags fail fast on a missing /
 * non-parseable value; unknown flags surface a usage error (exit 2).
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const flags: CliFlags = { ...DEFAULT_FLAGS };
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;
    if (arg === "--dry-run") flags.dryRun = true;
    else if (arg === "--only-failed") flags.onlyFailed = true;
    else if (arg === "--list-unmapped") flags.listUnmapped = true;
    else if (arg === "--list-failed") flags.listFailed = true;
    else if (arg === "--backfill-embeddings") flags.backfillEmbeddings = true;
    else if (arg === "--batch-id") {
      // Validated here so a malformed value is a usage error (exit 2) rather
      // than a Postgres `invalid input syntax for type uuid` fatal (exit 1).
      const raw = argv[i + 1];
      if (raw === undefined || !UUID_RE.test(raw)) {
        return { ok: false, error: `--batch-id requires a UUID` };
      }
      flags.batchId = raw;
      i += 1;
    } else if (arg === "--batch-size") {
      const n = Number(argv[i + 1]);
      if (!Number.isInteger(n) || n <= 0) {
        return { ok: false, error: `--batch-size requires a positive integer` };
      }
      flags.batchSize = n;
      i += 1;
    } else if (arg === "--since") {
      const raw = argv[i + 1];
      if (raw === undefined || Number.isNaN(Date.parse(raw))) {
        return { ok: false, error: `--since requires an ISO8601 timestamp` };
      }
      flags.since = raw;
      i += 1;
    } else {
      return { ok: false, error: `unknown flag: "${arg}"` };
    }
    i += 1;
  }
  const conflict = flagConflict(flags);
  if (conflict) return { ok: false, error: conflict };
  return { ok: true, flags };
}

/**
 * The flag combinations `runCli`'s routing cannot honour, named as usage
 * errors (exit 2) instead of silently resolved by routing order.
 *
 * `runCli` picks ONE mode per run in a fixed if-chain, so a second mode flag
 * is not "also applied", it is dropped. `--dry-run --backfill-embeddings` was
 * the load-bearing case: backfill is routed before the dry-run branch, so the
 * pair ran the repair mode's UPDATEs under a flag whose whole contract is
 * "writes nothing".
 */
function flagConflict(flags: CliFlags): string | null {
  const modes: Array<[string, boolean]> = [
    ["--list-unmapped", flags.listUnmapped],
    ["--list-failed", flags.listFailed],
    ["--backfill-embeddings", flags.backfillEmbeddings],
  ];
  const selected = modes.filter(([, on]) => on).map(([name]) => name);
  if (selected.length > 1) {
    return `${selected[0]} and ${selected[1]} are mutually exclusive`;
  }
  if (flags.dryRun && flags.backfillEmbeddings) {
    return `--dry-run and --backfill-embeddings are mutually exclusive`;
  }
  // `--batch-id` only filters the `--list-failed` report; accepting it on any
  // other path would silently ignore it instead of naming the mistake.
  if (flags.batchId !== null && !flags.listFailed) {
    return `--batch-id is only valid with --list-failed`;
  }
  return null;
}

/** Top-level entry, testable: parse flags, route, map results to exit codes. */
export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    writeStderr(`${USAGE}\nextract: ${parsed.error}\n`);
    return 2;
  }
  try {
    if (parsed.flags.listUnmapped) return await listUnmapped(deps);
    if (parsed.flags.listFailed) {
      return await listFailedReport(deps, parsed.flags);
    }
    if (parsed.flags.backfillEmbeddings) {
      return await backfillEmbeddings(deps);
    }
    return await runPipeline(deps, parsed.flags);
  } catch (err) {
    reportFatal(deps.logger, err);
    return 1;
  }
}

function reportFatal(logger: Logger, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  writeStderr(`extract fatal: ${msg}\n`);
  logger.error("extract-fatal", { error: msg });
}

/** Execute the scan → batch → per-chunk-transaction write pipeline. */
async function runPipeline(deps: CliDeps, flags: CliFlags): Promise<number> {
  const client = await deps.pool.connect();
  try {
    await upSchemaP0(client as unknown as PoolClient, deps.dims);
    const chunks = await scanChunks(client, flags);
    if (flags.dryRun) {
      await dryRunPlan(deps, chunks);
      return 0;
    }
    const summary = await processBatch(deps, client, flags, chunks);
    return summary.writeFailures > 0 ? 2 : 0;
  } finally {
    client.release();
  }
}

async function scanChunks(
  client: Queryable,
  flags: CliFlags
): Promise<ChunkInput[]> {
  const where: string[] = [
    `NOT EXISTS (SELECT 1 FROM extraction_records r WHERE r.chunk_id = c.id AND r.status = 'succeeded')`,
  ];
  const values: unknown[] = [];
  if (flags.since) {
    values.push(flags.since);
    where.push(`c.created_at >= $${values.length}`);
  }
  if (flags.onlyFailed) {
    // SC5: SELF_LOOP_REJECTED rows are excluded from --only-failed. A self-loop
    // is a permanent reject — re-extraction would only reproduce the same
    // self-loop. `listFailed()` (records.ts) applies the same exclusion; the
    // chunk scan must mirror it or operators see "must re-extract" rows that
    // no re-extract path can actually advance.
    where.push(
      `c.id IN (SELECT chunk_id FROM (
         SELECT chunk_id, status, error_code,
           row_number() OVER (PARTITION BY chunk_id ORDER BY created_at DESC) rn
         FROM extraction_records
       ) t WHERE rn = 1 AND status = 'failed' AND error_code != 'SELF_LOOP_REJECTED')`
    );
  }
  const { rows } = await client.query(
    `SELECT c.id, c.content FROM chunks c
     WHERE ${where.join(" AND ")}
     ORDER BY c.created_at
     LIMIT $${values.length + 1}`,
    [...values, flags.batchSize]
  );
  return rows.map((r) => ({
    id: r.id as string,
    content: r.content as string,
  }));
}

/** `--list-unmapped`: report relation_raw buckets, no LLM, no extraction. */
async function listUnmapped(deps: CliDeps): Promise<number> {
  const client = await deps.pool.connect();
  try {
    await upSchemaP0(client as unknown as PoolClient, deps.dims);
    const { rows } = await client.query(
      `SELECT relation_raw, count(*)::int AS count
       FROM triples WHERE relation_norm = 'UNMAPPED'
       GROUP BY relation_raw ORDER BY count DESC`,
      []
    );
    if (rows.length === 0) deps.logger.info("no-unmapped-relations");
    for (const r of rows) {
      deps.logger.info("unmapped", {
        relation_raw: r.relation_raw,
        count: r.count,
      });
    }
    return 0;
  } finally {
    client.release();
  }
}

/**
 * `--list-failed` (A15): report failed `extraction_records` rows, no LLM,
 * no extraction, no writes. `--batch-id` narrows the report to one batch.
 *
 * `listFailed()` returns its rows `created_at`-ascending; A15 asks for
 * newest-first and `records.ts` is not this flag's surface, so the ordering
 * flip is applied here on the already-bounded failed-row set.
 */
async function listFailedReport(
  deps: CliDeps,
  flags: CliFlags
): Promise<number> {
  const client = await deps.pool.connect();
  try {
    await upSchemaP0(client as unknown as PoolClient, deps.dims);
    const rows = await listFailed(
      client,
      flags.batchId ? { batchId: flags.batchId } : {}
    );
    if (rows.length === 0) {
      deps.logger.info("no-failed-records", { batchId: flags.batchId });
      return 0;
    }
    for (const r of [...rows].reverse()) {
      deps.logger.info("failed-record", {
        chunk_id: r.chunk_id ?? null,
        batch_id: r.batch_id ?? null,
        error_code: r.error_code ?? null,
        error_msg: r.error_msg ?? null,
        created_at: r.created_at ?? null,
      });
    }
    return 0;
  } finally {
    client.release();
  }
}

/**
 * `--backfill-embeddings` (A9): the idempotent NULL-embedding repair mode.
 * Every live entity whose `embedding` is NULL is embedded from its stored
 * `metadata.description` (empty string when the key is absent) through the
 * same `computeEntityEmbeddingText` SSOT the insert path uses, then UPDATEd.
 *
 * Its own flag, never a step of a normal extraction run: no chunk scan, no
 * LLM call, no extraction record — the UPDATE below is the only write.
 *
 * Idempotency is observable in the run output: an immediate second run scans
 * 0 rows and reports `backfilled: 0`. Each row is its own auto-committed
 * UPDATE instead of one batch transaction, so an interrupted repair keeps
 * the rows it already filled and a re-run picks up the remainder.
 */
async function backfillEmbeddings(deps: CliDeps): Promise<number> {
  const client = await deps.pool.connect();
  try {
    await upSchemaP0(client as unknown as PoolClient, deps.dims);
    const { rows } = await client.query(
      `SELECT id, canonical_name,
              coalesce(metadata->>'description', '') AS description
         FROM entities
        WHERE retired = false AND embedding IS NULL
        ORDER BY created_at`,
      []
    );
    let backfilled = 0;
    for (const row of rows) {
      backfilled += await backfillOne(deps, client, row);
    }
    deps.logger.info("backfill-embeddings-complete", {
      scanned: rows.length,
      backfilled,
    });
    return 0;
  } finally {
    client.release();
  }
}

/**
 * Embed and UPDATE one scanned row; returns how many rows the UPDATE actually
 * changed, which is what the run reports. The `embedding IS NULL` guard is
 * repeated in the WHERE clause so a vector some other writer stored between
 * the scan and this UPDATE survives (A8 first-write-wins) and is counted as
 * not backfilled rather than silently overwritten.
 */
async function backfillOne(
  deps: CliDeps,
  client: CliClient,
  row: { id: string; canonical_name: string; description: string | null }
): Promise<number> {
  const embedding = await embedEntity(deps, {
    canonicalName: row.canonical_name,
    description: row.description ?? "",
  });
  const { rows } = await client.query(
    `UPDATE entities SET embedding = $2::vector
      WHERE id = $1 AND embedding IS NULL
      RETURNING id`,
    [row.id, toVectorLiteral(embedding)]
  );
  return rows.length;
}

/** Dry-run: simulate extraction, print what would happen, write no rows. */
async function dryRunPlan(deps: CliDeps, chunks: ChunkInput[]): Promise<void> {
  deps.logger.info("dry-run-plan", { chunks: chunks.length });
  for (const chunk of chunks) {
    const outcome = await extractChunk(chunk, { llm: deps.llm });
    if (outcome.kind === "failed") {
      deps.logger.info("dry-run-chunk-would-fail", {
        chunkId: chunk.id,
        code: outcome.errorCode,
      });
      continue;
    }
    const unmapped = outcome.outputs.filter(
      (o) => o.relationNorm === "UNMAPPED"
    ).length;
    deps.logger.info("dry-run-chunk-would-write", {
      chunkId: chunk.id,
      triples: outcome.outputs.length,
      unmapped,
    });
  }
}

interface BatchOutcome {
  writeFailures: number;
  succeeded: number;
  failed: number;
}

/** Run the batch, one transaction per chunk (record + entities + triples). */
async function processBatch(
  deps: CliDeps,
  client: CliClient,
  flags: CliFlags,
  chunks: ChunkInput[]
): Promise<BatchOutcome> {
  const batchId = newRecordId();
  const startedAt = deps.now ? deps.now() : new Date().toISOString();
  let writeFailures = 0;
  let succeeded = 0;
  let failed = 0;
  for (const chunk of chunks) {
    const out = await processChunk(deps, client, chunk, batchId, startedAt);
    if (out.kind === "write-failure") writeFailures += 1;
    else if (out.kind === "ok") succeeded += 1;
    else failed += 1;
  }
  deps.logger.info("extract-batch-complete", {
    batchId,
    batchSize: flags.batchSize,
    processed: chunks.length,
    succeeded,
    failed,
    writeFailures,
  });
  return { writeFailures, succeeded, failed };
}

type ChunkOutcome =
  { kind: "ok" } | { kind: "failed" } | { kind: "write-failure" };

/** One chunk in one transaction; mark-and-continue on every failure leg. */
async function processChunk(
  deps: CliDeps,
  client: CliClient,
  chunk: ChunkInput,
  batchId: string,
  startedAt: string
): Promise<ChunkOutcome> {
  const recordId = newRecordId();
  await client.query("BEGIN");
  try {
    await insertRecord(client, {
      id: recordId,
      batchId,
      chunkId: chunk.id,
      startedAt,
    });
    const outcome = await extractChunk(chunk, { llm: deps.llm });
    if (outcome.kind === "failed") {
      await markFailed(client, recordId, {
        code: outcome.errorCode,
        msg: outcome.errorMsg,
      });
      await client.query("COMMIT");
      deps.logger.info("chunk-failed", {
        chunkId: chunk.id,
        code: outcome.errorCode,
      });
      return { kind: "failed" };
    }
    const counts = await persistOutputs(
      deps,
      client,
      chunk.id,
      outcome.outputs,
      startedAt
    );
    if (counts.allSelfLoop) {
      // SC5: every output was a self-loop, so the chunk produced zero graph
      // edges and zero entities. Record the chunk as a permanent reject — the
      // SELF_LOOP_REJECTED sentinel keeps it visible in extraction_records
      // while excluding it from --list-failed / --only-failed (no re-extract
      // path can produce anything but the same self-loop again).
      await markFailed(client, recordId, {
        code: SELF_LOOP_REJECTED_CODE,
        msg: "all outputs were self-loops",
      });
      await client.query("COMMIT");
      deps.logger.info("chunk-rejected", {
        chunkId: chunk.id,
        code: SELF_LOOP_REJECTED_CODE,
        reason: "all-outputs-self-loop",
      });
      return { kind: "failed" };
    }
    // Same transaction as the ledger rows it describes (SC3): a projection
    // intent that outlived a rolled-back chunk would tell the projector to
    // sync a row Postgres never kept, and a chunk that committed without one
    // would leave Neo4j permanently behind. A throw here lands in the catch
    // below, which rolls the whole chunk back.
    await emitProjectionIntents(client, counts.projected);
    await markSucceeded(client, recordId, {
      triplesCount: counts.triples,
      unmappedCount: counts.unmapped,
    });
    await client.query("COMMIT");
    // Authority writes are durable; the precision layer can now safely
    // mirror the canonical names + alias set we just persisted. Failures
    // here NEVER roll the chunk back — the same fail-open posture
    // `src/tools/push.ts` takes for chunk indexing. The chunk is reported
    // as `ok` either way; the precision layer surfaces its own degradation
    // through `keyword_bm25:attempted-and-failed` on stderr.
    await projectEntitiesToPrecisionLayer(deps, client, counts);
    return { kind: "ok" };
  } catch (err) {
    await client.query("ROLLBACK");
    deps.logger.error("chunk-write-failed", {
      chunkId: chunk.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return { kind: "write-failure" };
  }
}

/**
 * Best-effort mirror of the ledger entities this chunk just touched into
 * the ES precision-layer entity index. Authority writes always win — the
 * precision layer call happens AFTER `COMMIT`, is wrapped in try/catch,
 * and never aborts the chunk. Unconfigured precision layers are silent
 * no-ops (matches `push.ts`).
 */
async function projectEntitiesToPrecisionLayer(
  deps: CliDeps,
  client: CliClient,
  counts: PersistCounts
): Promise<void> {
  if (deps.precision === undefined) return;
  // Merge losers MUST be removed from the entity index BEFORE we re-index
  // the survivors: a stale loser in the index would otherwise continue
  // resolving lexically to a row whose only purpose is `merged_into`
  // audit. Fail-open here too — a delete failure cannot reverse a
  // committed merge.
  if (counts.mergedLoserIds.length > 0) {
    try {
      await deps.precision.deleteEntities(counts.mergedLoserIds);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeStderr(`extract precision entity delete failed: ${message}\n`);
      deps.logger.warn("precision-entity-delete-failed", {
        ids: counts.mergedLoserIds,
        error: message,
      });
    }
  }
  if (counts.entities.length === 0) return;
  try {
    const records = await fetchEntityProjection(client, counts.entities);
    if (records.length > 0) {
      await deps.precision.indexEntities(records);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeStderr(`extract precision entity index failed: ${message}\n`);
    deps.logger.warn("precision-entity-index-failed", {
      ids: counts.entities,
      error: message,
    });
  }
}

interface PersistCounts {
  triples: number;
  unmapped: number;
  /**
   * Ledger subjects this chunk touched, in write order — the projection
   * intents the caller emits before committing. Chunks are never listed:
   * they do not enter the graph (ADR-0001).
   */
  projected: ProjectionSubject[];
  /**
   * Unique canonical entity ids touched this chunk. De-duplicated because
   * the same entity may appear as the head of one output and the tail of
   * another; the precision-layer projection needs one row per entity id,
   * and a survivor of a soft-merge counts only once (the loser is NOT in
   * this set — it stays in `projected` for the Neo4j projection but the
   * ES entity index never sees a retired/merged-away row).
   */
  entities: string[];
  /**
   * Loser ids materialised by an L3 merge. Each loser is a fresh
   * `entities` row whose `merged_into` now points at a survivor; the
   * precision layer must drop them from its entity index so a lexical
   * seed lookup cannot resolve to a row that exists only as audit
   * history in the ledger.
   */
  mergedLoserIds: string[];
  /**
   * SC5: every output in this chunk was rejected as a self-loop. The chunk
   * produced zero graph edges and zero entities; the orchestrator marks it
   * `failed` with the SELF_LOOP_REJECTED sentinel so --list-failed /
   * --only-failed can hide it from "must re-extract" lists.
   */
  allSelfLoop: boolean;
}

/** Resolve/create entities and upsert triples for one chunk's outputs. */
async function persistOutputs(
  deps: CliDeps,
  client: CliClient,
  chunkId: string,
  outputs: ExtractionOutput[],
  startedAt: string
): Promise<PersistCounts> {
  let triples = 0;
  let unmapped = 0;
  let selfLoopCount = 0;
  const projected: ProjectionSubject[] = [];
  const entityIds = new Set<string>();
  const mergedLoserIds = new Set<string>();
  for (const out of outputs) {
    if (
      normalizeAlias(out.head) === normalizeAlias(out.tail) &&
      normalizeEntityType(out.headType) === normalizeEntityType(out.tailType)
    ) {
      logSelfLoopRejection(deps, chunkId, out);
      selfLoopCount += 1;
      continue;
    }
    const {
      headId,
      tailId,
      mergedLoserIds: losers,
    } = await resolveEndpoints(deps, client, out);
    // Both endpoints are projectable nodes even when the triple below is
    // rejected — an entity with no edge is still a node the graph arm can
    // seed on.
    projected.push({ kind: "entity", id: headId });
    entityIds.add(headId);
    for (const loser of losers) mergedLoserIds.add(loser);
    if (headId === tailId) {
      logSelfLoopRejection(deps, chunkId, out, headId);
      selfLoopCount += 1;
      continue;
    }
    projected.push({ kind: "entity", id: tailId });
    entityIds.add(tailId);
    const relationNorm = await vetRelationNorm(deps, out);
    // A merge returns the surviving row's id: its confidence just moved, so
    // the edge still needs re-projecting.
    const { tripleId } = await upsertTriple(client, {
      headId,
      tailId,
      relationRaw: out.relationRaw,
      relationNorm,
      confidence: out.confidence,
      sourceChunkId: chunkId,
      validWindow: { start: startedAt, end: null },
    });
    projected.push({ kind: "triple", id: tripleId });
    triples += 1;
    if (relationNorm === UNMAPPED) unmapped += 1;
  }
  // SC5: `allSelfLoop` is true only when outputs were present and EVERY
  // one was a self-loop. An empty `outputs` array vacuously yields false so
  // the caller still treats it as a normal zero-output chunk.
  const allSelfLoop = outputs.length > 0 && selfLoopCount === outputs.length;
  return {
    triples,
    unmapped,
    projected,
    entities: [...entityIds],
    mergedLoserIds: [...mergedLoserIds],
    allSelfLoop,
  };
}

/**
 * Resolve the two ends of one output.
 *
 * SC6 invariant: the head and the tail of a single output are mutually
 * exclusive merge candidates. The extraction schema gives one output ONE
 * `description`, which both ends are resolved with, so leaving the head in
 * the tail's candidate set lets the L3 name+description cosine fold the tail
 * into the head — the triple then asserts a relation from an entity to
 * itself. Excluding the resolved `headId` from the tail's candidate array
 * removes that path before the gates run, without touching
 * `mergeEntitiesWithGating`'s locked signature (G7).
 */
async function resolveEndpoints(
  deps: CliDeps,
  client: CliClient,
  out: ExtractionOutput
): Promise<{
  headId: string;
  tailId: string;
  mergedLoserIds: string[];
}> {
  // Normalize LLM types to the closed P0 set up front (CR High #2) so the
  // merge gates and the persisted row agree on the same type value.
  const head = await resolveEntity(deps, client, {
    canonicalName: out.head,
    type: normalizeEntityType(out.headType),
    description: out.description,
  });
  const tail = await resolveEntity(
    deps,
    client,
    {
      canonicalName: out.tail,
      type: normalizeEntityType(out.tailType),
      description: out.description,
    },
    { excludeIds: [head.id] }
  );
  return {
    headId: head.id,
    tailId: tail.id,
    mergedLoserIds: [...head.mergedLoserIds, ...tail.mergedLoserIds],
  };
}

/**
 * Backstop for the SC6 exclusion above: a triple whose two ends resolved to
 * the same entity asserts nothing, so it is rejected. Only THAT triple is
 * skipped — the chunk's remaining outputs and the rest of the batch continue,
 * same mark-and-continue posture the merge gates take on a gray-zone reject.
 */
function logSelfLoopRejection(
  deps: CliDeps,
  chunkId: string,
  out: ExtractionOutput,
  entityId?: string
): void {
  deps.logger.warn("triple-self-loop-rejected", {
    chunkId,
    entityId: entityId ?? null,
    head: out.head,
    tail: out.tail,
    relationRaw: out.relationRaw,
    reason: "head-equals-tail",
  });
}

/**
 * A10 trust policy for the LLM's claimed `relationNorm`.
 *
 * The claim is accepted iff it is a case-insensitive member of `ALLOWED`, and
 * the canonical `ALLOWED` spelling is what gets persisted — `relation_norm` is
 * the traversal key of the dedup triple `(head_id, relation_norm, tail_id)`,
 * so one relation must have exactly one spelling. Any other claim is discarded
 * and re-derived from `relation_raw` through the #4 D5 cascade, whose miss leg
 * is the legal `UNMAPPED` sentinel — never a silent coerce onto a neighbouring
 * term. `relation_raw` itself is stored exactly as received (#3 D3 audit
 * fidelity), which is what `--list-unmapped` groups on.
 */
async function vetRelationNorm(
  deps: CliDeps,
  out: ExtractionOutput
): Promise<string> {
  const claimed = out.relationNorm.trim().toLowerCase();
  const accepted = ALLOWED.find((term) => term === claimed);
  if (accepted !== undefined) return accepted;
  return normalizeRelation(out.relationRaw, {
    embedder: deps.embedder,
    threshold: DEFAULT_THRESHOLD,
  });
}

/**
 * Resolve the incoming entity via the merge gates, then persist. Merge →
 * reuse the survivor id; created-new / reject → insert a fresh row (the
 * gray-zone log already recorded the rejection via the merge default sink).
 *
 * A8 first-write-wins: a merge leaves the survivor's embedding, description
 * and canonical name alone. The only write a merge makes is the A11 alias row
 * recording the surface form the survivor was reached by.
 *
 * `excludeIds` drops candidates the caller has already ruled out — the SC6
 * head/tail exclusion. The filter is applied to the loaded `CandidateEntity[]`
 * before the gates see it, so the merge module keeps its locked signature.
 *
 * Returns the resolved id and any loser ids this call wrote. Loser ids are
 * the rows materialized as `merged_into` survivors — the precision layer
 * must remove them from its entity index so a lexical seed lookup can
 * never resolve to a row the ledger no longer answers for.
 */
async function resolveEntity(
  deps: CliDeps,
  client: CliClient,
  incoming: IncomingEntity,
  opts: { excludeIds?: string[] } = {}
): Promise<{ id: string; mergedLoserIds: string[] }> {
  const excluded = new Set(opts.excludeIds ?? []);
  const live = (await loadEntities(client)).filter((c) => !excluded.has(c.id));
  const { canonicalId, decision } = await mergeEntitiesWithGating(
    incoming,
    live,
    {
      embedder: deps.embedder,
    }
  );
  if (decision !== "created-new" && decision.kind === "merge") {
    const survivorId = await resolveCanonicalId(client, canonicalId);
    const survivor = live.find((c) => c.id === survivorId);
    const mergedLoserIds: string[] = [];
    if (decision.via === "L3") {
      // L3 is the only fuzzy merge: materialize the incoming entity as the
      // loser so the ledger retains a rollbackable merged_into edge. L0
      // matches an existing row exactly and must remain idempotent.
      const loserId = randomUUID();
      await insertEntity(
        client,
        loserId,
        incoming,
        await embedEntity(deps, incoming)
      );
      await linkMergedEntity(client, loserId, survivorId);
      mergedLoserIds.push(loserId);
    }
    if (survivor && survivor.canonicalName !== incoming.canonicalName) {
      await insertAlias(client, survivorId, incoming.canonicalName, "variant");
    }
    return { id: survivorId, mergedLoserIds };
  }
  const id = randomUUID();
  await insertEntity(client, id, incoming, await embedEntity(deps, incoming));
  await insertAlias(client, id, incoming.canonicalName, "name");
  return { id, mergedLoserIds: [] };
}

/**
 * Load live entities as merge candidates, carrying the stored embedding and
 * the `metadata.description` value (A7/A13) so the L2/L3 gates see production
 * data instead of empty strings.
 */
export async function loadEntities(
  client: Queryable
): Promise<CandidateEntity[]> {
  const { rows } = await client.query(
    `SELECT id, canonical_name, type, embedding::text AS embedding,
            coalesce(metadata->>'description', '') AS description
       FROM entities WHERE retired = false`,
    []
  );
  return rows.map((r) => {
    const embedding = parseVectorLiteral(r.embedding);
    return {
      id: r.id as string,
      canonicalName: r.canonical_name as string,
      type: r.type as string,
      description: (r.description as string | null) ?? "",
      ...(embedding ? { embedding } : {}),
    };
  });
}

/**
 * #6 Q1 SSOT: the entity vector is embedded from
 * `canonical_name + " | " + description` via `computeEntityEmbeddingText`,
 * with the same embedder and dimension as chunks. Computed once, at insert —
 * or, for a row that predates that write path, once at `--backfill-embeddings`
 * time, which is why this takes the name/description pair rather than a whole
 * `IncomingEntity`.
 */
async function embedEntity(
  deps: CliDeps,
  incoming: { canonicalName: string; description: string }
): Promise<number[]> {
  const text = computeEntityEmbeddingText(
    incoming.canonicalName,
    incoming.description
  );
  const [vector] = await deps.embedder.embed([text]);
  if (!vector) {
    throw new GraphragError(
      `embedder returned no vector for entity "${incoming.canonicalName}"`,
      "EMBEDDING_FAILED"
    );
  }
  return vector;
}

async function insertEntity(
  client: Queryable,
  id: string,
  incoming: IncomingEntity,
  embedding: number[]
): Promise<void> {
  // CR High #2: the DDL pins entities.type to a closed 4-value CHECK set
  // (person/concept/system/event). The LLM emits an open-string type, so we
  // normalize it into the closed set here — otherwise the INSERT would reject
  // the whole chunk transaction (write-failure → exit 2) on any non-listed
  // raw type (e.g. "Organization", "Location").
  const type = normalizeEntityType(incoming.type);
  // A7: description rides in the existing metadata JSONB — the spec-1 DDL is
  // frozen, so there is no description column to write.
  await client.query(
    `INSERT INTO entities (id, canonical_name, type, embedding, metadata, retired)
     VALUES ($1, $2, $3, $4::vector, $5::jsonb, false)`,
    [
      id,
      incoming.canonicalName,
      type,
      toVectorLiteral(embedding),
      JSON.stringify({ description: incoming.description }),
    ]
  );
}

/**
 * Persist a soft-merge pointer without rewriting any triple foreign keys.
 *
 * Exported so the SC6 idempotency contract (slice 4 of
 * `specs/retrieve-graph-quality.md`) is testable against real Postgres rows
 * without re-running the full CLI merge path. The `WHERE merged_into IS NULL`
 * guard is what makes the second call a no-op — the pointer is permanent
 * for this round once written.
 */
export async function linkMergedEntity(
  client: Queryable,
  loserId: string,
  survivorId: string
): Promise<void> {
  await client.query(
    `UPDATE entities SET merged_into = $2
      WHERE id = $1 AND merged_into IS NULL`,
    [loserId, survivorId]
  );
}

/**
 * Write one surface form into `entity_aliases` (A11). The UNIQUE
 * `(entity_id, alias)` index makes a repeat a silent no-op instead of an
 * error that would roll back the whole chunk transaction.
 */
async function insertAlias(
  client: Queryable,
  entityId: string,
  alias: string,
  aliasType: "name" | "variant"
): Promise<void> {
  await client.query(
    `INSERT INTO entity_aliases (id, entity_id, alias, alias_type)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (entity_id, alias) DO NOTHING`,
    [randomUUID(), entityId, alias, aliasType]
  );
}

/** Serialized pgvector literal: `[0.1,0.2,...]`; the SQL casts it `::vector`. */
function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

/** Inverse of `toVectorLiteral`; a NULL or unparseable column yields undefined. */
function parseVectorLiteral(raw: unknown): number[] | undefined {
  if (typeof raw !== "string") return undefined;
  const inner = raw.trim().replace(/^\[/, "").replace(/\]$/, "");
  if (inner.length === 0) return undefined;
  const values = inner.split(",").map(Number);
  return values.some(Number.isNaN) ? undefined : values;
}

const CANNED_OUTPUT = {
  head: "Alice",
  headType: "person",
  relationRaw: "works at",
  relationNorm: "MEMBER_OF",
  tail: "Acme",
  tailType: "system",
  description: "Alice works at Acme",
  evidenceSpan: "Alice works at Acme",
  confidence: 0.9,
};

/**
 * Build the LLM client from env. Real `AnthropicLLMClient` when a key is set;
 * a missing key is tolerated on every non-extraction path (`--dry-run`,
 * `--list-unmapped`, `--list-failed` and the `--backfill-embeddings` repair
 * mode), where a scripted fake gives deterministic output. A real extraction
 * with no key would silently INSERT canned triples into Postgres, so that
 * path throws ConfigError instead (CR High #1) rather than auto-falling back
 * to the fake.
 *
 * The refusal message names only the read-only flags: `--backfill-embeddings`
 * needs no LLM key but does need embedding credentials (`buildEmbedder`
 * below), so it is not a keyless run.
 */
function buildLlm({ flags }: { flags: CliFlags }): LLMClient {
  const apiKey = process.env.ANTHROPIC_AUTH_TOKEN?.trim();
  if (!apiKey) {
    if (!(
      flags.dryRun ||
      flags.listUnmapped ||
      flags.listFailed ||
      flags.backfillEmbeddings
    )) {
      throw new ConfigError(
        "refusing to run real extraction without ANTHROPIC_AUTH_TOKEN; pass --dry-run, --list-unmapped or --list-failed for keyless operation"
      );
    }
    // No key + a non-extraction path → scripted fake; canned ok so dry-run
    // has deterministic output. The fake never reaches the real write path.
    return new FakeLLMClient({
      scripted: async () => ({ kind: "ok", outputs: [CANNED_OUTPUT] }),
    });
  }
  const baseUrl = (
    process.env.GRAPHRAG_MEMORY_ANTHROPIC_BASE_URL?.trim() ||
    DEFAULT_LLM_BASE_URL
  ).replace(/\/$/, "");
  const model =
    process.env.GRAPHRAG_MEMORY_ANTHROPIC_MODEL?.trim() || DEFAULT_LLM_MODEL;
  return new AnthropicLLMClient({ apiKey, baseUrl, model });
}

/**
 * Build the embedder from env — the `buildLlm` key guard above, mirrored for
 * the embedding half.
 *
 * A WRITE embedding path (a real extraction, or the `--backfill-embeddings`
 * repair mode) persists vectors into `entities.embedding`. Falling back to
 * `FakeEmbedder` there stores derived-hash vectors that share no space with a
 * real embedder's, and nothing downstream can tell them apart from genuine
 * ones — the graph arm's seed similarity is then permanently poisoned, and
 * `--backfill-embeddings` will not repair it because those rows are no longer
 * NULL. So missing credentials are a ConfigError (exit 1), never a silent
 * downgrade.
 *
 * `FakeEmbedder` stays legal for the read-only flags (`--dry-run`,
 * `--list-unmapped`, `--list-failed`), which persist no vector, and for tests
 * that inject their own `CliDeps` instead of going through env.
 */
function buildEmbedder({
  env,
  flags,
}: {
  env: GraphragEnv;
  flags: CliFlags;
}): EmbeddingClient {
  if (env.embedApiKey && env.embedBaseUrl && env.embedModel) {
    return new NineRouterEmbedder({
      baseUrl: env.embedBaseUrl,
      model: env.embedModel,
      apiKey: env.embedApiKey,
      dimensions: env.embedDimensions,
    });
  }
  if (persistsEmbeddings(flags)) {
    throw new ConfigError(
      "refusing to persist embeddings without embedding credentials; " +
        "GRAPHRAG_MEMORY_EMBED_API_KEY, GRAPHRAG_MEMORY_VECTOR_API_KEY, or GRAPHRAG_MEMORY_ANTHROPIC_API_KEY / GRAPHRAG_MEMORY_EMBED_API_KEY_ENV, " +
        "GRAPHRAG_MEMORY_EMBED_BASE_URL and GRAPHRAG_MEMORY_EMBED_MODEL are " +
        "required for a real extraction and for --backfill-embeddings; pass " +
        "--dry-run, --list-unmapped or --list-failed for keyless operation"
    );
  }
  return new FakeEmbedder(env.embedDimensions);
}

/** True when the invocation writes a vector into `entities.embedding`. */
function persistsEmbeddings(flags: CliFlags): boolean {
  if (flags.backfillEmbeddings) return true;
  return !(flags.dryRun || flags.listUnmapped || flags.listFailed);
}

/** Wire real deps from env and run; used by main(). */
export async function runCliFromEnv(argv: string[]): Promise<number> {
  let env: GraphragEnv;
  try {
    env = loadEnv();
  } catch (err) {
    if (err instanceof ConfigError) {
      writeStderr(`extract config error: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
  if (!env.dbUrl) {
    writeStderr("extract config error: GRAPHRAG_MEMORY_DB_URL is required\n");
    return 1;
  }
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    writeStderr(`${USAGE}\nextract: ${parsed.error}\n`);
    return 2;
  }
  const pool = new Pool({ connectionString: env.dbUrl });
  // Mirror the server wiring (src/index.ts buildDeps): the ES precision
  // layer is built when the env block is configured (k1/b from env.retrieval)
  // and stays undefined otherwise — a silent no-op for every precision call
  // in the pipeline, matching the MCP push/ingest path. Without this, the
  // extract CLI's entity projection was unreachable in production and the
  // entity index could only be repaired by a manual `npm run es:reindex`.
  const precision =
    env.elasticsearch === undefined
      ? undefined
      : new ElasticsearchPrecisionLayer(env.elasticsearch, {
          k1: env.retrieval.k1,
          b: env.retrieval.b,
        });
  try {
    const deps: CliDeps = {
      pool,
      llm: buildLlm({ flags: parsed.flags }),
      embedder: buildEmbedder({ env, flags: parsed.flags }),
      dims: env.embedDimensions,
      logger: createLogger(env.logLevel),
      ...(precision !== undefined ? { precision } : {}),
    };
    return await runCli(argv, deps);
  } catch (err) {
    if (err instanceof ConfigError) {
      writeStderr(`extract config error: ${err.message}\n`);
      return 1;
    }
    throw err;
  } finally {
    await pool.end();
    if (precision !== undefined) await precision.close();
  }
}

/** Top-level entry: wire real deps, exit with the CLI exit code. */
export async function main(): Promise<void> {
  const code = await runCliFromEnv(process.argv.slice(2));
  process.exit(code);
}

// Run only when invoked directly. Mirrors src/index.ts isMain.
const isMain = (() => {
  if (typeof process === "undefined") return false;
  const arg1 = process.argv[1];
  if (!arg1) return false;
  return arg1.endsWith("cli/extract.ts") || arg1.endsWith("cli/extract.js");
})();

if (isMain) {
  main().catch((err) => {
    writeStderr(
      `extract fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`
    );
    process.exit(1);
  });
}
