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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ENTITY_TYPES } from "../../src/core/extraction/entity-type.js";
import {
  STRUCTURED_ERROR_RETRYABLE,
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
import { GraphragError, failureTokenOf } from "../../src/core/errors.js";
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
    name: "accepts count with an opaque read_revision and no list-only fields",
    request: validRequest({ operation: "count", read_revision: "rev-118" }),
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
    name: "refuses read_revision on list as malformed_structured_query (count-only field)",
    request: validRequest({ read_revision: "rev-118" }),
    expect: "malformed_structured_query",
  },
  {
    name: "refuses a numeric read_revision as invalid_value",
    request: validRequest({ operation: "count", read_revision: 7 }),
    expect: "invalid_value",
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
  {
    name: "refuses a zero read_revision as invalid_value",
    request: validRequest({ operation: "count", read_revision: 0 }),
    expect: "invalid_value",
  },
  {
    name: "refuses a null read_revision as invalid_value",
    request: validRequest({ operation: "count", read_revision: null }),
    expect: "invalid_value",
  },
  {
    name: "refuses a boolean read_revision as invalid_value",
    request: validRequest({ operation: "count", read_revision: true }),
    expect: "invalid_value",
  },
  {
    name: "refuses an array read_revision as invalid_value",
    request: validRequest({ operation: "count", read_revision: ["rev-118"] }),
    expect: "invalid_value",
  },
  {
    name: "refuses an object read_revision as invalid_value",
    request: validRequest({ operation: "count", read_revision: { value: "rev-118" } }),
    expect: "invalid_value",
  },
  {
    name: "refuses an empty read_revision as invalid_value",
    request: validRequest({ operation: "count", read_revision: "" }),
    expect: "invalid_value",
  },
  {
    name: "refuses a blank read_revision as invalid_value",
    request: validRequest({ operation: "count", read_revision: "   " }),
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

  it("keeps a uuid filter's case EXACTLY as the caller sent it", () => {
    // The `preserve` half of the shared UUID primitive, stated at this
    // boundary. The identity layer deliberately canonicalizes case — every
    // spelling of one entity must derive one id — but here PG's `uuid`
    // comparison is case-insensitive, so an uppercase id still matches the
    // stored lowercase row and the caller's value is passed through
    // untouched. If this ever starts folding case, the two boundaries have
    // silently collapsed onto one policy.
    const upper = "00000000-0000-4000-8000-00000000000A";
    const lower = upper.toLowerCase();
    for (const sent of [upper, lower]) {
      const validated = validateStructuredQueryRequest(
        validRequest({ filters: [{ field: "id", op: "eq", value: sent }] }),
        SQL_TIER
      );
      expect(validated.filters).toEqual([
        { field: "id", op: "eq", value: sent },
      ]);
    }
    // The shape is still closed on BOTH policies: a decorator spelling the
    // identity layer tolerates is not a UUID the request boundary accepts.
    for (const bad of [`{${upper}}`, `urn:uuid:${upper}`]) {
      expect(
        refusalCode(() =>
          validateStructuredQueryRequest(
            validRequest({ filters: [{ field: "id", op: "eq", value: bad }] }),
            SQL_TIER
          )
        )
      ).toBe("invalid_value");
    }
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

  it("preserves opaque count read_revision tokens exactly", () => {
    for (const readRevision of ["rev-118", "0007:alpha", " rev-118 "]) {
      const validated = validateStructuredQueryRequest(
        validRequest({ operation: "count", read_revision: readRevision }),
        SQL_TIER
      );
      expect(validated.readRevision).toBe(readRevision);
    }
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
    ).toEqual({ kind: "ok", filters: { source_ref: "docs/a.md" } });
  });

  it("returns no filters when the structured key was the only filter", () => {
    // The call shape must stay identical to a request that carried none.
    expect(
      stripStructuredQueryFilter({ [STRUCTURED_QUERY_FILTER_KEY]: {} })
    ).toEqual({ kind: "ok", filters: undefined });
  });

  it("keeps a filter map that never carried the key, pair for pair", () => {
    // The observable contract is the surviving key/value pairs, NOT the
    // identity of the returned object. Asserting `toBe` here pinned an
    // implementation shortcut — handing back the caller's own object
    // un-copied — which is precisely the shortcut the unverified cast sat
    // behind, so it could not have caught a value being dropped.
    const filters = { source_ref: "docs/a.md", search_mode: "sql" };
    expect(stripStructuredQueryFilter(filters)).toEqual({
      kind: "ok",
      filters: { source_ref: "docs/a.md", search_mode: "sql" },
    });
    expect(stripStructuredQueryFilter(undefined)).toEqual({
      kind: "ok",
      filters: undefined,
    });
  });

  it("preserves a JSON __proto__ filter key instead of silently dropping it", () => {
    const filters = JSON.parse(
      '{"structured_query":{"schema":"iknow.structured_query","schema_version":1,"subject":"entity","operation":"list"},"__proto__":"caller-value"}'
    ) as Record<string, unknown>;

    const stripped = stripStructuredQueryFilter(filters);

    expect(stripped.kind).toBe("ok");
    if (stripped.kind === "ok") {
      expect(Object.hasOwn(stripped.filters ?? {}, "__proto__")).toBe(true);
      expect((stripped.filters as Record<string, unknown>)?.["__proto__"]).toBe(
        "caller-value"
      );
    }
  });

  it("REFUSES a non-string value under a non-structured key instead of dropping it", () => {
    // Only `structured_query` is allowed an object. Anything else is a
    // non-string under a non-structured key, and it used to vanish: the
    // filter reached the arms missing, so the arm answered a NARROWER
    // question than the caller asked, with no refusal anywhere. Named loudly
    // instead, so the handler can refuse before any arm runs.
    for (const [key, value] of [
      ["source_ref", { nested: true }],
      ["community_level", 2],
      ["entity_type", null],
      ["search_mode", ["sql"]],
    ] as const) {
      expect(
        stripStructuredQueryFilter({
          [key]: value,
          [STRUCTURED_QUERY_FILTER_KEY]: { subject: "entity" },
        }),
        `filters.${key} = ${JSON.stringify(value)} was silently dropped`
      ).toEqual({ kind: "invalid", key, received: typeof value });
    }
  });

  it("loses no value: every non-structured entry either survives or refuses", () => {
    // The property, stated once over a mixed map: a strip may refuse, but it
    // may never hand the arms a map that is missing an entry the caller sent.
    const filters = {
      source_ref: "docs/a.md",
      [STRUCTURED_QUERY_FILTER_KEY]: { subject: "entity" },
      community_level: 2,
    };
    const stripped = stripStructuredQueryFilter(filters);
    if (stripped.kind === "invalid") {
      expect(
        Object.hasOwn(filters, stripped.key),
        "refused a key the caller never sent"
      ).toBe(true);
    } else {
      for (const [key, value] of Object.entries(filters)) {
        if (key === STRUCTURED_QUERY_FILTER_KEY) continue;
        expect(stripped.filters, `filters.${key} was dropped`).toHaveProperty(
          [key],
          value
        );
      }
    }
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
    // This handler has NO structured reader and a PROVISIONED ledger, so the
    // code observed here is the SPEC's capability trigger — "backend capability
    // unavailable" — and not the retired "no execution path exists" exit. The
    // ledger assertions below are the load-bearing half and are unchanged: a
    // structured request must never reach the sql arm, whether or not a reader
    // is injected.
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

  it("refuses a non-string value under a NON-structured filter key instead of dropping it", async () => {
    // The strip cannot refuse by throwing (it is a routing-key leaf with no
    // error vocabulary of its own), so it returns a typed resolution and the
    // handler turns it into the same INVALID_INPUT the other routing keys use.
    // What matters here: the arm never runs with the filter silently missing.
    let caught: unknown;
    try {
      await handler({
        query: "acme contracts",
        filters: { search_mode: "sql", source_ref: { nested: true } },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GraphragError);
    // The same typed refusal the other routing keys (search_mode, entity_type,
    // community_level) already publish, so no second error envelope is needed.
    expect((caught as GraphragError).code).toBe("INVALID_INPUT");
    expect(failureTokenOf(caught)).toBeUndefined();
    expect((caught as Error).message).toContain("source_ref");
    expect(ledgerCalls).toBe(0);
    expect(storageSearches).toEqual([]);
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

/**
 * The error vocabulary itself, and the QP4 ownership boundary.
 *
 * `STRUCTURED_ERROR_RETRYABLE` is the most cross-repo-consumed artifact the
 * structured contract has — fin maps every flag onto its own typed retrieve
 * failures — and it carried no assertion at all, so a flag could flip without a
 * single test noticing. The ownership half is just as unenforced: the plan
 * assigns exactly eight codes to QP4, but nothing stopped a ninth from being
 * thrown out of `request.ts`, and an unowned code would reach the host
 * classified with a retryability nobody agreed to.
 *
 * Two deliberately overlapping guards. The behavioural one drives the validator
 * over one input per refusal site, so the input→code mapping stays reviewable
 * and all eight are proven genuinely reachable. The source scan is the half that
 * survives a NEW site: a ninth code at a site no input reaches yet would slip
 * straight past a behavioural set, so the scan reads the codes the module can
 * actually name and requires them to be exactly the eight.
 */

/** The eight codes the plan assigns to QP4 (request validation). */
const QP4_OWNED_CODES: readonly StructuredErrorCode[] = [
  "malformed_structured_query",
  "unsupported_structured_schema",
  "unsupported_subject",
  "unsupported_operation",
  "unsupported_field",
  "unsupported_operator",
  "invalid_value",
  "request_too_large",
];

/** The contract's full 18-code vocabulary, with the flag each code carries. */
const CONTRACT_RETRYABLE: Readonly<Record<StructuredErrorCode, boolean>> = {
  malformed_structured_query: false,
  unsupported_structured_schema: false,
  unsupported_subject: false,
  unsupported_operation: false,
  unsupported_field: false,
  unsupported_operator: false,
  invalid_value: false,
  request_too_large: false,
  authorization_denied: false,
  invalid_cursor: false,
  cursor_expired: false,
  cursor_revision_mismatch: false,
  read_revision_mismatch: false,
  result_too_large: false,
  count_unavailable: true,
  query_timeout: true,
  structured_search_unavailable: true,
  maintenance_status_unavailable: true,
};

describe("the closed error vocabulary and the QP4 ownership boundary", () => {
  it("declares exactly the contract's 18 codes with exactly the contract's flags", () => {
    // A single wrong flag fails here: `toEqual` on the whole map compares every
    // value, so `count_unavailable: false` is caught just as a missing key is.
    expect(STRUCTURED_ERROR_RETRYABLE).toEqual(CONTRACT_RETRYABLE);
    expect(Object.keys(STRUCTURED_ERROR_RETRYABLE).sort()).toEqual(
      Object.keys(CONTRACT_RETRYABLE).sort()
    );
    // Retryability is a property of the CODE, so every code must have a flag
    // rather than defaulting: a boolean here, never undefined.
    for (const [code, retryable] of Object.entries(STRUCTURED_ERROR_RETRYABLE)) {
      expect(typeof retryable, `${code} has no boolean retryable flag`).toBe(
        "boolean"
      );
    }
    // The four transient exits are the only retryable ones, and they are the
    // execution-side codes — a request-side refusal is the caller's to fix.
    expect(
      Object.entries(STRUCTURED_ERROR_RETRYABLE)
        .filter(([, retryable]) => retryable)
        .map(([code]) => code)
        .sort()
    ).toEqual([
      "count_unavailable",
      "maintenance_status_unavailable",
      "query_timeout",
      "structured_search_unavailable",
    ]);
  });

  it("refuses exactly the eight QP4-owned codes across every refusal site", () => {
    // One violating input per refusal site in `request.ts`. Named by site so a
    // new site that reuses an existing code cannot hide behind the set below:
    // every row must still be REFUSED, which a new accept-path would break.
    const sites: ReadonlyArray<{
      site: string;
      request: unknown;
      boundTier?: string;
    }> = [
      // container + tier
      { site: "not an object", request: "nope" },
      {
        site: "tier other than sql",
        request: validRequest(),
        boundTier: "graph",
      },
      // size bound
      { site: "over 32 KiB", request: OVER_SIZE_LIMIT },
      // schema token + version, checked separately (ADR 0093)
      { site: "schema not a string", request: validRequest({ schema: 1 }) },
      { site: "unknown schema token", request: validRequest({ schema: "x.y" }) },
      {
        site: "schema_version not a whole number",
        request: validRequest({ schema_version: "1" }),
      },
      { site: "schema_version not 1", request: validRequest({ schema_version: 2 }) },
      // closed subject / operation tokens
      { site: "subject not a string", request: validRequest({ subject: 1 }) },
      { site: "subject outside the set", request: validRequest({ subject: "doc" }) },
      {
        site: "operation not a string",
        request: validRequest({ operation: null }),
      },
      {
        site: "operation outside the set",
        request: validRequest({ operation: "delete" }),
      },
      // closed member set
      { site: "unknown top-level member", request: validRequest({ sql: "SELECT 1" }) },
      // filters container + cap
      { site: "filters not an array", request: validRequest({ filters: {} }) },
      {
        site: "over the 16-filter cap",
        request: validRequest({
          filters: Array.from({ length: 17 }, () => ({
            field: "canonical_name",
            op: "eq",
            value: "a",
          })),
        }),
      },
      // one filter entry
      { site: "entry not an object", request: validRequest({ filters: ["x"] }) },
      {
        site: "entry has an unknown member",
        request: validRequest({
          filters: [{ field: "id", op: "eq", value: UUID_HEAD, extra: 1 }],
        }),
      },
      {
        site: "field not a string",
        request: validRequest({ filters: [{ field: 1, op: "eq", value: "a" }] }),
      },
      {
        site: "field not filterable on this subject",
        request: validRequest({ subject: "entity", filters: [{ field: "head_id", op: "eq", value: UUID_HEAD }] }),
      },
      {
        site: "repeats a field",
        request: validRequest({
          filters: [
            { field: "id", op: "eq", value: UUID_HEAD },
            { field: "id", op: "eq", value: UUID_TAIL },
          ],
        }),
      },
      {
        site: "missing the required value",
        request: validRequest({ filters: [{ field: "id", op: "eq" }] }),
      },
      // operator
      {
        site: "op not a string",
        request: validRequest({ filters: [{ field: "id", op: 1, value: UUID_HEAD }] }),
      },
      {
        site: "op outside the closed set",
        request: validRequest({ filters: [{ field: "id", op: "gte", value: UUID_HEAD }] }),
      },
      // declared value types
      {
        site: "value is not a string",
        request: validRequest({ filters: [{ field: "canonical_name", op: "eq", value: 7 }] }),
      },
      {
        site: "uuid value is not a UUID",
        request: validRequest({ filters: [{ field: "id", op: "eq", value: "nope" }] }),
      },
      {
        site: "entity_type outside the catalog",
        request: validRequest({ filters: [{ field: "type", op: "eq", value: "concept" }] }),
      },
      // in-list
      {
        site: "in value is not an array",
        request: validRequest({ filters: [{ field: "id", op: "in", value: UUID_HEAD }] }),
      },
      {
        site: "in-list empty",
        request: validRequest({ filters: [{ field: "id", op: "in", value: [] }] }),
      },
      {
        site: "in-list over 20 values",
        request: validRequest({
          filters: [
            {
              field: "id",
              op: "in",
              value: Array.from({ length: 21 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`),
            },
          ],
        }),
      },
      {
        site: "in-list repeats a value",
        request: validRequest({
          filters: [{ field: "id", op: "in", value: [UUID_HEAD, UUID_HEAD] }],
        }),
      },
      // relationship predicate
      {
        site: "relationship on an entity subject",
        request: validRequest({
          relationship: { anchor_entity_id: UUID_ANCHOR, direction: "outgoing" },
        }),
      },
      {
        site: "relationship not an object",
        request: validRequest({ subject: "relation_assertion", relationship: "x" }),
      },
      {
        site: "relationship has an unknown member",
        request: validRequest({
          subject: "relation_assertion",
          relationship: { anchor_entity_id: UUID_ANCHOR, direction: "outgoing", hops: 2 },
        }),
      },
      {
        site: "relationship direction outside the set",
        request: validRequest({
          subject: "relation_assertion",
          relationship: { anchor_entity_id: UUID_ANCHOR, direction: "sideways" },
        }),
      },
      {
        site: "anchor_entity_id is not a UUID",
        request: validRequest({
          subject: "relation_assertion",
          relationship: { anchor_entity_id: "nope", direction: "outgoing" },
        }),
      },
      // operation members + counters
      {
        site: "count carries a list-only member",
        request: validRequest({ operation: "count", limit: 5 }),
      },
      {
        site: "cursor is not a string",
        request: validRequest({ cursor: 7 }),
      },
      {
        site: "limit is not a safe integer",
        request: validRequest({ limit: 0 }),
      },
      {
        site: "read_revision is count-only",
        request: validRequest({ read_revision: "rev-118" }),
      },
    ];

    const observed = new Set<StructuredErrorCode>();
    for (const { site, request, boundTier } of sites) {
      // Every site must still be REFUSED. A row that started being accepted
      // fails here even when its code is one the eight already cover.
      let code: StructuredErrorCode;
      try {
        code = refusalCode(() =>
          validateStructuredQueryRequest(request, boundTier ?? SQL_TIER)
        );
      } catch (err) {
        throw new Error(`site "${site}" is no longer refused: ${String(err)}`);
      }
      observed.add(code);
    }
    // The boundary: the union of every code this module produced is exactly the
    // eight QP4 owns — no unowned ninth, and no owned code left unreachable.
    expect([...observed].sort()).toEqual([...QP4_OWNED_CODES].sort());
  });

  it("names no code outside the eight QP4 owns anywhere in request.ts", () => {
    // The half the behavioural set above structurally cannot provide: a code
    // named at a site no input reaches yet would be invisible to it. Comments
    // are stripped first so the docblock's list of what this module throws
    // cannot satisfy — or trip — the scan on its own.
    const source = readFileSync(
      fileURLToPath(new URL("../../src/core/structured/request.ts", import.meta.url)),
      "utf8"
    );
    const names = new Set<string>();
    for (const literal of stripComments(source).matchAll(/"([a-z][a-z_]*)"/g)) {
      names.add(literal[1]!);
    }
    const contractCodes = new Set(Object.keys(CONTRACT_RETRYABLE));
    const refused = [...names].filter((name) => contractCodes.has(name)).sort();
    expect(refused, "request.ts names a code QP4 does not own").toEqual(
      [...QP4_OWNED_CODES].sort()
    );
    // Sanity that the scan is not vacuous: it did find codes to compare.
    expect(refused.length).toBeGreaterThan(0);
  });
});

/** Blank out comments so a source scan reads code, not prose. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}
