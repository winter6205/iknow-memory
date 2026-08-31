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
export const IngestInputSchema = z
  .object({
    action: z.enum(["ingest", "invalidate"]).optional(),
    content: z.string().min(1, "content must be a non-empty string").optional(),
    source_ref: z.string().min(1, "source_ref must be a non-empty string"),
    metadata: z.record(z.string(), z.unknown()).optional(),
    valid_from: z.string().datetime().optional(),
    valid_until: z.string().datetime().optional(),
    invalidated_at: z.string().datetime().optional(),
    triggered_by: z.string().min(1).optional(),
  })
  .superRefine((input, ctx) => {
    const action = input.action ?? "ingest";
    if (action === "ingest" && input.content === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["content"],
        message: "content is required for ingest",
      });
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
    const content = input.content;
    if (content === undefined || content.length === 0) {
      throw new GraphragError(
        "ingest: content must be a non-empty string",
        "INVALID_INPUT"
      );
    }

    // 1. Size check: reject payloads above MAX_CONTENT_BYTES before doing
    //    any work. Buffer.byteLength gives UTF-8 byte count, not char count
    //    — which is what the cap actually limits.
    const byteLength = Buffer.byteLength(content, "utf8");
    if (byteLength > MAX_CONTENT_BYTES) {
      throw new GraphragError(
        `ingest: content size ${byteLength} bytes exceeds limit ${MAX_CONTENT_BYTES} (1MB)`,
        "CONTENT_TOO_LARGE"
      );
    }

    // 2. Semantic check: valid_from must be strictly before valid_until when
    //    both are present. A reversed or zero-width window is almost always
    //    a caller bug — we surface it as INVALID_INPUT so the host can fix
    //    the call instead of silently storing an empty window.
    if (input.valid_from && input.valid_until) {
      const fromMs = Date.parse(input.valid_from);
      const untilMs = Date.parse(input.valid_until);
      if (Number.isNaN(fromMs) || Number.isNaN(untilMs)) {
        // Zod's .datetime() should have caught this, but defend in depth:
        // a hand-built Input (or a future schema regression) should not
        // silently pass.
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

    // 3. Embed the pushed text as-is. The embedder is contractually
    //    responsible for throwing GraphragError(EMBEDDING_FAILED |
    //    EMBEDDING_DIM_MISMATCH) on failure.
    const embeddings = await deps.embedder.embed([content]);

    // 4. Build one ChunkRecord with ingest-time metadata.
    //    `valid_from` defaults to now (UTC ISO 8601) when not provided.
    //    `valid_until` defaults to null (forever valid).
    //    `created_at` is set to the same instant as the default `valid_from`
    //    so the two are consistent when the caller omits both.
    const now = new Date().toISOString();
    const validFrom = input.valid_from ?? now;
    const validUntil = input.valid_until ?? null;
    const identityVersions = {
      ...DEFAULT_CONTENT_IDENTITY_VERSIONS,
      ...deps.identityVersions,
    };
    const contentIdentity = computeContentIdentity(content, identityVersions);
    const records: ChunkRecord[] = [
      {
        id: computeChunkId(input.source_ref, contentIdentity),
        content,
        embedding: embeddings[0]!,
        source_ref: input.source_ref,
        metadata: input.metadata ?? {},
        valid_from: validFrom,
        valid_until: validUntil,
        created_at: now,
      },
    ];

    // 5. Store. upsert returns the chunk id in input order — we relay
    //    them as the tool result so callers can correlate or reference
    //    them later.
    const ids = await deps.storage.upsert(records);

    // 6. Return: textResult(JSON.stringify({ chunk_ids: ids })). The
    //    shape matches the host's text-content convention.
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
