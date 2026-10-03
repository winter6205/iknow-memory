/**
 * QP4 conformance driver — the closed structured-request vocabulary.
 *
 * Why a table and not a case per `it`: the SPEC defines a *closed* request, so
 * the contract that matters is the mapping from a violating input to exactly
 * one typed code. A table makes that mapping reviewable in one place and
 * makes a new refusal impossible to add without a named row.
 *
 * Every row carries exactly one violation, so the expected code is
 * deterministic and a case cannot accidentally pass for the wrong reason. The
 * validation order inside the validator is therefore part of the contract: the
 * 16-filter cap is checked before entries are walked, and the 32 KiB bound
 * before the body is read, so those two bounds stay observable even though the
 * allowlist is too small to fill 17 distinct fields.
 *
 * This is the unit/protocol tier: no Postgres, no child process, no network.
 * The real MCP boundary is proven separately in structured-error-wire.test.ts.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { ENTITY_TYPES } from "../../src/core/extraction/entity-type.js";
import {
  StructuredQueryError,
  type StructuredErrorCode,
} from "../../src/core/structured/errors.js";
import {
  STRUCTURED_LIST_DEFAULT_LIMIT,
  STRUCTURED_LIST_MAX_LIMIT,
  STRUCTURED_MAX_FIELD_FILTERS,
  STRUCTURED_MAX_IN_VALUES,
  STRUCTURED_QUERY_SCHEMA,
  STRUCTURED_REQUEST_MAX_BYTES,
  validateStructuredQueryRequest,
} from "../../src/core/structured/request.js";
import {
  STRUCTURED_QUERY_FILTER_KEY,
  stripStructuredQueryFilter,
} from "../../src/core/retrieval/wire-filters.js";
import {
  createRetrieveHandler,
  RetrieveInputSchema,
} from "../../src/tools/retrieve.js";
import { FakeEmbedder } from "../../src/core/embedder.js";
import { MemoryBackend } from "../../src/core/storage/memory-backend.js";
import type { BusinessQueryExecutor } from "../../src/core/business-query/sql-query-executor.js";
import type { SearchOptions } from "../../src/core/types.js";

/** The only tier a structured request may ride; the host binds it. */
const SQL_TIER = "sql";

const UUID_HEAD = "00000000-0000-4000-8000-000000000001";
const UUID_TAIL = "00000000-0000-4000-8000-000000000002";
const UUID_ANCHOR = "11111111-1111-4111-8111-111111111111";

/** A minimal valid request; `patch` overrides or adds top-level members. */
function validRequest(
  patch: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    schema: STRUCTURED_QUERY_SCHEMA,
    schema_version: 1,
    subject: "entity",
    operation: "list",
    ...patch,
  };
}

/** UTF-8 byte length of the encoded request — the SPEC's 32 KiB measure. */
function encodedBytes(request: unknown): number {
  return new TextEncoder().encode(JSON.stringify(request)).length;
}

/**
 * A request whose encoded size is exactly `totalBytes`. The padded member is
 * an exact-string `eq` value, so only the size bound can refuse it.
 */
function sizedRequest(totalBytes: number): Record<string, unknown> {
  const base = encodedBytes(
    validRequest({ filters: [{ field: "canonical_name", op: "eq", value: "" }] })
  );
  return validRequest({
    filters: [
      { field: "canonical_name", op: "eq", value: "x".repeat(totalBytes - base) },
    ],
  });
}

const AT_SIZE_LIMIT = sizedRequest(STRUCTURED_REQUEST_MAX_BYTES);
const OVER_SIZE_LIMIT = sizedRequest(STRUCTURED_REQUEST_MAX_BYTES + 1);

interface ConformanceCase {
  /** Doubles as the test name; keep it the refusal being pinned. */
  name: string;
  request: unknown;
  /** Expected code, or null when the request is accepted. */
  expect: StructuredErrorCode | null;
  /** Defaults to the `sql` tier; rows that probe the tier gate set it. */
  boundTier?: string;
}

const CONFORMANCE: readonly ConformanceCase[] = [
  // --- accepted requests -------------------------------------------------
  {
    name: "accepts a minimal entity list request",
    request: validRequest(),
    expect: null,
  },
  {
    name: "accepts the SPEC illustrative relation_assertion request",
    request: validRequest({
      subject: "relation_assertion",
      filters: [{ field: "relation_norm", op: "eq", value: "works_for" }],
      relationship: { anchor_entity_id: UUID_ANCHOR, direction: "outgoing" },
      limit: 20,
    }),
    expect: null,
  },
  {
    name: "accepts schema_version 1.0 (decodes to the same integer)",
    request: validRequest({ schema_version: 1.0 }),
    expect: null,
  },
  {
    name: "accepts count with a read_revision and no list-only fields",
    request: validRequest({ operation: "count", read_revision: 7 }),
    expect: null,
  },
  {
    name: "accepts an in filter at the 20-value cap",
    request: validRequest({
      filters: [
        {
          field: "canonical_name",
          op: "in",
          value: Array.from(
            { length: STRUCTURED_MAX_IN_VALUES },
            (_, i) => `name-${i}`
          ),
        },
      ],
    }),
    expect: null,
  },
  {
    name: "accepts a request encoded at exactly the 32 KiB bound",
    request: AT_SIZE_LIMIT,
    expect: null,
  },
  {
    name: "accepts each member of the closed entity_type catalog",
    request: validRequest({
      filters: [
        {
          field: "type",
          op: "in",
          value: [...ENTITY_TYPES],
        },
      ],
    }),
    expect: null,
  },

  // --- schema token and version (checked separately, ADR 0093) -----------
  {
    name: "refuses a boolean schema_version as malformed_structured_query",
    request: validRequest({ schema_version: true }),
    expect: "malformed_structured_query",
  },
  {
    name: "refuses a fractional schema_version 1.5 as malformed_structured_query",
    request: validRequest({ schema_version: 1.5 }),
    expect: "malformed_structured_query",
  },
  {
    name: 'refuses the string schema_version "1" as malformed_structured_query',
    request: validRequest({ schema_version: "1" }),
    expect: "malformed_structured_query",
  },
  {
    name: "refuses a missing schema_version as malformed_structured_query",
    request: (() => {
      const r = validRequest();
      delete r["schema_version"];
      return r;
    })(),
    expect: "malformed_structured_query",
  },
  {
    name: "refuses an unknown schema token as unsupported_structured_schema",
    request: validRequest({ schema: "iknow.corpus_query" }),
    expect: "unsupported_structured_schema",
  },
  {
    name: "refuses a version-suffixed token as unsupported_structured_schema",
    request: validRequest({ schema: `${STRUCTURED_QUERY_SCHEMA}.v1` }),
    expect: "unsupported_structured_schema",
  },
  {
    name: "refuses schema_version 2 as unsupported_structured_schema",
    request: validRequest({ schema_version: 2 }),
    expect: "unsupported_structured_schema",
  },
  {
    name: "refuses a missing schema token as malformed_structured_query",
    request: (() => {
      const r = validRequest();
      delete r["schema"];
      return r;
    })(),
    expect: "malformed_structured_query",
  },
  {
    name: "refuses a non-string schema token as malformed_structured_query",
    request: validRequest({ schema: 1 }),
    expect: "malformed_structured_query",
  },

  // --- closed subject and operation sets ---------------------------------
  {
    name: "refuses subject outside the closed set as unsupported_subject",
    request: validRequest({ subject: "document" }),
    expect: "unsupported_subject",
  },
  {
    name: "refuses a non-string subject as malformed_structured_query",
    request: validRequest({ subject: 3 }),
    expect: "malformed_structured_query",
  },
  {
    name: "refuses a missing subject as malformed_structured_query",
    request: (() => {
      const r = validRequest();
      delete r["subject"];
      return r;
    })(),
    expect: "malformed_structured_query",
  },
  {
    name: "refuses operation outside list/count as unsupported_operation",
    request: validRequest({ operation: "delete" }),
    expect: "unsupported_operation",
  },
  {
    name: "refuses a missing operation as malformed_structured_query",
    request: (() => {
      const r = validRequest();
      delete r["operation"];
      return r;
    })(),
    expect: "malformed_structured_query",
  },

  // --- per-subject field allowlist and operators -------------------------
  {
    name: "refuses a relation-only field on entity as unsupported_field",
    request: validRequest({
      filters: [{ field: "head_id", op: "eq", value: UUID_HEAD }],
    }),
    expect: "unsupported_field",
  },
  {
    name: "refuses an entity-only field on relation_assertion as unsupported_field",
    request: validRequest({
      subject: "relation_assertion",
      filters: [{ field: "canonical_name", op: "eq", value: "acme" }],
    }),
    expect: "unsupported_field",
  },
  {
    name: "refuses confidence as unsupported_field (no metadata filter exists)",
    request: validRequest({
      filters: [{ field: "confidence", op: "eq", value: "0.9" }],
    }),
    expect: "unsupported_field",
  },
  {
    name: "refuses a raw relation text field as unsupported_field",
    request: validRequest({
      subject: "relation_assertion",
      filters: [{ field: "relation_text", op: "eq", value: "works for" }],
    }),
    expect: "unsupported_field",
  },
  {
    name: "refuses a valid_window field as unsupported_field",
    request: validRequest({
      subject: "relation_assertion",
      filters: [{ field: "valid_window", op: "eq", value: "2024" }],
    }),
    expect: "unsupported_field",
  },
  {
    name: "refuses operator outside eq/in as unsupported_operator",
    request: validRequest({
      filters: [{ field: "canonical_name", op: "gte", value: "a" }],
    }),
    expect: "unsupported_operator",
  },
  {
    name: "refuses a fuzzy operator as unsupported_operator",
    request: validRequest({
      filters: [{ field: "canonical_name", op: "fuzzy", value: "a" }],
    }),
    expect: "unsupported_operator",
  },
  {
    name: "refuses a non-string operator as malformed_structured_query",
    request: validRequest({
      filters: [{ field: "canonical_name", op: 1, value: "a" }],
    }),
    expect: "malformed_structured_query",
  },

  // --- declared value types ----------------------------------------------
  {
    name: "refuses a non-UUID id value as invalid_value",
    request: validRequest({
      filters: [{ field: "id", op: "eq", value: "not-a-uuid" }],
    }),
    expect: "invalid_value",
  },
  {
    name: "refuses a truncated UUID as invalid_value (no implicit padding)",
    request: validRequest({
      filters: [{ field: "id", op: "eq", value: UUID_HEAD.slice(0, 30) }],
    }),
    expect: "invalid_value",
  },
  {
    name: "refuses a braced UUID as invalid_value (canonical form only)",
    request: validRequest({
      filters: [{ field: "id", op: "eq", value: `{${UUID_HEAD}}` }],
    }),
    expect: "invalid_value",
  },
  {
    name: "refuses an entity type outside the catalog as invalid_value",
    request: validRequest({
      filters: [{ field: "type", op: "eq", value: "Location" }],
    }),
    expect: "invalid_value",
  },
  {
    name: "refuses a type alias as invalid_value (no alias expansion)",
    request: validRequest({
      filters: [{ field: "type", op: "eq", value: "company" }],
    }),
    expect: "invalid_value",
  },
  {
    name: "refuses a numeric exact-string value as invalid_value (no coercion)",
    request: validRequest({
      filters: [{ field: "canonical_name", op: "eq", value: 42 }],
    }),
    expect: "invalid_value",
  },
  {
    name: "refuses a boolean exact-string value as invalid_value (no coercion)",
    request: validRequest({
      filters: [{ field: "canonical_name", op: "eq", value: false }],
    }),
    expect: "invalid_value",
  },
  {
    name: "refuses a null in-list value as invalid_value",
    request: validRequest({
      filters: [{ field: "type", op: "in", value: [null] }],
    }),
    expect: "invalid_value",
  },
  {
    name: "refuses a non-canonical UUID inside an in filter as invalid_value",
    request: validRequest({
      subject: "relation_assertion",
      filters: [{ field: "head_id", op: "in", value: [UUID_HEAD, "head"] }],
    }),
    expect: "invalid_value",
  },

  // --- in-list bounds -----------------------------------------------------
  {
    name: "refuses an in filter with zero values as invalid_value",
    request: validRequest({
      filters: [{ field: "canonical_name", op: "in", value: [] }],
    }),
    expect: "invalid_value",
  },
  {
    name: "refuses an in filter with 21 values as invalid_value",
    request: validRequest({
      filters: [
        {
          field: "canonical_name",
          op: "in",
          value: Array.from(
            { length: STRUCTURED_MAX_IN_VALUES + 1 },
            (_, i) => `name-${i}`
          ),
        },
      ],
    }),
    expect: "invalid_value",
  },
  {
    name: "refuses an in filter with duplicate values as invalid_value",
    request: validRequest({
      filters: [
        { field: "canonical_name", op: "in", value: ["acme", "acme"] },
      ],
    }),
    expect: "invalid_value",
  },
  {
    name: "refuses a non-array in value as malformed_structured_query",
    request: validRequest({
      filters: [{ field: "canonical_name", op: "in", value: "acme" }],
    }),
    expect: "malformed_structured_query",
  },

  // --- filter-set rules ---------------------------------------------------
  {
    name: "refuses a duplicate field entry as malformed_structured_query",
    request: validRequest({
      filters: [
        { field: "canonical_name", op: "eq", value: "acme" },
        { field: "canonical_name", op: "in", value: ["other"] },
      ],
    }),
    expect: "malformed_structured_query",
  },
  {
    name: "refuses 17 field filters as invalid_value (16-filter cap)",
    request: validRequest({
      filters: Array.from({ length: STRUCTURED_MAX_FIELD_FILTERS + 1 }, () => ({
        field: "canonical_name",
        op: "eq",
        value: "acme",
      })),
    }),
    expect: "invalid_value",
  },
  {
    name: "refuses a filter entry with an unknown member as malformed_structured_query",
    request: validRequest({
      filters: [
        { field: "id", op: "eq", value: UUID_HEAD, match: "loose" },
      ],
    }),
    expect: "malformed_structured_query",
  },
  {
    name: "refuses a filter entry missing its value as malformed_structured_query",
    request: validRequest({
      filters: [{ field: "canonical_name", op: "eq" }],
    }),
    expect: "malformed_structured_query",
  },
  {
    name: "refuses a non-array filters member as malformed_structured_query",
    request: validRequest({
      filters: { canonical_name: "acme" },
    }),
    expect: "malformed_structured_query",
  },
  {
    name: "refuses a non-object filter entry as malformed_structured_query",
    request: validRequest({ filters: ["canonical_name eq acme"] }),
    expect: "malformed_structured_query",
  },

  // --- relationship predicate --------------------------------------------
  {
    name: "refuses a relationship predicate on entity as malformed_structured_query",
    request: validRequest({
      relationship: { anchor_entity_id: UUID_ANCHOR, direction: "outgoing" },
    }),
    expect: "malformed_structured_query",
  },
  {
    name: "refuses an unknown direction as malformed_structured_query",
    request: validRequest({
      subject: "relation_assertion",
      relationship: { anchor_entity_id: UUID_ANCHOR, direction: "sideways" },
    }),
    expect: "malformed_structured_query",
  },
  {
    name: "refuses a relationship member beyond the closed pair as malformed_structured_query",
    request: validRequest({
      subject: "relation_assertion",
      relationship: {
        anchor_entity_id: UUID_ANCHOR,
        direction: "outgoing",
        hops: 2,
      },
    }),
    expect: "malformed_structured_query",
  },
  {
    name: "refuses a non-canonical relationship anchor as invalid_value",
    request: validRequest({
      subject: "relation_assertion",
      relationship: { anchor_entity_id: "acme", direction: "incoming" },
    }),
    expect: "invalid_value",
  },
  {
    name: "refuses a multi-hop path field as unsupported_field",
    request: validRequest({
      subject: "relation_assertion",
      filters: [{ field: "path", op: "eq", value: `${UUID_HEAD}->${UUID_TAIL}` }],
    }),
    expect: "unsupported_field",
  },

  // --- list bounds and count/list-only separation -------------------------
  {
    name: "refuses limit 0 as invalid_value",
    request: validRequest({ limit: 0 }),
    expect: "invalid_value",
  },
  {
    name: "refuses limit 21 as invalid_value",
    request: validRequest({ limit: STRUCTURED_LIST_MAX_LIMIT + 1 }),
    expect: "invalid_value",
  },
  {
    name: "refuses a fractional limit 20.5 as invalid_value",
    request: validRequest({ limit: 20.5 }),
    expect: "invalid_value",
  },
  {
    name: "refuses a boolean limit as invalid_value (no coercion)",
    request: validRequest({ limit: true }),
    expect: "invalid_value",
  },
  {
    name: "refuses a negative limit as invalid_value",
    request: validRequest({ limit: -1 }),
    expect: "invalid_value",
  },
  {
    name: "refuses an unsafe-integer limit as invalid_value",
    request: validRequest({ limit: Number.MAX_SAFE_INTEGER + 2 }),
    expect: "invalid_value",
  },
  {
    name: "refuses a non-numeric limit as invalid_value",
    request: validRequest({ limit: "20" }),
    expect: "invalid_value",
  },
  {
    name: "refuses limit on count as malformed_structured_query (list-only field)",
    request: validRequest({ operation: "count", limit: 20 }),
    expect: "malformed_structured_query",
  },
  {
    name: "refuses cursor on count as malformed_structured_query (list-only field)",
    request: validRequest({ operation: "count", cursor: "opaque" }),
    expect: "malformed_structured_query",
  },
  {
    name: "refuses a non-string cursor on list as malformed_structured_query",
    request: validRequest({ cursor: 7 }),
    expect: "malformed_structured_query",
  },
  {
    name: "refuses a negative read_revision as invalid_value",
    request: validRequest({ operation: "count", read_revision: -1 }),
    expect: "invalid_value",
  },
  {
    name: "refuses a fractional read_revision as invalid_value",
    request: validRequest({ operation: "count", read_revision: 1.5 }),
    expect: "invalid_value",
  },

  // --- size bound ---------------------------------------------------------
  {
    name: "refuses a 33 KiB request as request_too_large",
    request: validRequest({
      filters: [
        { field: "canonical_name", op: "eq", value: "x".repeat(33 * 1024) },
      ],
    }),
    expect: "request_too_large",
  },
  {
    name: "refuses a request one byte over 32 KiB as request_too_large",
    request: OVER_SIZE_LIMIT,
    expect: "request_too_large",
  },

  // --- host-bound tier ----------------------------------------------------
  {
    name: "refuses a structured request on the graph tier as malformed_structured_query",
    request: validRequest(),
    expect: "malformed_structured_query",
    boundTier: "graph",
  },
  {
    name: "refuses a structured request on the default (absent) tier as malformed_structured_query",
    request: validRequest(),
    expect: "malformed_structured_query",
    boundTier: "unspecified",
  },
  {
    name: "refuses a valid request on the lexical tier before reading its body as malformed_structured_query",
    // Wrong tier is refused without parsing the body, so an unsupported field
    // inside it cannot change the code the host sees.
    request: validRequest({
      filters: [{ field: "confidence", op: "eq", value: "0.9" }],
    }),
    expect: "malformed_structured_query",
    boundTier: "lexical",
  },

  // --- no access widening, no free-form query surface ---------------------
  {
    name: "refuses a request carrying scope_binding as malformed_structured_query",
    request: validRequest({ scope_binding: { tenant: "other" } }),
    expect: "malformed_structured_query",
  },
  {
    name: "refuses a request carrying queried_at as malformed_structured_query",
    request: validRequest({ queried_at: "2024-01-01T00:00:00Z" }),
    expect: "malformed_structured_query",
  },
  {
    name: "refuses a self-selected identity as malformed_structured_query",
    request: validRequest({ identity: { user: "admin" } }),
    expect: "malformed_structured_query",
  },
  {
    name: "refuses an as_user impersonation member as malformed_structured_query",
    request: validRequest({ as_user: "admin" }),
    expect: "malformed_structured_query",
  },
  {
    name: "refuses a raw SQL member as malformed_structured_query",
    request: validRequest({ sql: "SELECT * FROM entities" }),
    expect: "malformed_structured_query",
  },
  {
    name: "refuses a numeric aggregate member as malformed_structured_query",
    request: validRequest({ aggregate: "sum" }),
    expect: "malformed_structured_query",
  },
  {
    name: "refuses a nested boolean filter tree as malformed_structured_query",
    request: validRequest({
      filters: { all: [{ field: "canonical_name", op: "eq", value: "acme" }] },
    }),
    expect: "malformed_structured_query",
  },

  // --- non-object requests ------------------------------------------------
  {
    name: "refuses a null request as malformed_structured_query",
    request: null,
    expect: "malformed_structured_query",
  },
  {
    name: "refuses an array request as malformed_structured_query",
    request: [validRequest()],
    expect: "malformed_structured_query",
  },
  {
    name: "refuses a string request as malformed_structured_query",
    request: "entity",
    expect: "malformed_structured_query",
  },
];

/** Run the validator and return the code it refused with. */
function refusalCode(run: () => unknown): StructuredErrorCode {
  try {
    run();
  } catch (err) {
    expect(err).toBeInstanceOf(StructuredQueryError);
    return (err as StructuredQueryError).code;
  }
  throw new Error("expected a StructuredQueryError refusal");
}

describe("validateStructuredQueryRequest — conformance table", () => {
  for (const row of CONFORMANCE) {
    it(row.name, () => {
      if (row.expect === null) {
        // An accepted row must return a real result, never a partial or an
        // empty-success stand-in.
        const validated = validateStructuredQueryRequest(
          row.request,
          row.boundTier ?? SQL_TIER
        );
        expect(validated.subject).toBeTypeOf("string");
        expect(validated.operation).toBeTypeOf("string");
        return;
      }
      expect(
        refusalCode(() =>
          validateStructuredQueryRequest(row.request, row.boundTier ?? SQL_TIER)
        )
      ).toBe(row.expect);
    });
  }

  it("covers all eight QP4-owned codes at least once", () => {
    const owned: readonly StructuredErrorCode[] = [
      "malformed_structured_query",
      "unsupported_structured_schema",
      "unsupported_subject",
      "unsupported_operation",
      "unsupported_field",
      "unsupported_operator",
      "invalid_value",
      "request_too_large",
    ];
    const covered = new Set(CONFORMANCE.map((row) => row.expect));
    for (const code of owned) {
      expect(covered).toContain(code);
    }
  });

  it("normalizes an accepted request: default limit, empty filters, no relationship", () => {
    const validated = validateStructuredQueryRequest(validRequest(), SQL_TIER);
    expect(validated.subject).toBe("entity");
    expect(validated.operation).toBe("list");
    expect(validated.limit).toBe(STRUCTURED_LIST_DEFAULT_LIMIT);
    expect(validated.filters).toEqual([]);
    expect(validated.relationship).toBeUndefined();
    expect(validated.cursor).toBeUndefined();
    expect(validated.readRevision).toBeUndefined();
  });

  it("normalizes a count request to no limit and no cursor", () => {
    const validated = validateStructuredQueryRequest(
      validRequest({ operation: "count" }),
      SQL_TIER
    );
    expect(validated.operation).toBe("count");
    expect(validated.limit).toBeUndefined();
    expect(validated.cursor).toBeUndefined();
  });

  it("keeps eq and in distinguishable for execution", () => {
    const validated = validateStructuredQueryRequest(
      validRequest({
        subject: "relation_assertion",
        filters: [
          { field: "head_id", op: "eq", value: UUID_HEAD },
          { field: "relation_norm", op: "in", value: ["works_for", "located_in"] },
        ],
        relationship: { anchor_entity_id: UUID_ANCHOR, direction: "incoming" },
      }),
      SQL_TIER
    );
    expect(validated.filters).toEqual([
      { field: "head_id", op: "eq", value: UUID_HEAD },
      {
        field: "relation_norm",
        op: "in",
        values: ["works_for", "located_in"],
      },
    ]);
    expect(validated.relationship).toEqual({
      anchorEntityId: UUID_ANCHOR,
      direction: "incoming",
    });
  });
});

/**
 * The control-key discipline. `filters` is an exact-match contract: a
 * leftover `structured_query` key would reach a backend as a term clause no
 * index can satisfy, silently zeroing the arm instead of answering.
 */
describe("stripStructuredQueryFilter", () => {
  it("removes the structured key and keeps the string filters beside it", () => {
    expect(
      stripStructuredQueryFilter({
        source_ref: "docs/a.md",
        [STRUCTURED_QUERY_FILTER_KEY]: { subject: "entity" },
      })
    ).toEqual({ source_ref: "docs/a.md" });
  });

  it("returns undefined when the structured key was the only filter", () => {
    expect(
      stripStructuredQueryFilter({ [STRUCTURED_QUERY_FILTER_KEY]: {} })
    ).toBeUndefined();
  });

  it("passes a filter map without the key through unchanged", () => {
    const filters = { source_ref: "docs/a.md" };
    expect(stripStructuredQueryFilter(filters)).toBe(filters);
    expect(stripStructuredQueryFilter(undefined)).toBeUndefined();
  });
});

describe("retrieve input schema — the one widened filter value", () => {
  it("accepts an object-valued structured_query beside string filters", () => {
    const parsed = RetrieveInputSchema.safeParse({
      query: "acme contracts",
      filters: {
        search_mode: "sql",
        source_ref: "docs/a.md",
        [STRUCTURED_QUERY_FILTER_KEY]: validRequest(),
      },
    });
    expect(parsed.success).toBe(true);
  });

  it("keeps every non-structured filter value a string", () => {
    const parsed = RetrieveInputSchema.safeParse({
      query: "acme",
      filters: { source_ref: 7 },
    });
    expect(parsed.success).toBe(false);
  });

  it("still refuses an object under a non-structured filter key", () => {
    const parsed = RetrieveInputSchema.safeParse({
      query: "acme",
      filters: { source_ref: { nested: true } },
    });
    expect(parsed.success).toBe(false);
  });

  it("still refuses unknown top-level keys (strictObject contract)", () => {
    const parsed = RetrieveInputSchema.safeParse({
      query: "acme",
      structured_request: validRequest(),
    });
    expect(parsed.success).toBe(false);
  });
});

/**
 * The handler is where the closed request meets a real arm. Two properties are
 * load-bearing here: a structurally valid request never reaches the legacy
 * business ledger, and no structured request is answered as an empty success.
 */
describe("createRetrieveHandler — structured request routing", () => {
  const TEST_DIM = 1536;
  let ledgerCalls: number;
  let storageSearches: Array<SearchOptions["filters"]>;
  let handler: ReturnType<typeof createRetrieveHandler>;

  beforeEach(() => {
    ledgerCalls = 0;
    storageSearches = [];
    const backend = new MemoryBackend(TEST_DIM);
    const spy = backend as unknown as {
      search: (q: string, opts: SearchOptions) => Promise<unknown>;
    };
    backend.search = async (_q: string, opts: SearchOptions) => {
      storageSearches.push(opts.filters);
      return spy.search.bind(backend)(_q, opts);
    };
    // A provisioned ledger, so "no ledger execution" is a real observation and
    // not a side effect of the not-provisioned exit.
    const executor = {
      query: async () => {
        ledgerCalls += 1;
        return { rows: [], rowCount: 0 };
      },
    } as unknown as BusinessQueryExecutor;
    handler = createRetrieveHandler({
      embedder: new FakeEmbedder(TEST_DIM),
      storage: backend,
      businessQuery: executor,
    });
  });

  it("refuses a valid structured request as structured_search_unavailable and never executes the ledger", async () => {
    const code = await refusalCodeOf(async () => {
      await handler({
        query: "acme contracts",
        filters: {
          search_mode: "sql",
          [STRUCTURED_QUERY_FILTER_KEY]: validRequest(),
        },
      });
    });
    expect(code).toBe("structured_search_unavailable");
    expect(ledgerCalls).toBe(0);
    expect(storageSearches).toEqual([]);
  });

  it("refuses the same request on the graph tier without touching storage", async () => {
    const code = await refusalCodeOf(async () => {
      await handler({
        query: "acme contracts",
        filters: { [STRUCTURED_QUERY_FILTER_KEY]: validRequest() },
      });
    });
    expect(code).toBe("malformed_structured_query");
    expect(ledgerCalls).toBe(0);
    expect(storageSearches).toEqual([]);
  });

  it("refuses a SQL-shaped structured request as malformed_structured_query", async () => {
    const code = await refusalCodeOf(async () => {
      await handler({
        query: "acme contracts",
        filters: {
          search_mode: "sql",
          [STRUCTURED_QUERY_FILTER_KEY]: validRequest({
            sql: "SELECT * FROM entities",
          }),
        },
      });
    });
    expect(code).toBe("malformed_structured_query");
    expect(ledgerCalls).toBe(0);
  });

  it("keeps answering ordinary retrieves on the same tool", async () => {
    const result = await handler({
      query: "acme contracts",
      filters: { search_mode: "sql" },
    });
    // No structured request, so the sql arm runs as before: with a stub
    // executor provisioned it answers its own envelope, not a refusal.
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0]?.text ?? "{}")).toHaveProperty(
      "chunks"
    );
  });
});

/** Await the handler and return the code it refused with. */
async function refusalCodeOf(
  run: () => Promise<unknown>
): Promise<StructuredErrorCode> {
  try {
    await run();
  } catch (err) {
    expect(err).toBeInstanceOf(StructuredQueryError);
    return (err as StructuredQueryError).code;
  }
  throw new Error("expected a StructuredQueryError refusal");
}
