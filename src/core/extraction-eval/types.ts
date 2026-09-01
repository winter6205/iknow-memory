/**
 * Extraction-eval domain types (specs/p0-eval.md T1).
 *
 * These pin the two frozen artifacts the extraction quality gate is
 * measured against: the chunk snapshot (the corpus the gold model read)
 * and the gold set (the triples it produced, each carrying provenance).
 *
 * Separate from `src/core/eval/*`, which is the retrieve P@5 harness: the
 * two capabilities share neither fixtures nor error taxonomy, and mixing
 * them would let a retrieve fixture mistake read as an extraction-F1
 * regression.
 */

/** Inclusive lower bound on snapshot size (A5, SC8). */
export const SNAPSHOT_MIN_CHUNKS = 10;
/** Inclusive upper bound on snapshot size (A5, SC8); growing it is Ask-first. */
export const SNAPSHOT_MAX_CHUNKS = 40;

/** One frozen chunk the gold model was shown. */
export interface SnapshotChunk {
  /** Stable id; gold provenance points at it. */
  id: string;
  /** Verbatim chunk text — the substring hallucination is checked against. */
  content: string;
  /** Where the text came from, so a frozen snapshot stays auditable. */
  source_ref: string;
}

/**
 * A frozen chunk snapshot. `id` is the ruler identity (A9): appending
 * chunks means a new id, not an edit in place.
 */
export interface ChunkSnapshot {
  id: string;
  chunks: SnapshotChunk[];
}

/** What the code filter decided about a triple the gold model proposed. */
export type FilterVerdict = "accept" | "reject";

/**
 * SC11 provenance. Every field is mandatory: without the model id and
 * prompt hash a triple cannot be attributed to a ruler, without the
 * chunk id it cannot be scored, without the raw output the filter
 * verdict cannot be re-derived, and without the verdict the triple's
 * presence in the file is unexplained.
 */
export interface GoldProvenance {
  model_id: string;
  prompt_hash: string;
  chunk_id: string;
  raw_output: string;
  filter_verdict: FilterVerdict;
  /** Filter reason when the verdict is a reject; free text at this layer. */
  filter_reason?: string;
  /** Sampling seed, recorded only when the gold API exposes one (A11). */
  seed?: number;
}

/** One gold triple: the pinned match fields plus its provenance. */
export interface GoldTriple {
  head: string;
  /** A vocabulary term or the UNMAPPED sentinel; never a raw surface form. */
  relation_norm: string;
  tail: string;
  /** Span the gold model cited; substring grounding is checked downstream. */
  evidence_span: string;
  confidence: number;
  provenance: GoldProvenance;
}

/**
 * A gold file. The header names the ruler (snapshot + gold model +
 * prompt hash); every triple must be stamped with the same ruler, which
 * is what makes a stale gold model's leftovers detectable.
 */
export interface GoldSet {
  snapshot_id: string;
  gold_model: string;
  prompt_hash: string;
  triples: GoldTriple[];
}
