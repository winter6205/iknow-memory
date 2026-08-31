/**
 * Ingest tool — writes text content into the memory store.
 *
 * Pipeline: validate → size check → embed → store.
 * Stage 1: no triple extraction, no entity resolution (stage 3).
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  textResult,
  type ToolRegistration,
  type ToolResult,
} from "./registry.js";
import { ConfigError, readIngestBatchLimit } from "../config.js";
import type { EmbeddingClient } from "../core/embedder.js";
import type { ChunkRecord, StorageBackend } from "../core/types.js";
import { GraphragError, MAX_CONTENT_BYTES } from "../core/errors.js";
import {
  normalizeContentInvalidationRequest,
  supportsContentInvalidation,
  type ContentInvalidationRecord,
} from "../core/storage/backend.js";

/**
 * Zod schema for the ingest input. Mirrors `IngestInput` in core/types.ts
 * but with validation rules attached.
 *
 * - Normal ingest: `content` and `source_ref` are non-empty strings.
 * - Invalidation action: `action: "invalidate"` plus `source_ref` and
 *   `triggered_by`; it closes all chunks for that source without a new tool.
 * - `metadata`: optional string-keyed map of unknown values.
 * - `valid_from` / `valid_until`: optional ISO 8601 datetimes. The semantic
 *   check (valid_from < valid_until) lives in the handler, not the schema,
 *   because it depends on cross-field comparison.
 */
const IngestBatchItemSchema = z.object({
  content: z.string().min(1, "content must be a non-empty string"),
  source_ref: z
    .string()
    .min(1, "source_ref must be a non-empty string")
    .optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  valid_from: z.string().datetime().optional(),
  valid_until: z.string().datetime().optional(),
});

const IngestContentSchema = z.union([
  z.string().min(1, "content must be a non-empty string"),
  z.array(z.union([z.string().min(1), IngestBatchItemSchema])),
]);

export const IngestInputSchema = z
  .object({
    action: z.enum(["ingest", "invalidate"]).optional(),
    content: IngestContentSchema.optional(),
    source_ref: z.string().min(1, "source_ref must be a non-empty string"),
    metadata: z.record(z.string(), z.unknown()).optional(),
    valid_from: z.string().datetime().optional(),
    valid_until: z.string().datetime().optional(),
    invalidated_at: z.string().datetime().optional(),
    triggered_by: z.string().min(1).optional(),
  })
  .superRefine((input, ctx) => {
    const action = input.action ?? "ingest";
    if (action === "ingest") {
      if (input.content === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["content"],
          message: "content is required for ingest",
        });
      }
    }
    if (action === "invalidate") {
      if (input.content !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["content"],
          message: "content is not allowed for invalidation",
        });
      }
      if (input.triggered_by === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["triggered_by"],
          message: "triggered_by is required for invalidation",
        });
      }
      if (
        input.metadata !== undefined ||
        input.valid_from !== undefined ||
        input.valid_until !== undefined
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["action"],
          message: "invalidation cannot carry ingest fields",
        });
      }
    }
    if (action === "ingest" && input.invalidated_at !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["invalidated_at"],
        message: "invalidated_at requires action invalidate",
      });
    }
    if (action === "ingest" && input.triggered_by !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["triggered_by"],
        message: "triggered_by requires action invalidate",
      });
    }
  });

/** Inferred TypeScript type for the parsed ingest input. */
export type IngestInput = z.infer<typeof IngestInputSchema>;

/**
 * Version components of the content identity.
 *
 * These are service-owned rather than caller-owned: changing any component
 * deliberately creates a new key because the pushed text may have been
 * produced by a different normalization, parser, or parameter table.
 */
export interface ContentIdentityVersions {
  normalizationRuleVersion: string;
  parseRuleVersion: string;
  parameterTableVersion: string;
}

export const DEFAULT_CONTENT_IDENTITY_VERSIONS: ContentIdentityVersions = {
  normalizationRuleVersion: "normalization-v1",
  parseRuleVersion: "parse-v1",
  parameterTableVersion: "parameters-v1",
};

/** Deterministic content identity required by the cross-repo ingest contract. */
export function computeContentIdentity(
  content: string,
  versions: ContentIdentityVersions = DEFAULT_CONTENT_IDENTITY_VERSIONS
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        content,
        versions.normalizationRuleVersion,
        versions.parseRuleVersion,
        versions.parameterTableVersion,
      ]),
      "utf8"
    )
    .digest("hex");
}

/**
 * Derive a UUID-shaped stable chunk id from the full idempotency key.
 *
 * The version/variant bits preserve the UUID shape exposed by the existing
 * tool while the remaining bits come from SHA-256, so no random state can
 * make a retry address a different row.
 */
export function computeChunkId(
  sourceRef: string,
  contentIdentity: string
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([sourceRef, contentIdentity]), "utf8")
    .digest();
  digest[6] = (digest[6]! & 0x0f) | 0x40;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

/** Dependencies injected at wiring time (T7). */
export interface IngestDeps {
  embedder: EmbeddingClient;
  storage: StorageBackend;
  identityVersions?: Partial<ContentIdentityVersions>;
  /** Optional test/wiring override; absent uses the validated env default. */
  batchLimit?: number;
}

/** Typed failure for a batch that would exceed the configured limit. */
export class BatchLimitExceededError extends GraphragError {
  readonly actualCount: number;
  readonly limit: number;

  constructor(actualCount: number, limit: number) {
    super(
      `ingest: batch actual count ${actualCount} exceeds limit ${limit}`,
      "INVALID_INPUT"
    );
    this.name = "BatchLimitExceededError";
    // GraphragError's taxonomy predates T7 and errors.ts is outside this
    // ticket's edit scope. Preserve its runtime typed code without widening
    // the shared taxonomy for callers that do not know about batch ingest.
    (this as unknown as { code: string }).code = "BATCH_LIMIT_EXCEEDED";
    this.actualCount = actualCount;
    this.limit = limit;
  }
}

interface NormalizedIngestItem {
  content: string;
  source_ref: string;
  metadata: Record<string, unknown>;
  valid_from: string | undefined;
  valid_until: string | undefined;
}

function resolveBatchLimit(deps: IngestDeps): number {
  if (Object.hasOwn(deps, "batchLimit")) {
    const value = deps.batchLimit;
    if (
      value === undefined ||
      !Number.isFinite(value) ||
      !Number.isInteger(value) ||
      value <= 0
    ) {
      throw new ConfigError(
        `ingest batch limit must be a finite positive integer, got "${String(value)}"`
      );
    }
    return value;
  }
  return readIngestBatchLimit();
}

function normalizeIngestItems(input: IngestInput): NormalizedIngestItem[] {
  const content = input.content;
  if (content === undefined) {
    throw new GraphragError(
      "ingest: content must be provided",
      "INVALID_INPUT"
    );
  }
  if (typeof content === "string") {
    if (input.source_ref === undefined) {
      throw new GraphragError(
        "ingest: source_ref must be provided",
        "INVALID_INPUT"
      );
    }
    return [
      {
        content,
        source_ref: input.source_ref,
        metadata: input.metadata ?? {},
        valid_from: input.valid_from,
        valid_until: input.valid_until,
      },
    ];
  }
  if (!Array.isArray(content)) {
    throw new GraphragError(
      "ingest: content must be a string or a batch array",
      "INVALID_INPUT"
    );
  }
  return content.map((item) => {
    if (typeof item === "string") {
      if (input.source_ref === undefined) {
        throw new GraphragError(
          "ingest: source_ref must be provided for string batch items",
          "INVALID_INPUT"
        );
      }
      return {
        content: item,
        source_ref: input.source_ref,
        metadata: input.metadata ?? {},
        valid_from: input.valid_from,
        valid_until: input.valid_until,
      };
    }
    return {
      content: item.content,
      source_ref: item.source_ref ?? input.source_ref,
      metadata: item.metadata ?? input.metadata ?? {},
      valid_from: item.valid_from ?? input.valid_from,
      valid_until: item.valid_until ?? input.valid_until,
    };
  });
}

function validateIngestItem(item: NormalizedIngestItem): void {
  if (
    typeof item.content !== "string" ||
    item.content.length === 0 ||
    typeof item.source_ref !== "string" ||
    item.source_ref.length === 0
  ) {
    throw new GraphragError(
      "ingest: content and source_ref must be non-empty strings",
      "INVALID_INPUT"
    );
  }
  const byteLength = Buffer.byteLength(item.content, "utf8");
  if (byteLength > MAX_CONTENT_BYTES) {
    throw new GraphragError(
      `ingest: content size ${byteLength} bytes exceeds limit ${MAX_CONTENT_BYTES} (1MB)`,
      "CONTENT_TOO_LARGE"
    );
  }
  if (item.valid_from && item.valid_until) {
    const fromMs = Date.parse(item.valid_from);
    const untilMs = Date.parse(item.valid_until);
    if (Number.isNaN(fromMs) || Number.isNaN(untilMs)) {
      throw new GraphragError(
        "ingest: valid_from / valid_until are not valid ISO 8601 timestamps",
        "INVALID_INPUT"
      );
    }
    if (fromMs >= untilMs) {
      throw new GraphragError(
        "ingest: valid_from must be strictly before valid_until",
        "INVALID_INPUT"
      );
    }
  }
}

/**
 * Build the ingest handler with the given dependencies closed over.
 *
 * Order of checks (and why this order):
 *  1. Schema — already done by Zod before the handler runs.
 *  2. Size — cheap byte-length check, prevents the expensive embed
 *     pipeline from running on a multi-MB payload.
 *  3. Semantic — valid_from < valid_until. Must be explicit (a `>=` window
 *     would be either always-empty or instant-expiry, both bugs).
 *  4. Embed → upsert.
 */
export function createIngestHandler(deps: IngestDeps) {
  return async function ingestHandler(input: IngestInput): Promise<ToolResult> {
    if (input.action === "invalidate") {
      return handleInvalidation(deps, input);
    }
    const items = normalizeIngestItems(input);
    if (items.length === 0) {
      throw new GraphragError(
        "ingest: content batch must contain at least one item",
        "INVALID_INPUT"
      );
    }
    const batchLimit = resolveBatchLimit(deps);
    if (items.length > batchLimit) {
      throw new BatchLimitExceededError(items.length, batchLimit);
    }
    for (const item of items) validateIngestItem(item);

    const embeddings = await deps.embedder.embed(
      items.map((item) => item.content)
    );
    if (embeddings.length !== items.length) {
      throw new GraphragError(
        `ingest: embedding count ${embeddings.length} does not match batch count ${items.length}`,
        "EMBEDDING_FAILED"
      );
    }

    const now = new Date().toISOString();
    const identityVersions = {
      ...DEFAULT_CONTENT_IDENTITY_VERSIONS,
      ...deps.identityVersions,
    };
    const records: ChunkRecord[] = items.map((item, index) => {
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
        valid_from: item.valid_from ?? now,
        valid_until: item.valid_until ?? null,
        created_at: now,
      };
    });

    const ids = await deps.storage.upsert(records);
    return textResult(JSON.stringify({ chunk_ids: ids }));
  };
}

async function handleInvalidation(
  deps: IngestDeps,
  input: IngestInput
): Promise<ToolResult> {
  if (!supportsContentInvalidation(deps.storage)) {
    throw new GraphragError(
      "ingest: selected storage backend does not support content invalidation",
      "STORAGE_ERROR"
    );
  }
  if (input.source_ref === undefined) {
    throw new GraphragError(
      "content invalidation: source_ref must be a non-empty string",
      "INVALID_INPUT"
    );
  }
  const request = normalizeContentInvalidationRequest(
    input.source_ref,
    input.invalidated_at ?? new Date().toISOString(),
    input.triggered_by ?? ""
  );
  const records: ContentInvalidationRecord[] =
    await deps.storage.invalidateSourceRef(
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
}

/**
 * Wire the ingest tool into the registry. The handler is closed over `deps`
 * so the tool stays a static registration from the registry's perspective.
 */
export const ingestTool = (deps: IngestDeps): ToolRegistration => ({
  name: "ingest",
  description:
    "Ingest text content into the knowledge memory store. " +
    "Chunks, embeds, and stores with optional temporal validity.",
  inputSchema: IngestInputSchema,
  // The registry's handler signature is `(input: unknown) => ...` (the
  // generic is erased at the boundary so the registry stays a single
  // `ToolRegistrationAny` map). Each tool's real handler is typed against
  // its own Zod schema; the cast mirrors echo.ts.
  handler: createIngestHandler(deps) as unknown as ToolRegistration["handler"],
});
