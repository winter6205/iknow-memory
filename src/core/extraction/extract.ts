/**
 * Extraction pipeline entry — one chunk → validated LLM call → classification.
 *
 * `extractChunk` is a single logical call: validate the chunk, invoke
 * `LLMClient.extract` once, and classify the outcome. It does NOT retry —
 * retry policy lives in llm-client.ts (T2: 5xx×3 / 4xx×1 / format×1 per #4 D4).
 *
 * Mark-and-continue is the CALLER's job (the T6 CLI orchestrator batches chunks
 * and records per-chunk status). extractChunk never throws on an LLM failure so
 * a single bad chunk cannot abort the batch — every failure is a sealed
 * `{kind:"failed"}` result, not an exception.
 *
 * The two defensive boundary hooks (empty / oversized) run BEFORE the LLM call:
 * an empty prompt is a wasted billable round-trip, and an over-context chunk is
 * a guaranteed overflow error. T8 exercises these negative/overflow classes.
 */
import type { LLMClient } from "./llm-client.js";
import type { ExtractionOutput, ExtractionResponse } from "./types.js";

/** Outcome of one chunk extraction. Sealed union — every branch handled. */
export type ExtractionOutcome =
  | { kind: "ok"; outputs: ExtractionOutput[] }
  | { kind: "failed"; errorCode: string; errorMsg: string };

/** Error code for an empty / whitespace-only chunk (defensive boundary). */
export const EMPTY_CHUNK_CODE = "EMPTY_CHUNK";
/** Error code for a chunk exceeding the LLM context window (overflow boundary). */
export const OVERSIZED_CHUNK_CODE = "OVERSIZED_CHUNK";
/** Error code for an LLM client that threw during extraction (exception boundary). */
export const LLM_EXCEPTION_CODE = "LLM_EXCEPTION";

/** Default content-length cap when the caller does not supply one. */
const DEFAULT_MAX_CONTENT_LENGTH = 100_000;

export interface ExtractChunkContext {
  llm: LLMClient;
  maxContentLength?: number;
}

export interface ChunkInput {
  id: string;
  content: string;
}

/**
 * Extract triples from one chunk, never throwing on an LLM-level failure.
 *
 * Validation (empty / oversized) is a pre-flight guard against a wasted LLM
 * round-trip; LLM failures are classified into their RetryClass error code so
 * the caller can record `extraction_records.status='failed'` and continue.
 */
export async function extractChunk(
  chunk: ChunkInput,
  ctx: ExtractChunkContext
): Promise<ExtractionOutcome> {
  const max = ctx.maxContentLength ?? DEFAULT_MAX_CONTENT_LENGTH;
  const validation = validateChunk(chunk, max);
  if (validation) return failed(validation.code, validation.msg);

  // T8 boundary-class fix: spec requires mark-and-continue; a throwing LLM
  // client must not abort the batch, so the call is wrapped and the throw
  // surfaces as a sealed failed outcome.
  let response: ExtractionResponse;
  try {
    response = await ctx.llm.extract(chunk.content);
  } catch (err) {
    return failed(LLM_EXCEPTION_CODE, errorMessage(err));
  }
  return classify(response);
}

function errorMessage(err: unknown): string {
  return (err as { message?: string })?.message ?? "unknown LLM error";
}

interface ValidationFailure {
  code: string;
  msg: string;
}

/** Empty / oversized guards, run before any LLM call. Null = valid. */
function validateChunk(
  chunk: ChunkInput,
  maxContentLength: number
): ValidationFailure | null {
  if (chunk.content.trim().length === 0) {
    return {
      code: EMPTY_CHUNK_CODE,
      msg: `chunk ${chunk.id} has empty content`,
    };
  }
  if (chunk.content.length > maxContentLength) {
    return {
      code: OVERSIZED_CHUNK_CODE,
      msg: `chunk ${chunk.id} content length ${chunk.content.length} exceeds max ${maxContentLength}`,
    };
  }
  return null;
}

/**
 * Map an LLM response to an outcome. `ok` carries outputs; every RetryClass
 * branch becomes a failed outcome bearing that class as its error code.
 *
 * The `ExtractionResponse` union overlaps on `kind: "ok"` (RetryClass includes
 * "ok" as a code slot), so the narrowing predicate is the presence of the
 * `outputs` field — the canonical success shape — not the `kind` literal.
 */
function classify(response: ExtractionResponse): ExtractionOutcome {
  if ("outputs" in response) {
    return { kind: "ok", outputs: response.outputs };
  }
  return failed(response.kind, response.message);
}

function failed(errorCode: string, errorMsg: string): ExtractionOutcome {
  return { kind: "failed", errorCode, errorMsg };
}
