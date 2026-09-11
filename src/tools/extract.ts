/**
 * Extract tool — MCP trigger for the LLM triple-extraction + merge +
 * persist pipeline (specs/mcp-tool-surface.md §Extract tool contract).
 *
 * It runs the SAME lifted pipeline as the extract CLI
 * (`src/core/extraction/pipeline.ts`): select chunks → one transaction per
 * chunk (extraction record + entities + triples + outbox intents) →
 * mark-and-continue. This file owns ONLY the Host-facing selector contract,
 * the batch cap and error mapping. There is no second persist writer here
 * (the first-slice evidence-span grounding gate is inherited through the
 * shared `persistOutputs`), and no import from `src/cli` (SC13).
 *
 * Selector — exactly one (xor, enforced by the schema AND re-checked
 * defensively in the handler):
 *   - `chunk_ids`: non-empty list of chunk UUIDs, at most the shared batch
 *     limit (`resolveToolBatchLimit` — the frozen
 *     GRAPHRAG_MEMORY_INGEST_BATCH_LIMIT cap, same as the ingest tool).
 *     Existing ids are processed in the
 *     caller's order; re-extracting a known id is allowed (no pending
 *     filter — the caller named the chunks). Ids the store does not have
 *     are reported in `missing_chunk_ids` and counted nowhere.
 *   - `source_ref`: that source's pending chunks (no
 *     `extraction_records.status='succeeded'` row), oldest first, capped at
 *     the batch limit. `more_pending: true` in the response says a further
 *     call with the same source_ref will find more — no silent truncation.
 *     Zero pending is a success with zero counts, not an error.
 *
 * Auth (SC9): a persist run needs an LLM token and embedding credentials.
 * The core guards (`buildLlmClient` / `buildEmbedderClient`) still make the
 * keyless refusal decision; this layer only re-words their `ConfigError`
 * into a Host-readable typed error (the core message names CLI flags a Host
 * does not have). `FakeLLMClient` / fake vectors are unreachable on this
 * path — the fake fallbacks only exist behind a non-extraction intent.
 *
 * Error mapping:
 *   - missing Postgres pool / missing LLM or embedding credentials →
 *     `ExtractNotConfiguredError` (a `ConfigError`): the server itself
 *     boots and every other tool stays usable; only extract answers with
 *     the typed configuration error.
 *   - `chunk_ids` longer than the batch limit →
 *     `ExtractBatchLimitExceededError`, mirroring the ingest tool.
 *   - one chunk failing never aborts its siblings (mark-and-continue);
 *     failures travel in the response as `failed_chunks` entries shaped
 *     like `extraction_records` rows (chunk_id / error_code / error_msg).
 */
import { z } from "zod";

import { GraphragError } from "../core/errors.js";
import type { EmbeddingClient } from "../core/embedder.js";
import {
  buildEmbedderClient,
  buildLlmClient,
  type EmbedderClientEnv,
  type LlmClientEnv,
} from "../core/extraction/clients.js";
import type { LLMClient } from "../core/extraction/llm-client.js";
import {
  processBatch,
  selectChunksByIds,
  selectPendingChunksBySourceRef,
  type BatchSummary,
  type ChunkOutcomeReport,
  type ExtractPipelineDeps,
} from "../core/extraction/pipeline.js";
import type { PrecisionIndexer } from "../core/storage/elasticsearch-precision.js";
import { upSchemaBootstrap } from "../core/storage/schema-bootstrap.js";
import { ConfigError } from "../config.js";
import { resolveToolBatchLimit } from "./batch-limit.js";
import type { Logger } from "../logging.js";
import {
  textResult,
  type ToolRegistration,
  type ToolResult,
} from "./registry.js";

/**
 * Zod schema for the extract input. Strict (unknown keys are validation
 * errors, matching the other post-T2 tools). The xor / non-empty rules are
 * cross-field, so they live in a `superRefine` — with the defensive
 * re-check mirrored in the handler for direct (non-wire) callers.
 */
export const ExtractInputSchema = z
  .strictObject({
    chunk_ids: z.array(z.string().uuid()).optional(),
    source_ref: z
      .string()
      .min(1, "source_ref must be a non-empty string")
      .optional(),
  })
  .superRefine((input, ctx) => {
    const hasIds = input.chunk_ids !== undefined;
    const hasRef = input.source_ref !== undefined;
    if (hasIds && hasRef) {
      ctx.addIssue({
        code: "custom",
        path: ["chunk_ids"],
        message:
          "provide exactly one selector: chunk_ids or source_ref, never both",
      });
      return;
    }
    if (!hasIds && !hasRef) {
      ctx.addIssue({
        code: "custom",
        path: [],
        message: "provide exactly one selector: chunk_ids or source_ref",
      });
      return;
    }
    if (input.chunk_ids !== undefined && input.chunk_ids.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["chunk_ids"],
        message:
          "chunk_ids must be a non-empty array when selecting chunks by id",
      });
    }
  });

/** Inferred TypeScript type for the parsed extract input. */
export type ExtractInput = z.infer<typeof ExtractInputSchema>;

/** One failed chunk in the response — the `extraction_records` shape. */
export interface ExtractFailedChunk {
  chunk_id: string;
  error_code: string;
  error_msg: string;
}

/** JSON payload returned as text content on success. */
export interface ExtractOutput {
  batch_id: string;
  processed: number;
  /**
   * Host view: every chunk that did not succeed. Write failures (whose
   * extraction_records row rolled back with the chunk transaction) are
   * included here and broken out in `write_failures`.
   */
  succeeded: number;
  failed: number;
  write_failures: number;
  /** Per-triple ungrounded rejections (mark-and-continue, not chunk-fatal). */
  ungrounded: number;
  failed_chunks: ExtractFailedChunk[];
  /** source_ref selector only: a further call will find more pending chunks. */
  more_pending?: true;
  /** chunk_ids selector only: requested ids the store does not have. */
  missing_chunk_ids?: string[];
}

/**
 * Typed failure for a server whose environment cannot run the persist
 * pipeline: no database pool, no LLM token, or no embedding credentials.
 * Extends ConfigError — this is operator configuration, not per-call input —
 * while the handler boundary turns any throw into an `isError` tool result,
 * so the server keeps booting and the other tools stay offline-usable.
 */
export class ExtractNotConfiguredError extends ConfigError {
  constructor(message: string) {
    super(message);
    this.name = "ExtractNotConfiguredError";
  }
}

/** Typed failure for a chunk_ids selector over the configured batch limit. */
export class ExtractBatchLimitExceededError extends GraphragError {
  readonly actualCount: number;
  readonly limit: number;

  constructor(actualCount: number, limit: number) {
    super(
      `extract: chunk_ids length ${actualCount} exceeds limit ${limit}`,
      "INVALID_INPUT"
    );
    this.name = "ExtractBatchLimitExceededError";
    // GraphragError's taxonomy predates batch extract; mirror the ingest
    // tool's BATCH_LIMIT_EXCEEDED runtime code without widening the shared
    // union for callers that do not know about it.
    (this as unknown as { code: string }).code = "BATCH_LIMIT_EXCEEDED";
    this.actualCount = actualCount;
    this.limit = limit;
  }
}

/** One leased database connection (a pg PoolClient or a test fake). */
export interface ExtractClient {
  query: (text: string, values: unknown[]) => Promise<{ rows: any[] }>;
  release: () => void;
}

/**
 * Minimal pool surface the extract handler consumes. The production wiring
 * hands in a lazily-created pg pool (no startup dial); tests inject fakes.
 */
export interface ExtractPool {
  connect: () => Promise<ExtractClient>;
}

/** Dependencies injected at wiring time. */
export interface ExtractDeps {
  /**
   * ANTHROPIC_AUTH_TOKEN family, resolved by the wiring from its own env.
   * Undefined authToken on this always-extraction tool is a typed error.
   */
  llmEnv: LlmClientEnv;
  /** Embedding credential block, resolved by the wiring from its own env. */
  embedderEnv: EmbedderClientEnv;
  /**
   * Postgres pool. Absent → typed per-call error: extract persists, so it
   * cannot run without a database, but the server must still boot and the
   * other tools stay usable. Never substituted with a fake store.
   */
  pool?: ExtractPool;
  /**
   * Optional ES derived-index writer. Mirror happens after COMMIT inside the
   * core pipeline, fail-open — authority writes always win.
   */
  precision?: PrecisionIndexer;
  /**
   * Test seam: a pre-built LLM client overriding the credential-guard
   * build. Production wiring never sets it (the guard decides from
   * `llmEnv`); tests inject `FakeLLMClient` here so no network is dialed.
   */
  llm?: LLMClient;
  /**
   * Test seam: a pre-built embedder overriding the credential-guard build.
   * Production wiring never sets it; tests inject `FakeEmbedder` here.
   */
  embedder?: EmbeddingClient;
  /**
   * Structured logger for the SC10 extract process log. Optional so
   * existing dep constructions stay source-compatible; production wiring
   * threads the server logger in.
   */
  logger?: Logger;
  /** Test/wiring override of the batch cap; absent reads the env default. */
  batchLimit?: number;
  /** Injectable clock for deterministic started_at in tests. */
  now?: () => string;
  /**
   * T4 write-time supersede switch. Forwarded to the persist half so a
   * contradicting older row is retired in the same per-chunk transaction
   * instead of accumulating until an offline consolidate `--apply`.
   * The production wiring (`buildExtractDeps` in src/index.ts) threads the
   * validated env value — ON by default per ADR-0009, explicit off as the
   * escape hatch — so one operator setting governs both the MCP tool and
   * the offline CLI; tests inject it explicitly via this seam, where an
   * omitted value keeps the pre-T4 merge-on-overlap shape.
   */
  writeTimeSupersede?: boolean;
}

/** No-op logger for dep constructions that did not thread one in. */
const NOOP_LOGGER: Logger = {
  level: "error",
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * Build the real persist LLM client through the core credential guard.
 *
 * The guard throws ConfigError with CLI-flag wording ("pass --dry-run ...");
 * a Host has no CLI, so the refusal is re-worded into a typed Host-readable
 * error naming the env var that is missing. The decision itself is never
 * re-implemented here — the guard still decides (SC9).
 */
function buildGuardedLlm(deps: ExtractDeps): LLMClient {
  try {
    return buildLlmClient(deps.llmEnv, { extraction: true });
  } catch (err) {
    if (err instanceof ConfigError) {
      throw new ExtractNotConfiguredError(
        "extract is not configured: no LLM credential. Persisting extraction " +
          "results requires ANTHROPIC_AUTH_TOKEN; the server refuses to store " +
          "made-up triples, so configure the credential and retry."
      );
    }
    throw err;
  }
}

/** The LLM guard mirrored for the embedding half. */
function buildGuardedEmbedder(deps: ExtractDeps): EmbeddingClient {
  try {
    return buildEmbedderClient(deps.embedderEnv, {
      persistsEmbeddings: true,
    });
  } catch (err) {
    if (err instanceof ConfigError) {
      throw new ExtractNotConfiguredError(
        "extract is not configured: no embedding credentials. Persisting " +
          "extracted entities requires GRAPHRAG_MEMORY_EMBED_API_KEY, " +
          "GRAPHRAG_MEMORY_EMBED_BASE_URL and GRAPHRAG_MEMORY_EMBED_MODEL; " +
          "the server refuses to write fake vectors, so configure them and retry."
      );
    }
    throw err;
  }
}

/** The handler-level restatement of the schema's xor selector rules. */
function assertExactlyOneSelector(input: ExtractInput): void {
  if (
    (input.chunk_ids !== undefined && input.source_ref !== undefined) ||
    (input.chunk_ids === undefined && input.source_ref === undefined) ||
    (input.chunk_ids !== undefined && input.chunk_ids.length === 0)
  ) {
    throw new GraphragError(
      "extract: exactly one selector is required — chunk_ids (non-empty UUID list) or source_ref, never both",
      "INVALID_INPUT"
    );
  }
}

/**
 * A resolved selector: the chunks to run plus the selector's extra report
 * fields (`missing_chunk_ids` for chunk_ids, `more_pending` for source_ref).
 */
interface ResolvedSelector {
  chunks: { id: string; content: string }[];
  /** chunk_ids selector only: requested ids the store does not have. */
  missingChunkIds: string[];
  /** source_ref selector only: a further call will find more pending chunks. */
  morePending: boolean;
}

/**
 * Resolve the xor selector against the store (xor already enforced by
 * `assertExactlyOneSelector`).
 *
 * chunk_ids: existing ids are processed in the caller's order (no pending
 * filter — the caller named the chunks); ids the store does not have are
 * reported in `missingChunkIds` (deduplicated) and counted nowhere.
 * source_ref: that source's pending chunks, oldest first, capped at the
 * batch limit — `morePending` says a further call will find more (no silent
 * truncation).
 */
async function resolveSelector(
  client: ExtractClient,
  input: ExtractInput,
  batchLimit: number
): Promise<ResolvedSelector> {
  if (input.chunk_ids !== undefined) {
    const chunks = await selectChunksByIds(client, input.chunk_ids);
    const found = new Set(chunks.map((c) => c.id));
    const missingChunkIds = [...new Set(input.chunk_ids)].filter(
      (id) => !found.has(id)
    );
    return { chunks, missingChunkIds, morePending: false };
  }
  // source_ref is defined here by the xor check above.
  const scan = await selectPendingChunksBySourceRef(
    client,
    input.source_ref as string,
    batchLimit
  );
  return {
    chunks: scan.chunks,
    missingChunkIds: [],
    morePending: scan.hasMore,
  };
}

/**
 * Map one pipeline outcome onto the response's `failed_chunks` entry (the
 * `extraction_records` shape: chunk_id / error_code / error_msg). `ok`
 * outcomes map to nothing — only `failed` and `write-failure` legs are
 * Host-visible failures.
 */
function failedChunkFromOutcome(
  outcome: ChunkOutcomeReport
): ExtractFailedChunk | undefined {
  if (outcome.kind === "ok") return undefined;
  return {
    chunk_id: outcome.chunkId,
    error_code:
      outcome.kind === "failed"
        ? (outcome.errorCode ?? "UNKNOWN")
        : // Write failures leave no extraction_records row (the whole chunk
          // transaction rolled back), so the report code is named here
          // rather than in the database.
          "WRITE_FAILURE",
    error_msg:
      outcome.errorMsg ??
      (outcome.kind === "failed"
        ? "extraction failed"
        : "database write failed; the chunk transaction rolled back"),
  };
}

/**
 * Assemble the Host-facing JSON payload from the batch summary plus the
 * selector's report fields.
 */
function buildExtractOutput(
  summary: BatchSummary,
  failedChunks: ExtractFailedChunk[],
  selector: ResolvedSelector
): ExtractOutput {
  return {
    batch_id: summary.batchId,
    processed: summary.processed,
    succeeded: summary.succeeded,
    // Host view: every chunk that did not succeed counts as failed;
    // write_failures is the rolled-back-transaction subset.
    failed: summary.failed + summary.writeFailures,
    write_failures: summary.writeFailures,
    ungrounded: summary.ungrounded,
    failed_chunks: failedChunks,
    ...(selector.missingChunkIds.length > 0
      ? { missing_chunk_ids: selector.missingChunkIds }
      : {}),
    ...(selector.morePending ? { more_pending: true as const } : {}),
  };
}

/**
 * Assemble the core pipeline deps from the handler's injection seams.
 *
 * Split out of `extractHandler` so the handler reads as the straight-line
 * check → dial → run sequence it documents. Every optional seam is spread in
 * only when present, so an absent seam stays equivalent to the core's own
 * default (no precision layer, wall-clock `now`, supersede OFF) without
 * materializing `undefined` keys.
 *
 * `llm` / `embedder` arrive already built: the credential guards run in the
 * handler, where their `ConfigError` becomes the Host-readable
 * `ExtractNotConfiguredError` (SC9).
 */
function buildPipelineDeps(
  deps: ExtractDeps,
  llm: LLMClient,
  embedder: EmbeddingClient
): ExtractPipelineDeps {
  return {
    llm,
    embedder,
    logger: deps.logger ?? NOOP_LOGGER,
    ...(deps.precision !== undefined ? { precision: deps.precision } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
    ...(deps.writeTimeSupersede === true ? { writeTimeSupersede: true } : {}),
  };
}

/**
 * Build the extract handler with the given dependencies closed over.
 *
 * Order of checks (and why this order):
 *  1. Selector xor + batch cap — cheap input errors before any config gate.
 *  2. Pool presence — no database means extract can never run; this check
 *     only tests the wiring (it does not dial), so the Host learns the most
 *     fundamental missing piece first.
 *  3. Credentials — a typed config failure surfaces before the database is
 *     dialed (and long before any LLM call), so a misconfigured server
 *     never opens a connection it cannot use.
 *  4. Schema bootstrap → selector → batch.
 */
export function createExtractHandler(deps: ExtractDeps) {
  // The schema bootstrap is idempotent DDL (CREATE ... IF NOT EXISTS)
  // behind a transaction-scoped advisory lock. Memoize ONE run per tool
  // registration (per server) so repeated calls do not replay it; a failed
  // attempt clears the memo so the next call retries instead of caching the
  // failure. The CLI re-runs it per process — this is the same posture for
  // a long-lived caller.
  let schemaReady: Promise<void> | undefined;
  const ensureSchema = (client: ExtractClient): Promise<void> => {
    schemaReady ??= upSchemaBootstrap(
      client,
      deps.embedderEnv.dimensions
    ).catch((err: unknown) => {
      schemaReady = undefined;
      throw err;
    });
    return schemaReady;
  };

  return async function extractHandler(
    input: ExtractInput
  ): Promise<ToolResult> {
    assertExactlyOneSelector(input);
    const batchLimit = resolveToolBatchLimit(deps, "extract");
    if (input.chunk_ids !== undefined && input.chunk_ids.length > batchLimit) {
      throw new ExtractBatchLimitExceededError(
        input.chunk_ids.length,
        batchLimit
      );
    }
    if (deps.pool === undefined) {
      throw new ExtractNotConfiguredError(
        "extract is not configured: no database. Persisting extraction " +
          "results requires GRAPHRAG_MEMORY_DB_URL; this server was started " +
          "without one, so extract cannot run here."
      );
    }
    // Credentials next: fail fast before the database is dialed (SC9 —
    // never a fake client to "make it run"); injected clients (test seam)
    // skip the guards; production wiring never sets them.
    const llm = deps.llm ?? buildGuardedLlm(deps);
    const embedder = deps.embedder ?? buildGuardedEmbedder(deps);

    const client = await deps.pool.connect();
    try {
      await ensureSchema(client);
      const selector = await resolveSelector(client, input, batchLimit);

      const failedChunks: ExtractFailedChunk[] = [];
      const pipelineDeps = buildPipelineDeps(deps, llm, embedder);
      const summary = await processBatch(
        pipelineDeps,
        client,
        selector.chunks,
        {
          // The source_ref selector is scan-capped at the batch limit; report
          // the configured cap verbatim, same as the CLI's --batch-size.
          ...(input.chunk_ids === undefined ? { batchSize: batchLimit } : {}),
          onChunkOutcome: (outcome: ChunkOutcomeReport) => {
            const failed = failedChunkFromOutcome(outcome);
            if (failed !== undefined) failedChunks.push(failed);
          },
        }
      );
      return textResult(
        JSON.stringify(buildExtractOutput(summary, failedChunks, selector))
      );
    } finally {
      client.release();
    }
  };
}

/**
 * Wire the extract tool into the registry. The handler is closed over
 * `deps` so the tool stays a static registration from the registry's
 * perspective.
 */
export const extractTool = (deps: ExtractDeps): ToolRegistration => ({
  name: "extract",
  description:
    "Extract knowledge triples from stored chunks and persist them to the " +
    "knowledge graph. Exactly one selector is required: chunk_ids (a list " +
    "of specific chunk UUIDs) or source_ref (extracts that source's chunks " +
    "which do not have a successful extraction yet, oldest first; when more " +
    "than the configured batch limit remain, the response says so — call " +
    "again with the same source_ref to continue). Chunks are processed one " +
    "by one, synchronously: a failing chunk is recorded and reported while " +
    "the rest of the batch continues. The whole store is never scanned, and " +
    "results are never fabricated: database, LLM and embedding credentials " +
    "must be configured, or the call fails with a configuration error.",
  inputSchema: ExtractInputSchema,
  handler: createExtractHandler(deps) as unknown as ToolRegistration["handler"],
});
