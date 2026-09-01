/**
 * Typed error taxonomy for the extraction-eval capability
 * (specs/p0-eval.md SC8, SC11).
 *
 * Deliberately separate from `core/errors.ts` (per-request MCP failures)
 * and from `core/eval/errors.ts` (retrieve P@5 fixtures): an extraction
 * gold fixture mistake must never read as a Host-facing tool failure or
 * as a retrieve regression.
 *
 * Every code names one way a frozen artifact can be wrong, and every
 * message names the offending file / chunk / triple — a fixture fault
 * that produced a plausible-looking F1 would be worse than no number.
 */

/** What was wrong with the frozen chunk snapshot. */
export type ChunkSnapshotErrorCode =
  /** Path does not exist / is not readable. */
  | "SNAPSHOT_FILE_MISSING"
  /** File exists but holds no content. */
  | "SNAPSHOT_FILE_EMPTY"
  /** Not JSON, or JSON of the wrong shape. */
  | "SNAPSHOT_MALFORMED"
  /** Well-formed but carries zero chunks. */
  | "SNAPSHOT_EMPTY"
  /** Chunk count outside the frozen 10–40 band (A5, SC8). */
  | "SNAPSHOT_SIZE_OUT_OF_RANGE"
  /** A chunk has no id, no text, or no source reference. */
  | "SNAPSHOT_CHUNK_INVALID"
  /** Two chunks share an id, so gold provenance would be ambiguous. */
  | "SNAPSHOT_DUPLICATE_CHUNK_ID";

export class ChunkSnapshotError extends Error {
  constructor(
    message: string,
    readonly code: ChunkSnapshotErrorCode
  ) {
    super(message);
    this.name = "ChunkSnapshotError";
  }
}

/** What was wrong with the gold set. */
export type ExtractionGoldErrorCode =
  | "GOLD_FILE_MISSING"
  | "GOLD_FILE_EMPTY"
  | "GOLD_MALFORMED"
  /** A triple field is absent, blank, or out of range. */
  | "GOLD_TRIPLE_INVALID"
  /** A mandatory SC11 provenance field is absent. */
  | "GOLD_PROVENANCE_MISSING"
  /** A provenance field is present but not a legal value. */
  | "GOLD_PROVENANCE_INVALID"
  /** A triple is stamped with a different model / prompt than the header. */
  | "GOLD_PROVENANCE_MISMATCH"
  /** The gold set was built against a different snapshot id. */
  | "GOLD_SNAPSHOT_MISMATCH"
  /** A triple cites a chunk the snapshot does not contain. */
  | "GOLD_CHUNK_UNKNOWN";

export class ExtractionGoldError extends Error {
  constructor(
    message: string,
    readonly code: ExtractionGoldErrorCode
  ) {
    super(message);
    this.name = "ExtractionGoldError";
  }
}
