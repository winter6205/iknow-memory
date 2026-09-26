/**
 * In-memory storage backend for dev/test.
 * Vector search = brute-force cosine over all stored chunks.
 * Lexical search = Okapi BM25 over an incrementally-maintained inverted index.
 * No persistence — data lost on process exit.
 * Thread-safety: single-threaded Node; concurrent upserts are safe
 * because Map.set is synchronous within each await boundary.
 */
import type {
  ChunkRecord,
  ChunkUpsertOptions,
  IndexJobInsertOutcome,
  IndexJobRecord,
  IndexJobStore,
  PrecisionSearchOptions,
  RetrievedChunk,
  SearchOptions,
  SourceDocRecord,
  StorageBackend,
  StorageChunkView,
  StorageCounts,
  StorageEntityView,
  StorageListOptions,
  StoragePage,
  StorageReadPort,
  StorageReadResult,
  StorageSourceDocSummary,
  StorageSourceDocView,
  StorageTimelineEvent,
} from "../types.js";
import type {
  CommunityIndexStateRow,
  CommunityIndexStateStorage,
  ParentWindowRow,
  ParentWindowStorage,
} from "../retrieval/types.js";
import {
  INDEX_JOB_STATUS,
  SOURCE_DOC_COLLECTION_NAME,
  SOURCE_DOC_STATUS,
} from "../types.js";
import {
  appendContentInvalidation,
  CONTENT_INVALIDATIONS_METADATA_KEY,
  normalizeContentInvalidationRequest,
  readContentInvalidations,
  type ContentInvalidationRecord,
  type ContentInvalidationStorage,
  type LexicalStorageBackend,
} from "./backend.js";
import {
  lookupReadId,
  normalizeStorageListOptions,
  paginateItems,
  projectTimelineEvents,
  toChunkView,
} from "./storage-reads.js";
import { cosineSimilarity } from "../cosine.js";
import { GraphragError } from "../errors.js";

/** Okapi BM25 term-frequency saturation. */
const BM25_K1 = 1.2;
/** Okapi BM25 length-normalization strength. */
const BM25_B = 0.75;

/** The fallback tokenization used when the caller explicitly disables CJK. */
function tokenizeWithoutCjk(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0);
}

/**
 * Split text into lexical terms using the same shape as the precision layer.
 *
 * `Intl.Segmenter` ships with Node's ICU data and provides dictionary-backed
 * word boundaries for Chinese. The small Han-character fallback is only for
 * runtimes built with reduced ICU data; it preserves the important contract
 * that a continuous CJK string cannot collapse into one searchable token.
 * `cjkSegmentation=false` intentionally restores the old contiguous-run
 * behavior for ablation tests.
 */
export function tokenize(text: string, cjkSegmentation = true): string[] {
  if (!cjkSegmentation) return tokenizeWithoutCjk(text);
  const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
  const terms = [...segmenter.segment(text)]
    .filter((part) => part.isWordLike)
    .flatMap((part) => tokenizeWithoutCjk(part.segment));
  if (terms.length >= 2 || !/\p{Script=Han}/u.test(text)) return terms;
  return [...text.toLowerCase()].filter((char) =>
    /\p{Script=Han}|\p{L}|\p{N}/u.test(char)
  );
}

/** Per-chunk lexical statistics: term counts plus the chunk's length. */
interface LexicalDoc {
  termFreq: Map<string, number>;
  length: number;
}

/**
 * In-process StorageBackend. Suitable for unit tests, local dev, and any
 * context where durability is not required (no snapshot_id in stage 1).
 *
 * Indexing strategy: brute-force scan over the entire chunk set on every
 * search. With O(N) chunks this is O(N * dimensions) per query — fine for
 * the dev/test workloads stage 1 targets; PgvectorBackend (T8) takes over
 * when N grows past a few thousand.
 *
 * Why `Map<id, ChunkRecord>` and not an array: keyed by id gives us O(1)
 * overwrite semantics for "last write wins" on re-ingestion of the same
 * chunk id, and O(1) clear() on close().
 */
export class MemoryBackend
  implements
    StorageBackend,
    LexicalStorageBackend,
    ContentInvalidationStorage,
    ParentWindowStorage,
    CommunityIndexStateStorage,
    IndexJobStore,
    StorageReadPort
{
  private readonly store = new Map<string, ChunkRecord>();
  /**
   * Corpus-level C-ready singleton (the in-memory twin of
   * `community_index_state`). `null` = the row does not exist = the
   * community job never ran, which 档 C must read as not-ready, never as
   * empty.
   */
  private communityIndexState: CommunityIndexStateRow | null = null;
  /**
   * 资料 SoR rows (operator-console T3). Keyed by `source_ref` so re-push
   * of the same locator collapses to a single row (the concurrent class).
   * The Map preserves insertion order for stable list ordering on the
   * dashboard detail view.
   */
  private readonly sourceDocs = new Map<string, SourceDocRecord>();
  /**
   * Durable index-job ledger twin (corpus-index-job T2), keyed by the derived
   * `job_id` so a repeat submit collapses onto the existing row. Offline
   * semantics match the pg backend; durability across a process restart is a
   * pg-only claim (this Map is lost on exit).
   */
  private readonly indexJobs = new Map<string, IndexJobRecord>();

  /**
   * Lexical index, maintained on write rather than rebuilt on read.
   *
   * `docs` holds per-chunk term frequencies; `postings` maps a term to
   * the chunks containing it, which is what keeps a query touching only
   * candidate chunks instead of scanning the whole store. `totalLength`
   * tracks the running sum so the BM25 average-length term is O(1).
   */
  private readonly docs = new Map<string, LexicalDoc>();
  private readonly postings = new Map<string, Set<string>>();
  private totalLength = 0;

  constructor(private readonly dimensions: number) {}

  /**
   * Validate then store each chunk. The whole batch is atomic: if any chunk
   * fails the embedding-dimension check, the batch throws and no chunk is
   * persisted (Map.set has not been called yet for that chunk).
   *
   * Throws GraphragError EMBEDDING_DIM_MISMATCH if a chunk's embedding has
   * a length other than the configured dimensions.
   */
  async upsert(
    chunks: ChunkRecord[],
    // Memory mode has no generation ledger, so a caller-bound state is
    // accepted (same StorageBackend contract) and has nothing to bind to.
    _options?: ChunkUpsertOptions
  ): Promise<string[]> {
    // Pre-validate all chunks before mutating the store so a bad chunk in
    // position N does not leave the first N-1 chunks half-persisted.
    for (const chunk of chunks) {
      if (chunk.embedding.length !== this.dimensions) {
        throw new GraphragError(
          `upsert: chunk "${chunk.id}" embedding length ${chunk.embedding.length} !== ${this.dimensions}`,
          "EMBEDDING_DIM_MISMATCH"
        );
      }
    }

    const ids: string[] = [];
    for (const chunk of chunks) {
      // Last-write-wins: a re-ingestion of the same id replaces the old record.
      const stored = preserveInvalidationState(this.store.get(chunk.id), chunk);
      this.store.set(chunk.id, stored);
      this.reindex(stored);
      ids.push(chunk.id);
    }
    return ids;
  }

  async invalidateSourceRef(
    sourceRef: string,
    invalidatedAt: string,
    triggeredBy: string
  ): Promise<ContentInvalidationRecord[]> {
    const request = normalizeContentInvalidationRequest(
      sourceRef,
      invalidatedAt,
      triggeredBy
    );
    const matching = [...this.store.values()].filter(
      (chunk) => chunk.source_ref === request.sourceRef
    );
    if (matching.length === 0) {
      throw new GraphragError(
        `content invalidation: unknown source_ref "${request.sourceRef}"`,
        "INVALID_INPUT"
      );
    }

    // T5: content invalidation targets the 资料 AND its derived chunks.
    // The chunk windows below close one by one; the 资料 row's window
    // closes with them so read_source can answer a named-invalid while
    // the rows stay physically present (no delete this wave).
    const sourceDoc = this.sourceDocs.get(request.sourceRef);
    if (sourceDoc !== undefined) {
      this.sourceDocs.set(request.sourceRef, {
        ...sourceDoc,
        valid_until: closeValidityWindow(
          sourceDoc.valid_until ?? null,
          request.invalidatedAt
        ),
      });
    }

    const records: ContentInvalidationRecord[] = [];
    for (const chunk of matching) {
      const record: ContentInvalidationRecord = {
        chunk_id: chunk.id,
        invalidated_at: request.invalidatedAt,
        triggered_by: request.triggeredBy,
      };
      const metadata = appendContentInvalidation(chunk.metadata, record);
      this.store.set(chunk.id, {
        ...chunk,
        metadata,
        valid_until: closeValidityWindow(
          chunk.valid_until,
          request.invalidatedAt
        ),
      });
      records.push(record);
    }
    return sortInvalidationRecords(records);
  }

  /**
   * Insert-or-update a 资料 row keyed by `source_ref`. Same locator → same id
   * (caller-derived), so re-push is the concurrent class. Body + title are
   * replaced on a same-id re-push; `created_at` keeps the first write so the
   * row's identity timestamp stays stable.
   */
  async upsertSourceDoc(doc: SourceDocRecord): Promise<SourceDocRecord> {
    const existing = this.sourceDocs.get(doc.source_ref);
    // T5: mirror the chunk-level preserveInvalidationState rule. A
    // re-push of the same content keeps the closed 资料 window (the
    // invalidation still applies to what was re-pushed); a different
    // content version is a fresh document and reopens the window. The
    // write path always sends `valid_until: null` (a push is never a
    // close); only invalidation closes.
    const previousWindow = existing?.valid_until ?? null;
    const sameContent =
      existing !== undefined && existing.content === doc.content;
    const merged: SourceDocRecord = {
      ...(existing ? { ...doc, created_at: existing.created_at } : doc),
      ...carryStatus(existing, doc),
      valid_until:
        previousWindow !== null && sameContent ? previousWindow : null,
    };
    this.sourceDocs.set(doc.source_ref, merged);
    return merged;
  }

  /**
   * Drop every chunk row that back-points to `sourceDocId`. Operator-console
   * T3 rebuild semantics: a same-locator re-push wipes the derived chunk rows
   * for that 资料 before inserting the new set. Chunks without a back-pointer
   * (legacy rows) are NOT touched. Returns the count of dropped chunks.
   *
   * `excludeChunkIds` (optional) lists chunk ids that should NOT be deleted
   * even though they back-point to `sourceDocId`. T3's ingest handler uses
   * this to keep the just-upserted ids intact after `preserveInvalidationState`
   * merges their closed-row state — only orphans (chunks left over from a
   * previous content-identity version) are dropped.
   */
  async deleteChunksForSourceDoc(
    sourceDocId: string,
    excludeChunkIds?: Iterable<string>
  ): Promise<void> {
    const excluded = excludeChunkIds ? new Set(excludeChunkIds) : null;
    for (const [id, chunk] of this.store) {
      if (chunk.source_doc_id !== sourceDocId) continue;
      if (excluded !== null && excluded.has(id)) continue;
      this.deindex(id);
      this.store.delete(id);
    }
  }

  /**
   * 档 A child→parent window lookup (plans/search-mode-retrieve.md T2):
   * resolves each child chunk's back-pointer to its 资料 row. A child
   * without `source_doc_id` (legacy row) or whose 资料 row is gone yields
   * NO row — the caller must degrade rather than cite the child alone.
   */
  async parentWindowsByChunkIds(
    chunkIds: readonly string[]
  ): Promise<ParentWindowRow[]> {
    const rows: ParentWindowRow[] = [];
    for (const chunkId of chunkIds) {
      const chunk = this.store.get(chunkId);
      if (chunk === undefined || chunk.source_doc_id === undefined) continue;
      const doc = this.findSourceDocById(chunk.source_doc_id);
      if (doc === undefined) continue;
      rows.push({
        chunk_id: chunk.id,
        source_doc_id: doc.id,
        ordinal: chunk.ordinal ?? null,
        content: doc.content,
      });
    }
    return rows;
  }

  /**
   * 档 C readiness singleton write (plans/search-mode-retrieve.md T3).
   * Mirrors the CLI's swap: `null` clears the row (no job ever ran).
   */
  async setCommunityIndexState(
    row: CommunityIndexStateRow | null
  ): Promise<void> {
    this.communityIndexState = row === null ? null : { ...row };
  }

  async getCommunityIndexState(): Promise<CommunityIndexStateRow | undefined> {
    return this.communityIndexState === null
      ? undefined
      : { ...this.communityIndexState };
  }

  /**
   * Idempotent submit arm (corpus-index-job T2). The derived `job_id` already
   * present returns the existing row unchanged — a repeat submit never
   * overwrites a job a worker has already advanced. `inserted` says which arm
   * ran, so a caller cannot report a queue entry this call did not create.
   *
   * The memory twin of `index_jobs_one_active_per_source_idx`: a second live
   * `in_progress` row for one `source_ref` is refused as `conflict` naming the
   * row that owns the source, and nothing is stored. Check-then-set is
   * synchronous here (no await between probe and `Map.set`), so two racing
   * callers cannot both pass — the same total the partial unique index gives
   * Postgres.
   */
  async insertJobOrJoin(
    record: IndexJobRecord
  ): Promise<IndexJobInsertOutcome> {
    const existing = this.indexJobs.get(record.job_id);
    if (existing !== undefined) {
      return { record: { ...existing }, inserted: false };
    }
    if (record.status === INDEX_JOB_STATUS.IN_PROGRESS) {
      for (const other of this.indexJobs.values()) {
        if (
          other.source_ref === record.source_ref &&
          other.status === INDEX_JOB_STATUS.IN_PROGRESS
        ) {
          return { conflict: { ...other } };
        }
      }
    }
    const stored: IndexJobRecord = { ...record };
    this.indexJobs.set(record.job_id, stored);
    return { record: { ...stored }, inserted: true };
  }

  async getJob(jobId: string): Promise<IndexJobRecord | null> {
    const record = this.indexJobs.get(jobId);
    return record === undefined ? null : { ...record };
  }

  async getActiveJobForSource(
    sourceRef: string
  ): Promise<IndexJobRecord | null> {
    for (const record of this.indexJobs.values()) {
      if (
        record.source_ref === sourceRef &&
        record.status === INDEX_JOB_STATUS.IN_PROGRESS
      ) {
        return { ...record };
      }
    }
    return null;
  }

  /**
   * Demote every terminal `ready` job of a source to `stale`; returns the
   * number demoted. Mutates the stored rows, not the copies handed to callers.
   *
   * No exception parameter: the incoming job is `in_progress`, so the `ready`
   * predicate cannot touch it — same reasoning as the pg store's SQL.
   */
  async supersedeReadyJobs(sourceRef: string): Promise<number> {
    let demoted = 0;
    for (const [jobId, record] of this.indexJobs) {
      if (
        record.source_ref === sourceRef &&
        record.status === INDEX_JOB_STATUS.READY
      ) {
        this.indexJobs.set(jobId, {
          ...record,
          status: INDEX_JOB_STATUS.STALE,
        });
        demoted += 1;
      }
    }
    return demoted;
  }

  /**
   * List every chunk row that back-points to `sourceDocId`, ordered by
   * ordinal ascending. Used by T4's `read_source` and the dashboard detail.
   */
  async listChunksBySourceDoc(
    sourceDocId: string
  ): Promise<StorageChunkView[]> {
    return [...this.store.values()]
      .filter((chunk) => chunk.source_doc_id === sourceDocId)
      .sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0))
      .map((chunk) => toChunkView(chunk));
  }

  async listInvalidations(
    sourceRef?: string
  ): Promise<ContentInvalidationRecord[]> {
    if (sourceRef !== undefined && sourceRef.trim() === "") {
      throw new GraphragError(
        "content invalidation: source_ref must be a non-empty string",
        "INVALID_INPUT"
      );
    }
    const records: ContentInvalidationRecord[] = [];
    for (const chunk of this.store.values()) {
      if (sourceRef !== undefined && chunk.source_ref !== sourceRef) {
        continue;
      }
      records.push(...readContentInvalidations(chunk.metadata));
    }
    return sortInvalidationRecords(records);
  }

  async counts(): Promise<StorageCounts> {
    const invalidations = await this.listInvalidations();
    return {
      chunks: this.store.size,
      entities: 0,
      invalidations: invalidations.length,
    };
  }

  async listChunks(
    opts?: StorageListOptions
  ): Promise<StoragePage<StorageChunkView>> {
    const { limit, offset } = normalizeStorageListOptions(opts);
    const items = [...this.store.values()]
      .sort(compareIngestOrder)
      .map((chunk) => toChunkView(chunk));
    return paginateItems(items, limit, offset);
  }

  async getChunk(id: string): Promise<StorageReadResult<StorageChunkView>> {
    const lookedUp = lookupReadId(id);
    if (!lookedUp.ok) return lookedUp;
    const chunk = this.store.get(lookedUp.value);
    if (chunk === undefined) return { ok: false, code: "NOT_FOUND" };
    return { ok: true, value: toChunkView(chunk) };
  }

  async listEntities(
    opts?: StorageListOptions
  ): Promise<StoragePage<StorageEntityView>> {
    const { limit, offset } = normalizeStorageListOptions(opts);
    return paginateItems([], limit, offset);
  }

  async getEntity(id: string): Promise<StorageReadResult<StorageEntityView>> {
    const lookedUp = lookupReadId(id);
    if (!lookedUp.ok) return lookedUp;
    return { ok: false, code: "NOT_FOUND" };
  }

  async getSourceDoc(
    sourceRef: string
  ): Promise<StorageReadResult<StorageSourceDocView>> {
    if (typeof sourceRef !== "string" || sourceRef.trim() === "") {
      return { ok: false, code: "INVALID_INPUT" };
    }
    const doc = this.sourceDocs.get(sourceRef);
    if (doc === undefined) return { ok: false, code: "NOT_FOUND" };
    return {
      ok: true,
      value: toSourceDocView(doc, this.countChunksOf(doc.id)),
    };
  }

  async getSourceDocById(
    id: string
  ): Promise<StorageReadResult<StorageSourceDocView>> {
    if (typeof id !== "string" || id.trim() === "") {
      return { ok: false, code: "INVALID_INPUT" };
    }
    const doc = this.findSourceDocById(id);
    if (doc === undefined) return { ok: false, code: "NOT_FOUND" };
    return {
      ok: true,
      value: toSourceDocView(doc, this.countChunksOf(doc.id)),
    };
  }

  /** 资料 row by primary-key id (the Map is keyed by source_ref). */
  private findSourceDocById(id: string): SourceDocRecord | undefined {
    for (const doc of this.sourceDocs.values()) {
      if (doc.id === id) return doc;
    }
    return undefined;
  }

  /**
   * 资料 summaries in creation order (Map preserves insertion order;
   * a same-locator re-push keeps the original position). Body excluded —
   * the list is on-demand; open via getSourceDocById.
   */
  async listSourceDocs(
    opts?: StorageListOptions
  ): Promise<StoragePage<StorageSourceDocSummary>> {
    const { limit, offset } = normalizeStorageListOptions(opts);
    const items = [...this.sourceDocs.values()]
      .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
      .map((doc) => toSourceDocSummary(doc, this.countChunksOf(doc.id)));
    return paginateItems(items, limit, offset);
  }

  /** Successful chunk rows for one 资料 — the derived count SSOT. */
  private countChunksOf(sourceDocId: string): number {
    let count = 0;
    for (const chunk of this.store.values()) {
      if (chunk.source_doc_id === sourceDocId) count += 1;
    }
    return count;
  }

  /** Move a known 资料 to 就绪 (corpus-ready retrieve T3). */
  async markSourceDocReady(sourceDocId: string): Promise<void> {
    for (const [sourceRef, doc] of this.sourceDocs) {
      if (doc.id !== sourceDocId) continue;
      this.sourceDocs.set(sourceRef, {
        ...doc,
        status: SOURCE_DOC_STATUS.READY,
        failure_code: null,
      });
      return;
    }
  }

  /**
   * Record a failed push against a known 资料. Best-effort: an unknown
   * locator is a no-op (never an invented row) so a push that fails before
   * the 资料 row exists cannot manufacture one.
   */
  async recordSourceDocFailure(
    sourceRef: string,
    errorCode: string
  ): Promise<void> {
    if (typeof sourceRef !== "string" || sourceRef.trim() === "") {
      throw new GraphragError(
        "source doc failure: source_ref must be a non-empty string",
        "INVALID_INPUT"
      );
    }
    const existing = this.sourceDocs.get(sourceRef);
    if (existing === undefined) return;
    this.sourceDocs.set(sourceRef, {
      ...existing,
      status: SOURCE_DOC_STATUS.FAILED,
      failure_code: errorCode,
    });
  }

  async listTimeline(
    opts?: StorageListOptions
  ): Promise<StoragePage<StorageTimelineEvent>> {
    const { limit, offset } = normalizeStorageListOptions(opts);
    const chunks = [...this.store.values()]
      .sort(compareIngestOrder)
      .map((chunk) => toChunkView(chunk));
    return paginateItems(projectTimelineEvents(chunks), limit, offset);
  }

  /**
   * Replace a chunk's lexical entry. Retracting the previous posting
   * first is what stops superseded text from still matching after a
   * re-ingestion under the same id.
   */
  private reindex(chunk: ChunkRecord): void {
    this.deindex(chunk.id);
    const termFreq = new Map<string, number>();
    const terms = tokenize(chunk.content);
    for (const term of terms) {
      termFreq.set(term, (termFreq.get(term) ?? 0) + 1);
      let posting = this.postings.get(term);
      if (posting === undefined) {
        posting = new Set();
        this.postings.set(term, posting);
      }
      posting.add(chunk.id);
    }
    this.docs.set(chunk.id, { termFreq, length: terms.length });
    this.totalLength += terms.length;
  }

  /** Drop a chunk from the inverted index, pruning emptied postings. */
  private deindex(id: string): void {
    const previous = this.docs.get(id);
    if (previous === undefined) return;
    for (const term of previous.termFreq.keys()) {
      const posting = this.postings.get(term);
      if (posting === undefined) continue;
      posting.delete(id);
      if (posting.size === 0) this.postings.delete(term);
    }
    this.totalLength -= previous.length;
    this.docs.delete(id);
  }

  /**
   * Apply filters (valid_window + exact-match metadata/source_ref), score,
   * rank, and return the top-K.
   *
   * valid_window semantics: a chunk is in-window when
   *   valid_from <= validAt AND (valid_until === null OR valid_until > validAt)
   * valid_until is exclusive — a chunk expiring at exactly validAt is NOT
   * returned. This matches the spec at src/core/types.ts:63 ("OR valid_until > validAt").
   */
  async search(
    queryEmbedding: number[],
    opts: SearchOptions
  ): Promise<RetrievedChunk[]> {
    const admits = this.buildAdmissionFilter("search", opts);

    const scored: RetrievedChunk[] = [];
    for (const chunk of this.store.values()) {
      if (!admits(chunk)) continue;
      scored.push(
        toRetrievedChunk(
          chunk,
          cosineSimilarity(queryEmbedding, chunk.embedding)
        )
      );
    }

    // Sort descending by score. Ties keep insertion order
    // (Array.prototype.sort is stable in V8/Node since ES2019).
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, opts.limit);
  }

  /**
   * Okapi BM25 over the inverted index — the in-process test seam
   * mirroring `ElasticsearchPrecisionLayer.searchLexical`, so hybrid
   * retrieval can be exercised without a running precision-layer cluster.
   *
   * The corpus is small and fully in memory, so the real k1/b formula
   * runs here with no approximation. Scores are NOT comparable across
   * backends, which is fine — RRF fuses on rank.
   *
   * k1/b are the same retrieval knob as on the ES precision layer, but a
   * different mechanism: in-memory BM25 is computed per query, so they are
   * read from `SearchOptions.precision` here; on the ES backend they are
   * index-time similarity settings (see that class's searchLexical note).
   *
   * Query terms are OR-ed: candidates are the union of the postings for
   * the query's terms. Requiring every term would return nothing for
   * most natural-language queries, and this is a recall arm.
   */
  async searchLexical(
    query: string,
    opts: SearchOptions
  ): Promise<RetrievedChunk[]> {
    const admits = this.buildAdmissionFilter("searchLexical", opts);
    if (opts.limit <= 0) return [];

    const precision = opts.precision;
    const terms = [
      ...new Set(tokenize(query, precision?.cjkSegmentation ?? true)),
    ];
    if (terms.length === 0) return [];

    const docCount = this.docs.size;
    if (docCount === 0) return [];
    const avgLength = this.totalLength / docCount;
    const k1 = precision?.k1 ?? BM25_K1;
    const b = precision?.b ?? BM25_B;

    const scores = new Map<string, number>();
    for (const term of terms) {
      const posting = this.postings.get(term);
      if (posting === undefined) continue;
      // Standard BM25 IDF with the +1 guard, which keeps the value
      // positive even for a term present in every chunk (a plain
      // Robertson IDF would go negative there and push common-term
      // matches below chunks that match nothing).
      const idf = Math.log(
        1 + (docCount - posting.size + 0.5) / (posting.size + 0.5)
      );
      for (const id of posting) {
        const chunk = this.store.get(id);
        if (chunk === undefined || !admits(chunk)) continue;
        const doc = this.docs.get(id)!;
        const freq = doc.termFreq.get(term) ?? 0;
        const norm = freq + k1 * (1 - b + (b * doc.length) / (avgLength || 1));
        scores.set(
          id,
          (scores.get(id) ?? 0) + (idf * (freq * (k1 + 1))) / norm
        );
      }
    }

    const ranked = [...scores.entries()]
      .sort((a, b) => (b[1] !== a[1] ? b[1] - a[1] : a[0] < b[0] ? -1 : 1))
      .map(([id, score]) => [id, score] as [string, number]);
    applyFieldBoost(ranked, terms, precision, admits, this.store.values());
    applyPhraseBoost(ranked, query, precision, this.store);
    return ranked
      .sort((a, b) => (b[1] !== a[1] ? b[1] - a[1] : a[0] < b[0] ? -1 : 1))
      .slice(0, opts.limit)
      .map(([id, score]) => toRetrievedChunk(this.store.get(id)!, score));
  }

  /**
   * Return visible chunks within `width` ingest positions of each anchor.
   * This mirrors the Postgres neighbor seam and keeps the in-memory backend
   * useful for retrieve tests without making the orchestrator special-case it.
   */
  async chunksByChunkIds(
    chunkIds: readonly string[],
    validAt: string,
    width: number
  ): Promise<RetrievedChunk[]> {
    if (chunkIds.length === 0 || width <= 0) return [];

    const admits = this.buildAdmissionFilter("chunksByChunkIds", {
      limit: Number.MAX_SAFE_INTEGER,
      validAt,
    });
    const visible = [...this.store.values()]
      .filter(admits)
      .sort(compareIngestOrder);
    const bySource = new Map<string, ChunkRecord[]>();
    for (const chunk of visible) {
      const sourceChunks = bySource.get(chunk.source_ref) ?? [];
      sourceChunks.push(chunk);
      bySource.set(chunk.source_ref, sourceChunks);
    }
    const selected = new Set<string>();

    for (const anchorId of chunkIds) {
      const anchor = visible.find((chunk) => chunk.id === anchorId);
      if (anchor === undefined) continue;
      const sourceChunks = bySource.get(anchor.source_ref)!;
      const anchorPosition = sourceChunks.indexOf(anchor);
      for (
        let position = Math.max(0, anchorPosition - width);
        position <= Math.min(sourceChunks.length - 1, anchorPosition + width);
        position += 1
      ) {
        selected.add(sourceChunks[position]!.id);
      }
    }

    return visible
      .filter((chunk) => selected.has(chunk.id))
      .map((chunk) => toRetrievedChunk(chunk, 0));
  }

  /**
   * Build the shared "is this chunk visible to this query" predicate:
   * temporal window plus exact-match source_ref / metadata filters. Both
   * arms must agree on visibility, so they share one implementation
   * rather than two copies that can drift.
   *
   * `label` names the caller in the thrown message so an invalid
   * timestamp points at the arm that received it.
   */
  private buildAdmissionFilter(
    label: string,
    opts: SearchOptions
  ): (chunk: ChunkRecord) => boolean {
    const validAtMs = Date.parse(opts.validAt);
    if (Number.isNaN(validAtMs)) {
      throw new GraphragError(
        `${label}: invalid validAt timestamp "${opts.validAt}"`,
        "INVALID_INPUT"
      );
    }

    const filters = opts.filters ?? {};
    const wantSourceRef = filters["source_ref"];
    const metadataFilters: Array<{ key: string; value: string }> = [];
    for (const [k, v] of Object.entries(filters)) {
      if (k === "source_ref") continue;
      if (k.startsWith("metadata.")) {
        metadataFilters.push({ key: k.slice("metadata.".length), value: v });
      }
      // Unknown top-level filter keys are ignored — they cannot match
      // anything on a ChunkRecord (which only exposes source_ref + metadata).
    }

    return (chunk: ChunkRecord): boolean => {
      const fromMs = Date.parse(chunk.valid_from);
      if (Number.isNaN(fromMs) || fromMs > validAtMs) return false;
      if (chunk.valid_until !== null) {
        const untilMs = Date.parse(chunk.valid_until);
        if (Number.isNaN(untilMs) || untilMs <= validAtMs) return false;
      }

      if (wantSourceRef !== undefined && chunk.source_ref !== wantSourceRef) {
        return false;
      }

      // Text-comparison semantics to match pgvector's
      // `metadata ->> $key = $value`, which casts JSON values to text
      // before comparing — e.g. {category: 123} matches filter "123".
      for (const f of metadataFilters) {
        const val = chunk.metadata[f.key];
        if (val === undefined || String(val) !== f.value) return false;
      }
      return true;
    };
  }

  /**
   * Drop all stored chunks and the lexical index. Resolves successfully
   * even if the backend is already empty, so callers can use close() in
   * `finally` blocks without caring about state.
   */
  async close(): Promise<void> {
    this.store.clear();
    this.docs.clear();
    this.postings.clear();
    this.totalLength = 0;
  }
}

function applyFieldBoost(
  ranked: Array<[string, number]>,
  queryTerms: readonly string[],
  precision: PrecisionSearchOptions | undefined,
  admits: (chunk: ChunkRecord) => boolean,
  records: Iterable<ChunkRecord>
): void {
  if (precision?.fieldBoost === false) return;
  const boosts = precision?.fieldBoosts ?? {};
  if (Object.keys(boosts).length === 0) return;
  // Metadata and source_ref are not part of the content postings. Scan those
  // small fields only when field boosting is requested so they can contribute
  // as independently weighted lexical evidence.
  for (const record of records) {
    if (!admits(record)) continue;
    const id = record.id;
    const fields: Array<[string, string]> = [
      ["source_ref", record.source_ref],
      ...Object.entries(record.metadata).map(
        ([key, value]) => [`metadata.${key}`, String(value)] as [string, string]
      ),
    ];
    for (const [field, value] of fields) {
      const boost = boosts[field] ?? boosts["metadata.*"] ?? 0;
      if (boost <= 0) continue;
      const fieldTerms = new Set(tokenizeWithoutCjk(value));
      const matches = queryTerms.filter((term) => fieldTerms.has(term)).length;
      if (matches === 0) continue;
      const current = ranked.find(([rankedId]) => rankedId === id);
      const next = (current?.[1] ?? 0) + boost * matches;
      if (current) current[1] = next;
      else ranked.push([id, next]);
    }
  }
}

function applyPhraseBoost(
  ranked: Array<[string, number]>,
  query: string,
  precision: PrecisionSearchOptions | undefined,
  records: ReadonlyMap<string, ChunkRecord>
): void {
  if (precision?.phrase === false) return;
  const queryTerms = tokenize(query, precision?.cjkSegmentation ?? true);
  if (queryTerms.length < 2) return;
  for (const entry of ranked) {
    const record = records.get(entry[0]);
    if (record === undefined) continue;
    const contentTerms = tokenize(
      record.content,
      precision?.cjkSegmentation ?? true
    );
    const matches = contentTerms.some((_, index) =>
      queryTerms.every((term, offset) => contentTerms[index + offset] === term)
    );
    if (matches) entry[1] += Math.max(entry[1] * 0.5, 0.001);
  }
}

function compareIngestOrder(a: ChunkRecord, b: ChunkRecord): number {
  const createdAt = Date.parse(a.created_at) - Date.parse(b.created_at);
  return createdAt !== 0 ? createdAt : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function preserveInvalidationState(
  previous: ChunkRecord | undefined,
  incoming: ChunkRecord
): ChunkRecord {
  if (previous === undefined) return incoming;
  const records = readContentInvalidations(previous.metadata);
  if (records.length === 0) return incoming;
  return {
    ...incoming,
    valid_until: earlierValidityEnd(previous.valid_until, incoming.valid_until),
    metadata: {
      ...incoming.metadata,
      [CONTENT_INVALIDATIONS_METADATA_KEY]: records,
    },
  };
}

function earlierValidityEnd(
  current: string | null,
  incoming: string | null
): string | null {
  if (current === null) return incoming;
  if (incoming === null) return current;
  return Date.parse(current) <= Date.parse(incoming) ? current : incoming;
}

function closeValidityWindow(
  current: string | null,
  invalidatedAt: string
): string {
  if (current === null || Date.parse(invalidatedAt) < Date.parse(current)) {
    return invalidatedAt;
  }
  return current;
}

function sortInvalidationRecords(
  records: ContentInvalidationRecord[]
): ContentInvalidationRecord[] {
  return records.sort(
    (a, b) =>
      a.chunk_id.localeCompare(b.chunk_id) ||
      a.invalidated_at.localeCompare(b.invalidated_at) ||
      a.triggered_by.localeCompare(b.triggered_by)
  );
}

/** Project a stored chunk into the retrieve shape with a given score. */
function toRetrievedChunk(chunk: ChunkRecord, score: number): RetrievedChunk {
  return {
    id: chunk.id,
    content: chunk.content,
    source_ref: chunk.source_ref,
    valid_window: [chunk.valid_from, chunk.valid_until],
    score,
  };
}

/**
 * Resolve the status fields for an upsert, mirroring the pg upsert's
 * contract (corpus-ready retrieve T3). A caller that DECLARES a status
 * overwrites it and carries its `failure_code` with it (`null` on a
 * re-push clears a previous 失败). A caller that declares neither —
 * `ingest`, written before T3 — leaves the stored status alone rather
 * than downgrading a 就绪 资料 to 进行中 on an unrelated write.
 */
function carryStatus(
  existing: SourceDocRecord | undefined,
  doc: SourceDocRecord
): Pick<SourceDocRecord, "status" | "failure_code"> {
  if (doc.status !== undefined) {
    return { status: doc.status, failure_code: doc.failure_code ?? null };
  }
  const carried: Pick<SourceDocRecord, "status" | "failure_code"> = {};
  if (existing?.status !== undefined) carried.status = existing.status;
  if (existing?.failure_code !== undefined) {
    carried.failure_code = existing.failure_code;
  }
  return carried;
}

/**
 * Project a stored 资料 row into the read port view.
 *
 * `chunkCount` is passed in (derived by the caller from the chunk rows)
 * rather than stored on the record: a persisted counter could drift from
 * the rows it is supposed to count.
 */
function toSourceDocView(
  doc: SourceDocRecord,
  chunkCount: number
): StorageSourceDocView {
  return {
    id: doc.id,
    source_ref: doc.source_ref,
    title: doc.title,
    content: doc.content,
    created_at: doc.created_at,
    valid_until: doc.valid_until ?? null,
    collection: SOURCE_DOC_COLLECTION_NAME,
    status: doc.status ?? SOURCE_DOC_STATUS.IN_PROGRESS,
    failure_code: doc.failure_code ?? null,
    content_identity: doc.content_identity ?? null,
    chunk_count: chunkCount,
  };
}

/** List-row projection: no content body (on-demand list, operator-console T6). */
function toSourceDocSummary(
  doc: SourceDocRecord,
  chunkCount: number
): StorageSourceDocSummary {
  return {
    id: doc.id,
    source_ref: doc.source_ref,
    title: doc.title,
    created_at: doc.created_at,
    valid_until: doc.valid_until ?? null,
    collection: SOURCE_DOC_COLLECTION_NAME,
    status: doc.status ?? SOURCE_DOC_STATUS.IN_PROGRESS,
    failure_code: doc.failure_code ?? null,
    chunk_count: chunkCount,
  };
}
