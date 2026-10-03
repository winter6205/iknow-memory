/**
 * Typed error taxonomy for iknow-memory stage 1.
 *
 * Handlers throw GraphragError (never bare Error/string).
 * The registerOne catch in index.ts logs the code field, and serialises a
 * declared `failureToken` as the structured `error` field of the isError
 * result it hands the host.
 */
import {
  COMMUNITY_SUMMARY_INDEX_FAILURE,
  type EvidenceFailureToken,
} from "./types.js";

export type GraphragErrorCode =
  | "INVALID_INPUT" // Zod passed but semantically invalid (e.g. valid_from > valid_until)
  | "CONTENT_TOO_LARGE" // content exceeds MAX_CONTENT_BYTES (1MB)
  | "EMBEDDING_FAILED" // 9router /v1/embeddings call failed
  | "EMBEDDING_DIM_MISMATCH" // returned vector dimension !== configured dimensions
  | "STORAGE_ERROR"; // backend upsert/search underlying exception

/**
 * Named failures a host classifies deterministically. One vocabulary, anchored
 * on the constant the ledger and the arms already publish: `code` stays the
 * coarse internal category, `failureToken` is the public named fact.
 */
export type GraphragFailureToken =
  | typeof COMMUNITY_SUMMARY_INDEX_FAILURE
  | EvidenceFailureToken;

export class GraphragError extends Error {
  constructor(
    message: string,
    readonly code: GraphragErrorCode,
    readonly failureToken?: GraphragFailureToken
  ) {
    super(message);
    this.name = "GraphragError";
  }
}

/**
 * The named failure an error declares, if any. Classification reads this
 * field — never a substring of `message`, which is human-readable prose and
 * free to be reworded.
 */
export function failureTokenOf(
  error: unknown
): GraphragFailureToken | undefined {
  return error instanceof GraphragError ? error.failureToken : undefined;
}

/** Max content size for a single ingest call (1 MB). */
export const MAX_CONTENT_BYTES = 1_048_576;
