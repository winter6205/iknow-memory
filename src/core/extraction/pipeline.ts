/**
 * Extract batch orchestration — selectors + mark-and-continue batch runner.
 *
 * Lifted from `src/cli/extract.ts` (scanChunks / processBatch / processChunk)
 * so the CLI and the MCP extract tool (T3) drive the SAME pipeline without
 * the MCP layer importing `src/cli`. This module is pure orchestration:
 * callers bring a `Queryable` (pool client), clients (LLM / embedder built
 * via `clients.ts`), a logger and an optional precision layer; the schema
 * migration (`upSchemaBootstrap`) and the process exit codes stay caller concerns.
 *
 * Mark-and-continue: one chunk = one transaction. An LLM failure or an
 * all-self-loop reject is a sealed per-chunk outcome (the batch proceeds); a
 * thrown write error rolls that chunk back and is counted as a write failure
 * (the batch still proceeds — the caller decides what the counts mean, e.g.
 * the CLI maps `writeFailures > 0` to exit 2).
 *
 * A lifecycle is one population of chunks and it runs in two phases
 * (ADR-0013):
 *
 *   E — extract, per chunk, with NO transaction open: the method-conflict
 *       gate, the extract method, the judge. A sealed failure commits its own
 *       single-row transaction; an `ok` leg stages `{chunkId, outputs}`.
 *   C — commit: the merge-embed cap is derived ONCE from the phase-E
 *       population and armed, then every staged chunk runs its own
 *       transaction exactly as before.
 *
 * Phase E exists so the cap can be pre-declared: a cap computed while the
 * merge work it bounds is already running can only fire after the blow-up.
 *
 * Commit-phase transaction shape per chunk (SC3): BEGIN → insertRecord(pending)
 * → method-conflict re-check (T1) → persistOutputs (canonical merge) →
 * enrichStandardChunk (standard only: survivor descriptions + claims) →
 * emitProjectionIntents (same transaction as the ledger rows it describes) →
 * recordChunkExtractMethod (T1 version claim) → C-state READY →
 * STALE demotion when the chunk wrote graph rows (T5 gap) → markSucceeded →
 * COMMIT. The ES precision layer mirrors AFTER commit, fail-open, never
 * aborting the chunk.
 */
import { writeStderr, type Logger } from "../../logging.js";
import { GraphragError } from "../errors.js";
import {
  DEFAULT_ENTITY_MERGE_STAGE_MAX_BYTES,
  ENTITY_MERGE_STAGE_MAX_BYTES_VAR,
} from "../../config.js";
import type { PrecisionIndexer } from "../storage/elasticsearch-precision.js";
import { emitProjectionIntents } from "../storage/projection-outbox.js";
import { fetchEntityProjection } from "../storage/entity-projection.js";
import {
  MergeBudgetError,
  MergeStageScopeError,
} from "../entities/merge-budget.js";
import { type ChunkInput } from "./extract.js";
import type { ExtractionOutput, TripleVerdict } from "./types.js";
import {
  enrichStandardChunk,
  ZERO_ENRICH,
  type EnrichCounts,
} from "./enrich.js";
import type { LLMClient } from "./llm-client.js";
import {
  EXTRACT_METHOD_CONFLICT_CODE,
  findChunkMethodConflict,
  recordChunkExtractMethod,
  runExtractMethod,
} from "./method.js";
import { COMMUNITY_INDEX_STATUS, type ExtractMethod } from "../types.js";
import {
  insertRecord,
  markSucceeded,
  markFailed,
  markFailedWithProposal,
  newRecordId,
  MERGE_GRAY_HOLD_CODE,
  SELF_LOOP_REJECTED_CODE,
  type Queryable,
} from "./records.js";
import { judgeProposals } from "./judge.js";
import {
  persistOutputs,
  deriveMergeEmbedCap,
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
  /**
   * Byte ceiling over one lifecycle's staged outputs (ADR-0013), resolved by
   * the process owner (its own env knob) once at boot. Absent → the published
   * default, so no caller can run unbounded without asking for it.
   */
  stageMaxBytes?: number;
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
    // no re-extract path can actually advance. MERGE_GRAY_HOLD rows are
    // filtered out BEFORE the rn=1 partition: a hold describes one gray pair
    // the operator must decide, not the chunk's own status, and it must never
    // stand in as the chunk's latest record (same-transaction `created_at`
    // ties would otherwise make the rn=1 winner non-deterministic).
    where.push(
      `c.id IN (SELECT chunk_id FROM (
         SELECT chunk_id, status, error_code, discarded_at,
           row_number() OVER (PARTITION BY chunk_id ORDER BY created_at DESC) rn
         FROM extraction_records
         WHERE error_code IS DISTINCT FROM '${MERGE_GRAY_HOLD_CODE}'
       ) t WHERE rn = 1 AND status = 'failed' AND error_code != 'SELF_LOOP_REJECTED' AND discarded_at IS NULL)`
    );
  }
  const { rows } = await client.query(
    `SELECT c.id, c.content FROM chunks c
     WHERE ${where.join(" AND ")}
     ORDER BY c.created_at, c.id
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
     ORDER BY c.created_at, c.id
     LIMIT $2`,
    [sourceRef, effectiveCap + 1]
  );
  const chunks = rows
    .slice(0, effectiveCap)
    .map((r) => ({ id: r.id as string, content: r.content as string }));
  return { chunks, hasMore: rows.length > effectiveCap };
}

/** The keyset position one page ended on; `createdAt` rides as pg returned it. */
export interface PendingChunkCursor {
  readonly createdAt: unknown;
  readonly id: string;
}

export interface SourceRefPendingPage extends SourceRefPendingScan {
  /** Position to resume after — null once the population is exhausted. */
  readonly cursor: PendingChunkCursor | null;
}

/**
 * The extract lifecycle's page selector: `selectPendingChunksBySourceRef` on a
 * keyset cursor, so paging a source forward can neither skip nor repeat.
 *
 * The cursor is `(created_at, id)` and the `id` term is required, not a
 * refinement: a page boundary can fall inside a group of rows sharing one
 * `created_at`, which this repo already treats as non-deterministic. With
 * `created_at` alone, either `>` drops the rest of that group or `>=` reads it
 * twice. `hasMore` keeps the `cap + 1` probe.
 */
export async function selectPendingChunksBySourceRefAfter(
  client: Queryable,
  sourceRef: string,
  after: PendingChunkCursor | null,
  cap: number
): Promise<SourceRefPendingPage> {
  const effectiveCap = Math.max(cap, 0);
  const values: unknown[] = [sourceRef];
  const resumed =
    after === null
      ? ""
      : ` AND (c.created_at, c.id) > ($${values.push(after.createdAt)}, $${values.push(after.id)})`;
  const { rows } = await client.query(
    `SELECT c.id, c.content, c.created_at FROM chunks c
     WHERE c.source_ref = $1
       AND ${PENDING_CHUNK_PREDICATE}${resumed}
     ORDER BY c.created_at, c.id
     LIMIT $${values.length + 1}`,
    [...values, effectiveCap + 1]
  );
  const page = rows.slice(0, effectiveCap);
  const last = page[page.length - 1];
  return {
    chunks: page.map((r) => ({ id: r.id as string, content: r.content as string })),
    hasMore: rows.length > effectiveCap,
    cursor:
      last === undefined
        ? null
        : { createdAt: last.created_at, id: last.id as string },
  };
}

/** One source's share of a caller's selection, in first-appearance order. */
export interface ChunkSourcePartition {
  readonly sourceRef: string;
  readonly chunkIds: string[];
}

/**
 * The caller's partition key: which `source_ref`s an already-selected chunk
 * list belongs to. A selection can span sources, and one lifecycle is one
 * source (ADR-0013), so the CLI and the MCP tool resolve the split here
 * rather than sharing or summing a cap across sources.
 */
export async function selectSourcePartitions(
  client: Queryable,
  chunkIds: readonly string[]
): Promise<ChunkSourcePartition[]> {
  const unique = [...new Set(chunkIds)];
  if (unique.length === 0) return [];
  const placeholders = unique.map((_, i) => `$${i + 1}`).join(", ");
  const { rows } = await client.query(
    `SELECT c.id, c.source_ref FROM chunks c WHERE c.id IN (${placeholders})`,
    unique
  );
  const sourceOf = new Map(
    rows.map((r) => [r.id as string, r.source_ref as string])
  );
  const order: string[] = [];
  const grouped = new Map<string, string[]>();
  for (const id of unique) {
    const sourceRef = sourceOf.get(id);
    // A chunk whose row is gone cannot join a source lifecycle; the caller's
    // own selector already reported it as missing.
    if (sourceRef === undefined) continue;
    const bucket = grouped.get(sourceRef);
    if (bucket === undefined) {
      order.push(sourceRef);
      grouped.set(sourceRef, [id]);
    } else {
      bucket.push(id);
    }
  }
  return order.map((sourceRef) => ({
    sourceRef,
    chunkIds: grouped.get(sourceRef) ?? [],
  }));
}

export interface BatchSummary {
  batchId: string;
  processed: number;
  succeeded: number;
  failed: number;
  writeFailures: number;
  ungrounded: number;
  /**
   * Error codes of the sealed `failed` legs, one entry per failed chunk
   * (LLM retry class, SELF_LOOP_REJECTED, FAST_EMPTY_GRAPH, …) — the
   * counts alone cannot tell a job-level policy WHICH failures happened,
   * and a write-failure leg rolls its record back so re-querying
   * extraction_records is not equivalent. The pipeline only reports;
   * callers decide (the CLI maps an all-empty fast graph to exit 1).
   */
  failureCodes: string[];
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
  /**
   * T1 version spine: the extract method for this run, routed through the
   * `runExtractMethod` seam. Default "standard" — the spec's default job
   * (assumption 3); Fast never runs unasked. The production entry today is
   * this option (the extract CLI's --method flag); the MCP tool keeps the
   * standard default (a Fast switch there is a later surface).
   */
  method?: ExtractMethod;
  /**
   * The lifecycle's `source_ref`, for the two cap log lines ONLY (ADR-0013
   * Decision 7). It never scopes the run — the population is whatever the
   * caller handed over — and it exists so a caller that already partitioned
   * its selection can still label the cap it just paid.
   */
  sourceRef?: string | null;
  /**
   * Byte ceiling over the outputs staged between phase E and phase C
   * (ADR-0013 Decision 8). The production entries pass the configured knob;
   * the default here is the constant so this module never reads the operator
   * environment itself, and a test may lower it to reach the refusal without a
   * 64 MiB fixture.
   */
  stageMaxBytes?: number;
}

/**
 * The report code for a `write-failure` leg: the one failure whose whole chunk
 * transaction rolled back, so no `extraction_records` row exists to read a code
 * from and whatever reports the leg has to name it.
 */
export const EXTRACT_WRITE_FAILURE_CODE = "WRITE_FAILURE";

/**
 * The failure half of a batch, or of a stage tally over several batches:
 * `BatchSummary` and the index-job extract outcome are both assignable.
 */
export interface FailureTally {
  readonly failed: number;
  readonly writeFailures: number;
  readonly failureCodes: readonly string[];
}

/**
 * Every leg that indexed nothing: a sealed failure and a rolled-back write are
 * different legs (the second left no record and no code of its own), so the
 * batch's not-indexed total is their sum. One owner because every caller asks
 * the same question and two hand-written sums can drift apart.
 */
export function notIndexed(tally: FailureTally): number {
  return tally.failed + tally.writeFailures;
}

/**
 * The one code that names a failed batch — the single place the precedence
 * lives, so no caller restates it.
 *
 * The answer is null exactly when the tally indexed everything (`notIndexed`
 * zero), so a caller that takes the non-null half gets its failure gate and its
 * code from one predicate instead of two that can drift.
 *
 * WHY the typed code outranks `EXTRACT_WRITE_FAILURE_CODE`: a sealed leg's code
 * says *why* the chunk produced nothing (the class an operator or a retrier can
 * act on), while a write failure says only that a leg persisted nothing — the
 * container, not the cause. A batch that mixed both therefore names the cause;
 * `EXTRACT_WRITE_FAILURE_CODE` answers only a batch whose failed legs ALL rolled
 * back and so report no code of their own.
 *
 * Exit severity is a different question (see `src/cli/extract.ts`): which arm
 * outranks there is about what the operator must fix first, not about which
 * code names the failure.
 */
export function batchFailureCode(tally: FailureTally): string | null {
  if (notIndexed(tally) === 0) return null;
  return tally.failureCodes[0] ?? EXTRACT_WRITE_FAILURE_CODE;
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

type ChunkOutcome =
  | { kind: "ok"; ungrounded: number }
  | {
      kind: "failed";
      ungrounded: 0;
      errorCode: string;
      errorMsg: string;
    }
  | { kind: "write-failure"; ungrounded: 0; errorMsg: string };

/** One phase-E leg that reached phase C, with the outputs it extracted. */
interface StagedLeg {
  readonly kind: "staged";
  readonly chunkId: string;
  readonly outputs: ExtractionOutput[];
}

/** What phase E leaves behind per chunk: staged work, or a settled failure. */
type PhaseELeg =
  | StagedLeg
  | Exclude<ChunkOutcome, { kind: "ok" }>;

async function* onePage(chunks: ChunkInput[]): AsyncGenerator<ChunkInput[]> {
  if (chunks.length > 0) yield chunks;
}

/**
 * One extract lifecycle over an already-selected chunk list: phase E over the
 * whole list, then one cap and phase C.
 */
export async function processBatch(
  deps: ExtractPipelineDeps,
  client: Queryable,
  chunks: ChunkInput[],
  opts: ProcessBatchOptions = {}
): Promise<BatchSummary> {
  return runExtractLifecycle(deps, client, onePage(chunks), opts);
}

/**
 * One extract lifecycle over a source's whole pending set, paged by the
 * caller: the page loop is phase E's, and every page feeds ONE cap. A
 * lifecycle per page would multiply the formula by the page count.
 */
export async function runPagedExtractLifecycle(
  deps: ExtractPipelineDeps,
  client: Queryable,
  pages: AsyncIterable<ChunkInput[]>,
  opts: ProcessBatchOptions = {}
): Promise<BatchSummary> {
  return runExtractLifecycle(deps, client, pages, opts);
}

async function runExtractLifecycle(
  deps: ExtractPipelineDeps,
  client: Queryable,
  pages: AsyncIterable<ChunkInput[]>,
  opts: ProcessBatchOptions
): Promise<BatchSummary> {
  const batchId = newRecordId();
  const method: ExtractMethod = opts.method ?? "standard";
  const startedAt = depsNow(deps);
  const sourceRef = opts.sourceRef ?? null;
  const stageMaxBytes =
    opts.stageMaxBytes ??
    deps.stageMaxBytes ??
    DEFAULT_ENTITY_MERGE_STAGE_MAX_BYTES;
  // Forked per lifecycle: the deps object outlives the run, and two
  // lifecycles in one process must not share a counter.
  const mergeBudget = deps.mergeBudget.fork();
  const staged: StagedLeg[] = [];
  const legOrder: string[] = [];
  const outcomes = new Map<string, ChunkOutcome>();
  const failureCodes: string[] = [];
  let writeFailures = 0;
  let succeeded = 0;
  let failed = 0;
  let ungrounded = 0;
  let stagedBytes = 0;

  for await (const page of pages) {
    for (const chunk of page) {
      const leg = await extractPhase(
        deps,
        client,
        chunk,
        batchId,
        startedAt,
        method
      );
      legOrder.push(chunk.id);
      if (leg.kind === "staged") {
        staged.push(leg);
        stagedBytes += Buffer.byteLength(JSON.stringify(leg.outputs), "utf8");
      } else {
        outcomes.set(chunk.id, leg);
      }
    }
    // Checked at every page boundary, before the next page's round trips: the
    // pages already staged are discarded with the lifecycle and nothing was
    // committed.
    if (stagedBytes > stageMaxBytes) {
      const selection = sourceRef ?? "this selection";
      const message =
        `entity-merge staging scope refused for ${selection}: staged ` +
        `output bytes ${stagedBytes} exceed the ceiling ${stageMaxBytes}; ` +
        `raise ${ENTITY_MERGE_STAGE_MAX_BYTES_VAR} or split the source`;
      deps.logger.error("entity-merge-stage-limit", {
        source_ref: sourceRef,
        staged_bytes: stagedBytes,
        stage_max_bytes: stageMaxBytes,
      });
      throw new MergeStageScopeError(message, stagedBytes, stageMaxBytes);
    }
  }

  // The cap is derived from the phase-E population and armed before the first
  // merge-gate resolution of the lifecycle.
  mergeBudget.arm(
    deriveMergeEmbedCap(
      staged.flatMap((leg) => leg.outputs),
      staged.length
    ).embedCap
  );

  try {
    for (const leg of staged) {
      outcomes.set(
        leg.chunkId,
        await commitPhase(
          deps,
          { ...deps, mergeBudget },
          client,
          leg,
          batchId,
          startedAt,
          method
        )
      );
    }
  } catch (err) {
    // A budget refusal is a run-level failure: it must not be sealed as a
    // chunk leg, so it re-throws past phase C with the frozen three fields.
    if (err instanceof MergeBudgetError) {
      const budget = mergeBudget.snapshot();
      deps.logger.error("entity-merge-embed-limit", {
        source_ref: sourceRef,
        embed_calls: budget.embedCalls,
        embed_cap: budget.embedCap,
      });
    }
    throw err;
  }

  for (const chunkId of legOrder) {
    const out = outcomes.get(chunkId);
    if (out === undefined) continue;
    if (out.kind === "write-failure") writeFailures += 1;
    else if (out.kind === "ok") succeeded += 1;
    else {
      failed += 1;
      failureCodes.push(out.errorCode);
    }
    // Every leg defines `ungrounded` (failed legs are 0), so no guard needed.
    ungrounded += out.ungrounded;
    opts.onChunkOutcome?.({
      chunkId,
      kind: out.kind,
      ...(out.kind === "failed"
        ? { errorCode: out.errorCode, errorMsg: out.errorMsg }
        : out.kind === "write-failure"
          ? { errorMsg: out.errorMsg }
          : {}),
    });
  }

  const budget = mergeBudget.snapshot();
  deps.logger.info("extract-batch-complete", {
    batchId,
    batchSize: opts.batchSize ?? legOrder.length,
    processed: legOrder.length,
    succeeded,
    failed,
    writeFailures,
    ungrounded,
    source_ref: sourceRef,
    embed_cap: budget.embedCap,
    embed_calls: budget.embedCalls,
  });
  return {
    batchId,
    processed: legOrder.length,
    succeeded,
    failed,
    writeFailures,
    ungrounded,
    failureCodes,
  };
}

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

/**
 * Phase E, one chunk: no transaction is open, so no merge gate can run here.
 * A sealed failure commits its OWN single-row transaction at the point it is
 * sealed, so a crash during phase E never loses a failure record.
 */
async function extractPhase(
  deps: ExtractPipelineDeps,
  client: Queryable,
  chunk: ChunkInput,
  batchId: string,
  startedAt: string,
  method: ExtractMethod
): Promise<PhaseELeg> {
  const recordId = newRecordId();
  const latencyStart = Date.now();
  const sealFailed = async (
    code: string,
    msg: string,
    proposal?: { triples: ExtractionOutput[]; verdicts: TripleVerdict[] }
  ): Promise<PhaseELeg> => {
    await client.query("BEGIN", []);
    try {
      await insertRecord(client, { id: recordId, batchId, chunkId: chunk.id, startedAt });
      if (proposal === undefined) {
        await markFailed(client, recordId, { code, msg });
      } else {
        // A judge reject/down seals the reviewable proposal the maintenance
        // lane replays later — never triples, intents or graph rows.
        await markFailedWithProposal(client, recordId, { code, msg }, proposal);
      }
      await client.query("COMMIT", []);
    } catch (err) {
      await client.query("ROLLBACK", []);
      throw err;
    }
    deps.logger.info("chunk-failed", {
      ...chunkLogFields(deps, chunk.id, latencyStart),
      code,
      outcome: "failed",
    });
    return { kind: "failed", ungrounded: 0, errorCode: code, errorMsg: msg };
  };

  try {
    // T1 conflict gate, run early here only to avoid paying a model round trip
    // for a chunk that will be refused. The commit point re-checks it.
    const conflict = await findChunkMethodConflict(client, chunk.id, method);
    if (conflict) {
      return await sealFailed(
        EXTRACT_METHOD_CONFLICT_CODE,
        `source ${conflict.sourceRef} already extracted with method "${conflict.recorded}"; refusing "${method}" on the same version`
      );
    }
    const outcome = await runExtractMethod(method, chunk, { llm: deps.llm });
    if (outcome.kind === "failed") {
      return await sealFailed(outcome.errorCode, outcome.errorMsg);
    }
    const judged = await judgeProposals(deps.llm, chunk, outcome.outputs);
    if (judged.kind === "failed") {
      return await sealFailed(judged.errorCode, judged.errorMsg, {
        triples: outcome.outputs,
        verdicts: judged.verdicts,
      });
    }
    return { kind: "staged", chunkId: chunk.id, outputs: outcome.outputs };
  } catch (err) {
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
 * Phase C, one staged chunk, in one transaction; mark-and-continue on every
 * failure leg except a budget refusal, which is a run-level failure and
 * re-throws after rolling this chunk back.
 */
async function commitPhase(
  deps: ExtractPipelineDeps,
  mergeDeps: ExtractPipelineDeps,
  client: Queryable,
  leg: StagedLeg,
  batchId: string,
  startedAt: string,
  method: ExtractMethod
): Promise<ChunkOutcome> {
  const recordId = newRecordId();
  // Latency covers the whole commit (merge + persist) so the per-chunk
  // process log reflects what an operator would wait for (SC10).
  const latencyStart = Date.now();
  await client.query("BEGIN", []);
  try {
    await insertRecord(client, {
      id: recordId,
      batchId,
      chunkId: leg.chunkId,
      startedAt,
    });
    // The guard belongs at the commit point, so a writer that claimed another
    // method during phase E cannot slip a second claim in between.
    const conflict = await findChunkMethodConflict(client, leg.chunkId, method);
    if (conflict) {
      const msg = `source ${conflict.sourceRef} already extracted with method "${conflict.recorded}"; refusing "${method}" on the same version`;
      await markFailed(client, recordId, {
        code: EXTRACT_METHOD_CONFLICT_CODE,
        msg,
      });
      await client.query("COMMIT", []);
      deps.logger.info("chunk-failed", {
        ...chunkLogFields(deps, leg.chunkId, latencyStart),
        code: EXTRACT_METHOD_CONFLICT_CODE,
        outcome: "failed",
      });
      return {
        kind: "failed",
        ungrounded: 0,
        errorCode: EXTRACT_METHOD_CONFLICT_CODE,
        errorMsg: msg,
      };
    }
    const chunk = await readChunkContent(client, leg.chunkId);
    const counts = await persistOutputs(
      mergeDeps,
      client,
      chunk.id,
      chunk.content,
      leg.outputs,
      startedAt
    );
    // Gray pairs the judge held for the operator get one independent
    // failed record each (MERGE_GRAY_HOLD) in the SAME chunk transaction.
    // Recorded BEFORE the allSelfLoop branch so no path can drop a hold on
    // the floor: the chunk itself stays succeeded — a hold is a visible
    // maintenance item, not an extraction failure — and listFailed() shows
    // the pair next to extract failures for the operator to review or
    // discard.
    await recordMergeHolds(client, batchId, leg.chunkId, startedAt, counts);
    if (counts.allSelfLoop) {
      // SC5: every output was a self-loop, so the chunk produced zero graph
      // edges and zero entities. Record the chunk as a permanent reject — the
      // SELF_LOOP_REJECTED sentinel keeps it visible in extraction_records
      // while excluding it from --list-failed / --only-failed (no re-extract
      // path can produce anything but the same self-loop again).
      await commitSelfLoopRejection(client, recordId, deps.logger, {
        name: "chunk-rejected",
        fields: {
          ...chunkLogFields(deps, leg.chunkId, latencyStart),
          code: SELF_LOOP_REJECTED_CODE,
          reason: "all-outputs-self-loop",
          outcome: "failed",
        },
      });
      return {
        kind: "failed",
        ungrounded: 0,
        errorCode: SELF_LOOP_REJECTED_CODE,
        errorMsg: "all outputs were self-loops",
      };
    }
    // T3 standard-only post-merge enrichment (ADR 0069 / 0071): summarize
    // each merge survivor's description list and re-state this chunk's
    // claims AFTER the canonical merge settled survivors, inside the SAME
    // transaction — a rolled-back chunk keeps no summaries and no claims.
    // Every LLM-level miss is a sealed skip inside the leg (ticket: one
    // description miss does not fail the whole C job); a DB write error
    // still rolls the chunk back through the catch below. Fast never runs
    // this (spec: Fast has no descriptions, no claims).
    const enrich: EnrichCounts =
      method === "standard"
        ? await enrichStandardChunk(
            deps,
            client,
            chunk,
            counts.survivors,
            startedAt
          )
        : { ...ZERO_ENRICH };
    // Same transaction as the ledger rows it describes (SC3): a projection
    // intent that outlived a rolled-back chunk would tell the projector to
    // sync a row Postgres never kept, and a chunk that committed without one
    // would leave Neo4j permanently behind. A throw here lands in the catch
    // below, which rolls the whole chunk back.
    await emitProjectionIntents(client, counts.projected);
    // T1 version spine: the method that produced these rows is recorded on
    // the chunk's 资料 row inside the SAME transaction — a rolled-back chunk
    // never leaves a version claim behind, and the overwrite guard keeps a
    // conflicting method from being replaced (SC2).
    await recordChunkExtractMethod(client, leg.chunkId, method);
    // T5 review gap (graph-index-standard-fast): producer-side C demotion.
    // Graph rows committed by this chunk make the stored summary generation
    // outdated; a chunk that persisted nothing (`projected` empty) leaves the
    // state untouched. Riding the SAME transaction means a rolled-back chunk
    // never demotes, and a committed graph change never stays `ready`. The
    // WHERE guard keeps precedence: only READY moves to STALE — a failed
    // build is not resurrected, an in-flight rebuild is not interrupted,
    // and a missing row is a no-op (the community-summary swap to READY is
    // the recovery path either way).
    if (counts.projected.length > 0) {
      await demoteCommunityIndexState(client);
    }
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
    // this event fires post-commit with the whitelisted field set. The T3
    // enrichment counts and the T6 description-embed counts ride the same
    // whitelist (numbers only — never the summary text or claim text).
    deps.logger.info("chunk-extracted", {
      ...chunkLogFields(deps, leg.chunkId, latencyStart),
      outcome: "ok",
      triples: counts.triples,
      unmapped: counts.unmapped,
      ungrounded: counts.ungrounded,
      described: enrich.described,
      describeSkipped: enrich.describeSkipped,
      embedded: enrich.embedded,
      embedSkipped: enrich.embedSkipped,
      claims: enrich.claimsWritten,
      claimsSkipped: enrich.claimsSkipped,
    });
    return { kind: "ok", ungrounded: counts.ungrounded };
  } catch (err) {
    await client.query("ROLLBACK", []);
    // EXIT: sealing a cap breach as a chunk leg would report a cost refusal as
    // an ordinary write failure; the run-level refusal owns the whole batch.
    if (err instanceof MergeBudgetError) throw err;
    deps.logger.error("chunk-write-failed", {
      ...chunkLogFields(deps, leg.chunkId, latencyStart),
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
 * The chunk text phase C needs: the grounding gate compares the evidence span
 * against it and the standard enrichment takes the chunk. Phase E stages
 * outputs only, so it is re-read here, by id, inside this chunk's transaction.
 */
async function readChunkContent(
  client: Queryable,
  chunkId: string
): Promise<ChunkInput> {
  const { rows } = await client.query(
    `SELECT c.id, c.content FROM chunks c WHERE c.id = $1`,
    [chunkId]
  );
  const row = rows[0];
  if (row === undefined) {
    throw new GraphragError(
      `chunk ${chunkId} is gone by the commit phase of its lifecycle`,
      "STORAGE_ERROR"
    );
  }
  return { id: row.id as string, content: row.content as string };
}

/**
 * The one posture of a SELF_LOOP_REJECTED leg across every write path (the
 * batch and the promote replay): seal the record, COMMIT the rejection
 * inside the caller's transaction, then log with the caller's event fields.
 * Exported for actions.ts so the two paths cannot drift on how a permanent
 * reject settles.
 */
export async function commitSelfLoopRejection(
  client: Queryable,
  recordId: string,
  logger: Logger,
  event: { name: string; fields: Record<string, unknown> }
): Promise<void> {
  await markFailed(client, recordId, {
    code: SELF_LOOP_REJECTED_CODE,
    msg: "all outputs were self-loops",
  });
  await client.query("COMMIT", []);
  logger.info(event.name, event.fields);
}

/**
 * One failed extraction_records row per judge-held gray pair: the row rides
 * the same maintenance lane as extract failures (`MERGE_GRAY_HOLD` is not
 * excluded by `listFailed()`) while the chunk's own record still succeeds —
 * a hold needs an operator decision, not a re-extract of the whole chunk.
 */
async function recordMergeHolds(
  client: Queryable,
  batchId: string,
  chunkId: string,
  startedAt: string,
  counts: PersistCounts
): Promise<void> {
  for (const hold of counts.mergeHolds) {
    const id = newRecordId();
    await insertRecord(client, { id, batchId, chunkId, startedAt });
    await markFailed(client, id, {
      code: MERGE_GRAY_HOLD_CODE,
      msg:
        `merge gray-zone hold: incoming "${hold.incomingName}" ` +
        `(${hold.incomingType}) vs candidate ${hold.candidateId}` +
        (hold.observedCosine !== undefined
          ? ` cosine=${hold.observedCosine}`
          : ""),
    });
  }
}

/**
 * Move the singleton C-ready row READY → STALE (see the call site in
 * `processChunk` and `COMMUNITY_INDEX_STATUS` in core/types). Both literals
 * ride as binds so the vocabulary keeps its SSOT in the constant; the
 * `WHERE id = 1 AND status = <ready>` guard is the whole precedence rule —
 * no INSERT, so the state row only ever exists via a community-summary run.
 * Exported for the review lane (actions.ts promote replays graph rows and
 * must demote the same way a committed chunk does).
 */
export async function demoteCommunityIndexState(
  client: Queryable
): Promise<void> {
  await client.query(
    `UPDATE community_index_state
        SET status = $1, updated_at = now()
      WHERE id = 1 AND status = $2`,
    [COMMUNITY_INDEX_STATUS.STALE, COMMUNITY_INDEX_STATUS.READY]
  );
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
