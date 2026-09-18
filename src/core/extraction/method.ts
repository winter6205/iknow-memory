/**
 * Extract-method dispatch — the version spine of T1
 * (plans/graph-index-standard-fast.md).
 *
 * One 资料 version carries EXACTLY ONE extract method (spec assumption 3):
 * `standard` (LLM extraction) or `fast` (NLP co-occurrence, implemented by
 * T4). `runExtractMethod` is the single dispatch seam: `standard` delegates
 * to the existing `extractChunk` path; `fast` is SEALED until T4 and fails
 * with the typed FAST_EXTRACT_UNIMPLEMENTED code instead of dialing the LLM.
 *
 * The version columns ride the `source_documents` ledger (SoR):
 * `findChunkMethodConflict` is the pre-flight guard — it runs BEFORE any LLM
 * round-trip so a conflicting request never spends a billable call;
 * `recordChunkExtractMethod` claims the method for the 资料 row once a chunk
 * persisted, and its UPDATE is overwrite-guarded: a conflicting recorded
 * method can never be silently replaced.
 */
import { GraphragError } from "../errors.js";
import { EXTRACT_METHODS, type ExtractMethod } from "../types.js";
import type { Queryable } from "./records.js";
import {
  extractChunk,
  type ChunkInput,
  type ExtractChunkContext,
  type ExtractionOutcome,
} from "./extract.js";

/** Error code for the sealed fast method (typed, never bare). */
export const FAST_EXTRACT_UNIMPLEMENTED_CODE = "FAST_EXTRACT_UNIMPLEMENTED";
/** Error code for a method that conflicts with the version's recorded method. */
export const EXTRACT_METHOD_CONFLICT_CODE = "EXTRACT_METHOD_CONFLICT";

/** Runtime vocabulary guard for values that bypassed the TS type. */
export function isExtractMethod(value: unknown): value is ExtractMethod {
  return (
    typeof value === "string" &&
    (EXTRACT_METHODS as readonly string[]).includes(value)
  );
}

/** Typed failure for a method value outside the {standard, fast} vocabulary. */
export class InvalidExtractMethodError extends GraphragError {
  constructor(raw: string) {
    super(
      `unknown extract method "${raw}": expected ${EXTRACT_METHODS.join(
        " or "
      )}`,
      "INVALID_INPUT"
    );
    this.name = "InvalidExtractMethodError";
  }
}

/** Narrow an operator-supplied string to a method or throw typed. */
export function parseExtractMethod(raw: string): ExtractMethod {
  if (isExtractMethod(raw)) return raw;
  throw new InvalidExtractMethodError(raw);
}

/**
 * Dispatch one chunk through its version's extract method.
 *
 * `fast` is a sealed FAILED outcome (mark-and-continue stays the caller's
 * contract, and the code lands in extraction_records for operators) — it
 * returns before `ctx` is ever touched, so the LLM cannot be dialed.
 * A value outside the vocabulary is a caller-contract violation, not a
 * chunk outcome: it throws `InvalidExtractMethodError`.
 */
export async function runExtractMethod(
  method: ExtractMethod,
  chunk: ChunkInput,
  ctx: ExtractChunkContext
): Promise<ExtractionOutcome> {
  if (!isExtractMethod(method)) {
    throw new InvalidExtractMethodError(String(method));
  }
  if (method === "standard") return extractChunk(chunk, ctx);
  return {
    kind: "failed",
    errorCode: FAST_EXTRACT_UNIMPLEMENTED_CODE,
    errorMsg:
      "fast extraction is sealed until plan ticket T4 (NLP co-occurrence); " +
      "the standard method is the only runnable extract method",
  };
}

/** A 资料 row whose recorded method differs from the requested one. */
export interface MethodConflict {
  sourceRef: string;
  /** The method recorded on the version (a vocabulary member or junk). */
  recorded: string;
}

/**
 * Pre-flight conflict check: does the chunk's 资料 row record a DIFFERENT
 * method? Returns null when there is no 资料 row, the column is still NULL,
 * or the recorded method equals the request.
 *
 * The row must carry BOTH `source_ref` and a non-empty `extract_method` to
 * count as a conflict: several test fakes answer any `FROM chunks` SELECT
 * with chunk-shaped rows, and a row without the column is store noise, not
 * a version claim. A recorded value that IS present travels verbatim —
 * even one outside the vocabulary, because a version holding it can safely
 * be re-extracted by no method.
 */
export async function findChunkMethodConflict(
  client: Queryable,
  chunkId: string,
  method: ExtractMethod
): Promise<MethodConflict | null> {
  // `chunks t` (not the scan queries' `chunks c`) on purpose: fake stores and
  // existing tests key their row routing off the `FROM chunks c` shape.
  const { rows } = await client.query(
    `SELECT sd.source_ref, sd.extract_method
       FROM source_documents sd
      WHERE EXISTS (
              SELECT 1 FROM chunks t
               WHERE t.id = $1 AND t.source_ref = sd.source_ref
            )
        AND sd.extract_method IS NOT NULL
        AND sd.extract_method <> $2`,
    [chunkId, method]
  );
  const row = rows[0] as
    { source_ref?: unknown; extract_method?: unknown } | undefined;
  if (
    row === undefined ||
    typeof row.source_ref !== "string" ||
    typeof row.extract_method !== "string" ||
    row.extract_method.length === 0
  ) {
    return null;
  }
  return { sourceRef: row.source_ref, recorded: row.extract_method };
}

/**
 * Record `method` as the producer of the chunk's 资料 version. Runs inside
 * the chunk transaction so a rolled-back chunk never leaves metadata behind,
 * and the WHERE guard makes it (a) idempotent for the same method and
 * (b) incapable of overwriting a conflicting recorded method — the conflict
 * leg above is the only path a differing method can take.
 */
export async function recordChunkExtractMethod(
  client: Queryable,
  chunkId: string,
  method: ExtractMethod
): Promise<void> {
  await client.query(
    `UPDATE source_documents
        SET extract_method = $2
      WHERE source_ref = (SELECT t.source_ref FROM chunks t WHERE t.id = $1)
        AND (extract_method IS NULL OR extract_method = $2)`,
    [chunkId, method]
  );
}
