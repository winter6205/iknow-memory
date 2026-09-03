/**
 * Typed error taxonomy for the **evaluation** capability
 * (specs/retrieve-p5.md).
 *
 * Kept separate from `core/errors.ts` on purpose: a `GraphragError` is a
 * per-request failure of the MCP server, while these abort an offline
 * eval run. Mixing them would let an eval fixture mistake surface to a
 * Host as if the retrieve tool had failed.
 *
 * Every error carries a code and a message that names the offending
 * fixture / query, because the whole value of the harness is that a bad
 * baseline number is impossible to mistake for a good one.
 */

/** What was wrong with the gold fixture. */
export type GoldFixtureErrorCode =
  /** Path does not exist / is not readable. */
  | "GOLD_FILE_MISSING"
  /** File exists but holds no content. */
  | "GOLD_FILE_EMPTY"
  /** Not JSON, or JSON of the wrong shape. */
  | "GOLD_MALFORMED"
  /** Well-formed but carries zero queries. */
  | "GOLD_EMPTY"
  /** Query count outside the frozen 8–15 band (A8). */
  | "GOLD_SIZE_OUT_OF_RANGE"
  /** A query has no id / no text, or reuses another query's id. */
  | "GOLD_QUERY_INVALID"
  /** A query names no relevant chunk — R@5 would divide by zero. */
  | "GOLD_RELEVANT_EMPTY";

export class GoldFixtureError extends Error {
  constructor(
    message: string,
    readonly code: GoldFixtureErrorCode
  ) {
    super(message);
    this.name = "GoldFixtureError";
  }
}

/** What was wrong with the frozen seed corpus. */
export type CorpusFixtureErrorCode =
  | "CORPUS_FILE_MISSING"
  | "CORPUS_FILE_EMPTY"
  | "CORPUS_MALFORMED"
  | "CORPUS_EMPTY"
  | "CORPUS_CHUNK_INVALID"
  | "CORPUS_DUPLICATE_CHUNK_ID";

export class CorpusFixtureError extends Error {
  constructor(
    message: string,
    readonly code: CorpusFixtureErrorCode
  ) {
    super(message);
    this.name = "CorpusFixtureError";
  }
}

/**
 * A scoring step was asked for a number it cannot honestly produce —
 * currently only "average an empty list of scores". Returning NaN or 0
 * there would publish a baseline that looks like a measurement.
 */
export class EvalScoringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvalScoringError";
  }
}

/**
 * A step of the eval run itself failed: seeding the corpus, or the
 * retrieval assembler throwing on one gold query.
 *
 * The failing query is named in `queryId` (and in the message) because
 * an eval that fails halfway must say WHERE, and because the alternative
 * — recording an empty top-5 for that query and carrying on — would
 * publish a lower P@5 that looks like a retrieval regression.
 */
export class EvalRunError extends Error {
  constructor(
    message: string,
    readonly queryId?: string
  ) {
    super(message);
    this.name = "EvalRunError";
  }
}

/**
 * The baseline could not be persisted. Raised only after the temp file
 * has been cleaned up, so a failed write never leaves a half-written
 * baseline (or a stray temp file) where the previous one was.
 */
export class BaselineWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BaselineWriteError";
  }
}

/**
 * The ablation matrix builder or aggregation step produced an
 * unrecoverable value: an empty sample set, a non-finite metric, or a
 * missing baseline row. These are programming / fixture errors, not
 * retrieval failures, so they surface separately from `EvalRunError`.
 */
export class AblationMatrixError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AblationMatrixError";
  }
}
