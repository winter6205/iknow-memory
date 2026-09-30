/**
 * 档 D arm — the business-SQL path (plans/post322-a2-sql-slice.md T7;
 * specs/search-mode-business-sql-contract.md §5–§8).
 *
 * The arm is the row's wire home: a provisioned ledger answers
 * `{ chunks: [], database_rows: {schema, rows, result_count} }` (spec
 * §8.0 — a sibling envelope object, never a chunk, never a bare array), and the unprovisioned exit is the *typed, tokened*
 * `real_db_not_wired` (spec §7: after A2 it means "not provisioned" only,
 * never "refused"; §7.1: no SQL failure may be raised as an untokened
 * error, because an untokened failure serializes as prose and the host
 * cannot tell it from a dead server).
 *
 * What the arm owns, and what it deliberately does not:
 *   - selection is by NAME only, the one permitted template — a request
 *     cannot choose a statement, and user text never becomes SQL;
 *   - the window arrives from the dispatcher as the typed `sqlWindow`
 *     routing control and reaches the database as bound parameters or not
 *     at all; validation is the executor's single authority
 *     (`isBoundWindow`), so a malformed or absent window is refused
 *     `invalid_business_query` before a connection exists;
 *   - scope is never taken from the request (spec §5.2, v1): the reader
 *     role comes from this instance's configuration, the request carries
 *     no claim, and there is accordingly no claim for it to pass on.
 *
 * Imports stay on the leaf side (`wire-filters`, `errors`, business-query
 * module) exactly as mode-a/mode-c do, so `search-mode.ts` can import this
 * arm for the dispatch table without a runtime cycle.
 */
import type { SearchModeArm } from "./search-mode.js";
import { SEARCH_MODE_FILTER_KEY } from "./wire-filters.js";
import { GraphragError } from "../errors.js";
import { REAL_DB_NOT_WIRED } from "../business-query/sql-failure-tokens.js";
import type { BusinessQueryTemplate } from "../business-query/sql-query-types.js";

/** The one permitted query, named. A second query class means a second
 *  member here, not a request-selected template. */
const CONTRACTS_EXPIRING: BusinessQueryTemplate = "contracts_expiring";

/**
 * The stable host-mappable sentence for the not-provisioned exit. It keeps
 * the token in prose too (belt for hosts that scan text) while the DECLARED
 * token on the error is what serializes it as a structured `error` field.
 */
export function businessLedgerNotProvisionedMessage(): string {
  return (
    `retrieve ${SEARCH_MODE_FILTER_KEY}=sql cannot run: no business ledger ` +
    `is provisioned on this instance (${REAL_DB_NOT_WIRED}; document ` +
    `tables stay on 档 graph)`
  );
}

export const modeDBusinessSqlArm: SearchModeArm = async function assembleBusinessSql(
  args,
  deps
) {
  const executor = deps.businessQuery;
  if (executor === undefined) {
    // Code INVALID_INPUT mirrors the routing-time 400 class: the run never
    // starts, no storage is touched, so it is not a STORAGE_ERROR — the
    // same exit shape the pre-A2 stub kept, now with the token declared.
    throw new GraphragError(
      businessLedgerNotProvisionedMessage(),
      "INVALID_INPUT",
      REAL_DB_NOT_WIRED
    );
  }
  const result = await executor.query({
    template: CONTRACTS_EXPIRING,
    params: {
      windowStart: args.sqlWindow?.windowStart ?? "",
      windowEnd: args.sqlWindow?.windowEnd ?? "",
      limit: args.limit,
    },
  });
  // Empty `chunks` is honest here, not a degraded document answer: a
  // successful ledger read cites rows, and no document passage was or
  // could be retrieved on this route. The rows travel in the frozen
  // `fin.evidence.retrieve_rows.v1` envelope OBJECT (fin contract §4.4):
  // a bare array under this key is refused by fin ingress as
  // `database-rows-envelope-wrong-type`. `result_count` is this leg's
  // `rows.length`; truncation stays observable via the executor's own
  // `truncated` semantics, not a count mismatch.
  return {
    chunks: [],
    database_rows: {
      schema: "fin.evidence.retrieve_rows.v1",
      rows: result.rows,
      result_count: result.rows.length,
    },
  };
};
