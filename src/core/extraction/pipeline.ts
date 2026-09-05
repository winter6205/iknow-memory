/**
 * Extract batch orchestration — selectors + mark-and-continue batch runner.
 *
 * Lifted from `src/cli/extract.ts` (scanChunks / processBatch / processChunk)
 * so the CLI and the MCP extract tool (T3) drive the SAME pipeline without
 * the MCP layer importing `src/cli`. This module is pure orchestration:
 * callers bring a `Queryable` (pool client), clients (LLM / embedder built
 * via `clients.ts`), a logger and an optional precision layer; the schema
 * migration (`upSchemaP0`) and the process exit codes stay caller concerns.
 *
 * Mark-and-continue: one chunk = one transaction. An LLM failure or an
 * all-self-loop reject is a sealed per-chunk outcome (the batch proceeds); a
 * thrown write error rolls that chunk back and is counted as a write failure
 * (the batch still proceeds — the caller decides what the counts mean, e.g.
 * the CLI maps `writeFailures > 0` to exit 2).
 *
 * Transaction shape per chunk (SC3): BEGIN → insertRecord(pending) →
 * extractChunk → persistOutputs → emitProjectionIntents (same transaction as
 * the ledger rows it describes) → markSucceeded → COMMIT. The ES precision
 * layer mirrors AFTER commit, fail-open, never aborting the chunk.
 */
import { writeStderr } from "../../logging.js";
import type { PrecisionIndexer } from "../storage/elasticsearch-precision.js";
import { emitProjectionIntents } from "../storage/projection-outbox.js";
import { fetchEntityProjection } from "../storage/entity-projection.js";
import { extractChunk, type ChunkInput } from "./extract.js";
import type { LLMClient } from "./llm-client.js";
import {
  insertRecord,
  markSucceeded,
  markFailed,
  newRecordId,
  SELF_LOOP_REJECTED_CODE,
  type Queryable,
} from "./records.js";
import {
  persistOutputs,
  depsNow,
  type ExtractPersistDeps,
  type PersistCounts,
} from "./persist.js";

/**
 * Everything the batch orchestrator needs. Structurally satisfied by the
 * CLI's `CliDeps` (pool / dims are caller-side concerns this module never
 * touches).
 */
export interface ExtractPipelineDeps extends ExtractPersistDeps {
  llm: LLMClient;
  /**
   * Optional ES derived-index writer. Authority writes always win: the
   * precision mirror happens after COMMIT, fail-open, and never aborts the
   * chunk transaction. Absent when no precision layer is configured.
   */
  precision?: PrecisionIndexer;
}

export interface PendingScanOptions {
  /** Scan LIMIT — the batch size. */
  batchSize: number;
  /** Only chunks created at/after this ISO8601 timestamp. */
  since?: string | null;
  /**
   * Restrict to chunks whose latest extraction record is `failed` (excluding
   * the permanent SELF_LOOP_REJECTED sentinel — re-extraction cannot advance
   * those, mirroring `listFailed()`).
   */
  onlyFailed?: boolean;
}

/**
 * The pending-chunk invariant — chunks with NO `extraction_records.status=
 * 'succeeded'` row — as a SQL fragment with ONE home. Both scans below
 * (`selectPendingChunks`, `selectPendingChunksBySourceRef`) must express
 * exactly this rule so a chunk's pending-ness is judged identically no
 * matter which selector found it; the text is asserted by
 * tests/extraction/pipeline.test.ts.
 */
const PENDING_CHUNK_PREDICATE =
  "NOT EXISTS (SELECT 1 FROM extraction_records r WHERE r.chunk_id = c.id AND r.status = 'succeeded')";

/**
 * The undifferentiated pending scan: chunks matching
 * `PENDING_CHUNK_PREDICATE`, `created_at`-ascending, capped at `batchSize`.
 * Optional `since` / `onlyFailed` filters are caller-supplied (the CLI maps
 * its `--since` / `--only-failed` flags onto them; an MCP caller would not
 * use them).
 */
export async function selectPendingChunks(
  client: Queryable,
  opts: PendingScanOptions
): Promise<ChunkInput[]> {
  const where: string[] = [PENDING_CHUNK_PREDICATE];
  const values: unknown[] = [];
  if (opts.since) {
    values.push(opts.since);
    where.push(`c.created_at >= $${values.length}`);
  }
  if (opts.onlyFailed) {
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
    [...values, opts.batchSize]
  );
  return rows.map((r) => ({
    id: r.id as string,
    content: r.content as string,
  }));
}

/**
 * Explicit chunk_ids selector: load exactly the requested chunks, in the
 * caller's order, deduplicated (a repeated id is processed once). No pending
 * filter — the caller named the chunks, re-extracting a known id is allowed.
 * An empty list selects nothing without touching the database.
 */
export async function selectChunksByIds(
  client: Queryable,
  ids: string[]
): Promise<ChunkInput[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  const placeholders = unique.map((_, i) => `$${i + 1}`).join(", ");
  const { rows } = await client.query(
    `SELECT c.id, c.content FROM chunks c WHERE c.id IN (${placeholders})`,
    unique
  );
  const byId = new Map(
    rows.map((r) => [
      r.id as string,
      { id: r.id as string, content: r.content as string },
    ])
  );
  return unique.flatMap((id) => {
    const chunk = byId.get(id);
    return chunk ? [chunk] : [];
  });
}

export interface SourceRefPendingScan {
  /** Up to `cap` pending chunks for the source_ref, created_at-ascending. */
  chunks: ChunkInput[];
  /**
   * True when at least one further pending chunk exists beyond the cap —
   * the caller can report "more remain" instead of silently truncating.
   */
  hasMore: boolean;
}

/**
 * source_ref selector: pending chunks (same `PENDING_CHUNK_PREDICATE` rule
 * as `selectPendingChunks`) for one `chunks.source_ref`, capped at `cap` (a
 * non-positive cap selects zero chunks but still reports `hasMore`). The cap
 * is enforced by scanning `cap + 1` rows so "more remain" is observable
 * without a second count query.
 */
export async function selectPendingChunksBySourceRef(
  client: Queryable,
  sourceRef: string,
  cap: number
): Promise<SourceRefPendingScan> {
  const effectiveCap = Math.max(cap, 0);
  const { rows } = await client.query(
    `SELECT c.id, c.content FROM chunks c
     WHERE c.source_ref = $1
       AND ${PENDING_CHUNK_PREDICATE}
     ORDER BY c.created_at
     LIMIT $2`,
    [sourceRef, effectiveCap + 1]
  );
  const chunks = rows
    .slice(0, effectiveCap)
    .map((r) => ({ id: r.id as string, content: r.content as string }));
  return { chunks, hasMore: rows.length > effectiveCap };
}

export interface BatchSummary {
  batchId: string;
  processed: number;
  succeeded: number;
  failed: number;
  writeFailures: number;
  ungrounded: number;
}

export interface ProcessBatchOptions {
  /**
   * The configured scan cap, reported verbatim in the batch log. Defaults
   * to the number of chunks actually handed over (the natural value for an
   * explicit id-list caller).
   */
  batchSize?: number;
  /**
   * Per-chunk outcome observer. The CLI ignores it; the MCP extract tool
   * uses it to report failed chunk ids + error codes WITHOUT re-querying
   * extraction_records — a write-failure leg rolls the whole chunk
   * transaction back, so no failed row exists to select for those chunks.
   */
  onChunkOutcome?: (outcome: ChunkOutcomeReport) => void;
}

/**
 * One chunk's sealed outcome, as reported to `onChunkOutcome`. Mirrors the
 * `extraction_records` shape (`chunk_id` / `error_code` / `error_msg`) so a
 * caller can forward it to its client verbatim; write-failure legs carry no
 * `error_code` of the extraction kind (the record row rolled back with the
 * transaction), only the thrown write error message.
 */
export interface ChunkOutcomeReport {
  chunkId: string;
  kind: "ok" | "failed" | "write-failure";
  /** Failure code on `failed` legs (LLM error code or SELF_LOOP_REJECTED). */
  errorCode?: string;
  /** Human-readable failure message on `failed` / `write-failure` legs. */
  errorMsg?: string;
}

/** Run the batch, one transaction per chunk (record + entities + triples). */
export async function processBatch(
  deps: ExtractPipelineDeps,
  client: Queryable,
  chunks: ChunkInput[],
  opts: ProcessBatchOptions = {}
): Promise<BatchSummary> {
  const batchId = newRecordId();
  const startedAt = depsNow(deps);
  let writeFailures = 0;
  let succeeded = 0;
  let failed = 0;
  let ungrounded = 0;
  for (const chunk of chunks) {
    const out = await processChunk(deps, client, chunk, batchId, startedAt);
    if (out.kind === "write-failure") writeFailures += 1;
    else if (out.kind === "ok") succeeded += 1;
    else failed += 1;
    // Every leg defines `ungrounded` (failed legs are 0), so no guard needed.
    ungrounded += out.ungrounded;
    opts.onChunkOutcome?.({
      chunkId: chunk.id,
      kind: out.kind,
      ...(out.kind === "failed"
        ? { errorCode: out.errorCode, errorMsg: out.errorMsg }
        : out.kind === "write-failure"
          ? { errorMsg: out.errorMsg }
          : {}),
    });
  }
  deps.logger.info("extract-batch-complete", {
    batchId,
    batchSize: opts.batchSize ?? chunks.length,
    processed: chunks.length,
    succeeded,
    failed,
    writeFailures,
    ungrounded,
  });
  return {
    batchId,
    processed: chunks.length,
    succeeded,
    failed,
    writeFailures,
    ungrounded,
  };
}

type ChunkOutcome =
  | { kind: "ok"; ungrounded: number }
  | {
      kind: "failed";
      ungrounded: 0;
      errorCode: string;
      errorMsg: string;
    }
  | { kind: "write-failure"; ungrounded: 0; errorMsg: string };

/**
 * Process-log field whitelist (SC10): { time, chunkId, modelId, latencyMs,
 * outcome, counts }. See src/logging.ts for the full contract — never chunk
 * body text, span text, descriptions, prompts or API keys as log fields.
 */
interface ChunkLogFields {
  time: string;
  chunkId: string;
  modelId: string | null;
  latencyMs: number;
}

/** Whitelisted per-chunk log fields; `code` only on the failure legs. */
function chunkLogFields(
  deps: ExtractPipelineDeps,
  chunkId: string,
  latencyStart: number
): ChunkLogFields {
  return {
    time: depsNow(deps),
    chunkId,
    modelId: deps.llm.modelId ?? null,
    latencyMs: Date.now() - latencyStart,
  };
}

/** One chunk in one transaction; mark-and-continue on every failure leg. */
async function processChunk(
  deps: ExtractPipelineDeps,
  client: Queryable,
  chunk: ChunkInput,
  batchId: string,
  startedAt: string
): Promise<ChunkOutcome> {
  const recordId = newRecordId();
  // Latency covers the whole chunk (LLM call + persist) so the per-chunk
  // process log reflects what an operator would wait for (SC10).
  const latencyStart = Date.now();
  await client.query("BEGIN", []);
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
      await client.query("COMMIT", []);
      deps.logger.info("chunk-failed", {
        ...chunkLogFields(deps, chunk.id, latencyStart),
        code: outcome.errorCode,
        outcome: "failed",
      });
      return {
        kind: "failed",
        ungrounded: 0,
        errorCode: outcome.errorCode,
        errorMsg: outcome.errorMsg,
      };
    }
    const counts = await persistOutputs(
      deps,
      client,
      chunk.id,
      chunk.content,
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
      await client.query("COMMIT", []);
      deps.logger.info("chunk-rejected", {
        ...chunkLogFields(deps, chunk.id, latencyStart),
        code: SELF_LOOP_REJECTED_CODE,
        reason: "all-outputs-self-loop",
        outcome: "failed",
      });
      return {
        kind: "failed",
        ungrounded: 0,
        errorCode: SELF_LOOP_REJECTED_CODE,
        errorMsg: "all outputs were self-loops",
      };
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
    await client.query("COMMIT", []);
    // Authority writes are durable; the precision layer can now safely
    // mirror the canonical names + alias set we just persisted. Failures
    // here NEVER roll the chunk back — the same fail-open posture
    // `src/tools/push.ts` takes for chunk indexing. The chunk is reported
    // as `ok` either way; the precision layer surfaces its own degradation
    // through `keyword_bm25:attempted-and-failed` on stderr.
    await projectEntitiesToPrecisionLayer(deps, client, counts);
    // SC10 success leg: the counts are only final after persistOutputs, so
    // this event fires post-commit with the whitelisted field set.
    deps.logger.info("chunk-extracted", {
      ...chunkLogFields(deps, chunk.id, latencyStart),
      outcome: "ok",
      triples: counts.triples,
      unmapped: counts.unmapped,
      ungrounded: counts.ungrounded,
    });
    return { kind: "ok", ungrounded: counts.ungrounded };
  } catch (err) {
    await client.query("ROLLBACK", []);
    deps.logger.error("chunk-write-failed", {
      ...chunkLogFields(deps, chunk.id, latencyStart),
      outcome: "write-failed",
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      kind: "write-failure",
      ungrounded: 0,
      errorMsg: err instanceof Error ? err.message : String(err),
    };
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
  deps: ExtractPipelineDeps,
  client: Queryable,
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
