/**
 * Push tool — the fin-side ingestion entry.
 *
 * Plan D0 I-T4 / I-T7: this tool is the contract that fin's
 * `push_port` calls. It is intentionally distinct from `ingest`:
 *
 *  - The idempotency key is the full `(source_ref, content_identity)`
 *    pair (B4). A re-push with identical content returns the same
 *    `chunk_id` and does not grow the storage row count.
 *  - B4 required fields are non-optional: source_ref, content body,
 *    `chunks[]`, non-empty metadata, valid_from, and valid_until.
 *  - The text is written verbatim. There is no sliding-window chunker
 *    on this path, so the bytes that come back from retrieve equal
 *    the bytes that went in (I-T7).
 *
 * Operator-console T3: push and ingest now share the same one-envelope
 * shape `{ source_ref, content, chunks }`. The only difference is push's
 * stricter metadata and validity-window contract.
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
import type {
  ChunkRecord,
  SourceDocRecord,
  StorageBackend,
} from "../core/types.js";
import { GraphragError, MAX_CONTENT_BYTES } from "../core/errors.js";
import { SOURCE_DOC_STATUS } from "../core/types.js";
import type { PrecisionIndexer } from "../core/storage/elasticsearch-precision.js";
import type { Logger } from "../logging.js";
import {
  computeChunkId,
  computeContentIdentity,
  computeSourceDocId,
  DEFAULT_CONTENT_IDENTITY_VERSIONS,
  embedTextForSlice,
  embedWithLog,
  type ContentIdentityVersions,
} from "./ingest.js";
import {
  findSliceInvariantViolations,
  refineSliceInvariants,
} from "./slice-invariants.js";

const ChunkSliceSchema = z.object({
  content: z.string().min(1, "chunk content must be a non-empty string"),
  index: z.number().int().min(0, "chunk index must be a non-negative integer"),
});

/**
 * Batch per-item push shape:
 *   { items: [{ content, source_ref, chunks?, metadata, valid_from, valid_until }, ...] }
 *
 * `chunks[]` is fin's real wire (`mcp_push_port._to_push_item`): one slice per
 * chunk of the 资料 body. An item WITHOUT `chunks` stays a one-slice envelope
 * (body = item.content, chunks = [{ content, index: 0 }]) for the pure-legacy
 * migration ramp. The item is non-strict (`z.object`) so unknown keys are
 * ignored rather than rejected — the batch arm predates the strict envelope.
 */
const LegacyPushItemSchema = z
  .object({
    content: z.string().min(1, "content must be a non-empty string"),
    source_ref: z.string().min(1, "source_ref must be a non-empty string"),
    chunks: z
      .array(ChunkSliceSchema)
      .min(1, "chunks must contain at least one slice")
      .optional(),
    metadata: z
      .record(z.string(), z.unknown())
      .refine(
        (record) => Object.keys(record).length > 0,
        "metadata must contain at least one key (B4 required)"
      ),
    valid_from: z.string().datetime(),
    valid_until: z.string().datetime(),
  })
  .superRefine(refineSliceInvariants);
/**
 * Refuse a batch that carries the same 资料 twice.
 *
 * `source_ref` IS the 资料 key (`source_documents.source_ref` is UNIQUE) and
 * the rebuild-on-repush contract is per-`source_ref`: `writeEnvelope` deletes
 * the 资料's previous chunk rows before inserting the new set. Two envelopes
 * for one 资料 in ONE batch is therefore a contradictory input, not a merge:
 * the second envelope's sweep deletes the rows the first just inserted, while
 * the response still lists the first envelope's ids as if they had landed.
 * That is a silent false success — the returned `chunk_ids` would name rows
 * that do not exist, and fin's length-only check cannot see it.
 *
 * Refused rather than deduplicated or last-one-wins: both of those return
 * ids for a write that was discarded. A re-push of the same 资料 is still
 * legal — in a LATER call, which is the documented rebuild path.
 */
function findRepeatedSourceRefs(
  items: ReadonlyArray<{ source_ref: string }>
): Array<{ index: number; firstIndex: number; sourceRef: string }> {
  const firstSeenAt = new Map<string, number>();
  const repeats: Array<{
    index: number;
    firstIndex: number;
    sourceRef: string;
  }> = [];
  for (let i = 0; i < items.length; i += 1) {
    const sourceRef = items[i]!.source_ref;
    const firstIndex = firstSeenAt.get(sourceRef);
    if (firstIndex === undefined) {
      firstSeenAt.set(sourceRef, i);
      continue;
    }
    repeats.push({ index: i, firstIndex, sourceRef });
  }
  return repeats;
}

/** The wording shared by the schema refinement and the handler's re-check. */
function repeatedSourceRefMessage(repeat: {
  index: number;
  firstIndex: number;
  sourceRef: string;
}): string {
  return (
    `items[${repeat.index}].source_ref "${repeat.sourceRef}" repeats the ` +
    `source_ref of items[${repeat.firstIndex}]; one batch cannot carry two ` +
    `envelopes for the same 资料 (re-push it in a separate call)`
  );
}

const LegacyPushInputSchema = z
  .strictObject({
    items: z
      .array(LegacyPushItemSchema)
      .min(1, "push: items must contain at least one entry"),
  })
  .superRefine((input, ctx) => {
    for (const repeat of findRepeatedSourceRefs(input.items)) {
      ctx.addIssue({
        code: "custom",
        path: ["items", repeat.index, "source_ref"],
        message: repeatedSourceRefMessage(repeat),
      });
    }
  });

/**
 * Push envelope (operator-console T3):
 *   { source_ref, content: <body>, chunks: [{ content, index }],
 *     metadata: { ≥1 key }, valid_from, valid_until }
 *
 * Strict (z.strictObject) — unknown keys are a typed validation error.
 *
 * `superRefine` enforces the fin freeze invariant at the schema boundary:
 * each chunk content is a contiguous substring of the body, in order, with
 * dense 0..N-1 indexes. One-slice requires the slice to equal the body.
 */
const PushEnvelopeInputSchema = z
  .strictObject({
    source_ref: z.string().min(1, "source_ref must be a non-empty string"),
    content: z.string().min(1, "content must be a non-empty string"),
    chunks: z
      .array(ChunkSliceSchema)
      .min(1, "chunks must contain at least one slice"),
    title: z.string().min(1).optional(),
    metadata: z
      .record(z.string(), z.unknown())
      .refine(
        (record) => Object.keys(record).length > 0,
        "metadata must contain at least one key (B4 required)"
      ),
    valid_from: z.string().datetime(),
    valid_until: z.string().datetime(),
  })
  .superRefine(refineSliceInvariants);

export const PushInputSchema = z.union([
  PushEnvelopeInputSchema,
  LegacyPushInputSchema,
]);

export type PushInput = z.infer<typeof PushInputSchema>;

interface NormalizedPushEnvelope {
  source_ref: string;
  title: string | null;
  content: string;
  slices: Array<{ content: string; ordinal: number }>;
  metadata: Record<string, unknown>;
  valid_from: string;
  valid_until: string;
}

/** Dependencies injected at wiring time. Mirrors IngestDeps. */
export interface PushDeps {
  embedder: EmbeddingClient;
  storage: StorageBackend;
  /** Optional ES derived-index writer; authority writes always win. */
  precision?: PrecisionIndexer;
  identityVersions?: Partial<ContentIdentityVersions>;
  /**
   * Optional structured logger for the SC10 embed process log. Optional so
   * existing dep constructions stay source-compatible; production wiring
   * threads the server logger in.
   */
  logger?: Logger;
}

/**
 * Validate push-specific invariants not covered by Zod:
 *  - valid_from < valid_until (window ordering)
 *  - per-chunk content size ≤ 1MB (overflow refuse)
 *  - the fin freeze slice invariants, via the same walk the schema uses
 *    (dense indexes, contiguous substrings in order, one-slice-equals-body)
 *
 * Precedence is a contract, not an accident of loop order: the 1MB refusal
 * is checked for EVERY slice before any structural invariant is raised. A
 * body that is merely mis-sliced and a body that is genuinely oversized
 * must not report differently depending on which slice tripped first —
 * callers retry on CONTENT_TOO_LARGE (split the chunk) and fix on
 * INVALID_INPUT, so the two must never be conflated.
 *
 * This is defense in depth behind the Zod refine, not a re-implementation:
 * a regression that loosens the schema must still be caught here.
 */
function validatePushEnvelope(env: NormalizedPushEnvelope): void {
  if (env.valid_from >= env.valid_until) {
    throw new GraphragError(
      "push: valid_from must be strictly before valid_until",
      "INVALID_INPUT"
    );
  }
  for (const slice of env.slices) {
    const byteLength = Buffer.byteLength(slice.content, "utf8");
    if (byteLength > MAX_CONTENT_BYTES) {
      throw new GraphragError(
        `push: chunk ${slice.ordinal} content size ${byteLength} bytes exceeds limit ${MAX_CONTENT_BYTES} (1MB)`,
        "CONTENT_TOO_LARGE"
      );
    }
  }
  const violations = findSliceInvariantViolations(
    env.content,
    env.slices.map((slice) => ({
      content: slice.content,
      index: slice.ordinal,
    }))
  );
  if (violations.length > 0) {
    throw new GraphragError(`push: ${violations[0]!.message}`, "INVALID_INPUT");
  }
}

function normalizePushInput(input: PushInput): NormalizedPushEnvelope[] {
  // Union arm dispatch: items[] ⇒ legacy per-item; otherwise the new
  // envelope. The schema has already validated both branches.
  if ("items" in input && Array.isArray(input.items)) {
    // Defense in depth behind the schema's superRefine, same as
    // validatePushEnvelope below: a regression that loosens the schema must
    // not reopen the silent-loss path this refusal closes.
    const repeat = findRepeatedSourceRefs(input.items)[0];
    if (repeat !== undefined) {
      throw new GraphragError(
        `push: ${repeatedSourceRefMessage(repeat)}`,
        "INVALID_INPUT"
      );
    }
    return input.items.map((item) => ({
      source_ref: item.source_ref,
      title: null,
      content: item.content,
      slices:
        item.chunks === undefined
          ? [{ content: item.content, ordinal: 0 }]
          : item.chunks.map((slice) => ({
              content: slice.content,
              ordinal: slice.index,
            })),
      metadata: item.metadata,
      valid_from: item.valid_from,
      valid_until: item.valid_until,
    }));
  }
  const env = input as Exclude<PushInput, { items: unknown[] }>;
  return [
    {
      source_ref: env.source_ref,
      title: env.title ?? null,
      content: env.content,
      slices: env.chunks.map((slice) => ({
        content: slice.content,
        ordinal: slice.index,
      })),
      metadata: env.metadata,
      valid_from: env.valid_from,
      valid_until: env.valid_until,
    },
  ];
}

/**
 * Best-effort 失败 record for a push that threw (corpus-ready retrieve T3).
 *
 * The original error ALWAYS propagates: a status write that fails (e.g. the
 * same storage outage that broke the push) must not replace the push's own
 * diagnostic. An unknown `source_ref` is a no-op inside the storage layer,
 * so a push that fails before its 资料 row exists records nothing rather
 * than inventing a row.
 *
 * SCOPE: this covers failures raised INSIDE the handler. A payload the Zod
 * `inputSchema` rejects is refused by the MCP SDK before the handler runs
 * (see `registerOne` in src/index.ts — the SDK owns schema validation), so
 * an unparseable push cannot be attributed to a 资料: the shape error may
 * well be the `source_ref` field itself. Those refusals are reported to the
 * caller as a tool error and leave any existing 就绪 status in place.
 *
 * A persistent inability to write status must not look like a transient
 * one, so a failed write is reported on stderr — same EXIT as
 * `markSourceDocReadyBestEffort` below.
 */
async function recordPushFailure(
  storage: StorageBackend,
  sourceRefs: Iterable<string>,
  error: unknown
): Promise<void> {
  const code = error instanceof GraphragError ? error.code : "STORAGE_ERROR";
  for (const sourceRef of sourceRefs) {
    try {
      await storage.recordSourceDocFailure(sourceRef, code);
    } catch (statusError) {
      // EXIT: the push failure is the diagnostic that matters; a failed
      // status write is secondary and must not mask it.
      const message =
        statusError instanceof Error
          ? statusError.message
          : String(statusError);
      process.stderr.write(
        `push failure status write failed for "${sourceRef}": ${message}\n`
      );
    }
  }
}

/**
 * Run one stage of a push and, if it throws, name the 资料 it was pushing
 * as 失败 before letting the error continue. `sourceRefs` is a thunk so a
 * stage can name its scope lazily — the embed stage covers the batch it
 * read, the per-envelope write stage covers exactly one 资料.
 */
async function withFailureRecord<T>(
  storage: StorageBackend,
  sourceRefs: () => Iterable<string>,
  work: () => Promise<T>
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    await recordPushFailure(storage, sourceRefs(), error);
    throw error;
  }
}

/**
 * Everything one envelope's write needs that is shared across the batch:
 * the batch-wide embedding array and how many slices the earlier envelopes
 * already consumed, the identity version set, and the one timestamp the
 * whole batch stamps its rows with.
 */
interface EnvelopeWriteContext {
  embeddings: number[][];
  embeddingCursor: number;
  identityVersions: ContentIdentityVersions;
  now: string;
}

/**
 * Write ONE envelope end to end: upsert the 资料 row (recording 进行中 —
 * the slices have not landed yet), drop its previous chunk rows, then
 * insert the new ones.
 *
 * All three writes for a 资料 live here rather than being split between
 * this function and a batch-wide `upsert`, because a batch is a
 * convenience and not a transaction: with a trailing batch write, one
 * failing sibling would take down the chunk rows of every 资料 in the
 * batch and the 失败 stamp would have to name all of them. Per-envelope
 * writes keep the blast radius and the attribution on the 资料 that
 * actually failed.
 */
async function writeEnvelope(
  storage: StorageBackend,
  env: NormalizedPushEnvelope,
  ctx: EnvelopeWriteContext
): Promise<{ records: ChunkRecord[]; ids: string[]; sourceDocId: string }> {
  const sourceDocId = computeSourceDocId(env.source_ref);
  // Upsert the 资料 row keyed by source_ref (re-push updates body).
  const sourceDoc: SourceDocRecord = {
    id: sourceDocId,
    source_ref: env.source_ref,
    title: env.title,
    content: env.content,
    created_at: ctx.now,
    status: SOURCE_DOC_STATUS.IN_PROGRESS,
    failure_code: null,
  };
  await storage.upsertSourceDoc(sourceDoc);

  // Rebuild chunks for this 资料 before inserting the new set.
  await storage.deleteChunksForSourceDoc(sourceDocId);

  const records: ChunkRecord[] = [];
  for (const slice of env.slices) {
    const contentIdentity = computeContentIdentity(
      slice.content,
      ctx.identityVersions
    );
    records.push({
      id: computeChunkId(env.source_ref, contentIdentity),
      content: slice.content,
      embedding: ctx.embeddings[ctx.embeddingCursor]!,
      source_ref: env.source_ref,
      metadata: env.metadata,
      valid_from: env.valid_from,
      valid_until: env.valid_until,
      created_at: ctx.now,
      source_doc_id: sourceDocId,
      ordinal: slice.ordinal,
    });
    ctx.embeddingCursor += 1;
  }
  // upsert collapses same-id writes: a re-push of the same
  // (source_ref, content) returns the existing chunk_id and adds
  // zero new rows (the cross-repo idempotency baseline).
  const ids = await storage.upsert(records);
  return { records, ids, sourceDocId };
}

export function createPushHandler(deps: PushDeps) {
  return async function pushHandler(input: PushInput): Promise<ToolResult> {
    const envelopes = normalizePushInput(input);
    const allRefs = (): string[] => envelopes.map((env) => env.source_ref);

    // Validate the whole batch before any write, so a bad envelope cannot
    // leave a half-written batch behind. The 失败 record names only the
    // envelope whose validation threw: a batch-mate's document is fine and
    // must keep whatever status a previous push left it in.
    for (const env of envelopes) {
      try {
        validatePushEnvelope(env);
      } catch (error) {
        await recordPushFailure(deps.storage, [env.source_ref], error);
        throw error;
      }
    }

    // Embed INPUT carries the 资料 title (contextual wrap); the chunk rows
    // written below keep the pushed bytes.
    const sliceTexts = envelopes.flatMap((env) =>
      env.slices.map((slice) => embedTextForSlice(env.title, slice.content))
    );
    // Nothing has been written yet, so an embed failure fails the whole
    // batch: every envelope in it names a 失败 attempt.
    const embeddings = await withFailureRecord(deps.storage, allRefs, () =>
      embedSlices(deps, sliceTexts)
    );

    const ctx: EnvelopeWriteContext = {
      embeddings,
      embeddingCursor: 0,
      identityVersions: {
        ...DEFAULT_CONTENT_IDENTITY_VERSIONS,
        ...deps.identityVersions,
      },
      now: new Date().toISOString(),
    };
    const records: ChunkRecord[] = [];
    const ids: string[] = [];
    const sourceDocIds: string[] = [];
    for (const env of envelopes) {
      // A batch is not a transaction: only the 资料 whose own write threw
      // is recorded 失败, and a sibling that landed is marked 就绪 before
      // the next envelope is attempted — so a later failure cannot leave a
      // written 资料 sitting at 进行中 with its rows already durable.
      const written = await withFailureRecord(
        deps.storage,
        () => [env.source_ref],
        () => writeEnvelope(deps.storage, env, ctx)
      );
      records.push(...written.records);
      ids.push(...written.ids);
      sourceDocIds.push(written.sourceDocId);
      await markSourceDocReadyBestEffort(deps.storage, [written.sourceDocId]);
    }
    const precisionFailed = await indexPrecisionBestEffort(deps, records);
    return textResult(
      JSON.stringify({
        chunk_ids: ids,
        ...(sourceDocIds.length === 1
          ? { source_doc_id: sourceDocIds[0] }
          : { source_doc_ids: sourceDocIds }),
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

/** Embed every slice, refusing a count mismatch (a silent truncation). */
async function embedSlices(
  deps: PushDeps,
  sliceTexts: string[]
): Promise<number[][]> {
  const embeddings = await embedWithLog(
    deps.logger,
    deps.embedder,
    sliceTexts,
    {
      itemCount: sliceTexts.length,
    }
  );
  if (embeddings.length !== sliceTexts.length) {
    throw new GraphragError(
      `push: embedding count ${embeddings.length} does not match slice count ${sliceTexts.length}`,
      "EMBEDDING_FAILED"
    );
  }
  return embeddings;
}

/**
 * 就绪 only AFTER the chunk rows are durable (就绪 requires ≥1 successful
 * chunk). A status write failing here means a successful push whose status
 * was lost: log it rather than failing the push, since the rows are
 * already authoritative.
 */
async function markSourceDocReadyBestEffort(
  storage: StorageBackend,
  sourceDocIds: string[]
): Promise<void> {
  for (const sourceDocId of sourceDocIds) {
    try {
      await storage.markSourceDocReady(sourceDocId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`push status write failed: ${message}\n`);
    }
  }
}

/**
 * Mirror the records into the optional ES derived index. Returns whether
 * the mirror failed.
 *
 * EXIT: Postgres is authoritative; an ES outage is retryable through the
 * reindex command and must not turn a successful push into a partial
 * authority write.
 */
async function indexPrecisionBestEffort(
  deps: PushDeps,
  records: ChunkRecord[]
): Promise<boolean> {
  if (deps.precision === undefined) return false;
  try {
    await deps.precision.indexChunks(records);
    return false;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`push precision index failed: ${message}\n`);
    return true;
  }
}

export const pushTool = (deps: PushDeps): ToolRegistration => ({
  name: "push",
  description:
    "Strict batch text ingest. Each call takes one envelope with " +
    "source_ref, the prose body (content), and the slice list (chunks). " +
    "Idempotent on (source_ref, content_identity): an identical re-push " +
    "returns the same chunk_id without adding rows. Metadata is required " +
    "with at least one key; valid_from and valid_until are required. Text " +
    "is stored verbatim — it is never re-chunked.",
  inputSchema: PushInputSchema,
  handler: createPushHandler(deps) as unknown as ToolRegistration["handler"],
});
