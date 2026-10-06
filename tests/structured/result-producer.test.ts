/**
 * P1 producer conformance — the `structured_result` sibling the `retrieve`
 * seam now emits beside `chunks`.
 *
 * This suite is written against the CONSUMER, not against the producer's
 * intentions: every assertion is an exact key set or an exact field value, so
 * a missing member and an extra member both fail. "A `structured_result` exists"
 * would pass for a sibling no fin host can read, which is precisely the failure
 * mode this contract exists to prevent — hence the tables below mirror the
 * consumer's frozen sets member for member.
 *
 * The second half drives the real handler, because three of the load-bearing
 * properties live at the seam rather than in the builder: a structured request
 * never reaches the legacy ledger, an instance with no reader refuses instead
 * of falling back to it, and the validator's return value reaches the reader
 * rather than being discarded for its throw.
 *
 * Unit/protocol tier: no Postgres, no network, no child process. The MCP
 * transport is used once, only to prove the frozen `tools/list` name list did
 * not gain a member when this feature landed.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createServer } from "../../src/index.js";
import { setSettingHomeForTests } from "../../src/config.js";
import { FakeEmbedder } from "../../src/core/embedder.js";
import { MemoryBackend } from "../../src/core/storage/memory-backend.js";
import type { SearchOptions } from "../../src/core/types.js";
import type { BusinessQueryExecutor } from "../../src/core/business-query/sql-query-executor.js";
import { STRUCTURED_QUERY_SCHEMA } from "../../src/core/structured/request.js";
import {
  validateStructuredQueryRequest,
  type ValidatedStructuredQuery,
} from "../../src/core/structured/request.js";
import { StructuredQueryError } from "../../src/core/structured/errors.js";
import {
  STRUCTURED_RESULT_COUNT_COVERAGE,
  STRUCTURED_RESULT_COUNT_KEYS,
  STRUCTURED_RESULT_COUNT_RECEIPT_KEYS,
  STRUCTURED_RESULT_ENTITY_ROW_KEYS,
  STRUCTURED_RESULT_ENDPOINT_KEYS,
  STRUCTURED_RESULT_KEY,
  STRUCTURED_RESULT_LIST_KEYS,
  STRUCTURED_RESULT_MAINTENANCE_COVERAGE,
  STRUCTURED_RESULT_MAINTENANCE_KEYS,
  STRUCTURED_RESULT_MAX_BYTES,
  STRUCTURED_RESULT_MAX_INLINE_SUPPORTS,
  STRUCTURED_RESULT_MAX_ROWS,
  STRUCTURED_RESULT_RELATION_ROW_KEYS,
  STRUCTURED_RESULT_ROW_EVIDENCE_KEYS,
  STRUCTURED_RESULT_SCHEMA,
  STRUCTURED_RESULT_SCHEMA_VERSION,
  STRUCTURED_RESULT_SPAN_KEY,
  STRUCTURED_RESULT_SUPPORT_KEYS,
  buildStructuredResult,
  type StructuredCountRead,
  type StructuredEntityRowRecord,
  type StructuredListRead,
  type StructuredMaintenanceRecord,
  type StructuredQueryReader,
  type StructuredReadOutcome,
  type StructuredRelationRowRecord,
  type StructuredSupportRecord,
} from "../../src/core/structured/result.js";
import { STRUCTURED_QUERY_FILTER_KEY } from "../../src/core/retrieval/wire-filters.js";
import { createRetrieveHandler } from "../../src/tools/retrieve.js";

const TEST_DIM = 1536;
/** A fixed clock reading, so the emitted stamp and expiry are assertable. */
const NOW = new Date("2026-02-03T04:05:06.789Z");
const QUERIED_AT = "2026-02-03T04:05:06Z";

function uuid(ordinal: number): string {
  return `00000000-0000-4000-8000-${String(ordinal).padStart(12, "0")}`;
}

/** UTF-8 byte length of the encoded value — the bound's measure. */
function encodedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

function support(
  ordinal: number,
  patch: Partial<StructuredSupportRecord> = {}
): StructuredSupportRecord {
  return {
    supportId: uuid(ordinal),
    sourceRef: `docs/${ordinal}.md`,
    sourceVersion: "v1",
    location: { documentId: `doc-${ordinal}`, version: "v1", unit: 1 },
    extractionRef: `extraction/${ordinal}`,
    ...patch,
  };
}

function maintenance(
  patch: Partial<StructuredMaintenanceRecord> = {}
): StructuredMaintenanceRecord {
  // Both dimensions sum to `sourcesInScope`: a summary that does not is not a
  // status of this corpus, and the producer refuses rather than emitting it.
  return {
    maintenanceRevision: "mrev-7",
    sourcesInScope: 2,
    publishedSources: 1,
    desiredIndex: { pending: 0, running: 0, ready: 1, failed: 0, stale: 1 },
    conflictChecks: { pending: 0, running: 0, ready: 2, failed: 0, stale: 0 },
    rulesetRevision: "rrev-3",
    ...patch,
  };
}

function context(patch: Partial<StructuredListRead["context"]> = {}) {
  return {
    queryDigest: "sha256:0f".padEnd(71, "a"),
    scopeBinding: "scope-binding-1",
    readRevision: "rev-118",
    evidenceRef: "ev-count-1",
    maintenance: maintenance(),
    ...patch,
  };
}

function entityRow(
  ordinal: number,
  patch: Partial<StructuredEntityRowRecord> = {}
): StructuredEntityRowRecord {
  return {
    subject: "entity",
    id: uuid(1000 + ordinal),
    canonicalName: `Acme ${ordinal}`,
    type: "organization",
    displaySupportId: uuid(2000 + ordinal),
    displayDisagreement: false,
    evidenceRef: `ev-row-${ordinal}`,
    supports: [support(ordinal)],
    ...patch,
  };
}

function relationRow(
  ordinal: number,
  patch: Partial<StructuredRelationRowRecord> = {}
): StructuredRelationRowRecord {
  return {
    subject: "relation_assertion",
    id: uuid(3000 + ordinal),
    head: {
      id: uuid(1000 + ordinal),
      canonicalName: "Acme",
      type: "organization",
      displaySupportId: uuid(2000 + ordinal),
      displayDisagreement: false,
    },
    relationNorm: "works_for",
    tail: {
      id: uuid(4000 + ordinal),
      canonicalName: "Ada",
      type: "person",
      displaySupportId: uuid(5000 + ordinal),
      displayDisagreement: true,
    },
    validWindow: { from: "2020-01-01T00:00:00Z", until: null },
    evidenceRef: `ev-rel-${ordinal}`,
    supports: [support(ordinal)],
    ...patch,
  };
}

function listRead(
  rows: readonly StructuredEntityRowRecord[] | readonly StructuredRelationRowRecord[],
  patch: Partial<Omit<StructuredListRead, "kind" | "rows">> = {}
): StructuredListRead {
  return { kind: "list", context: context(), rows, nextCursor: null, ...patch };
}

function countRead(
  count: number,
  patch: Partial<Omit<StructuredCountRead, "kind" | "count">> = {}
): StructuredCountRead {
  return { kind: "count", context: context(), count, ...patch };
}

/** The validated value a well-formed raw request produces. */
function validated(patch: Record<string, unknown> = {}): ValidatedStructuredQuery {
  return validateStructuredQueryRequest(rawRequest(patch), "sql");
}

function rawRequest(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: STRUCTURED_QUERY_SCHEMA,
    schema_version: 1,
    subject: "entity",
    operation: "list",
    ...patch,
  };
}

/** A reader that records what it was asked and answers with `outcome`. */
function reader(outcome: StructuredReadOutcome | (() => never)): {
  reader: StructuredQueryReader;
  calls: ValidatedStructuredQuery[];
} {
  const calls: ValidatedStructuredQuery[] = [];
  return {
    calls,
    reader: {
      readStructuredQuery: async (request) => {
        calls.push(request);
        if (typeof outcome === "function") outcome();
        return outcome as StructuredReadOutcome;
      },
    },
  };
}

describe("buildStructuredResult — the frozen sibling", () => {
  it("emits the list key set exactly, with no extra and no missing member", () => {
    const result = buildStructuredResult(
      validated(),
      listRead([entityRow(1)]),
      NOW
    );
    expect([...Object.keys(result).sort()]).toEqual(
      [...STRUCTURED_RESULT_LIST_KEYS].sort()
    );
    expect(result.schema).toBe(STRUCTURED_RESULT_SCHEMA);
    expect(result.schema_version).toBe(STRUCTURED_RESULT_SCHEMA_VERSION);
    // The version is its own integer member; a token suffix would be an
    // unknown token to the consumer.
    expect(STRUCTURED_RESULT_SCHEMA).not.toContain("1");
  });

  it("emits the entity row key set exactly, and its evidence members", () => {
    const result = buildStructuredResult(
      validated(),
      listRead([entityRow(1)]),
      NOW
    );
    const row = result.rows[0]!;
    expect([...Object.keys(row).sort()]).toEqual(
      [...STRUCTURED_RESULT_ENTITY_ROW_KEYS].sort()
    );
    // The five evidence members are shared by both row subjects; a row that
    // dropped one would be a citable value with no evidence half.
    for (const key of STRUCTURED_RESULT_ROW_EVIDENCE_KEYS) {
      expect(Object.hasOwn(row, key), `row is missing ${key}`).toBe(true);
    }
    expect(row.evidence_expires_at).toBe("2027-02-03T04:05:06Z");
    expect(row.queried_at).toBeUndefined();
  });

  it("emits the relation row key set exactly, with both endpoints bounded", () => {
    const result = buildStructuredResult(
      validated({ subject: "relation_assertion" }),
      listRead([relationRow(1)]),
      NOW
    );
    const row = result.rows[0]!;
    expect([...Object.keys(row).sort()]).toEqual(
      [...STRUCTURED_RESULT_RELATION_ROW_KEYS].sort()
    );
    for (const side of ["head", "tail"] as const) {
      expect([...Object.keys(row[side]).sort()]).toEqual(
        [...STRUCTURED_RESULT_ENDPOINT_KEYS].sort()
      );
    }
    expect(Object.keys(row.valid_window).sort()).toEqual(["from", "until"]);
    expect(row.valid_window.until).toBeNull();
  });

  it("emits the support key set exactly, adding span only when known", () => {
    const withSpan = buildStructuredResult(
      validated(),
      listRead([entityRow(1, { supports: [support(1, { span: { start: 3, end: 9 } })] })]),
      NOW
    ).rows[0]!.provenance[0]!;
    expect([...Object.keys(withSpan).sort()]).toEqual(
      [...STRUCTURED_RESULT_SUPPORT_KEYS, STRUCTURED_RESULT_SPAN_KEY].sort()
    );
    expect(Object.keys(withSpan.location).sort()).toEqual([
      "document_id",
      "unit",
      "version",
    ]);
    expect(withSpan.span).toEqual({ start: 3, end: 9 });

    const withoutSpan = buildStructuredResult(
      validated(),
      listRead([entityRow(2, { supports: [support(2)] })]),
      NOW
    ).rows[0]!.provenance[0]!;
    expect([...Object.keys(withoutSpan).sort()]).toEqual(
      [...STRUCTURED_RESULT_SUPPORT_KEYS].sort()
    );
  });

  it("emits the count key set exactly, with the integer beside its receipt", () => {
    const result = buildStructuredResult(
      validated({ operation: "count" }),
      countRead(4_096),
      NOW
    );
    expect([...Object.keys(result).sort()]).toEqual(
      [...STRUCTURED_RESULT_COUNT_KEYS].sort()
    );
    expect(result.count).toBe(4_096);
    expect(Number.isInteger(result.count)).toBe(true);
    expect([...Object.keys(result.count_receipt).sort()]).toEqual(
      [...STRUCTURED_RESULT_COUNT_RECEIPT_KEYS].sort()
    );
    // The receipt restates the envelope context member for member, and its
    // coverage is the stored-subject token, NOT the maintenance one.
    expect(result.count_receipt.coverage).toBe(STRUCTURED_RESULT_COUNT_COVERAGE);
    expect(result.count_receipt.count).toBe(result.count);
    expect(result.count_receipt.queried_at).toBe(result.queried_at);
    expect(result.count_receipt.read_revision).toBe(result.read_revision);
    expect(result.count_receipt.maintenance).toEqual(result.maintenance);
    expect(result.count_receipt.maintenance_revision).toBe(
      result.maintenance.maintenance_revision
    );
  });

  it("emits an empty list page as a success rather than refusing it", () => {
    // A no-match is a successful empty list, not a backend failure. An empty
    // page has no row to cite, so the reader supplies no context-level
    // evidence_ref at all — requiring one here would turn a correct empty
    // answer into a refusal, so the empty reference is the condition under test.
    const result = buildStructuredResult(
      validated({ operation: "list" }),
      listRead([], { context: { ...context(), evidenceRef: "" } }),
      NOW
    );
    expect(result.rows).toEqual([]);
    expect([...Object.keys(result).sort()]).toEqual(
      [...STRUCTURED_RESULT_LIST_KEYS].sort()
    );
    expect(result.count).toBeUndefined();
  });

  it("still refuses a count whose own reference cannot be cited", () => {
    // The count receipt is the one member that MUST carry a reference, so the
    // exemption above must not extend to it.
    expect(() =>
      buildStructuredResult(
        validated({ operation: "count" }),
        countRead(0, { context: { ...context(), evidenceRef: "" } }),
        NOW
      )
    ).toThrow(/evidence_ref/);
  });

  it("emits the maintenance key set exactly, with the two contract tokens", () => {
    const result = buildStructuredResult(
      validated(),
      listRead([entityRow(1)]),
      NOW
    );
    expect([...Object.keys(result.maintenance).sort()]).toEqual(
      [...STRUCTURED_RESULT_MAINTENANCE_KEYS].sort()
    );
    expect(result.maintenance.coverage).toBe(
      STRUCTURED_RESULT_MAINTENANCE_COVERAGE
    );
    expect(result.maintenance.coverage).not.toBe(
      STRUCTURED_RESULT_COUNT_COVERAGE
    );
  });

  it("stamps queried_at as a whole second derived from the query instant", () => {
    const result = buildStructuredResult(
      validated(),
      listRead([entityRow(1)]),
      NOW
    );
    // The clock reading carried milliseconds; the contract's timestamp form has
    // no fractional part, and the consumer refuses rather than normalizes.
    expect(result.queried_at).toBe(QUERIED_AT);
    expect(result.queried_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it("declares the inline provenance prefix instead of truncating it silently", () => {
    const complete = buildStructuredResult(
      validated(),
      listRead([
        entityRow(1, {
          // Deliberately unsorted, and deliberately reversed, so the ordering
          // is the producer's to establish rather than the reader's accident.
          supports: [support(9), support(2), support(5)],
        }),
      ]),
      NOW
    ).rows[0]!;
    expect(complete.provenance.map((entry) => entry.support_id)).toEqual([
      uuid(2),
      uuid(5),
      uuid(9),
    ]);
    expect(complete.provenance_complete).toBe(true);
    expect(complete.provenance_next_ref).toBeNull();

    const cut = buildStructuredResult(
      validated(),
      listRead([
        entityRow(1, {
          supports: Array.from(
            { length: STRUCTURED_RESULT_MAX_INLINE_SUPPORTS + 3 },
            (_unused, index) => support(index)
          ),
        }),
      ]),
      NOW
    ).rows[0]!;
    expect(cut.provenance).toHaveLength(STRUCTURED_RESULT_MAX_INLINE_SUPPORTS);
    expect(cut.provenance_complete).toBe(false);
    // The continuation resumes at the first OMITTED support, which is the same
    // order the inline prefix was cut on.
    expect(cut.provenance_next_ref).toBe(
      uuid(STRUCTURED_RESULT_MAX_INLINE_SUPPORTS)
    );
    // The first omitted support is genuinely absent from the inline prefix,
    // which is what makes `provenance_complete: false` a truthful statement.
    expect(
      cut.provenance.some(
        (entry) => entry.support_id === uuid(STRUCTURED_RESULT_MAX_INLINE_SUPPORTS)
      )
    ).toBe(false);
  });

  it("refuses an over-bound result rather than trimming the page", () => {
    // Sized so the ENVELOPE — not one row — is what crosses the bound: a
    // page-shaped result that is individually citable and collectively not.
    const fits = buildStructuredResult(
      validated(),
      listRead(
        Array.from({ length: STRUCTURED_RESULT_MAX_ROWS }, (_unused, index) =>
          entityRow(index, { canonicalName: "a".repeat(600) })
        )
      ),
      NOW
    );
    expect(encodedBytes(fits)).toBeLessThan(STRUCTURED_RESULT_MAX_BYTES);

    const oversized = Array.from(
      { length: STRUCTURED_RESULT_MAX_ROWS },
      (_unused, index) => entityRow(index, { canonicalName: "a".repeat(1_200) })
    );
    expect(() =>
      buildStructuredResult(validated(), listRead(oversized), NOW)
    ).toThrowError(
      expect.objectContaining({ code: "result_too_large" }) as Error
    );
    // The refusal is the contract: a trimmed page would cite rows the caller
    // never asked for and could not re-read as one page.
    const partial = buildStructuredResult(
      validated(),
      listRead(oversized.slice(0, 3)),
      NOW
    );
    expect(partial.rows).toHaveLength(3);
  });

  it("refuses a page longer than the bound the request already carried", () => {
    const rows = Array.from(
      { length: STRUCTURED_RESULT_MAX_ROWS + 1 },
      (_unused, index) => entityRow(index)
    );
    expect(() =>
      buildStructuredResult(validated(), listRead(rows), NOW)
    ).toThrowError(
      expect.objectContaining({ code: "result_too_large" }) as Error
    );
  });

  it("refuses a reader that answers the other operation", () => {
    expect(() =>
      buildStructuredResult(validated({ operation: "count" }), listRead([]), NOW)
    ).toThrowError(
      expect.objectContaining({ code: "structured_search_unavailable" }) as Error
    );
  });

  it("refuses a row whose own subject disagrees with the validated request", () => {
    expect(() =>
      buildStructuredResult(
        validated({ subject: "relation_assertion" }),
        listRead([entityRow(1)] as never),
        NOW
      )
    ).toThrowError(
      expect.objectContaining({ code: "structured_search_unavailable" }) as Error
    );
  });

  it("refuses an uncitable field the backend produced", () => {
    const cases: Array<[string, StructuredEntityRowRecord]> = [
      ["a non-canonical id", entityRow(1, { id: "nope" })],
      [
        "an entity type outside the catalog",
        entityRow(1, { type: "concept" }),
      ],
      [
        "a support cited twice",
        entityRow(1, { supports: [support(1), support(1)] }),
      ],
      ["an empty evidence ref", entityRow(1, { evidenceRef: "" })],
    ];
    for (const [label, row] of cases) {
      expect(() =>
        buildStructuredResult(validated(), listRead([row]), NOW)
      ).toThrowError(
        expect.objectContaining({
          code: "structured_search_unavailable",
        }) as Error,
        label
      );
    }
  });

  it("refuses a maintenance summary that cannot describe this corpus", () => {
    const cases: Array<[string, StructuredMaintenanceRecord]> = [
      [
        "a dimension that does not account for every source",
        maintenance({
          conflictChecks: { pending: 0, running: 0, ready: 1, failed: 0, stale: 0 },
        }),
      ],
      [
        "a dimension naming a state outside the closed set",
        maintenance({
          sourcesInScope: 1,
          desiredIndex: { pending: 0, running: 0, ready: 1, failed: 0, stale: 0 },
          conflictChecks: {
            pending: 0,
            running: 0,
            ready: 0,
            failed: 0,
            stale: 0,
            blocked: 1,
          },
        }),
      ],
      ["more published sources than in scope", maintenance({ publishedSources: 3 })],
    ];
    for (const [label, summary] of cases) {
      expect(() =>
        buildStructuredResult(
          validated(),
          listRead([entityRow(1)], { context: context({ maintenance: summary }) }),
          NOW
        )
      ).toThrowError(
        expect.objectContaining({
          code: "maintenance_status_unavailable",
        }) as Error,
        label
      );
    }
  });

  it("refuses a count outside the non-negative safe integer range", () => {
    expect(() =>
      buildStructuredResult(
        validated({ operation: "count" }),
        countRead(-1),
        NOW
      )
    ).toThrowError(
      expect.objectContaining({ code: "count_unavailable" }) as Error
    );
  });
});

describe("createRetrieveHandler — the structured seam", () => {
  let ledgerCalls: number;
  let storageSearches: Array<SearchOptions["filters"]>;

  function handlerWith(structuredReader?: StructuredQueryReader) {
    const backend = new MemoryBackend(TEST_DIM);
    const spy = backend as unknown as {
      search: (q: string, opts: SearchOptions) => Promise<unknown>;
    };
    backend.search = async (q: string, opts: SearchOptions) => {
      storageSearches.push(opts.filters);
      return spy.search.bind(backend)(q, opts);
    };
    return createRetrieveHandler({
      embedder: new FakeEmbedder(TEST_DIM),
      storage: backend,
      // A provisioned ledger, so "the ledger never ran" is an observation and
      // not a side effect of the not-provisioned exit.
      businessQuery: {
        query: async () => {
          ledgerCalls += 1;
          return { rows: [], rowCount: 0 };
        },
      } as unknown as BusinessQueryExecutor,
      ...(structuredReader !== undefined ? { structuredReader } : {}),
    });
  }

  function envelopeOf(result: { content: unknown }): Record<string, unknown> {
    const text = (result.content as Array<{ type: string; text?: string }>)
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("");
    return JSON.parse(text) as Record<string, unknown>;
  }

  beforeEach(() => {
    ledgerCalls = 0;
    storageSearches = [];
  });

  it("answers a list request with structured_result beside an empty chunks", async () => {
    const { reader: injected, calls } = reader(listRead([entityRow(1)]));
    const result = await handlerWith(injected)({
      query: "acme contracts",
      filters: { search_mode: "sql", [STRUCTURED_QUERY_FILTER_KEY]: rawRequest() },
    });
    expect(result.isError).toBeUndefined();
    const envelope = envelopeOf(result);
    expect(envelope.chunks).toEqual([]);
    expect(Object.keys(envelope).sort()).toEqual([
      "chunks",
      STRUCTURED_RESULT_KEY,
    ]);
    // A structured read cites structured rows; the legacy row envelope belongs
    // to the sql arm, and a host refuses one that shows up here.
    expect(Object.hasOwn(envelope, "database_rows")).toBe(false);
    const structured = envelope[STRUCTURED_RESULT_KEY] as Record<string, unknown>;
    expect([...Object.keys(structured).sort()]).toEqual(
      [...STRUCTURED_RESULT_LIST_KEYS].sort()
    );
    expect(structured["rows"]).toHaveLength(1);
    // The invariant that survived the change: a structured request never runs
    // the legacy business ledger and never searches document storage.
    expect(ledgerCalls).toBe(0);
    expect(storageSearches).toEqual([]);
    // The validator's return value is the reader's input, not a discarded throw.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      subject: "entity",
      operation: "list",
      filters: [],
      relationship: undefined,
      limit: 20,
      cursor: undefined,
      readRevision: undefined,
    });
  });

  it("answers a count request with the integer and its receipt", async () => {
    const { reader: injected } = reader(countRead(1_234));
    const result = await handlerWith(injected)({
      query: "how many",
      filters: {
        search_mode: "sql",
        [STRUCTURED_QUERY_FILTER_KEY]: rawRequest({ operation: "count" }),
      },
    });
    const structured = envelopeOf(result)[STRUCTURED_RESULT_KEY] as Record<
      string,
      unknown
    >;
    expect([...Object.keys(structured).sort()]).toEqual(
      [...STRUCTURED_RESULT_COUNT_KEYS].sort()
    );
    expect(structured["count"]).toBe(1_234);
    const receipt = structured["count_receipt"] as Record<string, unknown>;
    expect([...Object.keys(receipt).sort()]).toEqual(
      [...STRUCTURED_RESULT_COUNT_RECEIPT_KEYS].sort()
    );
    expect(receipt["count"]).toBe(1_234);
    expect(ledgerCalls).toBe(0);
    expect(storageSearches).toEqual([]);
  });

  it("refuses an over-bound result instead of emitting a trimmed page", async () => {
    const oversized = Array.from(
      { length: STRUCTURED_RESULT_MAX_ROWS },
      (_unused, index) =>
        entityRow(index, { canonicalName: "a".repeat(1_200) })
    );
    const { reader: injected } = reader(listRead(oversized));
    const code = await refusalCodeOf(() =>
      handlerWith(injected)({
        query: "acme contracts",
        filters: {
          search_mode: "sql",
          [STRUCTURED_QUERY_FILTER_KEY]: rawRequest(),
        },
      })
    );
    expect(code).toBe("result_too_large");
    expect(ledgerCalls).toBe(0);
  });

  it("refuses structured_search_unavailable with no reader and no ledger fallback", async () => {
    const code = await refusalCodeOf(() =>
      handlerWith()({
        query: "acme contracts",
        filters: { search_mode: "sql", [STRUCTURED_QUERY_FILTER_KEY]: rawRequest() },
      })
    );
    // The SPEC's second trigger: backend capability unavailable. It must not be
    // answered by the provisioned ledger, which answers a different question.
    expect(code).toBe("structured_search_unavailable");
    expect(ledgerCalls).toBe(0);
    expect(storageSearches).toEqual([]);
  });

  it("propagates a typed refusal from the reader unchanged", async () => {
    const { reader: injected } = reader(() => {
      throw new StructuredQueryError(
        "the structured backend timed out",
        "query_timeout"
      );
    });
    const code = await refusalCodeOf(() =>
      handlerWith(injected)({
        query: "acme contracts",
        filters: { search_mode: "sql", [STRUCTURED_QUERY_FILTER_KEY]: rawRequest() },
      })
    );
    expect(code).toBe("query_timeout");
    expect(ledgerCalls).toBe(0);
  });

  it("still refuses an invalid request with the request's own code", async () => {
    // Validation runs before the capability check, so an unprovisioned
    // instance still names the caller's mistake rather than the backend's.
    const { reader: injected, calls } = reader(listRead([]));
    const code = await refusalCodeOf(() =>
      handlerWith(injected)({
        query: "acme contracts",
        filters: {
          search_mode: "sql",
          [STRUCTURED_QUERY_FILTER_KEY]: rawRequest({ sql: "SELECT 1" }),
        },
      })
    );
    expect(code).toBe("malformed_structured_query");
    expect(calls).toEqual([]);
  });
});

/**
 * The frozen host-facing surface. A mode switch hidden inside
 * `filters.structured_query` cannot be advertised by `tools/list`, which is
 * exactly why this feature is safe: the tool set is unchanged and the switch is
 * invisible to a host that only reads the published schema.
 */
describe("the frozen tool surface", () => {
  it("advertises the same eight tool names, sorted and exact", async () => {
    const { client, close } = await connectInProcess();
    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual([
        "extract",
        "ingest",
        "invalidate",
        "poll_index_job",
        "push",
        "read_source",
        "retrieve",
        "submit_index_job",
      ]);
      expect(
        tools.some((tool) => tool.name.includes("structured"))
      ).toBe(false);
    } finally {
      await close();
    }
  });
});

/** Await the handler and return the code it refused with. */
async function refusalCodeOf(
  run: () => Promise<unknown>
): Promise<string> {
  try {
    await run();
  } catch (err) {
    expect(err).toBeInstanceOf(StructuredQueryError);
    return (err as StructuredQueryError).code;
  }
  throw new Error("expected a StructuredQueryError refusal");
}

/**
 * Construct a server with the stage 1 env vars forced to their defaults, so a
 * developer machine's credentials cannot boot a networked server into a test
 * that means to stay offline. Mirrors tests/structured/structured-error-wire.test.ts.
 */
const ENV_KEYS = [
  "GRAPHRAG_MEMORY_STORAGE",
  "GRAPHRAG_MEMORY_DB_URL",
  "GRAPHRAG_MEMORY_EMBED_DIMENSIONS",
  "GRAPHRAG_MEMORY_PGVECTOR_ANN_MAX_DIMENSIONS",
  "GRAPHRAG_MEMORY_EMBED_BASE_URL",
  "GRAPHRAG_MEMORY_EMBED_MODEL",
  "GRAPHRAG_MEMORY_EMBED_API_KEY",
  "GRAPHRAG_MEMORY_EMBED_API_KEY_ENV",
  "GRAPHRAG_MEMORY_VECTOR_API_KEY",
  "NINE_ROUTER_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "GRAPHRAG_MEMORY_RERANK_API_KEY_ENV",
  "MINIMAX_API_KEY",
  "GRAPHRAG_MEMORY_JEV_API_KEY",
  "TYPESAFE_API_KEY",
  "GRAPHRAG_MEMORY_ANTHROPIC_API_KEY",
  "GRAPHRAG_MEMORY_RETRIEVAL_RERANK_ENABLED",
  "GRAPHRAG_MEMORY_RETRIEVAL_BM25_ENABLED",
  // No ledger DSN: the sql tier here is the not-provisioned exit, so this
  // suite's structured refusals can only come from the structured boundary.
  "FIN_BUSINESS_LEDGER_URL",
] as const;

async function createOfflineServer(): Promise<ReturnType<typeof createServer>> {
  const saved = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) {
    saved.set(key, process.env[key]);
    process.env[key] = "";
  }
  process.env["GRAPHRAG_MEMORY_EMBED_DIMENSIONS"] = "1536";
  process.env["GRAPHRAG_MEMORY_PGVECTOR_ANN_MAX_DIMENSIONS"] = "2000";
  process.env["GRAPHRAG_MEMORY_RETRIEVAL_GRAPH_ENABLED"] = "false";
  process.env["GRAPHRAG_MEMORY_RETRIEVAL_RERANK_ENABLED"] = "false";
  process.env["GRAPHRAG_MEMORY_RETRIEVAL_BM25_ENABLED"] = "false";
  const settingHome = mkdtempSync(join(tmpdir(), "iknow-result-setting-"));
  setSettingHomeForTests(settingHome);
  try {
    return await createServer();
  } finally {
    setSettingHomeForTests(null);
    rmSync(settingHome, { recursive: true, force: true });
    for (const [key, value] of saved) {
      if (value !== undefined) process.env[key] = value;
      else delete process.env[key];
    }
  }
}

async function connectInProcess(): Promise<{
  client: Client;
  close: () => Promise<void>;
}> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = await createOfflineServer();
  await server.connect(serverTransport);
  const client = new Client(
    { name: "structured-result-test", version: "0.0.0" },
    { capabilities: {} }
  );
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}