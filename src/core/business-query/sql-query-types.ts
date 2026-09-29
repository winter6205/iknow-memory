/**
 * The business-query module's public types and its limits (spec §6, §8).
 *
 * Independent of the document index by construction: nothing in this file
 * names a chunk, an embedding, a vector store, or a graph node. A ledger row
 * is not a document passage, so it does not borrow a passage's type.
 */
import type { GraphragFailureToken } from "../errors.js";

/**
 * Rows returned to the caller. Matches fin's `_LIMIT_CAP`, so no 档 ships a
 * 21st row — a SQL answer that outgrew the corpus answer's cap would be a
 * silent inconsistency between two 档 of the same entry point.
 */
export const SQL_MAX_ROWS = 20;

/**
 * Rows fetched from the database, one past the returned cap. The extra row
 * never reaches the caller; it exists so truncation is *observable*
 * (`truncated === true`) rather than silent. A read that returned exactly
 * `SQL_MAX_ROWS` is indistinguishable from a truncated one otherwise.
 */
export const SQL_FETCH_ROWS = SQL_MAX_ROWS + 1;

/**
 * Serialized envelope bytes, matching `read_source`'s budget. A row is
 * structured evidence, so the cap is enforced on the serialized result
 * rather than on a field count: one enormous `title` must not blow the
 * contract the other read path holds.
 */
export const SQL_MAX_RESULT_BYTES = 32_768;

/**
 * Per-statement budget. Must stay under the host's 5 s MCP timeout so the
 * *server* answers with a typed error rather than the host giving up on a
 * socket the database is still working on. Applied as a transaction-local
 * `SET LOCAL` rather than trusted to the role's `ALTER ROLE`, so an operator
 * who forgets the role-level setting still gets the server-side answer.
 */
export const SQL_STATEMENT_TIMEOUT_MS = 3_000;

/**
 * A read blocked behind a writer ends here instead of eating the statement
 * budget: the two facts have different remedies (retry vs. narrow), and
 * collapsing them would report a lock as a slow query.
 */
export const SQL_LOCK_TIMEOUT_MS = 1_000;

/**
 * Connect budget, below the statement budget so a dead host is reported as
 * unreachable rather than as a query that took too long.
 */
export const SQL_CONNECT_TIMEOUT_MS = 2_000;

/** Pool cap. The ledger is a single read-only role on one credential; a wide
 *  pool would only queue requests behind the connect budget. */
export const SQL_POOL_MAX = 4;

/**
 * The one permitted query, named. A request selects a template by name from
 * this closed set; the name never reaches the database and the window never
 * reaches the SQL text. Adding a query class means adding a member here.
 */
export const BUSINESS_QUERY_TEMPLATES = ["contracts_expiring"] as const;

export type BusinessQueryTemplate = (typeof BUSINESS_QUERY_TEMPLATES)[number];

/** True only for a member of the closed set (a fixed-list check, so an
 *  inherited `Object` member such as `toString` is never a template). */
export function isBusinessQueryTemplate(
  name: unknown
): name is BusinessQueryTemplate {
  return (
    typeof name === "string" &&
    (BUSINESS_QUERY_TEMPLATES as readonly string[]).includes(name)
  );
}

/**
 * The window and row cap one template is bound with. A named field, not a
 * positional array, so the executor's `$n` ordering is a property of one
 * place and a caller cannot transpose two dates.
 */
export interface ContractsExpiringParams {
  /** ISO `YYYY-MM-DD`; the inclusive start of the expiry window. */
  windowStart: string;
  /** ISO `YYYY-MM-DD`; the inclusive end. Must not precede the start. */
  windowEnd: string;
  /** The caller's requested row cap, clamped to `SQL_MAX_ROWS`. */
  limit: number;
}

/** Parameter values as they are bound — never interpolated into SQL text. */
export type BoundParams = readonly unknown[];

/**
 * The authorization claim as it arrives on the call. It names a SCOPE
 * (`ledger_ro.contract_expiry`), never a role: a caller that can put
 * arbitrary JSON on the wire can put `{"scope": "finance"}` on it, so a
 * claim is admissible only if it equals a scope this instance was
 * provisioned with. Anything else is refused rather than mapped.
 */
export interface SqlAuthorizationClaim {
  scope: string;
}

/**
 * The role the connection opens as. It comes from the instance's own
 * configuration, never from the request: the scope the reader can reach is
 * the scope the credential was granted, not a `WHERE` the application chose.
 */
export interface BusinessLedgerConfig {
  /** Read-only credential for the ledger. Never logged, never echoed. */
  connectionString: string;
  /** The scopes this instance is provisioned to answer, closed set. */
  authorizedScopes: readonly string[];
  /**
   * Accepted authorization claims. Empty — the default, and the only posture
   * this module ships — means the request may carry no claim at all, so there
   * is no scope field to forge. Populating it is the per-identity era.
   */
  trustedClaimKinds?: readonly string[];
}

/** The pool surface the executor uses, declared structurally so the module
 *  compiles with or without `pg` installed and so a fake drives it. */
export interface SqlPool {
  query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }>;
  end: () => Promise<void>;
}

export interface SqlPoolFactory {
  (config: {
    connectionString: string;
    max: number;
    connectionTimeoutMillis: number;
    /** Every session opens read-only: a belt-and-braces layer under the
     *  grants, and the only thing that refuses a `CREATE TEMP TABLE`. */
    options: string;
  }): SqlPool;
}

/** One row as the template returns it: canonical column name to value. */
export type SqlRow = Readonly<Record<string, unknown>>;

/**
 * A row carrying its own evidence (spec §8). It is a sibling of `chunks`,
 * not a member: the envelope's chunk shape requires a document `source_ref`
 * and a validity interval, and a ledger row has neither — fabricating them
 * would invent the identity the citation then claims.
 *
 * The field names are the spec §8 WIRE names (snake_case), not an internal
 * spelling: this object is serialized into the envelope verbatim, and fin
 * consumes exactly `{source, record_key, queried_at, fields, summary}`.
 * One shape, one authority — there is no second row type to translate to.
 */
export interface DatabaseRow {
  /** Which permitted view answered, so the read scope is auditable from the
   *  citation alone. */
  source: string;
  /** The row's own identity as a named-key mapping (`{"contract_id":
   *  "C-2291"}`), independent of its position in any text. */
  record_key: Readonly<Record<string, string>>;
  /** When the database answered. A ledger changes; a value with no time is a
   *  claim about a moving target. */
  queried_at: string;
  /** The values actually returned this round — the model may not invent one. */
  fields: Readonly<Record<string, unknown>>;
  /** One line for display; quotable but not synthesizable. */
  summary: string;
}

export interface BusinessQueryResult {
  /** The permitted view the rows came from. */
  source: string;
  /** At most `SQL_MAX_ROWS`; byte-budget may reduce this further. */
  rows: readonly DatabaseRow[];
  /** True when a row existed past the cap. Silent truncation is the failure
   *  this flag exists to prevent. */
  truncated: boolean;
  /** The window actually queried, echoed so an empty result can name it. */
  window: { start: string; end: string };
}

/** A SQL exit that has to be visible to the host. */
export interface SqlBusinessFailure {
  token: GraphragFailureToken;
  /** Human-readable, already credential-free. */
  message: string;
}
