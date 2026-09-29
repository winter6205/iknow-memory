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
 * The request never reached the permitted query: an unknown template name, or
 * a window/limit the template cannot bind. Refused before a connection is
 * opened, so it is never a database fact.
 */
export const INVALID_BUSINESS_QUERY = "invalid_business_query" as const;

/**
 * The ledger did not answer — refused connection, dead server, missing
 * database. Verbatim the host's existing code: a business database that is
 * down and an MCP server that is down are the same fact from the operator's
 * seat, and a second spelling would be a parallel scheme for one state.
 */
export const RETRIEVE_UNAVAILABLE = "retrieve_unavailable" as const;
