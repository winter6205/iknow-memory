/**
 * Invalidation tool — dedicated entry for fin's invalidation_port.
 *
 * Plan D0 I-T5: §B4 content invalidation semantics. This tool is the
 * cross-repo counterpart to fin's `invalidation_port`. It is
 * intentionally distinct from `ingest`'s `action: "invalidate"` path
 * for the same reason `push` is distinct from `ingest`: one tool per
 * caller-facing contract, even when the storage backend is shared.
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
    return textResult(
      JSON.stringify({
        invalidated_chunk_ids: records.map((record) => record.chunk_id),
        invalidations: records,
      })
    );
  };
}

export const invalidationTool = (deps: InvalidationDeps): ToolRegistration => ({
  name: "invalidation",
  description:
    "Close the validity window for every chunk of a source_ref. The " +
    "action appends a record to the per-chunk invalidation ledger " +
    "(queryable via listInvalidations) and is idempotent on identical " +
    "requests. No physical delete: chunks remain in the store with a " +
    "closed valid_until window.",
  inputSchema: InvalidationInputSchema,
  handler: createInvalidationHandler(
    deps
  ) as unknown as ToolRegistration["handler"],
});
