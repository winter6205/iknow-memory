/**
 * Push tool — the fin-side ingestion entry.
 *
 * Plan D0 I-T4 / I-T7: this tool is the contract that fin's
 * `push_port` calls. It is intentionally distinct from `ingest`:
 *
 *  - The idempotency key is the full `(source_ref, content_identity)`
 *    pair (B4). A re-push with identical content returns the same
 *    `chunk_id` and does not grow the storage row count.
 *  - B4 required fields are non-optional: source_ref, content,
 *    non-empty metadata, valid_from, and valid_until. A missing
 *    required field rejects the WHOLE batch (per the plan: 缺结构化
 *    元数据被拒).
 *  - The text is written verbatim. There is no sliding-window chunker
 *    on this path, so the bytes that come back from retrieve equal
 *    the bytes that went in (I-T7).
 *
 * The implementation reuses the content identity / chunk id helpers
 * already proven by `ingest` (cross-repo contract T-T2) and the
 * existing `StorageBackend.upsert` (which collapses same-id writes
 * with last-write-wins).
 */
import { z } from "zod";
import {
  textResult,
  type ToolRegistration,
  type ToolResult,
} from "./registry.js";
import type { EmbeddingClient } from "../core/embedder.js";
import type { ChunkRecord, StorageBackend } from "../core/types.js";
import { GraphragError, MAX_CONTENT_BYTES } from "../core/errors.js";
import type { PrecisionIndexer } from "../core/storage/elasticsearch-precision.js";
import {
  computeChunkId,
  computeContentIdentity,
  DEFAULT_CONTENT_IDENTITY_VERSIONS,
  type ContentIdentityVersions,
} from "./ingest.js";

/**
 * A single pushed item. Every field is required: `push` rejects the
 * entire batch when B4 metadata is missing. Keeping the schema strict
 * (z.strictObject) means fin's adapter cannot smuggle in legacy keys
 * like `top_k` and have them silently swallowed.
 */
const PushItemSchema = z.strictObject({
  content: z.string().min(1, "content must be a non-empty string"),
  source_ref: z.string().min(1, "source_ref must be a non-empty string"),
  metadata: z
    .record(z.string(), z.unknown())
    .refine(
      (record) => Object.keys(record).length > 0,
      "metadata must contain at least one key (B4 required)"
    ),
  valid_from: z.string().datetime(),
  valid_until: z.string().datetime(),
});

export const PushInputSchema = z.strictObject({
  items: z
    .array(PushItemSchema)
    .min(1, "push: items must contain at least one entry"),
});

export type PushInput = z.infer<typeof PushInputSchema>;
export type PushItem = z.infer<typeof PushItemSchema>;

/** Dependencies injected at wiring time. Mirrors IngestDeps. */
export interface PushDeps {
  embedder: EmbeddingClient;
  storage: StorageBackend;
  /** Optional ES derived-index writer; authority writes always win. */
  precision?: PrecisionIndexer;
  identityVersions?: Partial<ContentIdentityVersions>;
}

function validateItemSize(item: PushItem): void {
  const byteLength = Buffer.byteLength(item.content, "utf8");
  if (byteLength > MAX_CONTENT_BYTES) {
    throw new GraphragError(
      `push: content size ${byteLength} bytes exceeds limit ${MAX_CONTENT_BYTES} (1MB)`,
      "CONTENT_TOO_LARGE"
    );
  }
  if (Date.parse(item.valid_from) >= Date.parse(item.valid_until)) {
    throw new GraphragError(
      "push: valid_from must be strictly before valid_until",
      "INVALID_INPUT"
    );
  }
}

export function createPushHandler(deps: PushDeps) {
  return async function pushHandler(input: PushInput): Promise<ToolResult> {
    const identityVersions = {
      ...DEFAULT_CONTENT_IDENTITY_VERSIONS,
      ...deps.identityVersions,
    };
    for (const item of input.items) validateItemSize(item);

    const embeddings = await deps.embedder.embed(
      input.items.map((item) => item.content)
    );
    if (embeddings.length !== input.items.length) {
      throw new GraphragError(
        `push: embedding count ${embeddings.length} does not match batch count ${input.items.length}`,
        "EMBEDDING_FAILED"
      );
    }

    const now = new Date().toISOString();
    const records: ChunkRecord[] = input.items.map((item, index) => {
      const contentIdentity = computeContentIdentity(
        item.content,
        identityVersions
      );
      return {
        id: computeChunkId(item.source_ref, contentIdentity),
        content: item.content,
        embedding: embeddings[index]!,
        source_ref: item.source_ref,
        metadata: item.metadata,
        valid_from: item.valid_from,
        valid_until: item.valid_until,
        created_at: now,
      };
    });

    // upsert collapses same-id writes: a re-push of the same
    // (source_ref, content) returns the existing chunk_id and adds
    // zero new rows (the cross-repo idempotency baseline).
    const ids = await deps.storage.upsert(records);
    let precisionFailed = false;
    if (deps.precision !== undefined) {
      try {
        await deps.precision.indexChunks(records);
      } catch (error) {
        // EXIT: Postgres is authoritative; an ES outage is retryable through
        // the reindex command and must not turn a successful push into a
        // partial authority write.
        precisionFailed = true;
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`push precision index failed: ${message}\n`);
      }
    }
    return textResult(
      JSON.stringify({
        chunk_ids: ids,
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

export const pushTool = (deps: PushDeps): ToolRegistration => ({
  name: "push",
  description:
    "Idempotent text ingest for the fin push_port. Each item is keyed " +
    "by (source_ref, content_identity); a re-push returns the same " +
    "chunk_id without growing the row count. Pushes never chunk the " +
    "input — the bytes that come back from retrieve equal the bytes " +
    "that went in.",
  inputSchema: PushInputSchema,
  handler: createPushHandler(deps) as unknown as ToolRegistration["handler"],
});
