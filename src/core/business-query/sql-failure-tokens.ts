/**
 * The named failures the business SQL path publishes on the wire.
 *
 * A leaf on purpose: `core/errors.ts` owns the `GraphragFailureToken` union
 * and `core/retrieval/search-mode.ts` imports `GraphragError` from it, so any
 * module that both declares a token and is imported by the union has to sit
 * below both. Nothing here imports anything.
 *
 * Every value is a `GraphragFailureToken` member. A SQL failure that reaches
 * the MCP boundary without one of them is published as plain-text `isError`
 * (src/index.ts), and the host then cannot tell a typed denial from a dead
 * server — both become `retrieve_unavailable`.
 */

/**
 * The database refused the read: 42501 (no grant on the requested object) or
 * 25006 (the transaction is read-only). "We checked, and the answer is no."
 */
export const SQL_QUERY_DENIED = "sql_query_denied" as const;

/**
 * The database stopped the statement: 57014 (statement_timeout) or 55P03
 * (lock_timeout, a read queued behind a writer). Kept distinct from an
 * unavailable database — a slow read on a healthy ledger is a different
 * product fact with a different fix (narrow the window), and collapsing the
 * two would tell an operator to check a connection that is working.
 */
export const SQL_QUERY_TIMEOUT = "sql_query_timeout" as const;

/**
 * The request carried an authorization claim this build cannot vouch for.
 * Distinct from `SQL_QUERY_DENIED`: denied means the grant says no, this
 * means the claim was never checked. A claim is refused, never mapped to a
 * default scope — a fallback here is the silent widening the whole
 * authorization design exists to prevent.
 */
export const SQL_AUTHORIZATION_UNVERIFIED = "sql_authorization_unverified" as const;

/**
 * The query ran correctly against a live database and matched no row. Not
 * `corpus_not_ready`: that exit advises ingesting documents, which is
 * factually wrong advice after a database miss.
 */
export const SQL_NO_MATCHING_ROWS = "sql_no_matching_rows" as const;

/**
 * The request could not be answered as the permitted query was written.
 * Two surfaces, shared by the remedy (change the request, not the ledger):
 *
 * - an unknown template name, or a window/limit the template cannot bind:
 *   refused before a connection is opened, so never a database fact.
 * - a row the database returned that does not fit the result byte budget:
 *   raised AFTER the database answered. The database is healthy and did
 *   exactly what was asked; the uncarryable fact is the request's. This is
 *   why the token does not become `sql_no_matching_rows` (a different fact)
 *   or `retrieve_unavailable` (a wrong remedy).
 *
 * Deferred rename (review M4): the oversized-row surface deserves its own
 * token, but the failure vocabulary is the seven-member cross-repo
 * agreement of fin:specs/search-mode-business-sql-contract.md §7.1, so
 * adding a member is gated on a fin-side spec revision, not on this module.
 */
export const INVALID_BUSINESS_QUERY = "invalid_business_query" as const;

/**
 * The ledger did not answer — refused connection, dead server, missing
 * database. Verbatim the host's existing code: a business database that is
 * down and an MCP server that is down are the same fact from the operator's
 * seat, and a second spelling would be a parallel scheme for one state.
 */
export const RETRIEVE_UNAVAILABLE = "retrieve_unavailable" as const;

/**
 * No business ledger is provisioned on this instance. After the A2 wire-in
 * this token means *not provisioned* ONLY — never "refused" (spec §7:
 * collapsing the two is the empty-vs-error conflation the port forbids).
 * It shares its name verbatim with fin's `named_failures.REAL_DB_NOT_WIRED`
 * so the host maps the code without a second translation table.
 */
export const REAL_DB_NOT_WIRED = "real_db_not_wired" as const;
