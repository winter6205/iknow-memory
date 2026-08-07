/**
 * Extraction domain types (T2).
 *
 * The sealed tagged union `ExtractionResponse` is the contract between the
 * LLM client and the extraction pipeline (extract.ts). Every branch is a
 * `RetryClass`; the pipeline classifies per #4 D4 (5xx/network → 3 attempts,
 * 4xx → no retry, format → 1 retry) and marks-and-continues on failure.
 *
 * Why a sealed union rather than a class hierarchy: the consumer must handle
 * every outcome exhaustively — a rejected/errored chunk is a first-class
 * result, not a thrown exception, because mark-and-continue means the batch
 * proceeds when one chunk fails.
 */
import { GraphragError } from "../errors.js";

/** Classification of an extraction attempt's failure mode (or success). */
export type RetryClass = "ok" | "5xx" | "4xx" | "format";

/** A single fact triple produced by the LLM for one chunk. */
export interface ExtractionOutput {
  /** Entity surface form at the head of the triple. */
  head: string;
  /** Open string; the L1 type gate enforces consistency (not enumerated). */
  headType: string;
  /** Free-text relation as the LLM produced it (audit trail). */
  relationRaw: string;
  /** Vocabulary-normalized relation; may equal 'UNMAPPED'. */
  relationNorm: string;
  /** Entity surface form at the tail of the triple. */
  tail: string;
  tailType: string;
  /** MANDATORY per #6 Q1(b) — the LLM client validates it is non-empty. */
  description: string;
  /** Verbatim substring of the chunk content backing this triple. */
  evidenceSpan: string;
  /** Confidence in [0,1]. */
  confidence: number;
}

/**
 * Result of one `LLMClient.extract` call.
 *
 * `kind: "ok"` carries extracted triples; every other kind is a `RetryClass`
 * telling the pipeline how many more attempts are worth expending.
 */
export type ExtractionResponse =
  | { kind: "ok"; outputs: ExtractionOutput[] }
  | { kind: RetryClass; message: string };

/**
 * Chunk content is empty or whitespace-only. Raised before any LLM call —
 * an empty prompt is a wasted, billable round-trip and always a format error.
 * Codes back to errors.ts taxonomy (INVALID_INPUT).
 */
export class EmptyChunkError extends GraphragError {
  constructor(message: string) {
    super(message, "INVALID_INPUT");
    this.name = "EmptyChunkError";
  }
}

/**
 * Chunk content exceeds the LLM context window (overflow boundary class).
 * Codes CONTENT_TOO_LARGE so the pipeline can classify it into the 4xx
 * overflow family without re-reading the configured limit.
 */
export class OversizedChunkError extends GraphragError {
  constructor(message: string) {
    super(message, "CONTENT_TOO_LARGE");
    this.name = "OversizedChunkError";
  }
}

/**
 * The LLM returned content that failed to parse into `ExtractionResponse`
 * (bad JSON, missing fields, wrong shape). Distinguishable from a 5xx/4xx
 * because the transport succeeded — so the pipeline retries once (format
 * branch) rather than exhausting transport retries.
 */
export class ExtractionFormatError extends GraphragError {
  constructor(message: string) {
    super(message, "INVALID_INPUT");
    this.name = "ExtractionFormatError";
  }
}
