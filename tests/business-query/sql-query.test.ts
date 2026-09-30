/**
 * Business-query module contract tests (fin:plans/post322-a2-sql-slice.md T4).
 *
 * Drivable with a fake pool and no database: the module takes its pool from a
 * factory, so every assertion here is about the module's own behaviour —
 * which statement it sends, which values it binds, what it projects, and what
 * it refuses. The live-database run against the synthetic ledger is a
 * separate opt-in suite and is NOT what this file stands in for.
 *
 * Expected values are the literals written in the committed fixture
 * (fin:tests/retrieve/fixtures/ledger/002_seed.sql), not values read back from a
 * database, so a broken seed cannot make these pass vacuously.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { failureTokenOf } from "../../src/core/errors.js";
import {
  BusinessQueryExecutor,
  SqlBusinessQueryError,
} from "../../src/core/business-query/sql-query-executor.js";
import {
  CONTRACTS_EXPIRING_SQL,
  isBoundWindow,
  resolveTemplate,
} from "../../src/core/business-query/sql-query-templates.js";
import {
  BUSINESS_QUERY_TEMPLATES,
  SQL_FETCH_ROWS,
  SQL_LOCK_TIMEOUT_MS,
  SQL_MAX_RESULT_BYTES,
  SQL_MAX_ROWS,
  SQL_POOL_MAX,
  SQL_STATEMENT_TIMEOUT_MS,
  isBusinessQueryTemplate,
  type BusinessLedgerConfig,
  type SqlPool,
  type SqlPoolFactory,
} from "../../src/core/business-query/sql-query-types.js";
import { INVALID_BUSINESS_QUERY, SQL_NO_MATCHING_ROWS } from "../../src/core/business-query/sql-failure-tokens.js";

/** Never a real credential: the module must never echo it, and a test that
 *  asserts that needs a string it can look for. */
const CREDENTIAL = "postgresql://fin_sql_reader:hunter2@ledger.invalid/fin_business";

const CONFIG: BusinessLedgerConfig = {
  connectionString: CREDENTIAL,
  authorizedScopes: ["ledger_ro.contract_expiry"],
};

interface RecordedQuery {
  text: string;
  values: unknown[];
  options: string;
  connectionString: string;
  max: number;
  connectionTimeoutMillis: number;
}

/** A fake pool that records every statement and answers from a fixture row
 *  set. Records the connection options too, so the session-level read-only
 *  and timeout posture is asserted rather than assumed. */
function fakePool(rows: unknown[]): {
  pool: SqlPool;
  calls: RecordedQuery[];
  factory: SqlPoolFactory;
} {
  const calls: RecordedQuery[] = [];
  const factory: SqlPoolFactory = (config) => {
    calls.push({
      text: "",
      values: [],
      options: config.options,
      connectionString: config.connectionString,
      max: config.max,
      connectionTimeoutMillis: config.connectionTimeoutMillis,
    });
    return {
      query: async (text, values = []) => {
        const last = calls[calls.length - 1];
        last.text = text;
        last.values = values;
        return { rows };
      },
      end: async () => undefined,
    };
  };
  return {
    pool: { query: async () => ({ rows }), end: async () => undefined },
    calls,
    factory,
  };
}

function executorWith(
  rows: unknown[],
  config: BusinessLedgerConfig = CONFIG
): { executor: BusinessQueryExecutor; calls: RecordedQuery[] } {
  const { calls, factory } = fakePool(rows);
  return { executor: new BusinessQueryExecutor(config, { poolFactory: factory }), calls };
}

/** The canonical seeded row (002_seed.sql, contract C-2291). Dates arrive as
 *  `Date` because that is what `pg` returns for a `date` column; the module
 *  must normalize them. */
const C_2291 = {
  contract_id: "C-2291",
  title: "Warehouse logistics master agreement",
  counterparty: "Northwind Logistics",
  expiry_date: new Date("2026-03-14T00:00:00.000Z"),
  notice_by: new Date("2026-02-12T00:00:00.000Z"),
  total_amount: "480000.00",
  currency: "USD",
  owner_dept: "operations",
};

const WINDOW = { windowStart: "2026-01-01", windowEnd: "2026-03-31", limit: 20 };

describe("driver date normalization", () => {
  /**
   * `pg` parses a `date` column (1082) and the `timestamp without time zone`
   * the view derives `notice_by` as (1114) into a Date at LOCAL midnight, so
   * on a server east of Greenwich `toISOString()` renders the previous
   * calendar day. That would put a wrong date in a citation, which is the
   * one thing the record_key/fields evidence contract exists to prevent.
   */
  function inTimeZone<T>(zone: string, run: () => T): T {
    const previous = process.env.TZ;
    process.env.TZ = zone;
    try {
      return run();
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  }

  /** The Dates a driver hands back for the seeded contract's two dates. */
  function driverDates(): Record<string, Date> {
    return {
      expiry_date: new Date(2026, 2, 14), // 2026-03-14 local midnight
      notice_by: new Date(2026, 1, 12), // 2026-02-12 local midnight
    };
  }

  for (const zone of ["UTC", "Asia/Shanghai", "America/Los_Angeles"]) {
    it(`cites the ledger's calendar day, not the UTC day, in ${zone}`, async () => {
      // The row is built INSIDE the zone, because that is where the driver
      // would parse it: `pg` reads 2026-03-14 into a Date at local midnight
      // of whatever zone the server runs in. Building the Date in a
      // different zone would test the harness, not the executor.
      const result = await inTimeZone(zone, async () => {
        const { executor } = executorWith([{ ...C_2291, ...driverDates() }]);
        return executor.query({ template: "contracts_expiring", params: WINDOW });
      });
      expect(result.rows[0]?.fields.expiry_date).toBe("2026-03-14");
      expect(result.rows[0]?.fields.notice_by).toBe("2026-02-12");
    });
  }
});

describe("module independence and the lazy driver", () => {
  const source = (name: string): string =>
    readFileSync(
      fileURLToPath(
        new URL(`../../src/core/business-query/${name}`, import.meta.url)
      ),
      "utf8"
    );

  it("imports nothing from the document index, the vector store, or the graph", () => {
    // Structural, not incidental: the module is independent of the document
    // index by construction, so a later import that couples it to chunks or
    // embeddings fails here rather than in a review. Matched against the
    // import SPECIFIERS, not the whole text, so a comment may still explain
    // the boundary in prose.
    for (const name of [
      "sql-query-executor.ts",
      "sql-query-templates.ts",
      "sql-query-types.ts",
    ]) {
      const specifiers = [
        ...source(name).matchAll(/from\s+"([^"]+)"/g),
        ...source(name).matchAll(/import\("([^"]+)"\)/g),
      ].map((match) => match[1]!);
      expect(specifiers.length, `${name} should import something`).toBeGreaterThan(0);
      for (const specifier of specifiers) {
        for (const forbidden of [
          "pgvector-backend",
          "memory-backend",
          "neo4j",
          "elasticsearch",
          "embedder",
          "query-builder",
          "rrf",
          "rerank",
          "retrieval/",
        ]) {
          expect(specifier, `${name} must not import ${forbidden}`).not.toContain(
            forbidden
          );
        }
      }
    }
  });

  it("keeps the token vocabulary a zero-import leaf, so the union has no cycle", () => {
    // errors.ts imports this file to widen GraphragFailureToken, and
    // search-mode.ts imports errors.ts. Any import back into the tree closes
    // that cycle, so the leaf property is the constraint, not a style choice.
    const text = source("sql-failure-tokens.ts");
    expect([...text.matchAll(/from\s+"([^"]+)"/g)]).toHaveLength(0);
    expect([...text.matchAll(/import\("([^"]+)"\)/g)]).toHaveLength(0);
  });

  it("loads `pg` only at first use, so a memory-mode install never pays for it", () => {
    const text = source("sql-query-executor.ts");
    // Same discipline as pgvector-backend.ts: a static import would make
    // every consumer of the module depend on the driver.
    expect(text).toContain('await import("pg")');
    expect(text).not.toMatch(/^\s*import\s[^;]*["']pg["']/m);
  });
});

describe("the permitted query set", () => {
  it("holds exactly one template, and the registry has a row for each name", () => {
    expect([...BUSINESS_QUERY_TEMPLATES]).toEqual(["contracts_expiring"]);
  });

  it("sends user values only as bound parameters, never as SQL text", () => {
    // The structural property, asserted on the statement itself: the window
    // and the limit appear as placeholders, so no caller's date can become
    // syntax. There is no concatenation site to test at runtime.
    expect(CONTRACTS_EXPIRING_SQL).toContain("$1::date");
    expect(CONTRACTS_EXPIRING_SQL).toContain("$2::date");
    expect(CONTRACTS_EXPIRING_SQL).toContain("LIMIT $3");
    expect(CONTRACTS_EXPIRING_SQL).not.toMatch(/2026-\d{2}-\d{2}/);
  });

  it("reads the permitted view, so the scope is the view's predicate", () => {
    expect(CONTRACTS_EXPIRING_SQL).toContain("FROM ledger_ro.contract_expiry");
    // The active-only scope is the view's, not a WHERE written here: a WHERE
    // the application chooses is policy, not enforcement.
    expect(CONTRACTS_EXPIRING_SQL).not.toContain("status");
  });

  it("orders by expiry so the cap takes the soonest contracts", () => {
    expect(CONTRACTS_EXPIRING_SQL).toContain("ORDER BY expiry_date");
  });

  it("refuses every name outside the closed set, including Object members", () => {
    for (const name of [
      "",
      "contracts",
      "CONTRACTS_EXPIRING",
      "toString",
      "constructor",
      "__proto__",
      "1",
    ]) {
      expect(resolveTemplate(name)).toBeUndefined();
      expect(isBusinessQueryTemplate(name)).toBe(false);
    }
  });

  it("resolves the one name the set contains", () => {
    const resolved = resolveTemplate("contracts_expiring");
    expect(resolved?.sql).toBe(CONTRACTS_EXPIRING_SQL);
    expect(resolved?.definition.source).toBe("ledger_ro.contract_expiry");
    expect(resolved?.definition.recordKeyColumn).toBe("contract_id");
  });
});

describe("window and limit binding", () => {
  it("accepts an inclusive ISO window and a positive integer cap", () => {
    expect(isBoundWindow(WINDOW)).toBe(true);
    expect(isBoundWindow({ ...WINDOW, windowStart: WINDOW.windowEnd })).toBe(true);
  });

  it("refuses a malformed date, an inverted window, and a non-positive cap", () => {
    for (const bad of [
      { ...WINDOW, windowStart: "2026-3-1" },
      { ...WINDOW, windowStart: "" },
      { ...WINDOW, windowStart: "2026-01-01T00:00:00Z" },
      { ...WINDOW, windowEnd: "not-a-date" },
      { ...WINDOW, windowStart: "2026-04-01" },
      { ...WINDOW, limit: 0 },
      { ...WINDOW, limit: -1 },
      { ...WINDOW, limit: 1.5 },
      { ...WINDOW, limit: Number.NaN },
    ]) {
      expect(isBoundWindow(bad)).toBe(false);
    }
  });

  it("refuses an impossible calendar date that matches the ISO shape", () => {
    // The digit shape alone accepts `2024-13-45`. If it were bound, the
    // template's `$n::date` cast would reject it in the database (SQLSTATE
    // 22007) and classifyDriverFailure would publish `retrieve_unavailable`
    // — a client typo reported as an operator outage, violating the token's
    // own invariant. Only a calendar round-trip refuses it here.
    expect(isBoundWindow({ ...WINDOW, windowStart: "2024-13-45" })).toBe(false);
    expect(isBoundWindow({ ...WINDOW, windowEnd: "2024-02-30" })).toBe(false);
    expect(isBoundWindow({ ...WINDOW, windowStart: "2023-02-29" })).toBe(false);
    // A leap day exists in a leap year: the validator refuses the impossible
    // date, not the valid one shaped like it.
    expect(isBoundWindow({ ...WINDOW, windowStart: "2024-02-29" })).toBe(true);
  });
});

describe("a normal query", () => {
  it("binds the window and the capped limit, and sends the one permitted statement", async () => {
    const { executor, calls } = executorWith([C_2291]);
    await executor.query({ template: "contracts_expiring", params: WINDOW });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toBe(CONTRACTS_EXPIRING_SQL);
    expect(calls[0]?.values).toEqual([
      "2026-01-01",
      "2026-03-31",
      SQL_FETCH_ROWS,
    ]);
  });

  it("projects a row into evidence carrying its own identity and its own time", async () => {
    const { executor } = executorWith([C_2291]);
    const result = await executor.query({
      template: "contracts_expiring",
      params: WINDOW,
    });

    expect(result.source).toBe("ledger_ro.contract_expiry");
    expect(result.truncated).toBe(false);
    expect(result.window).toEqual({ start: "2026-01-01", end: "2026-03-31" });
    expect(result.rows).toHaveLength(1);

    const row = result.rows[0]!;
    expect(row.source).toBe("ledger_ro.contract_expiry");
    // Spec §8 wire shape: the row's identity is a named-key mapping, so a
    // citation traces to a record without inventing a document locator.
    expect(row.record_key).toEqual({ contract_id: "C-2291" });
    // The values are the ones the fixture DDL writes, not what a model said.
    expect(row.fields).toEqual({
      title: "Warehouse logistics master agreement",
      counterparty: "Northwind Logistics",
      expiry_date: "2026-03-14",
      notice_by: "2026-02-12",
      total_amount: "480000.00",
      currency: "USD",
      owner_dept: "operations",
    });
    expect(row.queried_at).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    expect(row.summary).toContain("C-2291");
    expect(row.summary).toContain("Northwind Logistics");
  });

  it("omits a column the query did not project rather than inventing it", async () => {
    const { executor } = executorWith([{ ...C_2291, source_system: undefined }]);
    const result = await executor.query({
      template: "contracts_expiring",
      params: WINDOW,
    });
    expect(result.rows[0]?.fields).not.toHaveProperty("source_system");
  });

  it("normalizes a driver date and a plain string to the same evidence", async () => {
    const asString = { ...C_2291, expiry_date: "2026-03-14", notice_by: "2026-02-12" };
    const fromDate = executorWith([C_2291]);
    const fromString = executorWith([asString]);
    const a = await fromDate.executor.query({ template: "contracts_expiring", params: WINDOW });
    const b = await fromString.executor.query({ template: "contracts_expiring", params: WINDOW });
    // `queried_at` legitimately differs between two calls; everything else
    // must be identical or a citation's identity would depend on driver
    // configuration rather than on the ledger.
    expect(b.rows[0]?.fields).toEqual(a.rows[0]?.fields);
  });
});

describe("the connection posture", () => {
  it("refuses an impossible calendar date with no pool touched", async () => {
    // The shape-only check let `2024-13-45` reach the `::date` cast, where
    // SQLSTATE 22007 surfaced as `retrieve_unavailable` — an operator outage
    // reported for a client typo. The calendar round-trip must refuse it
    // before a pool is constructed (spec §5c: request refusals open nothing).
    for (const bad of [
      { ...WINDOW, windowStart: "2024-13-45", windowEnd: "2024-12-31" },
      { ...WINDOW, windowStart: "2024-01-01", windowEnd: "2024-02-30" },
    ]) {
      const { executor, calls } = executorWith([C_2291]);
      const error = (await executor
        .query({ template: "contracts_expiring", params: bad })
        .catch((caught: unknown) => caught)) as Error;
      expect(failureTokenOf(error)).toBe(INVALID_BUSINESS_QUERY);
      expect(calls).toHaveLength(0);
    }
  });


  it("opens the pool as the configured reader credential, never a claim's role", async () => {
    const { executor, calls } = executorWith([C_2291]);
    await executor.query({ template: "contracts_expiring", params: WINDOW });
    expect(calls[0]?.connectionString).toBe(CREDENTIAL);
  });

  it("requests a read-only session with the spec's time budgets", async () => {
    const { executor, calls } = executorWith([C_2291]);
    await executor.query({ template: "contracts_expiring", params: WINDOW });
    const options = calls[0]?.options ?? "";
    expect(options).toContain("default_transaction_read_only=on");
    expect(options).toContain(`statement_timeout=${SQL_STATEMENT_TIMEOUT_MS}`);
    expect(options).toContain(`lock_timeout=${SQL_LOCK_TIMEOUT_MS}`);
    expect(calls[0]?.max).toBe(SQL_POOL_MAX);
  });

  it("holds the spec's limits: 20 returned, 21 fetched", () => {
    expect(SQL_MAX_ROWS).toBe(20);
    expect(SQL_FETCH_ROWS).toBe(21);
  });

  it("shares one pool across concurrent first queries", async () => {
    // The pool is memoized behind a promise; two concurrent first calls must
    // not each construct one, or every concurrent retrieve leaks a pool.
    let constructed = 0;
    const factory: SqlPoolFactory = () => {
      constructed += 1;
      return {
        query: async () => ({ rows: [C_2291] }),
        end: async () => undefined,
      };
    };
    const executor = new BusinessQueryExecutor(CONFIG, { poolFactory: factory });
    await Promise.all([
      executor.query({ template: "contracts_expiring", params: WINDOW }),
      executor.query({ template: "contracts_expiring", params: WINDOW }),
      executor.query({ template: "contracts_expiring", params: WINDOW }),
    ]);
    expect(constructed).toBe(1);
  });

  it("never echoes the credential in a refusal", async () => {
    const factory: SqlPoolFactory = () => {
      throw new Error(`connect ECONNREFUSED for ${CREDENTIAL}`);
    };
    const executor = new BusinessQueryExecutor(CONFIG, { poolFactory: factory });
    const error = (await executor
      .query({ template: "contracts_expiring", params: WINDOW })
      .catch((caught: unknown) => caught)) as Error;
    expect(error.message).not.toContain("hunter2");
    expect(error.message).not.toContain("fin_sql_reader@");
  });
});

describe("row truncation", () => {
  function rows(n: number): unknown[] {
    return Array.from({ length: n }, (_unused, i) => ({
      ...C_2291,
      contract_id: `C-${String(i).padStart(4, "0")}`,
    }));
  }

  it("returns at most the cap and marks the result truncated", async () => {
    const { executor } = executorWith(rows(SQL_FETCH_ROWS));
    const result = await executor.query({
      template: "contracts_expiring",
      params: WINDOW,
    });
    expect(result.rows).toHaveLength(SQL_MAX_ROWS);
    expect(result.truncated).toBe(true);
  });

  it("does not mark a result truncated when the page is exactly full", async () => {
    // The one-past-the-cap fetch exists precisely so these two are
    // distinguishable; without it a full page would look truncated.
    const { executor } = executorWith(rows(SQL_MAX_ROWS));
    const result = await executor.query({
      template: "contracts_expiring",
      params: WINDOW,
    });
    expect(result.rows).toHaveLength(SQL_MAX_ROWS);
    expect(result.truncated).toBe(false);
  });

  it("clamps a caller cap above the tier cap rather than raising it", async () => {
    const { executor, calls } = executorWith(rows(SQL_FETCH_ROWS));
    const result = await executor.query({
      template: "contracts_expiring",
      params: { ...WINDOW, limit: 500 },
    });
    expect(result.rows.length).toBeLessThanOrEqual(SQL_MAX_ROWS);
    expect(calls[0]?.values[2]).toBe(SQL_FETCH_ROWS);
  });

  it("keeps the serialized result inside the result byte budget", async () => {
    const wide = Array.from({ length: SQL_FETCH_ROWS }, (_u, i) => ({
      ...C_2291,
      contract_id: `C-${i}`,
      title: "x".repeat(4_000),
    }));
    const { executor } = executorWith(wide);
    const result = await executor.query({
      template: "contracts_expiring",
      params: WINDOW,
    });
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(
      SQL_MAX_RESULT_BYTES
    );
    expect(result.rows.length).toBeGreaterThan(0);
  });

  it("refuses rather than reporting a healthy miss when no row fits the budget", async () => {
    const { executor } = executorWith([
      { ...C_2291, title: "x".repeat(SQL_MAX_RESULT_BYTES * 2) },
    ]);
    const error = (await executor
      .query({ template: "contracts_expiring", params: WINDOW })
      .catch((caught: unknown) => caught)) as Error;
    // Zero rows after fitting would read as `sql_no_matching_rows`, which
    // names a different product fact than an uncarryable row.
    expect(failureTokenOf(error)).toBe(INVALID_BUSINESS_QUERY);
    expect(failureTokenOf(error)).not.toBe(SQL_NO_MATCHING_ROWS);
  });
});

describe("an empty result", () => {
  it("names the database, the window, and the absence — never ingest advice", async () => {
    const { executor } = executorWith([]);
    const error = (await executor
      .query({ template: "contracts_expiring", params: WINDOW })
      .catch((caught: unknown) => caught)) as SqlBusinessQueryError;
    expect(failureTokenOf(error)).toBe(SQL_NO_MATCHING_ROWS);
    expect(error.message).toContain("ledger_ro.contract_expiry");
    expect(error.message).toContain("2026-01-01");
    expect(error.message).toContain("2026-03-31");
    for (const forbidden of ["ingest", "corpus", "document", "add documents"]) {
      expect(error.message.toLowerCase()).not.toContain(forbidden);
    }
  });

  it("is not the corpus advice token the document 档 uses", () => {
    // `corpus_not_ready` is correct for a document miss and factually wrong
    // advice after a database miss; the two must not collapse.
    expect(SQL_NO_MATCHING_ROWS).not.toBe("corpus_not_ready");
  });

  it("treats a row with no record key as uncarryable rather than a healthy hit", async () => {
    // Documents the all-dropped path: the view's PRIMARY KEY makes a null
    // key unproducible from a real ledger, so the only way to reach this
    // branch is an off-contract driver row. The fake pool drives it here so
    // the exit is pinned, not incidental.
    const { executor } = executorWith([{ ...C_2291, contract_id: null }]);
    const error = (await executor
      .query({ template: "contracts_expiring", params: WINDOW })
      .catch((caught: unknown) => caught)) as Error;
    expect(failureTokenOf(error)).toBe(SQL_NO_MATCHING_ROWS);
  });

  it("drops a keyless row but keeps the rest of the page", async () => {
    const { executor } = executorWith([
      { ...C_2291, contract_id: null },
      C_2291,
    ]);
    const result = await executor.query({
      template: "contracts_expiring",
      params: WINDOW,
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.record_key).toEqual({ contract_id: "C-2291" });
  });
});
