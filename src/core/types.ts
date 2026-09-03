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
}

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
  upsert(chunks: ChunkRecord[]): Promise<string[]>; // returns chunk ids
  search(
    queryEmbedding: number[],
    opts: SearchOptions
  ): Promise<RetrievedChunk[]>;
  close(): Promise<void>;
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
