/**
 * Core domain types for iknow-memory stage 1.
 *
 * Stage 1 = chunks-only vector retrieval with valid_window time slicing.
 * No triples/entities/facts (stage 3). No snapshot_id (T-001 drift verdict #2).
 */

/** A stored text chunk with its embedding and temporal validity. */
export interface ChunkRecord {
  id: string;
  content: string;
  embedding: number[]; // vector of configured dimensions
  source_ref: string;
  metadata: Record<string, unknown>;
  valid_from: string; // ISO 8601 datetime
  valid_until: string | null; // null = forever valid
  created_at: string; // ISO 8601 datetime
  /**
   * Back-pointer to the 资料 row this chunk was sliced from
   * (operator-console T1). Optional on the read path so legacy chunk
   * rows written before T1 still load; new ingest/push writes populate
   * both fields (T3 enforces required on the envelope write path).
   */
  source_doc_id?: string;
  /** Zero-based ordinal of this chunk within its source document. */
  ordinal?: number;
  /**
   * Vector for the INCOMING generation slot, embedded with the incoming
   * (model, dimensions) pair (embedding generation rotate T2). Present only
   * while a `dual_write` rotate is open; the pgvector backend refuses the
   * batch when the rotate is open and this field is missing, so a row can
   * never be half-written into one generation only.
   */
  incoming_embedding?: number[];
}

/**
 * Per-write generation binding for `StorageBackend.upsert` (embedding
 * generation rotate, review repair E). The tool layer embeds against the
 * ledger state it reads from the backend cache; passing THAT exact state
 * here makes it the single source for validation AND the dual-write, so a
 * rotate opening mid-process can never half-decide on one state and write
 * on another. When `generation` is absent (undefined) the backend re-reads
 * the ledger fresh, preserving the self-healing behavior of callers that
 * never bind a state (extract / community paths).
 */
export interface ChunkUpsertOptions {
  /** `null` = the caller asserts no ledger row (legacy single-column write). */
  generation?: EmbeddingGenerationState | null;
}

/**
 * A 资料 prose SoR row (operator-console T1 / ADR-0010).
 *
 * One row holds the full body text the injector pushed; the dashboard and
 * `read_source` MCP tool return this body. Chunks back-point to this row
 * via `chunks.source_doc_id` + `chunks.ordinal` so a derived slice stays
 * traceable to its source.
 */
export interface SourceDocRecord {
  id: string;
  source_ref: string;
  title: string | null;
  content: string;
  created_at: string;
  /**
   * Close of the 资料 validity window (operator-console T5). `null` =
   * forever valid — the ingest/push write path always writes `null`
   * (an opening push is never a close). Set by `invalidateSourceRef`
   * in the same transaction that closes the derived chunk windows.
   * Optional on the read path so callers written before T5 still load.
   */
  valid_until?: string | null;
  /**
   * Persisted 就绪 status (corpus-ready retrieve T3). Optional on the WRITE
   * path so callers written before T3 still load; a push with no explicit
   * status records 进行中. The storage layer never derives status from
   * `valid_until` — a closed window is invalidation, a different concept.
   */
  status?: SourceDocStatus;
  /** Stable code of the last failed push; written with `status: "failed"`. */
  failure_code?: string | null;
  /**
   * Current content version of the (source_ref, content_identity) idempotency
   * pair (corpus-index-job T2). NULL on legacy rows until the next push
   * backfills it.
   */
  content_identity?: string | null;
}

/**
 * 资料 status vocabulary (corpus-ready retrieve T3).
 *
 * PERSISTED, not derived: `in_progress` is written when a push starts and a
 * failure is written when one fails, so the 资料页 can name 失败 for a
 * locator whose envelope never produced a chunk row.
 */
export const SOURCE_DOC_STATUS = {
  /** A push for this 资料 is in flight (or landed no chunk yet). */
  IN_PROGRESS: "in_progress",
  /** The last push succeeded and ≥1 chunk row exists. */
  READY: "ready",
  /** The last push for this 资料 failed; `failure_code` says how. */
  FAILED: "failed",
} as const;

export type SourceDocStatus =
  (typeof SOURCE_DOC_STATUS)[keyof typeof SOURCE_DOC_STATUS];

/**
 * Extract-method vocabulary (graph-index-standard-fast T1; spec assumption 3).
 *
 * One 资料 version carries EXACTLY ONE method: `standard` (LLM extraction,
 * the default job) or `fast` (pure NLP co-occurrence, T4). Persisted on
 * `source_documents.extract_method`; the CHECK constraint in
 * schema-bootstrap.ts derives its literal list from this constant, mirroring
 * the `SOURCE_DOC_STATUS` pattern.
 */
export const EXTRACT_METHODS = ["standard", "fast"] as const;

export type ExtractMethod = (typeof EXTRACT_METHODS)[number];

/**
 * C-ready vocabulary for the corpus-level community index (graph-index-
 * standard-fast T5; spec assumption 10 / success criterion 11).
 *
 * Persisted on the single row of `community_index_state`, following the
 * `SOURCE_DOC_STATUS` convention (constant-derived CHECK, `failure_code`
 * beside `status`). Not-ready is the safe default: only a completed atomic
 * swap of the whole summary generation writes READY, so a failed or
 * in-flight rebuild never lets the previous report set be served as
 * current C. `in_progress` exists so a crashed rebuild stays 未就绪 until an
 * operator reruns the job, instead of silently re-validating the old set.
 * `stale` is the producer-side demotion (T5 review gap): an extract chunk
 * that persisted new graph rows moves READY there inside the SAME chunk
 * transaction, so the summary generation is openly outdated until the next
 * community-summary rebuild swaps back to READY.
 */
export const COMMUNITY_INDEX_STATUS = {
  /** A detect + summarize rebuild is running (or died mid-flight). */
  IN_PROGRESS: "in_progress",
  /** The ledger holds the complete summary generation for the current graph. */
  READY: "ready",
  /** Graph rows landed after the last swap; the summaries are outdated. */
  STALE: "stale",
  /** The last community-summary job failed; `failure_code` says how. */
  FAILED: "failed",
} as const;

export type CommunityIndexStatus =
  (typeof COMMUNITY_INDEX_STATUS)[keyof typeof COMMUNITY_INDEX_STATUS];

/**
 * Durable corpus index-job status vocabulary (corpus-index-job T2).
 *
 * Reuses the four C values; queued vs running is `started_at IS NULL`,
 * never a fifth state word. `source_documents.status` stays a separate fact.
 */
export const INDEX_JOB_STATUS = {
  IN_PROGRESS: "in_progress",
  READY: "ready",
  FAILED: "failed",
  STALE: "stale",
} as const;

export type IndexJobStatus =
  (typeof INDEX_JOB_STATUS)[keyof typeof INDEX_JOB_STATUS];

/** One persisted index-job row bound to exactly one (source_ref, content_identity). */
export interface IndexJobRecord {
  /** Derived id: same pair → same job (idempotent submit arm). */
  job_id: string;
  source_ref: string;
  content_identity: string;
  status: IndexJobStatus;
  created_at: string;
  /** null = queued (persisted, not yet picked up). */
  started_at: string | null;
  finished_at: string | null;
  /** Typed stage failure; set when status is failed. */
  failure_code: string | null;
}

/**
 * Persistence seam for the index-job ledger (corpus-index-job T2).
 *
 * insertJobOrJoin is the idempotent arm: when the derived job_id row already
 * exists it returns that row with `inserted: false` instead of creating a
 * second job — the caller must not claim a fresh queue entry it did not make.
 * The `conflict` arm is the one-active-job-per-source rule enforced at the
 * source of truth (partial unique index on `index_jobs`, and its memory
 * twin): an `in_progress` insert for a source another active job already owns
 * persists nothing and returns that racing row instead.
 */
export type IndexJobInsertOutcome =
  | { readonly record: IndexJobRecord; readonly inserted: boolean }
  | { readonly conflict: IndexJobRecord };

export interface IndexJobStore {
  insertJobOrJoin(record: IndexJobRecord): Promise<IndexJobInsertOutcome>;
  getJob(jobId: string): Promise<IndexJobRecord | null>;
  getActiveJobForSource(sourceRef: string): Promise<IndexJobRecord | null>;
  /** Demote this source's terminal `ready` jobs to `stale` when a new
   * content version supersedes them; returns the number of rows demoted. */
  supersedeReadyJobs(sourceRef: string): Promise<number>;
}

/**
 * Rotate-mode vocabulary for the embedding-generation ledger
 * (embedding generation rotate T1; specs/embedding-generation.md).
 *
 * Persisted on `embedding_generation.rotate_mode` while an incoming slot is
 * open: `dual_write` keeps vector reads on the active generation while
 * persist writes land in both slots; `downtime` typed-refuses vector reads
 * until cutover. The CHECK in schema-bootstrap.ts derives its literal list
 * from this constant, mirroring the `SOURCE_DOC_STATUS` pattern.
 */
export const EMBED_ROTATE_MODES = ["dual_write", "downtime"] as const;

export type EmbedRotateMode = (typeof EMBED_ROTATE_MODES)[number];

/**
 * One side of the generation pointer: the (model, dimensions) pair that
 * defines which embeddings may share a cosine index. `model` is NULL when
 * no embedding key is configured (the operator setting has no model to
 * record), and the boot comparison treats NULL and "absent" as equal.
 */
export interface EmbeddingGenerationPair {
  model: string | null;
  dimensions: number;
}

/**
 * The typed read of the `embedding_generation` singleton
 * (embedding-generation.ts). All three vector classes (chunks, entities,
 * community summaries) share this one pointer; cutover flips them together.
 */
export interface EmbeddingGenerationState {
  /** Physical vector column name of the active generation. */
  activeSlot: string;
  active: EmbeddingGenerationPair;
  /** Incoming slot name; null = no rotate is open. */
  incomingSlot: string | null;
  /** Incoming generation; undefined together with `incomingSlot`. */
  incoming: EmbeddingGenerationPair | null;
  rotateMode: EmbedRotateMode | null;
  /**
   * Slot of the generation a cutover displaced (T4); null = no cutover is
   * on record, so there is nothing to roll back or drop.
   */
  rollbackSlot: string | null;
  /** Displaced pair; undefined together with `rollbackSlot`. */
  rollback: EmbeddingGenerationPair | null;
  updatedAt: Date;
}

export function isEmbedRotateMode(value: unknown): value is EmbedRotateMode {
  return (
    typeof value === "string" &&
    (EMBED_ROTATE_MODES as readonly string[]).includes(value)
  );
}

/**
 * Stable failure code stored in `community_index_state.failure_code` when a
 * community-summary job fails. Spec 待写入 keeps public spellings as an
 * Open Question; this string is the fin `具名失败` token already pinned by
 * `specs/search-mode-retrieve.md` (`community_summary_index_failure`), so
 * the retrieve-side ticket can forward it verbatim. The process-level typed
 * error stays `COMMUNITY_SUMMARY_JOB_FAILED` on the CLI.
 */
export const COMMUNITY_SUMMARY_INDEX_FAILURE =
  "community_summary_index_failure" as const;

/**
 * v1 is a SINGLE process-wide 资料集合 (spec Open Question 2, leading
 * option): every stored 资料 belongs to the one collection the operator
 * sees on the existing 资料页. A collections table would be a schema,
 * routing, and permissions question with no v1 consumer, so the name is a
 * constant — stable for the wire, the dashboard, and fin's operator copy.
 * Revisit when a second collection actually has to coexist.
 */
export const SOURCE_DOC_COLLECTION_NAME = "默认资料集合";

/** Input to the ingest tool (after Zod validation). */
export interface IngestInput {
  content: string;
  source_ref: string;
  metadata?: Record<string, unknown>;
  valid_from?: string; // ISO 8601; defaults to now
  valid_until?: string; // ISO 8601; defaults to null (forever)
}

/** Input to the retrieve tool (after Zod validation). */
export interface RetrieveInput {
  query: string;
  valid_at?: string; // ISO 8601; defaults to now
  filters?: Record<string, string>; // exact match on source_ref / metadata keys
  limit?: number; // top-K; defaults to 10
  wait_for_drain?: boolean;
  wait_for_drain_timeout_ms?: number;
}

/** A single chunk in a retrieve response. */
export interface RetrievedChunk {
  id: string;
  content: string;
  source_ref: string;
  valid_window: [string, string | null]; // [valid_from, valid_until]
  score: number; // cosine similarity 0-1
}

/** Response from the retrieve tool. */
export interface RetrieveResult {
  chunks: RetrievedChunk[];
}

/** Storage backend contract — both MemoryBackend and PgvectorBackend implement this. */
export interface StorageBackend {
  upsert(
    chunks: ChunkRecord[],
    options?: ChunkUpsertOptions
  ): Promise<string[]>; // returns chunk ids
  /**
   * The embedding-generation ledger as last read by the backend
   * (embedding generation rotate T1/T2). Optional: memory-mode and test
   * backends have no generations, and an absent read means "no rotate is
   * open" for the dual-write decision at the tool layer.
   */
  getGenerationState?(): EmbeddingGenerationState | undefined;
  search(
    queryEmbedding: number[],
    opts: SearchOptions
  ): Promise<RetrievedChunk[]>;
  close(): Promise<void>;
  /**
   * Insert-or-update a 资料 row keyed by `source_ref`. The same locator
   * always maps to the same `id` (operator-console T3 — re-push is the
   * concurrent class). Returns the persisted record. Idempotent: a
   * re-push with the same body returns the existing row unchanged;
   * a re-push with a different body replaces `title` / `content`.
   */
  upsertSourceDoc(doc: SourceDocRecord): Promise<SourceDocRecord>;
  /**
   * Drop every chunk row that back-points to `sourceDocId`. Used by
   * T3's re-push rebuild semantics: a same-locator re-push wipes the
   * derived chunk rows for that doc before inserting the new set.
   * Chunks without a back-pointer (legacy rows) are NOT touched.
   *
   * `excludeChunkIds` lists chunks that should NOT be deleted even though
   * they back-point to `sourceDocId` — typically the ones the caller is
   * about to upsert under the same id (so `preserveInvalidationState`
   * can keep the closed-row state on a same-content re-push). When
   * omitted the call behaves as before: drop every back-pointed chunk.
   */
  deleteChunksForSourceDoc(
    sourceDocId: string,
    excludeChunkIds?: Iterable<string>
  ): Promise<void>;
  /**
   * List every chunk row that back-points to `sourceDocId`, ordered by
   * ordinal ascending. Used by T4 read_source and the dashboard detail.
   */
  listChunksBySourceDoc(sourceDocId: string): Promise<StorageChunkView[]>;
  /**
   * Record that the last push for `sourceDocId` produced at least one
   * successful chunk row (corpus-ready retrieve T3). Ready additionally
   * requires ≥1 chunk row; the count itself is always derived from the
   * back-pointers, so this call only moves the status.
   */
  markSourceDocReady(sourceDocId: string): Promise<void>;
  /**
   * Record a failed push against a 资料 that is ALREADY known, keyed by
   * `sourceRef` (corpus-ready retrieve T3). Best-effort by contract: an
   * unknown locator is a no-op, never an invented row — the 资料页 shows
   * 失败 for a locator the store has seen, and a push that fails before
   * any 资料 row exists has nothing to attach the failure to.
   */
  recordSourceDocFailure(sourceRef: string, errorCode: string): Promise<void>;
}

/**
 * Dedicated core read port for operator browse/stats/timeline.
 * Not on StorageBackend so chunk-only fakes stay valid; both production
 * backends implement it. SQL for the pg path lives in core, not HTTP.
 */
export const STORAGE_LIST_LIMIT_DEFAULT = 20;
export const STORAGE_LIST_LIMIT_MAX = 100;

export interface StorageListOptions {
  limit?: number;
  offset?: number;
}

export interface StorageCounts {
  chunks: number;
  entities: number;
  invalidations: number;
}

export interface StorageChunkView {
  id: string;
  content: string;
  source_ref: string;
  valid_from: string;
  valid_until: string | null;
  metadata: Record<string, unknown>;
  /** Back-pointer to the 资料 row this chunk was sliced from (operator-console T3). */
  source_doc_id?: string;
  /** Zero-based ordinal of this chunk within its source document. */
  ordinal?: number;
}

export interface StorageEntityView {
  id: string;
  canonical_name: string;
  type: string;
  retired: boolean;
  aliases: string[];
}

/** Read-only view of a 资料 (source_documents) row for operator UI / read_source. */
export interface StorageSourceDocView {
  id: string;
  source_ref: string;
  title: string | null;
  content: string;
  created_at: string;
  /**
   * Close of the 资料 validity window (operator-console T5). `null` when
   * the 资料 is still valid; a timestamp once content invalidation has
   * closed it. Exposed so the dashboard list can show invalidation state
   * without a second query.
   */
  valid_until: string | null;
  /**
   * Process-wide 资料集合 name (corpus-ready retrieve T3). v1 is a single
   * implicit collection — see `SOURCE_DOC_COLLECTION_NAME`. Present on
   * every 资料 so the 资料页 can show the field without a collections
   * table.
   */
  collection: string;
  /** Persisted 就绪 status — see `SOURCE_DOC_STATUS`. */
  status: SourceDocStatus;
  /**
   * Stable code of the last failed push, or `null` when the last outcome
   * was not a failure. Required only when `status === "failed"`.
   */
  failure_code: string | null;
  /**
   * Successful chunk count, DERIVED from `chunks.source_doc_id`
   * back-pointers (never a second mutable counter that could drift from
   * the rows).
   */
  chunk_count: number;
  /**
   * Current content version of the (source_ref, content_identity) pair
   * (corpus-index-job T2). `undefined`/`null` = legacy row not yet backfilled.
   */
  content_identity?: string | null;
}

export type StorageTimelineEvent =
  | {
      kind: "chunk_valid_from" | "chunk_valid_until";
      at: string;
      chunk_id: string;
      source_ref: string;
    }
  | {
      kind: "invalidation";
      at: string;
      chunk_id: string;
      source_ref: string;
      triggered_by: string;
    };

export interface StoragePage<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export type StorageReadResult<T> =
  { ok: true; value: T } | { ok: false; code: "NOT_FOUND" | "INVALID_INPUT" };

export interface StorageReadPort {
  counts(): Promise<StorageCounts>;
  listChunks(opts?: StorageListOptions): Promise<StoragePage<StorageChunkView>>;
  getChunk(id: string): Promise<StorageReadResult<StorageChunkView>>;
  listEntities(
    opts?: StorageListOptions
  ): Promise<StoragePage<StorageEntityView>>;
  getEntity(id: string): Promise<StorageReadResult<StorageEntityView>>;
  listTimeline(
    opts?: StorageListOptions
  ): Promise<StoragePage<StorageTimelineEvent>>;
  /**
   * Fetch a 资料 (source_documents) row by its source_ref locator. Used by
   * T4's `read_source` MCP tool and the dashboard detail page.
   */
  getSourceDoc(
    sourceRef: string
  ): Promise<StorageReadResult<StorageSourceDocView>>;
  /**
   * Fetch a 资料 (source_documents) row by its primary-key id. Used by
   * the dashboard list→detail navigation when only the id is on hand.
   */
  getSourceDocById(
    id: string
  ): Promise<StorageReadResult<StorageSourceDocView>>;
  /**
   * List 资料 (source_documents) summaries in creation order. Summaries
   * carry NO `content` — the dashboard list is on-demand (operator-console
   * T6: no full-corpus body fetch when listing); the body is fetched by
   * `getSourceDocById` when a row is opened.
   */
  listSourceDocs(
    opts?: StorageListOptions
  ): Promise<StoragePage<StorageSourceDocSummary>>;
}

/**
 * List-row projection of a 资料: everything the operator list needs,
 * without the full body. `title` is nullable — an empty title displays
 * `source_ref` on the board.
 */
export interface StorageSourceDocSummary {
  id: string;
  source_ref: string;
  title: string | null;
  created_at: string;
  valid_until: string | null;
  /** Process-wide 资料集合 name (corpus-ready retrieve T3). */
  collection: string;
  /** Persisted 就绪 status — see `SOURCE_DOC_STATUS`. */
  status: SourceDocStatus;
  /** Stable code of the last failed push, or `null`. */
  failure_code: string | null;
  /** Successful chunk count, derived from the chunk back-pointers. */
  chunk_count: number;
}

export interface SearchOptions {
  limit: number;
  validAt: string; // ISO 8601 — filter: valid_from <= validAt AND (valid_until IS NULL OR valid_until > validAt)
  filters?: Record<string, string>; // exact match on source_ref / metadata keys
  /**
   * Optional lexical precision-layer controls. Vector backends ignore this
   * block; the Elasticsearch adapter consumes it when it builds the lexical
   * query. Keeping it on the shared search shape lets the orchestrator pass
   * one immutable set of retrieval knobs to either backend.
   */
  precision?: PrecisionSearchOptions;
}

export interface PrecisionSearchOptions {
  /**
   * Okapi BM25 term-frequency saturation. Same retrieval knob on both
   * backends, different mechanism: the MemoryBackend double applies it
   * per query (in-memory BM25); the Elasticsearch backend applies it as
   * INDEX-TIME similarity settings only (ES has no per-request BM25
   * override), so a query-time k1 there is deliberately ignored.
   */
  k1?: number;
  /**
   * Okapi BM25 document-length normalization. Index-time on the ES
   * backend (see the `k1` note above); query-time on MemoryBackend.
   */
  b?: number;
  /** Use match_phrase clauses in addition to term matching. */
  phrase?: boolean;
  /** Use configured per-field boosts instead of uniform fields. */
  fieldBoost?: boolean;
  /** Use the IK CJK query analyzer; false preserves the unsegmented path. */
  cjkSegmentation?: boolean;
  /** Optional field → boost overrides for the lexical query. */
  fieldBoosts?: Record<string, number>;
}
