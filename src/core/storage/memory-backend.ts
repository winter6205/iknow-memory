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
  RetrievedChunk,
  SearchOptions,
  StorageBackend,
} from "../types.js";
import type { LexicalStorageBackend } from "./backend.js";
import { cosineSimilarity } from "../cosine.js";
import { GraphragError } from "../errors.js";

/** Okapi BM25 term-frequency saturation. */
const BM25_K1 = 1.2;
/** Okapi BM25 length-normalization strength. */
const BM25_B = 0.75;

/**
 * Split text into lexical terms.
 *
 * Lowercase, then split on anything that is not a letter or digit. This
 * deliberately mirrors what Postgres' `simple` text-search config does on
 * the production side (case-folding and nothing else — no stemmer, no
 * stop-word list), so a query behaves the same shape in both backends
 * even though the scores differ.
 *
 * Unicode-aware via the `u` flag, so accented and CJK characters survive
 * tokenization. CJK still lands as one run per contiguous span because
 * there is no segmenter here — segmentation is explicitly out of scope
 * for this spec, and adding a naive one would silently change recall.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0);
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
export class MemoryBackend implements StorageBackend, LexicalStorageBackend {
  private readonly store = new Map<string, ChunkRecord>();

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
  async upsert(chunks: ChunkRecord[]): Promise<string[]> {
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
      this.store.set(chunk.id, chunk);
      this.reindex(chunk);
      ids.push(chunk.id);
    }
    return ids;
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
   * Okapi BM25 over the inverted index — the same contract
   * `PgvectorBackend.searchLexical` implements, so hybrid retrieval can be
   * exercised without Postgres.
   *
   * Unlike the Postgres side (which approximates with `ts_rank_cd`), this
   * is the real k1/b formula: the corpus is small and fully in memory, so
   * there is no reason to approximate. Scores are NOT comparable between
   * the two backends, which is fine — RRF fuses on rank.
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

    const terms = [...new Set(tokenize(query))];
    if (terms.length === 0) return [];

    const docCount = this.docs.size;
    if (docCount === 0) return [];
    const avgLength = this.totalLength / docCount;

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
        const norm =
          freq +
          BM25_K1 * (1 - BM25_B + (BM25_B * doc.length) / (avgLength || 1));
        scores.set(
          id,
          (scores.get(id) ?? 0) + (idf * (freq * (BM25_K1 + 1))) / norm
        );
      }
    }

    return [...scores.entries()]
      .sort((a, b) => (b[1] !== a[1] ? b[1] - a[1] : a[0] < b[0] ? -1 : 1))
      .slice(0, opts.limit)
      .map(([id, score]) => toRetrievedChunk(this.store.get(id)!, score));
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
