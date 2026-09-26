/**
 * Ingest tool — writes text content into the memory store.
 *
 * Pipeline (operator-console T3 envelope):
 *  1. Validate the one envelope: { source_ref, content: <body>, chunks: [{ content, index }] }.
 *     A one-slice list is allowed (body must equal that slice). Multi-slice
 *     slices must be contiguous substrings of the body in order with indexes 0..N-1.
 *  2. Upsert the 资料 SoR row (keyed by source_ref; same id on re-push).
 *  3. Rebuild the chunk rows: delete the previous chunks back-pointed to that
 *     资料, then insert the new ordinal chunk rows (one envelope = one rebuild).
 *  4. Embed slice texts (not the body) and store each chunk with
 *     source_doc_id + ordinal back-pointers.
 *
 * Backward-compat: if the caller sends the legacy single-content or batch
 * shape WITHOUT a `chunks` field, each item is treated as a one-slice envelope
 * (body=item content, chunks=[{content: item.content, index: 0}]). fin's old
 * push_port shape adapts through the same path. The new envelope is the
 * documented primary shape.
 *
 * The tool is write-only (specs/mcp-tool-surface.md): content invalidation
 * is a separate `invalidate` tool, never an ingest action.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  textResult,
  type ToolRegistration,
  type ToolResult,
} from "./registry.js";
import { resolveToolBatchLimit } from "./batch-limit.js";
import type { EmbeddingClient } from "../core/embedder.js";
import type { SlotEmbeddingSource } from "../core/embed-slots.js";
import { embedWithSlotFallback } from "../core/embed-slots.js";
import type {
  ChunkRecord,
  SourceDocRecord,
  StorageBackend,
} from "../core/types.js";
import type { PrecisionIndexer } from "../core/storage/elasticsearch-precision.js";
import { GraphragError, MAX_CONTENT_BYTES } from "../core/errors.js";
import type { Logger } from "../logging.js";
import {
  findSliceInvariantViolations,
  refineSliceInvariants,
} from "./slice-invariants.js";

/**
 * A single slice in the new envelope.
 *
 * `index` is the zero-based ordinal inside the 资料 body. The handler
 * validates that the indexes are dense and start at 0 (the schema
 * enforces it via superRefine).
 */
const ChunkSliceSchema = z.object({
  content: z.string().min(1, "chunk content must be a non-empty string"),
  index: z.number().int().min(0, "chunk index must be a non-negative integer"),
});

/**
 * New envelope shape (operator-console T3):
 *   { source_ref, content: <body>, chunks: [{ content, index }], title?, ... }
 *
 * Strict (z.strictObject) — unknown keys are a typed validation error.
 *
 * The `superRefine` below enforces the fin freeze invariant (each chunk
 * content is a contiguous substring of the body, in order) and the
 * dense 0..N-1 index rule. Server-side these are not optional — a
 * non-substring slice or a gap in indexes is a typed INVALID_INPUT.
 */
const EnvelopeShapeSchema = z
  .strictObject({
    source_ref: z.string().min(1, "source_ref must be a non-empty string"),
    content: z.string().min(1, "content must be a non-empty string"),
    chunks: z
      .array(ChunkSliceSchema)
      .min(1, "chunks must contain at least one slice"),
    title: z.string().min(1).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    valid_from: z.string().datetime().optional(),
    valid_until: z.string().datetime().optional(),
  })
  .superRefine(refineSliceInvariants);

/**
 * Legacy single-content shape:
 *   { content: <string>, source_ref, metadata?, valid_from?, valid_until? }
 * The body equals the content; one-slice envelope.
 */
const LegacySingleSchema = z.strictObject({
  content: z.string().min(1, "content must be a non-empty string"),
  source_ref: z.string().min(1, "source_ref must be a non-empty string"),
  metadata: z.record(z.string(), z.unknown()).optional(),
  valid_from: z.string().datetime().optional(),
  valid_until: z.string().datetime().optional(),
});

/**
 * Legacy batch shape:
 *   { content: [string | { content, source_ref?, ... }, ...], source_ref, ... }
 *
 * Bare-string items inherit the top-level `source_ref` and become a
 * one-slice envelope each (the legacy T7 batch ingest surface). Object
 * items may carry their own `source_ref` / metadata / window.
 */
const LegacyBatchItemSchema = z.union([
  z.string().min(1, "content must be a non-empty string"),
  z.object({
    content: z.string().min(1, "content must be a non-empty string"),
    source_ref: z.string().min(1).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    valid_from: z.string().datetime().optional(),
    valid_until: z.string().datetime().optional(),
  }),
]);
const LegacyBatchSchema = z.strictObject({
  content: z
    .array(LegacyBatchItemSchema)
    .min(1, "content batch must not be empty"),
  source_ref: z.string().min(1, "source_ref must be a non-empty string"),
  metadata: z.record(z.string(), z.unknown()).optional(),
  valid_from: z.string().datetime().optional(),
  valid_until: z.string().datetime().optional(),
});

/**
 * Discriminated union over the three accepted shapes. The handler picks the
 * right path based on which keys are present (`chunks` ⇒ new envelope,
 * `content: string` ⇒ legacy single, `content: array` ⇒ legacy batch).
 */
export const IngestInputSchema = z.union([
  EnvelopeShapeSchema,
  LegacySingleSchema,
  LegacyBatchSchema,
]);

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

/**
 * Derive a stable 资料 (source_documents) id from the source_ref locator.
 *
 * Same locator → same id across re-pushes (the concurrent class in the spec
 * must collapse to one 资料 row). UUID shape matches the existing
 * `chunks` row PK so foreign keys stay uniform.
 */
export function computeSourceDocId(sourceRef: string): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([sourceRef]), "utf8")
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
  /** Optional ES derived-index writer; Postgres remains authoritative. */
  precision?: PrecisionIndexer;
  identityVersions?: Partial<ContentIdentityVersions>;
  /** Optional test/wiring override; absent uses the validated env default. */
  batchLimit?: number;
  /**
   * Optional structured logger for the SC10 embed process log. Optional so
   * existing dep constructions stay source-compatible; production wiring
   * threads the server logger in.
   */
  logger?: Logger;
  /**
   * Embedding rotate T2: where to get an embedder for the OTHER slot's
   * (model, dimensions) pair while a `dual_write` rotate is open. Absent on
   * memory/test deps — then an open rotate is a typed refuse, not a
   * one-slot write.
   */
  slotEmbedding?: SlotEmbeddingSource;
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

/**
 * Normalized envelope that the handler writes per-call.
 *
 * One ingest call may carry multiple envelopes when the legacy batch shape
 * arrives; the new envelope is always exactly one envelope per call.
 */
interface NormalizedEnvelope {
  source_ref: string;
  title: string | null;
  content: string;
  slices: Array<{ content: string; ordinal: number }>;
  metadata: Record<string, unknown>;
  valid_from: string | undefined;
  valid_until: string | undefined;
}

/**
 * Pick the union branch and normalize it into one or more envelopes.
 *
 * - New envelope: one envelope, validate slice contiguous-substring invariant.
 * - Legacy single: one envelope, one slice equal to the body.
 * - Legacy batch: N envelopes, one slice each equal to that item's content.
 */
function normalizeIngestInput(input: IngestInput): NormalizedEnvelope[] {
  // The union arms are distinguished by the presence of `chunks` (new)
  // versus the shape of `content` (legacy single string vs legacy batch array).
  if ("chunks" in input && input.chunks !== undefined) {
    const env = input;
    assertSliceInvariants(env.content, env.chunks);
    return [
      {
        source_ref: env.source_ref,
        title: env.title ?? null,
        content: env.content,
        slices: env.chunks.map((slice) => ({
          content: slice.content,
          ordinal: slice.index,
        })),
        metadata: env.metadata ?? {},
        valid_from: env.valid_from,
        valid_until: env.valid_until,
      },
    ];
  }
  // Legacy branch: `content` is either a string (single) or array (batch).
  const legacy = input as Exclude<IngestInput, { chunks: unknown[] }>;
  if (typeof legacy.content === "string") {
    return [
      {
        source_ref: legacy.source_ref,
        title: null,
        content: legacy.content,
        slices: [{ content: legacy.content, ordinal: 0 }],
        metadata: legacy.metadata ?? {},
        valid_from: legacy.valid_from,
        valid_until: legacy.valid_until,
      },
    ];
  }
  // Legacy batch: each item becomes a one-slice envelope. All items share
  // the top-level source_ref, so they are slices of the same 资料 — the
  // ordinal is the item's position in the batch, which keeps the
  // (source_doc_id, ordinal) unique index satisfied and gives the derived
  // chunks a stable order (the pre-T3 batch surface had no ordinal concept;
  // array position is the closest faithful mapping).
  return legacy.content.map((item, position) => {
    if (typeof item === "string") {
      return {
        source_ref: legacy.source_ref,
        title: null,
        content: item,
        slices: [{ content: item, ordinal: position }],
        metadata: legacy.metadata ?? {},
        valid_from: legacy.valid_from,
        valid_until: legacy.valid_until,
      };
    }
    // An object item carrying its own source_ref is its own 资料 — its
    // one slice is ordinal 0. Only items inheriting the top-level
    // source_ref are slices of the batch 资料 and take the position.
    const ownSourceRef = item.source_ref ?? legacy.source_ref;
    const ordinal =
      item.source_ref !== undefined && item.source_ref !== legacy.source_ref
        ? 0
        : position;
    return {
      source_ref: ownSourceRef,
      title: null,
      content: item.content,
      slices: [{ content: item.content, ordinal }],
      metadata: item.metadata ?? legacy.metadata ?? {},
      valid_from: item.valid_from ?? legacy.valid_from,
      valid_until: item.valid_until ?? legacy.valid_until,
    };
  });
}

/**
 * Handler-side enforcement of the fin freeze invariant, over the shared walk
 * in slice-invariants.ts. The schema already refines the same list; this is
 * defense in depth, so a regression that loosens the schema is still caught.
 * A typed INVALID_INPUT is thrown on the FIRST violation — validation never
 * raises a bare Error.
 */
function assertSliceInvariants(
  body: string,
  chunks: ReadonlyArray<{ content: string; index: number }>
): void {
  const violations = findSliceInvariantViolations(body, chunks);
  if (violations.length > 0) {
    throw new GraphragError(
      `ingest: ${violations[0]!.message}`,
      "INVALID_INPUT"
    );
  }
}

/**
 * SC10 embed process log: ONE structured entry per `embedder.embed(...)` call
 * (not per item), whitelist fields only — { time, modelId, itemCount,
 * latencyMs, outcome }. Content text and embeddings never travel with the
 * line; `redactDiagnostic` stays URL/credential redaction, not a body scanner.
 *
 * The implementation now lives in core/embed-log.ts (single contract shared
 * with the extract CLI's "entity-embed" event); this re-export keeps the
 * historical import path for push.ts and existing tests. `embedTextForSlice`
 * (the chunk embed-input wrap) rides the same path from the same module.
 */
export { embedWithLog, embedTextForSlice } from "../core/embed-log.js";
import { embedTextForSlice } from "../core/embed-log.js";

/**
 * Per-envelope preflight: per-chunk size cap (1MB), empty-content reject,
 * and (when supplied) valid_window ordering. The cap is per chunk — the
 * body itself may be larger than 1MB because we only embed and store slices.
 *
 * Empty content is rejected as INVALID_INPUT. The schema enforces `.min(1)`
 * on the new envelope and the object form of the legacy batch, but a
 * bare-string legacy batch item could still be empty when callers go
 * around the schema. Rejecting here keeps a single source of truth.
 */
function validateEnvelopeSizes(env: NormalizedEnvelope): void {
  if (env.content.length === 0) {
    throw new GraphragError(
      "ingest: content must be a non-empty string",
      "INVALID_INPUT"
    );
  }
  for (const slice of env.slices) {
    if (slice.content.length === 0) {
      throw new GraphragError(
        `ingest: chunks[${slice.ordinal}] content must be a non-empty string`,
        "INVALID_INPUT"
      );
    }
    const byteLength = Buffer.byteLength(slice.content, "utf8");
    if (byteLength > MAX_CONTENT_BYTES) {
      throw new GraphragError(
        `ingest: chunk ${slice.ordinal} content size ${byteLength} bytes exceeds limit ${MAX_CONTENT_BYTES} (1MB)`,
        "CONTENT_TOO_LARGE"
      );
    }
  }
  if (env.valid_from && env.valid_until) {
    const fromMs = Date.parse(env.valid_from);
    const untilMs = Date.parse(env.valid_until);
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
 *  1. Schema — already done by Zod before the handler runs (union arms).
 *  2. Normalize to envelopes, validate slice / window invariants.
 *  3. Size — per-chunk 1MB cap, before the embed pipeline runs.
 *  4. Embed → upsert 资料 row → rebuild chunk rows (delete + insert).
 *
 * Rebuild semantics (operator-console T3):
 *  - Upsert the source_documents row keyed by source_ref (idempotent on locator).
 *  - For the (possibly multiple) 资料 rows about to be written, delete every
 *    chunk row back-pointed to that source_doc_id before inserting the new
 *    chunks. This is "no re-chunking": the pushed slice text is final.
 */
export function createIngestHandler(deps: IngestDeps) {
  return async function ingestHandler(input: IngestInput): Promise<ToolResult> {
    const envelopes = normalizeIngestInput(input);
    if (envelopes.length === 0) {
      throw new GraphragError(
        "ingest: at least one envelope is required",
        "INVALID_INPUT"
      );
    }
    const batchLimit = resolveToolBatchLimit(deps, "ingest");
    if (envelopes.length > batchLimit) {
      throw new BatchLimitExceededError(envelopes.length, batchLimit);
    }
    for (const env of envelopes) validateEnvelopeSizes(env);

    const totalSlices = envelopes.reduce(
      (acc, env) => acc + env.slices.length,
      0
    );
    // The embed INPUT carries the 资料 title (contextual wrap); the stored
    // chunk content below stays the pushed bytes.
    const sliceTexts = envelopes.flatMap((env) =>
      env.slices.map((slice) => embedTextForSlice(env.title, slice.content))
    );
    // Embed slice texts in one call per touched generation slot (slice text
    // is final — no re-chunking). T2 dual-write: while a `dual_write` rotate
    // is open the incoming slot's batch is embedded with ITS OWN pair before
    // any write happens — a secondary failure refuses the ingest with both
    // slots unwritten (both-or-neither).
    const generation = deps.storage.getGenerationState?.() ?? null;
    const batches = await embedWithSlotFallback({
      embedder: deps.embedder,
      slotEmbedding: deps.slotEmbedding,
      state: generation,
      site: "ingest",
      texts: sliceTexts,
      logger: deps.logger,
      itemCount: totalSlices,
    });
    const embeddings = batches.active;
    if (embeddings.length !== sliceTexts.length) {
      throw new GraphragError(
        `ingest: embedding count ${embeddings.length} does not match slice count ${sliceTexts.length}`,
        "EMBEDDING_FAILED"
      );
    }
    if (
      batches.incoming !== null &&
      batches.incoming.length !== sliceTexts.length
    ) {
      throw new GraphragError(
        `ingest: incoming embedding count ${batches.incoming.length} does not match slice count ${sliceTexts.length}`,
        "EMBEDDING_FAILED"
      );
    }

    const now = new Date().toISOString();
    const identityVersions = {
      ...DEFAULT_CONTENT_IDENTITY_VERSIONS,
      ...deps.identityVersions,
    };
    const allChunkIds: string[] = [];
    const records: ChunkRecord[] = [];
    let embeddingCursor = 0;
    /**
     * The 资料 rows this batch wrote, keyed by `source_ref` with
     * LAST-write-wins — the same rule the upsert itself applies. A legacy
     * batch may repeat one `source_ref` (its items are slices of one 资料),
     * so publishing per-envelope ids/identities would name values no row
     * ever held. The index-job submit pair keys on the identity, so the
     * response publishes exactly the per-资料 facts that survive the writes.
     */
    const writtenBySourceRef = new Map<
      string,
      { sourceDocId: string; contentIdentity: string }
    >();
    /**
     * New chunk ids grouped by source_doc_id. After upsert, these are
     * the ids we MUST NOT delete — they're the same-id merges that
     * preserve T6's closed-row state on a same-content re-push.
     * Anything else still back-pointed to that 资料 is an orphan from a
     * previous content-identity version and gets cleaned up.
     */
    const keptIdsBySourceDoc = new Map<string, Set<string>>();
    for (const env of envelopes) {
      const sourceDocId = computeSourceDocId(env.source_ref);

      // Upsert the 资料 SoR row keyed by source_ref (re-push updates body).
      // Document-level content identity is declared here with the SAME
      // derivation push uses — over the whole body with the DEFAULT version
      // components, not the caller's `identityVersions` overrides — because
      // `source_ref` resolves to exactly one current identity: a writer that
      // hashed with its own versions would leave the row addressable by a
      // pair the other writer cannot reproduce, and every later submit for
      // that source would be an identity mismatch.
      const documentContentIdentity = computeContentIdentity(env.content);
      writtenBySourceRef.set(env.source_ref, {
        sourceDocId,
        contentIdentity: documentContentIdentity,
      });
      const sourceDoc: SourceDocRecord = {
        id: sourceDocId,
        source_ref: env.source_ref,
        title: env.title,
        content: env.content,
        created_at: now,
        content_identity: documentContentIdentity,
      };
      await deps.storage.upsertSourceDoc(sourceDoc);

      const kept = keptIdsBySourceDoc.get(sourceDocId) ?? new Set<string>();
      keptIdsBySourceDoc.set(sourceDocId, kept);

      for (const slice of env.slices) {
        const contentIdentity = computeContentIdentity(
          slice.content,
          identityVersions
        );
        const record: ChunkRecord = {
          id: computeChunkId(env.source_ref, contentIdentity),
          content: slice.content,
          embedding: embeddings[embeddingCursor]!,
          ...(batches.incoming === null
            ? {}
            : { incoming_embedding: batches.incoming[embeddingCursor]! }),
          source_ref: env.source_ref,
          metadata: env.metadata,
          valid_from: env.valid_from ?? now,
          valid_until: env.valid_until ?? null,
          created_at: now,
          source_doc_id: sourceDocId,
          ordinal: slice.ordinal,
        };
        records.push(record);
        kept.add(record.id);
        allChunkIds.push(record.id);
        embeddingCursor += 1;
      }
    }
    // One entry per 资料 actually written, in first-touch order: the arrays
    // are aligned because both come off the same last-write-wins map.
    const writtenDocs = [...writtenBySourceRef.values()];
    const sourceDocIds = writtenDocs.map((w) => w.sourceDocId);
    const contentIdentities = writtenDocs.map((w) => w.contentIdentity);

    // Rebuild sweep BEFORE the upsert, excluding the ids this push is
    // about to write:
    //  - Same-id re-push (same content identity): the old chunk stays in
    //    place, so `preserveInvalidationState` (memory) / the ON CONFLICT
    //    (id) CASE (pg) keeps the closed-row state from a prior
    //    invalidation (T6).
    //  - Slot conflicts (same source_doc_id + ordinal, different id) and
    //    orphans from a previous content identity are cleared BEFORE the
    //    INSERT, so the (source_doc_id, ordinal) unique index cannot
    //    reject the new slice rows.
    for (const [sourceDocId, kept] of keptIdsBySourceDoc) {
      await deps.storage.deleteChunksForSourceDoc(sourceDocId, kept);
    }
    // Review repair E: bind the write to the SAME ledger state the slices
    // were embedded against above — the backend must not re-read the ledger
    // and decide the dual-write against a different (fresher) state.
    const ids = await deps.storage.upsert(records, { generation });
    // 就绪 only AFTER the chunk rows are durable. ingest writes the same
    // (资料 row, chunk rows) pair push does, so it reaches the same state:
    // docs/CONTEXT.md 资料集合 defines 就绪 as status ready AND count ≥ 1,
    // and a 资料 ingested here would otherwise sit at 进行中 with a
    // non-zero count forever. Best-effort by the same EXIT as push's: a
    // status write failing must not fail an ingest whose rows are already
    // authoritative.
    for (const sourceDocId of sourceDocIds) {
      try {
        await deps.storage.markSourceDocReady(sourceDocId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`ingest status write failed: ${message}\n`);
      }
    }
    let precisionFailed = false;
    if (deps.precision !== undefined) {
      try {
        await deps.precision.indexChunks(records);
      } catch (error) {
        // EXIT: a derived-index failure is visible but never rolls back the
        // authoritative chunk write; reindex repairs it later.
        precisionFailed = true;
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`ingest precision index failed: ${message}\n`);
      }
    }
    return textResult(
      JSON.stringify({
        chunk_ids: ids,
        ...(sourceDocIds.length === 1
          ? {
              source_doc_id: sourceDocIds[0],
              content_identity: contentIdentities[0],
            }
          : {
              source_doc_ids: sourceDocIds,
              content_identities: contentIdentities,
            }),
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

/**
 * Wire the ingest tool into the registry. The handler is closed over `deps`
 * so the tool stays a static registration from the registry's perspective.
 */
export const ingestTool = (deps: IngestDeps): ToolRegistration => ({
  name: "ingest",
  description:
    "Write one or more 资料 (source documents) into the knowledge memory " +
    "store. Each call takes an envelope with source_ref, the prose body " +
    "(content), and the slice list (chunks) the injector pre-cut. " +
    "Re-pushing the same source_ref updates the body and rebuilds its " +
    "derived chunks without growing the 资料 row count. The response names " +
    "each 资料 row's content identity, the pair half an index-job submit " +
    "takes.",
  inputSchema: IngestInputSchema,
  // The registry's handler signature is `(input: unknown) => ...` (the
  // generic is erased at the boundary so the registry stays a single
  // `ToolRegistrationAny` map). Each tool's real handler is typed against
  // its own Zod schema; the cast mirrors the other tool files.
  handler: createIngestHandler(deps) as unknown as ToolRegistration["handler"],
});
