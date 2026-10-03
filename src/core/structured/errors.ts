/**
 * The closed structured-query error vocabulary (specs/structured-corpus-query
 * "Typed errors").
 *
 * One vocabulary, partially populated: every code the SPEC defines is declared
 * here so a host can classify any structured refusal from structure alone, but
 * only the codes a given ticket is allowed to *throw* are thrown by it. QP4
 * (request validation) throws the first eight; execution tickets throw the
 * rest. A code that is declared but not yet reachable is deliberate — a closed
 * set with gaps beats two overlapping sets.
 *
 * Why a dedicated class instead of reusing `GraphragError`: a structured
 * refusal is not a legacy retrieve failure. It must not collapse into the
 * named-token `{ error, message }` shape (fin classifies those by SQL/natural
 * tokens) and must never be rendered as prose, so the server's tool adapter
 * needs a type it can recognise without matching a message string.
 */
export const STRUCTURED_ERROR_SCHEMA = "iknow.structured_error";

/** Envelope version. Tracked separately from the token, as ADR 0093 requires. */
export const STRUCTURED_ERROR_SCHEMA_VERSION = 1;

/**
 * The closed 18-code set. Declared as a string-literal union rather than
 * `string` so an unlisted code is a compile error at every throw site.
 */
export type StructuredErrorCode =
  | "malformed_structured_query"
  | "unsupported_structured_schema"
  | "unsupported_subject"
  | "unsupported_operation"
  | "unsupported_field"
  | "unsupported_operator"
  | "invalid_value"
  | "request_too_large"
  | "authorization_denied"
  | "invalid_cursor"
  | "cursor_expired"
  | "cursor_revision_mismatch"
  | "read_revision_mismatch"
  | "result_too_large"
  | "count_unavailable"
  | "query_timeout"
  | "structured_search_unavailable"
  | "maintenance_status_unavailable";

/**
 * Retryability is a property of the CODE, not of the call site: fin maps it
 * onto its own typed retrieve failures, so the same refusal must always answer
 * the same way. The four `yes` rows are the SPEC's transient exits; every
 * request-side refusal is the caller's to fix and retrying cannot help.
 */
export const STRUCTURED_ERROR_RETRYABLE: Readonly<
  Record<StructuredErrorCode, boolean>
> = {
  malformed_structured_query: false,
  unsupported_structured_schema: false,
  unsupported_subject: false,
  unsupported_operation: false,
  unsupported_field: false,
  unsupported_operator: false,
  invalid_value: false,
  request_too_large: false,
  authorization_denied: false,
  invalid_cursor: false,
  cursor_expired: false,
  cursor_revision_mismatch: false,
  read_revision_mismatch: false,
  result_too_large: false,
  count_unavailable: true,
  query_timeout: true,
  structured_search_unavailable: true,
  maintenance_status_unavailable: true,
};

/**
 * A structured refusal. `code` is the contract; `message` is human-facing
 * detail and must never be the thing a host parses.
 */
export class StructuredQueryError extends Error {
  constructor(
    message: string,
    readonly code: StructuredErrorCode
  ) {
    super(message);
    this.name = "StructuredQueryError";
  }
}

/** The wire shape a host parses; see the SPEC's `iknow.structured_error`. */
export interface StructuredErrorEnvelope {
  schema: typeof STRUCTURED_ERROR_SCHEMA;
  schema_version: typeof STRUCTURED_ERROR_SCHEMA_VERSION;
  error: { code: StructuredErrorCode; retryable: boolean };
}

/**
 * Serialize a refusal into the envelope. Built from the code alone, so no
 * path exists on which a structured failure reaches the wire as prose.
 */
export function structuredErrorEnvelope(
  error: StructuredQueryError
): StructuredErrorEnvelope {
  return {
    schema: STRUCTURED_ERROR_SCHEMA,
    schema_version: STRUCTURED_ERROR_SCHEMA_VERSION,
    error: {
      code: error.code,
      retryable: STRUCTURED_ERROR_RETRYABLE[error.code],
    },
  };
}
