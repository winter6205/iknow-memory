/**
 * QP4 — validation of the bounded structured request carried in MCP
 * `filters.structured_query` (specs/structured-corpus-query §Query contract →
 * Request).
 *
 * The request is a CLOSED surface, so this module is written to make one
 * violating input produce exactly one typed refusal:
 *
 *   - `malformed_structured_query` — the request is not a well-formed instance
 *     of the shape: wrong container, missing/extra member, a member whose JSON
 *     type is wrong, a closed-set token that should be a shape token, an
 *     illegal combination (count carrying list-only fields, `relationship` on an
 *     entity), or a tier other than the host-bound `sql`.
 *   - `unsupported_structured_schema` — the schema token is unknown, or its
 *     integer version is not 1.
 *   - `unsupported_subject` / `unsupported_operation` / `unsupported_field` /
 *     `unsupported_operator` — a string token outside its closed set.
 *   - `invalid_value` — the value violates the type or bound declared for it
 *     (non-canonical UUID, non-catalog entity type, an `in` list outside
 *     1–20 unique values, a limit/read_revision that is not a finite safe
 *     integer in range).
 *   - `request_too_large` — the encoded request exceeds 32 KiB.
 *
 * Two SPEC decisions are load-bearing and easy to get wrong:
 *
 * 1. The token and the version are checked SEPARATELY (ADR 0093). `1` and the
 *    JSON `1.0` (which decodes to the same number) are both accepted, while a
 *    boolean, a fraction, or a string is `malformed_structured_query` and a
 *    whole integer other than 1 is `unsupported_structured_schema`. Versioning
 *    lives in `schema_version`, never in a token suffix.
 * 2. The request cannot override the host-bound search mode and cannot widen
 *    access. The bound tier arrives from the caller, and no member of the
 *    request may select an identity, a scope binding, or a query time — those
 *    are simply not in the member set, so they are refused as unknown members.
 *
 * There is deliberately no SQL, boolean tree, join, free-text claim,
 * aggregation, fuzzy match, or multi-hop path here: the interface cannot
 * express them, which is stronger than validating them away.
 */
import { ENTITY_TYPES } from "../extraction/entity-type.js";
import { StructuredQueryError, type StructuredErrorCode } from "./errors.js";

/** The recognized token. A version suffix makes it an UNKNOWN token. */
export const STRUCTURED_QUERY_SCHEMA = "iknow.structured_query";

/** The only supported integer version. */
export const STRUCTURED_QUERY_SCHEMA_VERSION = 1;

/** The bound on the complete UTF-8 encoded request, in bytes. */
export const STRUCTURED_REQUEST_MAX_BYTES = 32 * 1024;

/** Distinct field filters per request. */
export const STRUCTURED_MAX_FIELD_FILTERS = 16;

/** Values in one `in` predicate. */
export const STRUCTURED_MAX_IN_VALUES = 20;

/** Page size when a list request omits `limit`. */
export const STRUCTURED_LIST_DEFAULT_LIMIT = 20;

/** Hard page cap; also the list `limit` maximum. */
export const STRUCTURED_LIST_MAX_LIMIT = 20;

/** The closed subject set. */
export type StructuredSubject = "entity" | "relation_assertion";

/** The closed operation set. */
export type StructuredOperation = "list" | "count";

/** The closed operator set. */
export type StructuredOperator = "eq" | "in";

/** Which side of the one-hop relationship predicate binds the anchor. */
export type StructuredRelationshipDirection = "outgoing" | "incoming";

/**
 * Declared value type of a filter field. Execution reuses this instead of
 * re-deriving the SPEC table, so the allowlist below stays the only copy.
 */
export type StructuredFieldValueKind = "uuid" | "string" | "entity_type";

export type StructuredEntityFilterField = "id" | "canonical_name" | "type";

export type StructuredRelationAssertionFilterField =
  | "id"
  | "head_id"
  | "relation_norm"
  | "tail_id"
  | "source_ref";

export type StructuredFilterField =
  | StructuredEntityFilterField
  | StructuredRelationAssertionFilterField;

/**
 * The per-subject allowlist (SPEC table). A field absent from a subject's row
 * is `unsupported_field` — including the fields that exist in storage but are
 * deliberately not filterable (confidence, raw relation text, `valid_window`,
 * source version, location).
 */
export const STRUCTURED_FILTER_FIELDS_BY_SUBJECT: Readonly<
  Record<StructuredSubject, Readonly<Record<string, StructuredFieldValueKind>>>
> = {
  entity: {
    id: "uuid",
    canonical_name: "string",
    type: "entity_type",
  },
  relation_assertion: {
    id: "uuid",
    head_id: "uuid",
    relation_norm: "string",
    tail_id: "uuid",
    source_ref: "string",
  },
};

/** One validated exact test. `in` carries 1–20 unique values. */
export type ValidatedStructuredFilter =
  | { field: StructuredFilterField; op: "eq"; value: string }
  | {
      field: StructuredFilterField;
      op: "in";
      values: readonly string[];
    };

/** The optional one-hop relationship predicate (relation assertions only). */
export interface ValidatedStructuredRelationship {
  anchorEntityId: string;
  direction: StructuredRelationshipDirection;
}

/** A request that passed every bound. Execution is a later ticket. */
export interface ValidatedStructuredQuery {
  subject: StructuredSubject;
  operation: StructuredOperation;
  /** At most 16 distinct fields, in request order. */
  filters: readonly ValidatedStructuredFilter[];
  relationship: ValidatedStructuredRelationship | undefined;
  /** Effective page size for `list` (defaulted); always undefined for `count`. */
  limit: number | undefined;
  /** Opaque continuation token, unvalidated here — `invalid_cursor` is QP6's. */
  cursor: string | undefined;
  /** Requested data revision; staleness is a QP6/QP7 typed refusal. */
  readRevision: number | undefined;
}

/** Top-level members the SPEC declares. Anything else is refused. */
const REQUEST_MEMBERS: ReadonlySet<string> = new Set([
  "schema",
  "schema_version",
  "subject",
  "operation",
  "filters",
  "relationship",
  "limit",
  "cursor",
  "read_revision",
]);

/** Members of one filter entry; `value` is required and typed by the field. */
const FILTER_MEMBERS: ReadonlySet<string> = new Set(["field", "op", "value"]);

/** The closed pair of the relationship predicate. */
const RELATIONSHIP_MEMBERS: ReadonlySet<string> = new Set([
  "anchor_entity_id",
  "direction",
]);

/**
 * Canonical 8-4-4-4-12 hex, the same closed pattern the dashboard detail
 * route uses for PG `uuid` columns (which are case-insensitive). A
 * non-canonical spelling is `invalid_value` rather than a lookup miss: it is a
 * malformed filter, not an empty result.
 */
const CANONICAL_UUID =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const ENCODER = new TextEncoder();

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function refuse(code: StructuredErrorCode, message: string): never {
  throw new StructuredQueryError(message, code);
}

/**
 * Validate an untrusted structured request.
 *
 * `boundTier` is the host-resolved search mode, never a request member: the
 * request may not select its own tier, so a request on a tier other than `sql`
 * refuses before any of its body is read.
 *
 * Throws `StructuredQueryError` on every refusal. It never returns a partial
 * or empty-success result, and it never interprets SQL, a boolean tree, a join,
 * a claim, an aggregation, a fuzzy match, or a multi-hop path.
 */
export function validateStructuredQueryRequest(
  raw: unknown,
  boundTier: string
): ValidatedStructuredQuery {
  if (!isPlainObject(raw)) {
    refuse(
      "malformed_structured_query",
      "structured_query must be a JSON object"
    );
  }
  if (boundTier !== "sql") {
    refuse(
      "malformed_structured_query",
      `structured_query may only ride the host-bound sql tier, got "${boundTier}"`
    );
  }
  // The size bound is read before the body, so an over-large request is refused
  // as a resource fact rather than after a walk of its contents.
  if (encodedSize(raw) > STRUCTURED_REQUEST_MAX_BYTES) {
    refuse(
      "request_too_large",
      `structured_query exceeds ${STRUCTURED_REQUEST_MAX_BYTES} UTF-8 bytes`
    );
  }

  requireRecognizedSchema(raw);
  // The closed subject set is the key set of the field allowlist above, so the
  // two cannot drift apart.
  const subject = readClosedToken(
    raw["subject"],
    STRUCTURED_FILTER_FIELDS_BY_SUBJECT,
    "unsupported_subject",
    "subject"
  ) as StructuredSubject;
  const operation = readClosedToken(
    raw["operation"],
    { list: true, count: true },
    "unsupported_operation",
    "operation"
  ) as StructuredOperation;
  requireKnownMembers(raw);

  return {
    subject,
    operation,
    filters: readFilters(raw["filters"], subject),
    relationship: readRelationship(raw["relationship"], subject),
    ...readOperationMembers(raw, operation),
  };
}

/**
 * The token and the version are checked separately (ADR 0093): an unknown
 * token and a recognized token carrying a different whole version are both
 * `unsupported_structured_schema`, while a version that is not a finite whole
 * number is malformed — there is no version to disagree about.
 */
function requireRecognizedSchema(members: Readonly<Record<string, unknown>>): void {
  const schema = members["schema"];
  if (typeof schema !== "string") {
    refuse(
      "malformed_structured_query",
      "structured_query.schema must be a string"
    );
  }
  if (schema !== STRUCTURED_QUERY_SCHEMA) {
    refuse(
      "unsupported_structured_schema",
      `unknown structured_query schema token "${schema}"`
    );
  }
  const version = members["schema_version"];
  if (
    typeof version !== "number" ||
    !Number.isFinite(version) ||
    !Number.isInteger(version)
  ) {
    refuse(
      "malformed_structured_query",
      "structured_query.schema_version must be a finite whole number"
    );
  }
  if (version !== STRUCTURED_QUERY_SCHEMA_VERSION) {
    refuse(
      "unsupported_structured_schema",
      `unsupported structured_query schema_version ${version}`
    );
  }
}

/**
 * No input may widen access, so the member set is closed: `scope_binding`,
 * `queried_at`, a self-selected identity, SQL, a boolean tree, an aggregate,
 * and a multi-hop path are not members this request can have.
 */
function requireKnownMembers(members: Readonly<Record<string, unknown>>): void {
  for (const key of Object.keys(members)) {
    if (!REQUEST_MEMBERS.has(key)) {
      refuse(
        "malformed_structured_query",
        `structured_query has no member "${key}"`
      );
    }
  }
}

/** UTF-8 byte length of the encoded request — the SPEC's 32 KiB measure. */
function encodedSize(request: unknown): number {
  return ENCODER.encode(JSON.stringify(request)).length;
}

/**
 * Read a closed token member. A wrong JSON type is malformed (the member is not
 * a token at all); a string outside the set is the typed "unsupported" refusal,
 * which is what tells a host it asked for a vocabulary that does not exist.
 */
function readClosedToken(
  value: unknown,
  allowed: Readonly<Record<string, unknown>>,
  code: StructuredErrorCode,
  member: string
): string {
  if (typeof value !== "string") {
    refuse(
      "malformed_structured_query",
      `structured_query.${member} must be a string`
    );
  }
  if (!Object.hasOwn(allowed, value)) {
    refuse(
      code,
      `structured_query.${member} "${value}" is outside the closed set ` +
        `${Object.keys(allowed).join(" | ")}`
    );
  }
  return value;
}

function readFilters(
  raw: unknown,
  subject: StructuredSubject
): readonly ValidatedStructuredFilter[] {
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    refuse(
      "malformed_structured_query",
      "structured_query.filters must be an array"
    );
  }
  // The cap is checked before the entries are walked: it is a declared bound on
  // the request, and reading it first keeps it observable.
  if (raw.length > STRUCTURED_MAX_FIELD_FILTERS) {
    refuse(
      "invalid_value",
      `structured_query.filters holds ${raw.length} entries, ` +
        `the maximum is ${STRUCTURED_MAX_FIELD_FILTERS}`
    );
  }
  const fields = STRUCTURED_FILTER_FIELDS_BY_SUBJECT[subject];
  const seen = new Set<string>();
  const validated: ValidatedStructuredFilter[] = [];
  for (const [index, entry] of raw.entries()) {
    const filter = readFilterEntry(entry, fields, index);
    if (seen.has(filter.field)) {
      refuse(
        "malformed_structured_query",
        `structured_query.filters repeats field "${filter.field}"`
      );
    }
    seen.add(filter.field);
    validated.push(filter);
  }
  return validated;
}

function readFilterEntry(
  entry: unknown,
  fields: Readonly<Record<string, StructuredFieldValueKind>>,
  index: number
): ValidatedStructuredFilter {
  if (!isPlainObject(entry)) {
    refuse(
      "malformed_structured_query",
      `structured_query.filters[${index}] must be an object`
    );
  }
  for (const key of Object.keys(entry)) {
    if (!FILTER_MEMBERS.has(key)) {
      refuse(
        "malformed_structured_query",
        `structured_query.filters[${index}] has no member "${key}"`
      );
    }
  }
  const field = entry["field"];
  if (typeof field !== "string") {
    refuse(
      "malformed_structured_query",
      `structured_query.filters[${index}].field must be a string`
    );
  }
  if (!Object.hasOwn(fields, field)) {
    refuse(
      "unsupported_field",
      `field "${field}" is not filterable on this subject`
    );
  }
  // Membership is proven above; the cast records it for the result type.
  const allowed = field as StructuredFilterField;
  const kind = fields[field] as StructuredFieldValueKind;
  const op = readOperator(entry["op"], index);
  if (!("value" in entry)) {
    refuse(
      "malformed_structured_query",
      `structured_query.filters[${index}] requires a value`
    );
  }
  if (op === "eq") {
    return {
      field: allowed,
      op,
      value: readDeclaredValue(field, kind, entry["value"]),
    };
  }
  return {
    field: allowed,
    op,
    values: readInValues(field, kind, entry["value"], index),
  };
}

function readOperator(value: unknown, index: number): StructuredOperator {
  if (typeof value !== "string") {
    refuse(
      "malformed_structured_query",
      `structured_query.filters[${index}].op must be a string`
    );
  }
  if (value !== "eq" && value !== "in") {
    refuse(
      "unsupported_operator",
      `operator "${value}" is outside the closed set eq | in`
    );
  }
  return value;
}

/** One exact value of the field's declared type. No coercion, no fuzzy match. */
function readDeclaredValue(
  field: string,
  kind: StructuredFieldValueKind,
  value: unknown
): string {
  if (typeof value !== "string") {
    refuse(
      "invalid_value",
      `field "${field}" takes an exact ${kind} value, got a ${typeof value}`
    );
  }
  if (kind === "uuid" && !CANONICAL_UUID.test(value)) {
    refuse(
      "invalid_value",
      `field "${field}" requires a canonical UUID, got "${value}"`
    );
  }
  if (kind === "entity_type" && !(ENTITY_TYPES as readonly string[]).includes(value)) {
    refuse(
      "invalid_value",
      `"${value}" is not a member of the closed entity_type catalog`
    );
  }
  return value;
}

function readInValues(
  field: string,
  kind: StructuredFieldValueKind,
  value: unknown,
  index: number
): readonly string[] {
  if (!Array.isArray(value)) {
    refuse(
      "malformed_structured_query",
      `structured_query.filters[${index}] with op "in" requires an array value`
    );
  }
  if (value.length < 1 || value.length > STRUCTURED_MAX_IN_VALUES) {
    refuse(
      "invalid_value",
      `field "${field}" in-list holds ${value.length} values, ` +
        `the range is 1-${STRUCTURED_MAX_IN_VALUES}`
    );
  }
  const unique = new Set<string>();
  for (const item of value) {
    const read = readDeclaredValue(field, kind, item);
    if (unique.has(read)) {
      refuse(
        "invalid_value",
        `field "${field}" in-list repeats the value "${read}"`
      );
    }
    unique.add(read);
  }
  return [...unique];
}

function readRelationship(
  raw: unknown,
  subject: StructuredSubject
): ValidatedStructuredRelationship | undefined {
  if (raw === undefined) {
    return undefined;
  }
  // One hop, relation assertions only: the predicate has no entity-side
  // meaning, so carrying it there is an illegal combination rather than a
  // silently ignored member.
  if (subject !== "relation_assertion") {
    refuse(
      "malformed_structured_query",
      "structured_query.relationship is allowed only for relation_assertion"
    );
  }
  if (!isPlainObject(raw)) {
    refuse(
      "malformed_structured_query",
      "structured_query.relationship must be an object"
    );
  }
  for (const key of Object.keys(raw)) {
    if (!RELATIONSHIP_MEMBERS.has(key)) {
      refuse(
        "malformed_structured_query",
        `structured_query.relationship has no member "${key}"`
      );
    }
  }
  const direction = readClosedToken(
    raw["direction"],
    { outgoing: true, incoming: true },
    "malformed_structured_query",
    "relationship.direction"
  );
  return {
    anchorEntityId: readDeclaredValue(
      "relationship.anchor_entity_id",
      "uuid",
      raw["anchor_entity_id"]
    ),
    direction: direction as StructuredRelationshipDirection,
  };
}

interface OperationBounds {
  limit: number | undefined;
  cursor: string | undefined;
  readRevision: number | undefined;
}

function readOperationMembers(
  members: Readonly<Record<string, unknown>>,
  operation: StructuredOperation
): OperationBounds {
  const readRevision = readCounter(members["read_revision"], "read_revision", 0);
  if (operation === "count") {
    // Count is not a page: carrying the list-only controls is an illegal
    // combination, refused rather than ignored.
    for (const member of ["limit", "cursor"]) {
      if (Object.hasOwn(members, member)) {
        refuse(
          "malformed_structured_query",
          `count rejects the list-only member "${member}"`
        );
      }
    }
    return { limit: undefined, cursor: undefined, readRevision };
  }
  const cursor = members["cursor"];
  if (cursor !== undefined && typeof cursor !== "string") {
    refuse(
      "malformed_structured_query",
      "structured_query.cursor must be a string"
    );
  }
  return {
    limit:
      readCounter(members["limit"], "limit", 1, STRUCTURED_LIST_MAX_LIMIT) ??
      STRUCTURED_LIST_DEFAULT_LIMIT,
    cursor: cursor ?? undefined,
    readRevision,
  };
}

/**
 * A counter the SPEC declares as a finite safe integer. Booleans, fractions,
 * negatives, and unsafe integers are all in one class here: they are not
 * accepted, not rounded, and not clamped. An absent member reads as absent,
 * which is how `limit` picks up its default and `read_revision` stays optional.
 */
function readCounter(
  value: unknown,
  member: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    refuse(
      "invalid_value",
      `structured_query.${member} must be a finite safe integer in ` +
        `${minimum}..${maximum}`
    );
  }
  return value;
}
