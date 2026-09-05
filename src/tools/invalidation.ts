/**
 * Invalidate tool — MCP name `invalidate` (renamed from `invalidation`,
 * specs/mcp-tool-surface.md Catalog).
 *
 * §B4 content invalidation semantics: one tool per caller-facing
 * contract, distinct from `ingest` and `push` even though the storage
 * backend is shared.
 *
 * Behavior:
 *  - Closes the validity window at `invalidated_at`. A subsequent
 *    `retrieve` with `valid_at` in the closed interval MUST NOT match
 *    the invalidated chunks (the source-of-truth filter is in
 *    `MemoryBackend.search` and `PgvectorBackend.search`).
 *  - No physical deletion. The chunks stay in the ledger; the
 *    authoritative close is the `valid_until` set on each row. A
 *    later `listInvalidations(source_ref)` returns every record.
 *  - Idempotent on identical requests: the storage layer's
 *    `appendContentInvalidation` dedups records that share
 *    `chunk_id` + `invalidated_at` + `triggered_by`, so a repeated
 *    call returns the same record set without growing the ledger.
 *  - When the optional precision layer (Elasticsearch) is configured,
 *    the same source_ref is also closed in the derived index. The
 *    authoritative Postgres write has already committed by then, so an
 *    ES failure is reported as a degraded response but never rolls the
 *    source-of-truth write back.
 */
import { z } from "zod";
import {
  textResult,
  type ToolRegistration,
  type ToolResult,
} from "./registry.js";
import type { EmbeddingClient } from "../core/embedder.js";
import type { StorageBackend } from "../core/types.js";
import { GraphragError } from "../core/errors.js";
import {
  normalizeContentInvalidationRequest,
  supportsContentInvalidation,
} from "../core/storage/backend.js";
import type { PrecisionIndexer } from "../core/storage/elasticsearch-precision.js";

export const InvalidationInputSchema = z.strictObject({
  source_ref: z.string().min(1, "source_ref must be a non-empty string"),
  invalidated_at: z.string().datetime().optional(),
  triggered_by: z.string().min(1, "triggered_by must be a non-empty string"),
});

export type InvalidationInput = z.infer<typeof InvalidationInputSchema>;

/**
 * Dependencies. Embedder is required for parity with the rest of the
 * tool surface even though invalidation does not need to embed
 * anything — the storage backend's invalidate path is pure metadata.
 */
export interface InvalidationDeps {
  embedder: EmbeddingClient;
  storage: StorageBackend;
  /**
   * Optional derived-index writer. Postgres stays authoritative: an ES
   * failure here surfaces as `degraded: true` + the named
   * `keyword_bm25:attempted-and-failed` reason, but never rolls back
   * the authoritative close.
   */
  precision?: PrecisionIndexer;
}

export function createInvalidationHandler(deps: InvalidationDeps) {
  return async function invalidationHandler(
    input: InvalidationInput
  ): Promise<ToolResult> {
    if (!supportsContentInvalidation(deps.storage)) {
      throw new GraphragError(
        "invalidation: selected storage backend does not support content invalidation",
        "STORAGE_ERROR"
      );
    }
    const request = normalizeContentInvalidationRequest(
      input.source_ref,
      input.invalidated_at ?? new Date().toISOString(),
      input.triggered_by
    );
    const records = await deps.storage.invalidateSourceRef(
      request.sourceRef,
      request.invalidatedAt,
      request.triggeredBy
    );
    // EXIT: derived-index failures must not block the authoritative close.
    // Mirror the ingest/push pattern: stderr observation, response degraded
    // with the same named reason so observability stays consistent.
    let precisionFailed = false;
    if (deps.precision !== undefined) {
      try {
        await deps.precision.invalidateSourceRef(
          request.sourceRef,
          request.invalidatedAt
        );
      } catch (error) {
        precisionFailed = true;
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(
          `invalidation precision index failed: ${message}\n`
        );
      }
    }
    return textResult(
      JSON.stringify({
        invalidated_chunk_ids: records.map((record) => record.chunk_id),
        invalidations: records,
        ...(precisionFailed
          ? {
              degraded: true,
              degraded_reasons: ["keyword_bm25:attempted-and-failed"],
            }
          : {}),
      })
    );
  };
}

export const invalidationTool = (deps: InvalidationDeps): ToolRegistration => ({
  name: "invalidate",
  description:
    "Close the validity window of every chunk belonging to a source_ref. " +
    "Idempotent on identical requests, and there is no physical delete: " +
    "chunks remain in the store with a closed valid_until window, plus a " +
    "queryable invalidation record per chunk.",
  inputSchema: InvalidationInputSchema,
  handler: createInvalidationHandler(
    deps
  ) as unknown as ToolRegistration["handler"],
});
