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
  /**
   * Producer provenance written to `triples.extractor`. The LLM path leaves
   * it absent (persist defaults to 'llm'); the fast NLP path (T4) tags its
   * co-occurrence edges 'fast' so the ledger records which method produced
   * the row.
   */
  extractor?: string;
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

// ─── T3 (graph-index-standard-fast): standard post-merge enrichment ──────

/**
 * One merge survivor's per-output description as produced by an
 * `ExtractionOutput` endpoint — the input unit of the post-merge describe
 * step (ADR 0069) and the entity anchor of a claim (ADR 0071). Produced by
 * `persistOutputs` AFTER the canonical merge, so `entityId` is always the
 * survivor row's id, never a merged-away loser.
 */
export interface SurvivorRef {
  entityId: string;
  canonicalName: string;
  description: string;
}

/** One entity whose merged description list is summarized into one string. */
export interface EntityDescribeTarget {
  canonicalName: string;
  /** The survivor's stored summary first (when present), then this run's new descriptions. */
  descriptions: string[];
}

/** Input to the per-chunk batched describe call. */
export interface DescribeInput {
  entities: EntityDescribeTarget[];
}

/** One summarized description returned for one entity. */
export interface EntityDescriptionDraft {
  canonicalName: string;
  description: string;
}

/**
 * Sealed outcome of one describe call (ADR 0069): a failure skips the leg —
 * it never throws and never fails the chunk or the C job. `errorCode` is a
 * transport `RetryClass` ("5xx" / "4xx" / "format") or `LLM_EXCEPTION_CODE`
 * when the client itself threw.
 */
export type DescribeResponse =
  | { kind: "ok"; descriptions: EntityDescriptionDraft[] }
  | { kind: "failed"; errorCode: string; errorMsg: string };

/** Input to the per-chunk claim-extract call (ADR 0071). */
export interface ClaimsInput {
  chunkText: string;
  /** Canonical names of this chunk's merge survivors — a claim must anchor on one. */
  entities: string[];
}

/** One time-bounded assertion as emitted by the LLM. */
export interface ClaimOutput {
  /** Entity surface form; matched to a survivor name by the pipeline. */
  entity: string;
  claim: string;
  /** ISO-8601 date string or null; unparseable values collapse to null. */
  validFrom: string | null;
  validTo: string | null;
  confidence: number;
  evidenceSpan: string;
}

/** Sealed outcome of one claims call — same failure posture as describe. */
export type ClaimsResponse =
  | { kind: "ok"; claims: ClaimOutput[] }
  | { kind: "failed"; errorCode: string; errorMsg: string };

// ─── Grounded judge before persist ─────────────────────────────────────────

/** Input to the per-chunk groundedness judge: chunk text + proposed triples. */
export interface JudgeInput {
  chunkText: string;
  candidates: ExtractionOutput[];
}

/**
 * The judge's answer for ONE candidate: `index` is the candidate's position
 * in `JudgeInput.candidates`; `grounded` is the yes/no; `reason` explains the
 * verdict. The wire schema requires it on both yes and no (JudgeItemSchema
 * in llm-client.ts), so a sealed record always carries the model's wording.
 */
export interface TripleVerdict {
  index: number;
  grounded: boolean;
  reason: string;
}

/**
 * Sealed outcome of one judge call. `failed` covers transport/format/throw
 * misses at the adapter boundary — the judge gate in judge.ts converts them
 * (and adapter absence) into the chunk-level JUDGE_DOWN failure.
 */
export type JudgeResponse =
  | { kind: "ok"; verdicts: TripleVerdict[] }
  | { kind: "failed"; errorCode: string; errorMsg: string };

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
