/**
 * The business-query executor (fin:specs/search-mode-business-sql-contract.md
 * §1.1, §5, §6, §7).
 *
 * iknow owns the credential, runs one named parameterized template, and lets
 * the database enforce the scope. This module is independent of the document
 * index: it imports no chunk, embedding, vector, or graph code, and its
 * result travels as a sibling of `chunks` rather than inside it.
 *
 * `pg` is imported lazily, on the first query, exactly as
 * `pgvector-backend.ts` does — a memory-mode install never loads the driver.
 * A pool may also be supplied directly, which is what makes the whole
 * failure surface drivable with a fake and no database.
 */
import { GraphragError } from "../errors.js";
import { redactPgDiagnostic } from "../storage/pg-diagnostics.js";
import {
  isBoundWindow,
  resolveTemplate,
  type BusinessQueryTemplateDefinition,
} from "./sql-query-templates.js";
import {
  INVALID_BUSINESS_QUERY,
  RETRIEVE_UNAVAILABLE,
  SQL_AUTHORIZATION_UNVERIFIED,
  SQL_NO_MATCHING_ROWS,
  SQL_QUERY_DENIED,
  SQL_QUERY_TIMEOUT,
} from "./sql-failure-tokens.js";
import {
  SQL_CONNECT_TIMEOUT_MS,
  SQL_FETCH_ROWS,
  SQL_LOCK_TIMEOUT_MS,
  SQL_MAX_RESULT_BYTES,
  SQL_MAX_ROWS,
  SQL_POOL_MAX,
  SQL_STATEMENT_TIMEOUT_MS,
  type BusinessLedgerConfig,
  type BusinessQueryResult,
  type ContractsExpiringParams,
  type DatabaseRow,
  type SqlAuthorizationClaim,
  type SqlPool,
  type SqlPoolFactory,
  type SqlRow,
} from "./sql-query-types.js";

/** PostgreSQL SQLSTATEs this module classifies. Named constants so the
 *  taxonomy is one table rather than a scatter of magic strings. */
const INSUFFICIENT_PRIVILEGE = "42501";
const READ_ONLY_TRANSACTION = "25006";
const QUERY_CANCELED = "57014";
const LOCK_NOT_AVAILABLE = "55P03";

export interface SqlQueryRequest {
  /** A member of the permitted set; anything else is refused unconnected. */
  template: string;
  params: ContractsExpiringParams;
  /** Present only when the caller supplies one. See the module note on
   *  `BusinessLedgerConfig.trustedClaimKinds`: v1 admits no claim at all. */
  authorization?: SqlAuthorizationClaim;
}

export interface SqlQueryExecutorDeps {
  /**
   * Build the pool. Defaults to a lazy `pg` import. Supplying one is the
   * only reason this module needs a database to be testable at all.
   */
  poolFactory?: SqlPoolFactory;
}

/**
 * Read the SQLSTATE off a driver error. `pg` sets `code`; a wrapped or
 * foreign driver may not, in which case the failure is an unavailability
 * rather than a guess at a permission fact.
 */
function sqlStateOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

export class SqlBusinessQueryError extends GraphragError {
  constructor(
    message: string,
    token:
      | typeof INVALID_BUSINESS_QUERY
      | typeof RETRIEVE_UNAVAILABLE
      | typeof SQL_AUTHORIZATION_UNVERIFIED
      | typeof SQL_NO_MATCHING_ROWS
      | typeof SQL_QUERY_DENIED
      | typeof SQL_QUERY_TIMEOUT,
    code: "INVALID_INPUT" | "STORAGE_ERROR" = "STORAGE_ERROR"
  ) {
    super(message, code, token);
    this.name = "SqlBusinessQueryError";
  }
}

/**
 * Format one row for display. Deliberately mechanical: the model may quote
 * this line, so every value in it came out of the result set this round.
 */
function summaryOf(
  recordKey: string,
  fields: Readonly<Record<string, unknown>>
): string {
  const parts = Object.entries(fields).map(
    ([key, value]) => `${key}=${value === null ? "" : String(value)}`
  );
  return `${recordKey} ${parts.join(", ")}`.trim();
}

/** Normalize a driver date into the ISO `YYYY-MM-DD` the evidence shape
 *  promises, so a `Date` (pg's default for `date`) and a `string` produce
 *  byte-identical evidence for the same ledger value.
 *
 *  Local components, NOT `toISOString()`: `pg` parses `date` and
 *  `timestamp without time zone` into a Date at local midnight, so
 *  `toISOString()` shifts the calendar day by the UTC offset and the ledger's
 *  `2026-02-12` would be cited as `2026-02-11` on any server east of
 *  Greenwich. The value is a business date, not an instant. */
function isoDate(value: unknown): unknown {
  if (!(value instanceof Date)) return value;
  const year = String(value.getFullYear()).padStart(4, "0");
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function projectRow(
  source: string,
  recordKeyColumn: string,
  fieldColumns: readonly string[],
  row: SqlRow,
  queriedAt: string
): DatabaseRow | undefined {
  const recordKey = row[recordKeyColumn];
  // A row with no key cannot be cited, so it cannot ship. The drop is
  // defense in depth, not a live branch: `contract_id` is the base table's
  // PRIMARY KEY and the view projects it directly
  // (fin:tests/retrieve/fixtures/ledger/001_schema.sql), so a real ledger
  // cannot produce a null key. If the view DDL ever relaxes that, this
  // drop site is where a matched-but-undisplayable row would surface —
  // pinned by the fake-pool tests, not by hope.
  if (recordKey === undefined || recordKey === null) return undefined;
  const fields: Record<string, unknown> = {};
  for (const column of fieldColumns) {
    const value = row[column];
    if (value !== undefined) fields[column] = isoDate(value);
  }
  const keyValue = String(recordKey);
  return {
    source,
    // The identity keeps its column name (spec §8): `{"contract_id":
    // "C-2291"}` traces to a record, and the citation never has to guess
    // which column was the key.
    record_key: { [recordKeyColumn]: keyValue },
    queried_at: queriedAt,
    fields,
    summary: summaryOf(keyValue, fields),
  };
}

/**
 * Drop trailing rows until the serialized result fits the byte budget, or
 * refuse. A `LIMIT` bounds the row COUNT; a business `title` is free text, so
 * the byte bound is the one that actually protects the wire.
 *
 * Refusing rather than returning zero rows follows `read_source`: an answer
 * with no row would read as a healthy miss (`sql_no_matching_rows`) when the
 * fact is that the row is too large to carry. A request that cannot be
 * answered inside the result contract is a request refusal, not an answer.
 * The token carries two surfaces — the agreement and the deferred dedicated
 * token are documented on `INVALID_BUSINESS_QUERY` itself.
 */
function fitToByteBudget(
  result: BusinessQueryResult,
  budget: number,
  template: string
): BusinessQueryResult {
  let rows = result.rows;
  while (
    rows.length > 0 &&
    Buffer.byteLength(JSON.stringify({ ...result, rows }), "utf8") > budget
  ) {
    rows = rows.slice(0, -1);
  }
  if (rows.length === result.rows.length) return result;
  if (rows.length === 0) {
    throw new SqlBusinessQueryError(
      `business query ${template} matched a row that exceeds the ` +
        `${budget}-byte result budget`,
      INVALID_BUSINESS_QUERY
    );
  }
  return { ...result, rows, truncated: true };
}

export class BusinessQueryExecutor {
  private pool: SqlPool | undefined;
  private initPromise: Promise<SqlPool> | undefined;

  constructor(
    private readonly config: BusinessLedgerConfig,
    private readonly deps: SqlQueryExecutorDeps = {}
  ) {}

  /**
   * Close the pool. The server owns the executor for its lifetime, so this
   * exists for CLIs and tests; an unclosed pool is the same leak the
   * pgvector backend's `close()` already guards.
   */
  async close(): Promise<void> {
    const pool = this.pool;
    this.pool = undefined;
    this.initPromise = undefined;
    if (pool !== undefined) await pool.end();
  }

  /**
   * Refuse a claim this instance cannot vouch for.
   *
   * v1 (fin spec §5.2): this build ships no verifier, so a request that
   * DELIVERS a claim is refused as `sql_authorization_unverified` even when
   * the named scope is provisioned — matching a scope the instance happens
   * to hold does not verify anything, since a forged claim would name
   * exactly that. A request with no claim passes: there is nothing to
   * vouch for, and scope enforcement is the credential and the view's.
   * The scope-comparison branches below only fire once `trustedClaimKinds`
   * is populated — the per-identity era. Nothing ever falls back to a
   * default scope; that would be the silent widening this model exists to
   * prevent. `sql_query_denied` stays reserved for the database's own no.
   */
  private assertAuthorization(request: SqlQueryRequest): void {
    const claim = request.authorization;
    const trustExpected = (this.config.trustedClaimKinds ?? []).length > 0;
    if (claim === undefined) {
      if (trustExpected) {
        // The per-identity era: this instance expects to be able to check a
        // claim, and an absent one means no verified identity. Refused, not
        // defaulted.
        throw new SqlBusinessQueryError(
          `business query arrived with no authorization claim to verify`,
          SQL_AUTHORIZATION_UNVERIFIED,
          "INVALID_INPUT"
        );
      }
      return;
    }
    if (!trustExpected) {
      throw new SqlBusinessQueryError(
        `business query named scope "${claim.scope}", but this build accepts ` +
          `no authorization claim (v1, spec §5.2)`,
        SQL_AUTHORIZATION_UNVERIFIED,
        "INVALID_INPUT"
      );
    }
    if (claim.scope === undefined || claim.scope === "") {
      throw new SqlBusinessQueryError(
        `business query carried an empty authorization scope`,
        SQL_AUTHORIZATION_UNVERIFIED,
        "INVALID_INPUT"
      );
    }
    if (!this.config.authorizedScopes.includes(claim.scope)) {
      throw new SqlBusinessQueryError(
        `business query claimed scope "${claim.scope}", which this instance is not provisioned for`,
        SQL_AUTHORIZATION_UNVERIFIED,
        "INVALID_INPUT"
      );
    }
  }

  /**
   * Run one permitted template. The order of the guards IS the contract:
   * claim, then template name, then parameter shape — all three are refusals
   * about the REQUEST, and all three are answered before a connection exists.
   * A recognized name with an unrecognized parameter never reaches the
   * database, so a malformed request cannot be used to probe it.
   */
  async query(request: SqlQueryRequest): Promise<BusinessQueryResult> {
    this.assertAuthorization(request);

    const resolved = resolveTemplate(request.template);
    if (resolved === undefined) {
      throw new SqlBusinessQueryError(
        `business query template "${request.template}" is not in the permitted set`,
        INVALID_BUSINESS_QUERY,
        "INVALID_INPUT"
      );
    }
    if (!isBoundWindow(request.params)) {
      throw new SqlBusinessQueryError(
        `business query ${request.template} received a window or limit it cannot bind`,
        INVALID_BUSINESS_QUERY,
        "INVALID_INPUT"
      );
    }
    const { sql, definition } = resolved;

    const limit = Math.min(request.params.limit, SQL_MAX_ROWS);
    const pool = await this.ensureReady();
    // Whole seconds only. The evidence contract's timestamp is
    // `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$`, and fin is forbidden from
    // normalizing a fractional value it receives — a millisecond here is a
    // refused envelope, not a rounded one. `queried_at` is an INSTANT, so
    // unlike `isoDate` above (a business calendar DATE, which must stay on
    // local components) UTC truncation is the correct frame. This is the one
    // mint site; `queriedAt` is threaded by reference, so truncating here
    // fixes every row on the page.
    const queriedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

    let fetched: SqlRow[];
    try {
      const result = await pool.query(sql, [
        request.params.windowStart,
        request.params.windowEnd,
        // One past the cap, so a full page is distinguishable from a
        // truncated one instead of looking identical. The executor is the
        // single bind site: `$n` order lives next to the template it
        // binds into, never in a second registry nobody calls.
        Math.min(limit + 1, SQL_FETCH_ROWS),
      ]);
      fetched = result.rows as SqlRow[];
    } catch (error) {
      throw this.classifyDriverFailure(error);
    }

    return fitToByteBudget(
      this.buildResult(request, definition, fetched, limit, queriedAt),
      SQL_MAX_RESULT_BYTES,
      request.template
    );
  }

  /**
   * Project fetched driver rows into the returned page: drop uncarryable
   * rows, name the miss, cut at the cap, and mark truncation from the
   * over-fetch. Kept separate from `query()` so the transport half (bind,
   * dial, classify) and the answer-shape half are each one job.
   */
  private buildResult(
    request: SqlQueryRequest,
    definition: BusinessQueryTemplateDefinition,
    fetched: SqlRow[],
    limit: number,
    queriedAt: string
  ): BusinessQueryResult {
    const projected: DatabaseRow[] = [];
    for (const row of fetched) {
      const record = projectRow(
        definition.source,
        definition.recordKeyColumn,
        definition.fieldColumns,
        row,
        queriedAt
      );
      if (record !== undefined) projected.push(record);
    }

    if (projected.length === 0) {
      throw new SqlBusinessQueryError(
        `business query ${request.template} matched no row in ` +
          `${definition.source} for ${request.params.windowStart}..` +
          `${request.params.windowEnd}`,
        SQL_NO_MATCHING_ROWS
      );
    }

    return {
      source: definition.source,
      rows: projected.slice(0, limit),
      // Only true when the over-fetch actually returned a row past the
      // cap — a page that ends at exactly the cap is complete, not trimmed.
      truncated: projected.length > limit,
      window: {
        start: request.params.windowStart,
        end: request.params.windowEnd,
      },
    };
  }

  /**
   * Map a driver failure onto the taxonomy. A denial and a timeout are
   * separate answers, and both are separate from an unavailability: the
   * operator's remedy differs in all three cases.
   */
  private classifyDriverFailure(error: unknown): GraphragError {
    const state = sqlStateOf(error);
    if (state === INSUFFICIENT_PRIVILEGE || state === READ_ONLY_TRANSACTION) {
      return new SqlBusinessQueryError(
        `business query refused by the database (SQLSTATE ${state})`,
        SQL_QUERY_DENIED
      );
    }
    if (state === QUERY_CANCELED || state === LOCK_NOT_AVAILABLE) {
      return new SqlBusinessQueryError(
        `business query exceeded its database time budget (SQLSTATE ${state})`,
        SQL_QUERY_TIMEOUT
      );
    }
    return new SqlBusinessQueryError(
      `business ledger unavailable: ${redactPgDiagnostic(error)}`,
      RETRIEVE_UNAVAILABLE
    );
  }

  /**
   * Lazily open the pool. A memoized promise so concurrent first queries
   * share one pool: the `??=` is synchronous, which the single-threaded event
   * loop makes atomic, and the driver is imported only when a query actually
   * dials the database.
   */
  private async ensureReady(): Promise<SqlPool> {
    if (this.pool !== undefined) return this.pool;
    if (this.initPromise !== undefined) {
      await this.initPromise;
      return this.pool!;
    }
    this.initPromise = (async () => {
      const factory = this.deps.poolFactory ?? (await loadPgPoolFactory());
      this.pool = factory({
        connectionString: this.config.connectionString,
        max: SQL_POOL_MAX,
        connectionTimeoutMillis: SQL_CONNECT_TIMEOUT_MS,
        // Session-local, so the budget belongs to this module rather than to
        // a role setting an operator may never have applied. The read-only
        // default is belt-and-braces under the grants: it is the only layer
        // that refuses a `CREATE TEMP TABLE`.
        options:
          `-c default_transaction_read_only=on` +
          ` -c statement_timeout=${SQL_STATEMENT_TIMEOUT_MS}` +
          ` -c lock_timeout=${SQL_LOCK_TIMEOUT_MS}` +
          ` -c idle_in_transaction_session_timeout=` +
          `${SQL_STATEMENT_TIMEOUT_MS * 2}`,
      });
      return this.pool;
    })();
    try {
      return await this.initPromise;
    } catch (error) {
      this.pool = undefined;
      this.initPromise = undefined;
      throw new SqlBusinessQueryError(
        `business ledger unavailable: ${redactPgDiagnostic(error)}`,
        RETRIEVE_UNAVAILABLE
      );
    }
  }
}

/**
 * The production pool factory, resolving `pg` on first use.
 *
 * `await import("pg")` rather than a top-level import, so importing this
 * module — and therefore the whole `sql` 档 arm — costs a memory-mode install
 * nothing. The same discipline as `pgvector-backend.ts`. A missing or
 * incompatible driver surfaces as a typed unavailability from the caller's
 * `ensureReady` catch, not as a `TypeError` at the query site.
 */
async function loadPgPoolFactory(): Promise<SqlPoolFactory> {
  const mod = (await import("pg")) as unknown as {
    Pool: new (config: {
      connectionString: string;
      max: number;
      connectionTimeoutMillis: number;
      options: string;
    }) => SqlPool;
  };
  if (typeof mod.Pool !== "function") {
    throw new Error(`pg module does not export a Pool constructor`);
  }
  return (config) => new mod.Pool(config);
}
