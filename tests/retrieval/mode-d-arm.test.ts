/**
 * 档 D (sql) arm contract tests — plans/post322-a2-sql-slice.md T7.
 *
 * The arm is the row's wire home: a provisioned ledger answers
 * `{ chunks: [], database_rows: [...] }` (spec §8.0 — a sibling key, never
 * a chunk), and an unprovisioned one answers the structured
 * `real_db_not_wired` exit (spec §7: after A2 the token means *not
 * provisioned* only). Driven with a fake pool through the real executor,
 * so every assertion is about the arm's own behaviour and no database is
 * required. Expected row values are the literals of the committed fixture
 * `tests/retrieve/fixtures/ledger/002_seed.sql` (contract C-2291).
 */
import { describe, expect, it } from "vitest";
import { createRetrieveHandler } from "../../src/tools/retrieve.js";
import { FakeEmbedder } from "../../src/core/embedder.js";
import type { EmbeddingClient } from "../../src/core/embedder.js";
import { MemoryBackend } from "../../src/core/storage/memory-backend.js";
import { GraphragError, failureTokenOf } from "../../src/core/errors.js";
import type { StorageBackend } from "../../src/core/types.js";
import type { ToolResult } from "../../src/tools/registry.js";
import {
  INVALID_BUSINESS_QUERY,
  REAL_DB_NOT_WIRED,
} from "../../src/core/business-query/sql-failure-tokens.js";
import { BusinessQueryExecutor } from "../../src/core/business-query/sql-query-executor.js";
import { CONTRACTS_EXPIRING_SQL } from "../../src/core/business-query/sql-query-templates.js";
import type {
  BusinessLedgerConfig,
  SqlPool,
  SqlPoolFactory,
} from "../../src/core/business-query/sql-query-types.js";

const TEST_DIM = 8;

const CONFIG: BusinessLedgerConfig = {
  connectionString:
    "postgresql://fin_sql_reader:unused-test-secret@ledger.invalid/fin_business",
  authorizedScopes: ["ledger_ro.contract_expiry"],
};

/** The canonical seeded row (002_seed.sql, contract C-2291), shaped as `pg`
 *  returns it: `date` columns arrive as Date. */
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

interface SentQuery {
  text: string;
  values: unknown[];
}

/** Executor over a recording fake pool — the arm runs without a database. */
function executorWith(rows: unknown[]): {
  executor: BusinessQueryExecutor;
  sent: SentQuery[];
} {
  const sent: SentQuery[] = [];
  const factory: SqlPoolFactory = () => ({
    query: async (text: string, values: unknown[] = []) => {
      sent.push({ text, values });
      return { rows };
    },
    end: async () => undefined,
  });
  return { executor: new BusinessQueryExecutor(CONFIG, { poolFactory: factory }), sent };
}

function unitEmbedding(): number[] {
  const v = new Array<number>(TEST_DIM).fill(0);
  v[0] = 1;
  return v;
}

class CountingEmbedder implements EmbeddingClient {
  readonly available = true;
  calls = 0;
  constructor(private readonly inner: EmbeddingClient) {}
  async embed(texts: string[]): Promise<number[][]> {
    this.calls += 1;
    return this.inner.embed(texts);
  }
}

function storageProbe(target: StorageBackend): {
  storage: StorageBackend;
  touched: string[];
} {
  const touched: string[] = [];
  const storage = new Proxy(target, {
    get(obj, prop, receiver) {
      if (typeof prop === "string") touched.push(prop);
      const value = Reflect.get(obj, prop, receiver);
      return typeof value === "function" ? value.bind(obj) : value;
    },
  });
  return { storage, touched };
}

/**
 * The frozen ingress envelope (fin enterprise-evidence-contract.md §4.4):
 * `database_rows` is an OBJECT `{schema, rows, result_count}` — the bare
 * array this arm shipped pre-envelope is refused by fin ingress as
 * `database-rows-envelope-wrong-type`.
 */
interface RetrieveRowsEnvelopeBody {
  schema: string;
  rows: Array<Record<string, unknown>>;
  result_count: number;
}

function parseBody(result: ToolResult): {
  chunks: unknown[];
  database_rows?: RetrieveRowsEnvelopeBody;
} {
  const text = result.content[0]?.text;
  if (typeof text !== "string") {
    throw new Error("expected text content in ToolResult");
  }
  return JSON.parse(text);
}

const WINDOW_FILTERS = {
  search_mode: "sql",
  sql_window_start: "2026-01-01",
  sql_window_end: "2026-03-31",
};

describe("mode-d arm — provisioned ledger", () => {
  it("answers with an empty chunks list and the rows as the sibling key", async () => {
    const { executor } = executorWith([C_2291]);
    const handler = createRetrieveHandler({
      embedder: new FakeEmbedder(TEST_DIM),
      storage: new MemoryBackend(TEST_DIM),
      businessQuery: executor,
    });
    const body = parseBody(
      await handler({ query: "which contracts expire", filters: WINDOW_FILTERS })
    );
    expect(body.chunks).toEqual([]);
    // The sibling key is the envelope OBJECT, never a bare array (§4.4).
    expect(Array.isArray(body.database_rows)).toBe(false);
    expect(body.database_rows!.schema).toBe("fin.evidence.retrieve_rows.v1");
    expect(body.database_rows!.rows).toHaveLength(1);
    expect(body.database_rows!.result_count).toBe(1);
    const row = body.database_rows!.rows[0]!;
    // Spec §8 shape, snake_case on the wire: the row carries its own
    // identity and its own time, not a fabricated document locator.
    expect(row).toEqual({
      source: "ledger_ro.contract_expiry",
      record_key: { contract_id: "C-2291" },
      queried_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/),
      fields: {
        title: "Warehouse logistics master agreement",
        counterparty: "Northwind Logistics",
        expiry_date: "2026-03-14",
        notice_by: "2026-02-12",
        total_amount: "480000.00",
        currency: "USD",
        owner_dept: "operations",
      },
      summary: expect.stringContaining("C-2291"),
    });
  });

  it("binds the request window as parameters and sends only the named template", async () => {
    const { executor, sent } = executorWith([C_2291]);
    const handler = createRetrieveHandler({
      embedder: new FakeEmbedder(TEST_DIM),
      storage: new MemoryBackend(TEST_DIM),
      businessQuery: executor,
    });
    await handler({
      query: "DROP TABLE ledger.contract; -- which contracts expire",
      filters: WINDOW_FILTERS,
      limit: 5,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toBe(CONTRACTS_EXPIRING_SQL);
    // Window and cap arrive bound, never as SQL text: the query string
    // appears nowhere in what was sent.
    expect(sent[0]!.values).toEqual(["2026-01-01", "2026-03-31", 6]);
    expect(sent[0]!.text).not.toContain("DROP TABLE");
  });

  it("touches no embedder and no document storage on the sql route", async () => {
    const { executor } = executorWith([C_2291]);
    const embedder = new CountingEmbedder(new FakeEmbedder(TEST_DIM));
    const { storage, touched } = storageProbe(new MemoryBackend(TEST_DIM));
    const handler = createRetrieveHandler({ embedder, storage, businessQuery: executor });
    await handler({ query: "anything", filters: WINDOW_FILTERS });
    expect(embedder.calls).toBe(0);
    expect(touched).toEqual([]);
  });

  it("routes the executor's typed failures out untokened-free: a malformed window is invalid_business_query before any pool opens", async () => {
    const { executor, sent } = executorWith([C_2291]);
    const handler = createRetrieveHandler({
      embedder: new FakeEmbedder(TEST_DIM),
      storage: new MemoryBackend(TEST_DIM),
      businessQuery: executor,
    });
    let thrown: unknown;
    try {
      await handler({
        query: "anything",
        filters: {
          search_mode: "sql",
          sql_window_start: "not-a-date",
          sql_window_end: "2026-03-31",
        },
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(GraphragError);
    expect(failureTokenOf(thrown)).toBe(INVALID_BUSINESS_QUERY);
    // Refused before a connection exists — the request never probes the
    // database (spec §5c).
    expect(sent).toEqual([]);
  });

  it("an omitted window is the same typed refusal, never a defaulted window", async () => {
    const { executor, sent } = executorWith([C_2291]);
    const handler = createRetrieveHandler({
      embedder: new FakeEmbedder(TEST_DIM),
      storage: new MemoryBackend(TEST_DIM),
      businessQuery: executor,
    });
    let thrown: unknown;
    try {
      await handler({ query: "anything", filters: { search_mode: "sql" } });
    } catch (err) {
      thrown = err;
    }
    expect(failureTokenOf(thrown)).toBe(INVALID_BUSINESS_QUERY);
    expect(sent).toEqual([]);
  });

  it("strips the window routing keys so no arm sees them as chunk filters", async () => {
    // The dispatcher is the single strip point (review I2): an unstripped
    // control key would become an exact-match term clause and zero the
    // vector arms. Here: a graph call that also carries the sql window
    // keys must answer exactly like the same call without them.
    const storage = new MemoryBackend(TEST_DIM);
    await storage.upsert([
      {
        id: "b-1",
        content: "content of b-1",
        embedding: unitEmbedding(),
        source_ref: "src/b-1",
        metadata: {},
        valid_from: "2024-01-01T00:00:00Z",
        valid_until: null,
        created_at: "2024-01-01T00:00:00Z",
      },
    ]);
    const handler = createRetrieveHandler({
      embedder: new FakeEmbedder(TEST_DIM),
      storage,
    });
    const plain = parseBody(await handler({ query: "content" }));
    const withWindow = parseBody(
      await handler({
        query: "content",
        filters: {
          sql_window_start: "2026-01-01",
          sql_window_end: "2026-03-31",
        },
      })
    );
    expect(withWindow).toEqual(plain);
    expect(plain.chunks).toHaveLength(1);
  });
});

describe("mode-d arm — not provisioned", () => {
  it("exits the structured real_db_not_wired token, not prose", async () => {
    const handler = createRetrieveHandler({
      embedder: new FakeEmbedder(TEST_DIM),
      storage: new MemoryBackend(TEST_DIM),
    });
    let thrown: unknown;
    try {
      await handler({ query: "anything", filters: WINDOW_FILTERS });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(GraphragError);
    expect(failureTokenOf(thrown)).toBe(REAL_DB_NOT_WIRED);
    const error = thrown as GraphragError;
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.message).toContain("search_mode=sql");
    expect(error.message).toContain("real_db_not_wired");
  });
});
