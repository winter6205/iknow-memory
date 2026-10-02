/**
 * Business-query failure matrix (fin:plans/post322-a2-sql-slice.md T5).
 *
 * The six classes of .claude/rules/test.md over the business-query seam, all
 * against a fake pool — no live database, and no document-index machinery.
 * The file's job is DISTINGUISHABILITY: one run must show six outcomes that
 * no two of which collapse into one, because a host that cannot tell them
 * apart tells the operator the wrong remedy.
 *
 * What is asserted here and nowhere else:
 *   - the lock-timeout class (SQLSTATE 55P03), which no test in either
 *     repository asserted before;
 *   - that a denial, a timeout, an unavailability, an empty result, an
 *     invalid request and an unverified claim are six DIFFERENT tokens;
 *   - that a request-level refusal opens no connection at all;
 *   - that every one of them names a token in the widened union, so each
 *     reaches the host as a structured `error` field rather than as prose.
 */
import { describe, expect, it } from "vitest";

import { failureTokenOf, GraphragError } from "../../src/core/errors.js";
import { BusinessQueryExecutor } from "../../src/core/business-query/sql-query-executor.js";
import {
  INVALID_BUSINESS_QUERY,
  RETRIEVE_UNAVAILABLE,
  SQL_AUTHORIZATION_UNVERIFIED,
  SQL_NO_MATCHING_ROWS,
  SQL_QUERY_DENIED,
  SQL_QUERY_TIMEOUT,
} from "../../src/core/business-query/sql-failure-tokens.js";
import type {
  BusinessLedgerConfig,
  ContractsExpiringParams,
  SqlPool,
  SqlPoolFactory,
} from "../../src/core/business-query/sql-query-types.js";

const PARAMS: ContractsExpiringParams = {
  windowStart: "2026-01-01",
  windowEnd: "2026-03-31",
  limit: 20,
};

const CONFIG: BusinessLedgerConfig = {
  connectionString: "postgresql://fin_sql_reader:secret@ledger.invalid/fin_business",
  authorizedScopes: ["ledger_ro.contract_expiry"],
};

/** A driver error as `pg` raises it: a message plus a SQLSTATE on `code`. */
class DriverError extends Error {
  constructor(
    message: string,
    readonly code?: string
  ) {
    super(message);
    this.name = "DriverError";
  }
}

interface Harness {
  executor: BusinessQueryExecutor;
  /** How many connections the module opened. A request-level refusal must
   *  leave this at zero. */
  opens: () => number;
}

function harness(
  respond: (text: string, values: unknown[]) => Promise<{ rows: unknown[] }>,
  config: BusinessLedgerConfig = CONFIG
): Harness {
  let opens = 0;
  const factory: SqlPoolFactory = () => {
    opens += 1;
    const pool: SqlPool = {
      query: respond,
      end: async () => undefined,
    };
    return pool;
  };
  return {
    executor: new BusinessQueryExecutor(config, { poolFactory: factory }),
    opens: () => opens,
  };
}

function oneRow(): unknown[] {
  return [
    {
      contract_id: "C-2291",
      title: "Warehouse logistics master agreement",
      counterparty: "Northwind Logistics",
      expiry_date: "2026-03-14",
      notice_by: "2026-02-12",
      total_amount: "480000.00",
      currency: "USD",
      owner_dept: "operations",
    },
  ];
}

async function failureOf(executor: BusinessQueryExecutor): Promise<unknown> {
  return executor
    .query({ template: "contracts_expiring", params: PARAMS })
    .then(
      (value) => value,
      (error: unknown) => error
    );
}

// --- 1. normal ------------------------------------------------------------

describe("normal", () => {
  it("answers a healthy window with rows, not a failure", async () => {
    const { executor } = harness(async () => ({ rows: oneRow() }));
    const result = await executor.query({
      template: "contracts_expiring",
      params: PARAMS,
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.record_key).toEqual({ contract_id: "C-2291" });
  });
});

// --- 2. failure -----------------------------------------------------------

describe("failure", () => {
  it("names a denial when the database refuses on privilege (42501)", async () => {
    const { executor } = harness(async () => {
      throw new DriverError(
        `permission denied for view contract_expiry`,
        "42501"
      );
    });
    const error = await failureOf(executor);
    expect(failureTokenOf(error)).toBe(SQL_QUERY_DENIED);
  });

  it("names a denial when the session is read-only and a write is attempted (25006)", async () => {
    // The executor only ever reads, so this SQLSTATE can only reach it from a
    // pool misconfiguration; it is classified anyway rather than leaking as
    // an unavailability, because "we checked, and the answer is no" is the
    // same product fact either way.
    const { executor } = harness(async () => {
      throw new DriverError(
        `cannot execute INSERT in a read-only transaction`,
        "25006"
      );
    });
    expect(failureTokenOf(await failureOf(executor))).toBe(SQL_QUERY_DENIED);
  });

  it("names an unavailability when the ledger does not answer", async () => {
    const { executor } = harness(async () => {
      throw new DriverError(`connect ECONNREFUSED 10.0.0.5:5432`, "ECONNREFUSED");
    });
    expect(failureTokenOf(await failureOf(executor))).toBe(RETRIEVE_UNAVAILABLE);
  });

  it("treats a driver error with no SQLSTATE as an unavailability, not a guess", async () => {
    // A permission fact may not be inferred from a message: only the
    // database's own code names one.
    const { executor } = harness(async () => {
      throw new DriverError(`permission denied for relation ledger_ro.contract_expiry`);
    });
    expect(failureTokenOf(await failureOf(executor))).toBe(RETRIEVE_UNAVAILABLE);
  });
});

// --- 3. boundary ----------------------------------------------------------

describe("boundary", () => {
  it("names a statement timeout (57014) distinctly from an unavailability", async () => {
    const { executor } = harness(async () => {
      throw new DriverError(`canceling statement due to statement timeout`, "57014");
    });
    // "A slow query on a healthy database is a different product fact with a
    // different fix": the operator narrows the window, not the connection.
    expect(failureTokenOf(await failureOf(executor))).toBe(SQL_QUERY_TIMEOUT);
  });

  it("names a LOCK timeout (55P03) distinctly from a statement timeout", async () => {
    // 55P03 has never been asserted anywhere in either repository. It is the
    // one class that would otherwise collapse into 57014, and the collapse
    // would tell an operator to narrow a window when the real fact is that
    // a writer held the row.
    const { executor } = harness(async () => {
      throw new DriverError(
        `canceling statement due to lock timeout`,
        "55P03"
      );
    });
    const error = await failureOf(executor);
    expect(failureTokenOf(error)).toBe(SQL_QUERY_TIMEOUT);
    expect(error).toBeInstanceOf(GraphragError);
    // Distinct from an unavailability, and it must not read as a dead ledger.
    expect(failureTokenOf(error)).not.toBe(RETRIEVE_UNAVAILABLE);
    expect((error as Error).message).toContain("55P03");
  });

  it("does not let a statement timeout become a denial", async () => {
    const { executor } = harness(async () => {
      throw new DriverError(`canceling statement due to statement timeout`, "57014");
    });
    expect(failureTokenOf(await failureOf(executor))).not.toBe(SQL_QUERY_DENIED);
  });

  it("refuses an unrecognized template without opening a connection", async () => {
    const { executor, opens } = harness(async () => ({ rows: oneRow() }));
    const error = await executor
      .query({ template: "drop_everything", params: PARAMS })
      .catch((caught: unknown) => caught);
    expect(failureTokenOf(error)).toBe(INVALID_BUSINESS_QUERY);
    expect(opens()).toBe(0);
  });

  it("refuses a bound-unsuitable window without opening a connection", async () => {
    const { executor, opens } = harness(async () => ({ rows: oneRow() }));
    const error = await executor
      .query({
        template: "contracts_expiring",
        params: { ...PARAMS, windowStart: "'; DROP TABLE ledger.contract; --" },
      })
      .catch((caught: unknown) => caught);
    expect(failureTokenOf(error)).toBe(INVALID_BUSINESS_QUERY);
    // No connection means no statement: the injection attempt is refused as
    // a malformed parameter, never forwarded to be parsed by the database.
    expect(opens()).toBe(0);
  });

  it("refuses an impossible calendar date as invalid_business_query, never as an outage", async () => {
    // `2024-13-45` and `2024-02-30` match the ISO digit shape but name no
    // calendar day. Bound, the template's date cast would raise SQLSTATE
    // 22007 and the classifier would publish `retrieve_unavailable` — a
    // client typo reported as an operator outage. The calendar round-trip
    // refuses them with the request token, and the pool is never built.
    for (const bad of [
      { ...PARAMS, windowStart: "2024-13-45", windowEnd: "2024-12-31" },
      { ...PARAMS, windowStart: "2024-01-01", windowEnd: "2024-02-30" },
    ]) {
      const { executor, opens } = harness(async () => ({ rows: oneRow() }));
      const error = await executor
        .query({ template: "contracts_expiring", params: bad })
        .catch((caught: unknown) => caught);
      expect(failureTokenOf(error)).toBe(INVALID_BUSINESS_QUERY);
      expect(failureTokenOf(error)).not.toBe(RETRIEVE_UNAVAILABLE);
      expect(opens()).toBe(0);
    }
  });
});

// --- 4. insufficient permissions ------------------------------------------

describe("insufficient permissions", () => {
  it("refuses a claim naming a scope this instance was not provisioned for", async () => {
    const { executor, opens } = harness(async () => ({ rows: oneRow() }));
    const error = await executor
      .query({
        template: "contracts_expiring",
        params: PARAMS,
        // Well-shaped data naming a scope the instance does not hold. The
        // threat is precisely that it looks legitimate.
        authorization: { scope: "ledger_ro.all_contracts" },
      })
      .catch((caught: unknown) => caught);
    // `unverified`, not `denied`: nobody checked this claim, so the answer
    // is not "no" — it is "we could not establish who sent it".
    expect(failureTokenOf(error)).toBe(SQL_AUTHORIZATION_UNVERIFIED);
    expect(failureTokenOf(error)).not.toBe(SQL_QUERY_DENIED);
    expect(opens()).toBe(0);
  });

  it("refuses an empty claim rather than treating it as absent", async () => {
    const { executor } = harness(async () => ({ rows: oneRow() }));
    const error = await executor
      .query({
        template: "contracts_expiring",
        params: PARAMS,
        authorization: { scope: "" },
      })
      .catch((caught: unknown) => caught);
    expect(failureTokenOf(error)).toBe(SQL_AUTHORIZATION_UNVERIFIED);
  });

  it("refuses a delivered claim even when it names a provisioned scope: v1 admits no claim", async () => {
    // Settled decision (fin spec §5.2): in v1 a request naming a scope is a
    // named failure — this build has nothing that verified a claim, so it
    // never vouches for one, matching scope included. Accepting a
    // provisioned-scope claim would make the forged-or-not difference hinge
    // on the very field the claim cannot be trusted to carry.
    const { executor, opens } = harness(async () => ({ rows: oneRow() }));
    const error = await executor
      .query({
        template: "contracts_expiring",
        params: PARAMS,
        authorization: { scope: "ledger_ro.contract_expiry" },
      })
      .catch((caught: unknown) => caught);
    expect(failureTokenOf(error)).toBe(SQL_AUTHORIZATION_UNVERIFIED);
    expect(opens()).toBe(0);
  });

  it("never widens to a default scope when a claim cannot be vouched for", async () => {
    // The failure mode the whole authorization design exists to prevent: a
    // refused claim quietly answering from the configured range.
    const { executor } = harness(async () => ({ rows: oneRow() }));
    const error = await executor
      .query({
        template: "contracts_expiring",
        params: PARAMS,
        authorization: { scope: "finance" },
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GraphragError);
    expect(failureTokenOf(error)).toBe(SQL_AUTHORIZATION_UNVERIFIED);
  });
});

// --- 5. empty or invalid input --------------------------------------------

describe("empty or invalid input", () => {
  it("names an empty result distinctly from a corpus that needs ingesting", async () => {
    const { executor } = harness(async () => ({ rows: [] }));
    const error = await failureOf(executor);
    expect(failureTokenOf(error)).toBe(SQL_NO_MATCHING_ROWS);
    expect(failureTokenOf(error)).not.toBe("corpus_not_ready");
  });

  it("refuses an empty template name without opening a connection", async () => {
    const { executor, opens } = harness(async () => ({ rows: oneRow() }));
    const error = await executor
      .query({ template: "", params: PARAMS })
      .catch((caught: unknown) => caught);
    expect(failureTokenOf(error)).toBe(INVALID_BUSINESS_QUERY);
    expect(opens()).toBe(0);
  });

  it("refuses a non-integer limit without opening a connection", async () => {
    const { executor, opens } = harness(async () => ({ rows: oneRow() }));
    const error = await executor
      .query({
        template: "contracts_expiring",
        params: { ...PARAMS, limit: 2.5 },
      })
      .catch((caught: unknown) => caught);
    expect(failureTokenOf(error)).toBe(INVALID_BUSINESS_QUERY);
    expect(opens()).toBe(0);
  });

  it("refuses an inverted window without opening a connection", async () => {
    const { executor, opens } = harness(async () => ({ rows: oneRow() }));
    const error = await executor
      .query({
        template: "contracts_expiring",
        params: { windowStart: "2026-03-31", windowEnd: "2026-01-01", limit: 20 },
      })
      .catch((caught: unknown) => caught);
    expect(failureTokenOf(error)).toBe(INVALID_BUSINESS_QUERY);
    expect(opens()).toBe(0);
  });
});

// --- 6. concurrent --------------------------------------------------------

describe("concurrent", () => {
  it("keeps a slow query from being reclassified by a concurrent denial", async () => {
    // Two in-flight queries against one pool: one 55P03, one 42501. Each
    // must keep its own classification — a shared "last error" would report
    // the lock as a permission denial.
    const responses: Array<() => Promise<{ rows: unknown[] }>> = [
      async () => {
        throw new DriverError(`canceling statement due to lock timeout`, "55P03");
      },
      async () => {
        throw new DriverError(`permission denied for view contract_expiry`, "42501");
      },
    ];
    let next = 0;
    const { executor } = harness(async () => {
      const respond = responses[next]!;
      next += 1;
      return respond();
    });
    const [a, b] = await Promise.all([failureOf(executor), failureOf(executor)]);
    const tokens = [failureTokenOf(a), failureTokenOf(b)];
    expect(tokens).toContain(SQL_QUERY_TIMEOUT);
    expect(tokens).toContain(SQL_QUERY_DENIED);
    // Both are timeouts-or-denials; neither degraded to the other or to an
    // unavailability.
    expect(tokens).not.toContain(RETRIEVE_UNAVAILABLE);
  });

  it("keeps concurrent empty results from turning into a shared error", async () => {
    const { executor } = harness(async () => ({ rows: [] }));
    const results = await Promise.all([
      failureOf(executor),
      failureOf(executor),
      failureOf(executor),
    ]);
    for (const result of results) {
      expect(failureTokenOf(result)).toBe(SQL_NO_MATCHING_ROWS);
    }
  });
});

// --- the vocabulary itself ------------------------------------------------

describe("the six outcomes are separately assertable", () => {
  it("gives every class its own token, and no two classes share one", async () => {
    const observed = new Map<string, string>();
    const cases: Array<[string, () => Promise<unknown>]> = [
      ["denied", async () =>
        failureOf(
          harness(async () => {
            throw new DriverError("permission denied", "42501");
          }).executor
        )],
      ["timeout", async () =>
        failureOf(
          harness(async () => {
            throw new DriverError("statement timeout", "57014");
          }).executor
        )],
      ["unavailable", async () =>
        failureOf(
          harness(async () => {
            throw new DriverError("ECONNREFUSED", "ECONNREFUSED");
          }).executor
        )],
      ["empty", async () => failureOf(harness(async () => ({ rows: [] })).executor)],
      ["invalid", async () =>
        new BusinessQueryExecutor(CONFIG)
          .query({ template: "nope", params: PARAMS })
          .catch((caught: unknown) => caught)],
      ["untrusted", async () =>
        new BusinessQueryExecutor(CONFIG)
          .query({
            template: "contracts_expiring",
            params: PARAMS,
            authorization: { scope: "forged" },
          })
          .catch((caught: unknown) => caught)],
    ];

    for (const [label, run] of cases) {
      const token = failureTokenOf(await run());
      expect(token, `${label} must name a token`).toBeDefined();
      expect(observed.get(token!), `${label} must not share a token`).toBeUndefined();
      observed.set(token!, label);
    }
    expect(observed.size).toBe(6);
  });

  it("keeps every token in the named-failure union, so none reaches the wire as prose", () => {
    // The union is the only read path a host has. A token outside it cannot
    // be declared, so a SQL failure would fall back to plain-text isError
    // and be classified as retrieve_unavailable by a message scan.
    for (const token of [
      SQL_QUERY_DENIED,
      SQL_QUERY_TIMEOUT,
      SQL_AUTHORIZATION_UNVERIFIED,
      SQL_NO_MATCHING_ROWS,
      INVALID_BUSINESS_QUERY,
      RETRIEVE_UNAVAILABLE,
    ]) {
      const declared: GraphragError = new GraphragError("probe", "STORAGE_ERROR", token);
      expect(failureTokenOf(declared)).toBe(token);
    }
  });
});
