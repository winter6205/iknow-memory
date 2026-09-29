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
  type BoundParams,
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
  /** Bind one request's parameters to `$1..$n`. Called with already
   *  validated values; must return exactly the template's placeholder count. */
  bind: (params: ContractsExpiringParams) => BoundParams;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

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
    bind: (params) => [params.windowStart, params.windowEnd, params.limit],
  },
};

export interface ResolvedTemplate {
  sql: string;
  definition: BusinessQueryTemplateDefinition;
}

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
 * A bound window is an ISO calendar date, a start that does not follow the
 * end, and a positive integer cap. Checked here rather than trusted: the
 * `::date` cast in the template turns a malformed value into a database
 * error, and a database error is a much worse place to learn that a date was
 * nonsense.
 */
export function isBoundWindow(params: ContractsExpiringParams): boolean {
  if (!ISO_DATE.test(params.windowStart)) return false;
  if (!ISO_DATE.test(params.windowEnd)) return false;
  if (params.windowEnd < params.windowStart) return false;
  if (!Number.isInteger(params.limit) || params.limit <= 0) return false;
  return true;
}
