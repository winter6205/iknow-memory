/**
 * The permitted query set (spec §5c, §2.3).
 *
 * Every statement is a static template literal with positional `$n`
 * parameters, selected by name from a closed set — the same discipline
 * `pgvector-backend.ts` follows for the document tables. User text reaches
 * the database as a bound value or not at all: there is no code path here
 * that concatenates a caller's string into SQL, and an unrecognized name is
 * refused before a connection exists.
 *
 * The window predicate lives in the VIEW (`status = 'active'`), not here. A
 * `WHERE` the application writes is policy; a grant is enforcement.
 */
import {
  isBusinessQueryTemplate,
  type BusinessQueryTemplate,
  type ContractsExpiringParams,
} from "./sql-query-types.js";

/**
 * The single query that answers "which contracts expire in this window, who
 * are the counterparties, and by when must we give notice".
 *
 * `notice_by` is computed by the view so no business date arithmetic
 * happens in the caller. The `LIMIT` is bound (`$3`), never formatted, and
 * the executor over-fetches by one to make truncation observable.
 */
export const CONTRACTS_EXPIRING_SQL = `
SELECT contract_id, title, counterparty, expiry_date, notice_by,
       total_amount, currency, owner_dept
  FROM ledger_ro.contract_expiry
 WHERE expiry_date BETWEEN $1::date AND $2::date
 ORDER BY expiry_date, contract_id
 LIMIT $3
`;

export interface BusinessQueryTemplateDefinition {
  /** The permitted view this template reads. Named per-row, so a citation
   *  states the read scope without the caller repeating it. */
  source: string;
  /** The column whose value is the row's own identity. */
  recordKeyColumn: string;
  /** Columns projected into a row's `fields`, in display order. */
  fieldColumns: readonly string[];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * True only for a real calendar day. The digit shape alone accepts
 * `2024-13-45`; parsed and re-serialized against UTC, that date is not.
 * `Date.UTC` maps years 0000-0099 into 1900-1999, so the round-trip also
 * refuses the pathological small years rather than binding them.
 */
function isCalendarDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year!, month! - 1, day!));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month! - 1 &&
    parsed.getUTCDate() === day
  );
}

/**
 * Templates keyed by name. The key IS the wire token: a value outside this
 * map has no statement to run, which is what makes the allowlist total
 * rather than advisory.
 */
export const BUSINESS_QUERY_TEMPLATE_REGISTRY: Readonly<
  Record<BusinessQueryTemplate, BusinessQueryTemplateDefinition>
> = {
  contracts_expiring: {
    source: "ledger_ro.contract_expiry",
    recordKeyColumn: "contract_id",
    fieldColumns: [
      "title",
      "counterparty",
      "expiry_date",
      "notice_by",
      "total_amount",
      "currency",
      "owner_dept",
    ],
  },
};

export interface ResolvedTemplate {
  sql: string;
  definition: BusinessQueryTemplateDefinition;
}

/**
 * The read surface this build can answer: the source view of every
 * permitted template. The provisioning layer derives the authorized
 * scope set from here, so "what the instance may answer" and "what the
 * executor can run" cannot drift into two lists.
 */
export const BUSINESS_LEDGER_AUTHORIZED_SCOPES: readonly string[] =
  Object.values(BUSINESS_QUERY_TEMPLATE_REGISTRY).map(
    (definition) => definition.source
  );

/**
 * The statement and projection for a recognized name, or undefined for
 * anything else. One lookup, so the allowlist cannot admit a name the
 * executor then fails to find a statement for (or the reverse).
 */
export function resolveTemplate(name: unknown): ResolvedTemplate | undefined {
  if (!isBusinessQueryTemplate(name)) return undefined;
  const definition = BUSINESS_QUERY_TEMPLATE_REGISTRY[name];
  if (name === "contracts_expiring") {
    return { sql: CONTRACTS_EXPIRING_SQL, definition };
  }
  return undefined;
}

/**
 * A bound window is a real ISO calendar date, a start that does not follow
 * the end, and a positive integer cap. Checked here rather than trusted:
 * the `::date` cast in the template turns a malformed value into a database
 * error, and a database error is a much worse place to learn that a date
 * was nonsense. The check is a calendar round-trip, not a digit shape,
 * because `2024-13-45` has the shape of a date but none of its meaning:
 * bound, it reaches the database as SQLSTATE 22007, which this module
 * classifies as an unavailability — a client typo published as an operator
 * outage, violating `invalid_business_query`'s own invariant.
 */
export function isBoundWindow(params: ContractsExpiringParams): boolean {
  if (!isCalendarDate(params.windowStart)) return false;
  if (!isCalendarDate(params.windowEnd)) return false;
  if (params.windowEnd < params.windowStart) return false;
  if (!Number.isInteger(params.limit) || params.limit <= 0) return false;
  return true;
}
