/**
 * P1 producer — the wire home of one structured `list` / `count` result.
 *
 * `retrieve` used to refuse every structurally valid structured request, so
 * this module is the half that makes one answerable: it owns the reader PORT
 * the tool depends on, the projection from a reader's domain rows onto the
 * `structured_result` sibling, and the size decision that refuses instead of
 * trimming.
 *
 * Why the key sets below are spelled out rather than derived: the sibling is
 * a CROSS-REPO contract. fin's `validate_structured_result` refuses an unknown
 * key and a missing key with the same code, so a fifth field and a typo are
 * equally fatal. The object literals at the bottom of this module are the only
 * place a key can enter, and TypeScript's excess-property check is what holds
 * them to the declared set. Versioning lives in the integer `schema_version`
 * member, never in a token suffix (ADR 0093) — the same rule `iknow.structured_error`
 * follows.
 *
 * Why the producer refuses rather than repairs: every bound here (the page cap,
 * the inline-support cap, the 32 KiB bound) exists because a cited value must
 * be COMPLETE. A snapshot taken from a trimmed page cites something the caller
 * never read, and the consumer cannot tell. So an oversized result is
 * `result_too_large` — a narrower request fixes that — and a provenance cut at
 * the inline cap is declared (`provenance_complete: false` plus the ref a
 * continuation resumes from), never silent.
 *
 * What this module deliberately does NOT do: open a transaction, build SQL,
 * decide authorization, or mint an evidence ref. The reader runs inside an
 * already-authorized scope and hands back rows plus the context that scope
 * proved; this module only projects them onto the frozen wire shape. That
 * split is also why a reader that answers a different question than the
 * validated request is refused rather than projected, and why each row carries
 * its own subject tag: the request is the contract, and a row that disagrees
 * with it would be answered as a different question than the one asked.
 */
import { ENTITY_TYPES } from "../extraction/entity-type.js";
import { readUuidShape } from "./identity.js";
import { StructuredQueryError } from "./errors.js";
import {
  STRUCTURED_LIST_MAX_LIMIT,
  type StructuredOperation,
  type StructuredSubject,
  type ValidatedStructuredQuery,
} from "./request.js";

/** The sibling key beside `chunks`; fin reads it under exactly this name. */
export const STRUCTURED_RESULT_KEY = "structured_result";

/** A version suffix makes this an UNKNOWN token, so the version is a member. */
export const STRUCTURED_RESULT_SCHEMA = "iknow.structured_result";

/** The only supported integer version. */
export const STRUCTURED_RESULT_SCHEMA_VERSION = 1;

/**
 * The bound on the encoded sibling. Checked against the WHOLE sibling and
 * never worked around by dropping a row: the consumer measures the same bytes,
 * so a producer that "fit" by trimming would simply be refused there.
 */
export const STRUCTURED_RESULT_MAX_BYTES = 32 * 1024;

/**
 * Inline supports per row. The cut is declared rather than silent: a row with
 * more carries `provenance_complete: false` and the ref a continuation reads
 * from, so a caller can tell "this is all of it" from "here is a prefix".
 */
export const STRUCTURED_RESULT_MAX_INLINE_SUPPORTS = 8;

/** The page cap; the request's own `limit` already bounds it (max 20). */
export const STRUCTURED_RESULT_MAX_ROWS = STRUCTURED_LIST_MAX_LIMIT;

/**
 * A contract token, not a fact: what the maintenance summary was computed
 * over. Emitted from here rather than read, because the consumer admits one
 * value and a reader reporting another would turn a claim into a fiction.
 */
export const STRUCTURED_RESULT_MAINTENANCE_COVERAGE = "structural_candidates_only";

/** The count receipt's coverage token — the stored subject set, not a claim. */
export const STRUCTURED_RESULT_COUNT_COVERAGE = "stored_structured_subjects";

/**
 * Evidence lifetime, measured from `queried_at`. The consumer recomputes the
 * expiry from the query instant and refuses a mismatch, so the producer
 * derives it from the same clock reading rather than trusting the reader's.
 */
export const STRUCTURED_RESULT_EVIDENCE_TTL_DAYS = 365;

/** The five states a maintenance dimension counts, and nothing else. */
export const STRUCTURED_RESULT_MAINTENANCE_STATES = [
  "pending",
  "running",
  "ready",
  "failed",
  "stale",
] as const;

/**
 * The declared key sets, exported so a consumer-side driver can assert the
 * exact set instead of spot-checking members. The contract is the SET, because
 * the consumer compares key sets; the order here is only the emitted order.
 */
export const STRUCTURED_RESULT_CONTEXT_KEYS = [
  "subject",
  "operation",
  "query_digest",
  "scope_binding",
  "read_revision",
  "queried_at",
] as const;

export const STRUCTURED_RESULT_LIST_KEYS = [
  "schema",
  "schema_version",
  ...STRUCTURED_RESULT_CONTEXT_KEYS,
  "maintenance",
  "rows",
  "next_cursor",
] as const;

export const STRUCTURED_RESULT_COUNT_KEYS = [
  "schema",
  "schema_version",
  ...STRUCTURED_RESULT_CONTEXT_KEYS,
  "maintenance",
  "count",
  "count_receipt",
] as const;

export const STRUCTURED_RESULT_MAINTENANCE_KEYS = [
  "maintenance_revision",
  "sources_in_scope",
  "published_sources",
  "desired_index",
  "conflict_checks",
  "ruleset_revision",
  "coverage",
] as const;

export const STRUCTURED_RESULT_ROW_EVIDENCE_KEYS = [
  "evidence_ref",
  "evidence_expires_at",
  "provenance",
  "provenance_complete",
  "provenance_next_ref",
] as const;

export const STRUCTURED_RESULT_ENTITY_ROW_KEYS = [
  "id",
  "canonical_name",
  "type",
  "display_support_id",
  "display_disagreement",
  ...STRUCTURED_RESULT_ROW_EVIDENCE_KEYS,
] as const;

export const STRUCTURED_RESULT_RELATION_ROW_KEYS = [
  "id",
  "head",
  "relation_norm",
  "tail",
  "valid_window",
  ...STRUCTURED_RESULT_ROW_EVIDENCE_KEYS,
] as const;

export const STRUCTURED_RESULT_ENDPOINT_KEYS = [
  "id",
  "canonical_name",
  "type",
  "display_support_id",
  "display_disagreement",
] as const;

export const STRUCTURED_RESULT_SUPPORT_KEYS = [
  "support_id",
  "source_ref",
  "source_version",
  "location",
  "extraction_ref",
] as const;

/** `span` is the ONE optional key a support may carry; the rest are required. */
export const STRUCTURED_RESULT_SPAN_KEY = "span";

export const STRUCTURED_RESULT_COUNT_RECEIPT_KEYS = [
  "subject",
  "count",
  "query_digest",
  "scope_binding",
  "read_revision",
  "queried_at",
  "coverage",
  "maintenance_revision",
  "maintenance",
  "evidence_ref",
  "evidence_expires_at",
] as const;

// ---------------------------------------------------------------------------
// Wire shape
// ---------------------------------------------------------------------------

export type StructuredResultMaintenanceStates = Readonly<
  Record<string, number>
>;

export interface StructuredResultMaintenance {
  readonly maintenance_revision: string;
  readonly sources_in_scope: number;
  readonly published_sources: number;
  readonly desired_index: StructuredResultMaintenanceStates;
  readonly conflict_checks: StructuredResultMaintenanceStates;
  readonly ruleset_revision: string;
  readonly coverage: typeof STRUCTURED_RESULT_MAINTENANCE_COVERAGE;
}

export interface StructuredResultLocation {
  readonly document_id: string;
  readonly version: string;
  readonly unit: number;
}

export interface StructuredResultSpan {
  readonly start: number;
  readonly end: number;
}

export interface StructuredResultSupport {
  readonly support_id: string;
  readonly source_ref: string;
  readonly source_version: string;
  readonly location: StructuredResultLocation;
  readonly extraction_ref: string;
  readonly span?: StructuredResultSpan;
}

/** One side of a relation: the display fields, never the evidence half. */
export interface StructuredResultEndpoint {
  readonly id: string;
  readonly canonical_name: string;
  readonly type: string;
  readonly display_support_id: string;
  readonly display_disagreement: boolean;
}

export interface StructuredResultRowEvidence {
  readonly evidence_ref: string;
  readonly evidence_expires_at: string;
  readonly provenance: readonly StructuredResultSupport[];
  readonly provenance_complete: boolean;
  readonly provenance_next_ref: string | null;
}

export interface StructuredResultEntityRow extends StructuredResultRowEvidence {
  readonly id: string;
  readonly canonical_name: string;
  readonly type: string;
  readonly display_support_id: string;
  readonly display_disagreement: boolean;
}

export interface StructuredResultRelationRow extends StructuredResultRowEvidence {
  readonly id: string;
  readonly head: StructuredResultEndpoint;
  readonly relation_norm: string;
  readonly tail: StructuredResultEndpoint;
  readonly valid_window: {
    readonly from: string | null;
    readonly until: string | null;
  };
}

export type StructuredResultRow =
  | StructuredResultEntityRow
  | StructuredResultRelationRow;

/**
 * The six context fields, declared once because list, count, and the count
 * receipt each carry them and must agree member for member.
 */
interface StructuredResultContext {
  readonly subject: StructuredSubject;
  readonly operation: StructuredOperation;
  readonly query_digest: string;
  readonly scope_binding: string;
  readonly read_revision: string;
  readonly queried_at: string;
}

export interface StructuredResultListEnvelope extends StructuredResultContext {
  readonly schema: typeof STRUCTURED_RESULT_SCHEMA;
  readonly schema_version: typeof STRUCTURED_RESULT_SCHEMA_VERSION;
  readonly maintenance: StructuredResultMaintenance;
  readonly rows: readonly StructuredResultRow[];
  readonly next_cursor: string | null;
}

export interface StructuredResultCountReceipt {
  readonly subject: StructuredSubject;
  readonly count: number;
  readonly query_digest: string;
  readonly scope_binding: string;
  readonly read_revision: string;
  readonly queried_at: string;
  readonly coverage: typeof STRUCTURED_RESULT_COUNT_COVERAGE;
  readonly maintenance_revision: string;
  readonly maintenance: StructuredResultMaintenance;
  readonly evidence_ref: string;
  readonly evidence_expires_at: string;
}

export interface StructuredResultCountEnvelope extends StructuredResultContext {
  readonly schema: typeof STRUCTURED_RESULT_SCHEMA;
  readonly schema_version: typeof STRUCTURED_RESULT_SCHEMA_VERSION;
  readonly maintenance: StructuredResultMaintenance;
  readonly count: number;
  readonly count_receipt: StructuredResultCountReceipt;
}

export type StructuredResultEnvelope =
  | StructuredResultListEnvelope
  | StructuredResultCountEnvelope;

// ---------------------------------------------------------------------------
// Reader port
// ---------------------------------------------------------------------------

/**
 * One cited support, as the reader holds it. Domain field names, because the
 * wire spellings are this module's to fix — see the frozen sets above.
 */
export interface StructuredSupportRecord {
  readonly supportId: string;
  readonly sourceRef: string;
  readonly sourceVersion: string;
  /** The company locator triple; `unit` is one-based. */
  readonly location: {
    readonly documentId: string;
    readonly version: string;
    readonly unit: number;
  };
  readonly extractionRef: string;
  /** A half-open code-point interval, present only when the row has one. */
  readonly span?: { readonly start: number; readonly end: number };
}

export interface StructuredEndpointRecord {
  readonly id: string;
  readonly canonicalName: string;
  readonly type: string;
  readonly displaySupportId: string;
  readonly displayDisagreement: boolean;
}

interface StructuredRowRecordBase {
  /**
   * The row's own subject tag, checked against the validated request rather
   * than assumed. A row whose tag disagrees cannot be projected onto the row
   * shape the request selected, and projecting it anyway would answer a
   * different question than the one asked.
   */
  readonly subject: StructuredSubject;
  readonly id: string;
  /** The citable reference for this row; a count carries its own. */
  readonly evidenceRef: string;
  readonly supports: readonly StructuredSupportRecord[];
}

export interface StructuredEntityRowRecord extends StructuredRowRecordBase {
  readonly subject: "entity";
  readonly canonicalName: string;
  readonly type: string;
  readonly displaySupportId: string;
  readonly displayDisagreement: boolean;
}

export interface StructuredRelationRowRecord extends StructuredRowRecordBase {
  readonly subject: "relation_assertion";
  readonly head: StructuredEndpointRecord;
  readonly relationNorm: string;
  readonly tail: StructuredEndpointRecord;
  /** Whole-second UTC instants or null; a stored window is never rewritten. */
  readonly validWindow: {
    readonly from: string | null;
    readonly until: string | null;
  };
}

export type StructuredRowRecord =
  | StructuredEntityRowRecord
  | StructuredRelationRowRecord;

/**
 * What the maintenance summary is computed over, as the authorized scope holds
 * it. `coverage` is absent on purpose: it is a contract token this module
 * emits, not a fact the reader reports.
 */
export interface StructuredMaintenanceRecord {
  readonly maintenanceRevision: string;
  readonly sourcesInScope: number;
  readonly publishedSources: number;
  readonly desiredIndex: Readonly<Record<string, number>>;
  readonly conflictChecks: Readonly<Record<string, number>>;
  readonly rulesetRevision: string;
}

/** The facts only an already-authorized, already-opened scope can prove. */
export interface StructuredReadContext {
  readonly queryDigest: string;
  readonly scopeBinding: string;
  readonly readRevision: string;
  /** The citable reference for a COUNT value; rows carry their own. */
  readonly evidenceRef: string;
  readonly maintenance: StructuredMaintenanceRecord;
}

export interface StructuredListRead {
  readonly kind: "list";
  readonly context: StructuredReadContext;
  readonly rows: readonly StructuredRowRecord[];
  readonly nextCursor: string | null;
}

export interface StructuredCountRead {
  readonly kind: "count";
  readonly context: StructuredReadContext;
  readonly count: number;
}

export type StructuredReadOutcome = StructuredListRead | StructuredCountRead;

/**
 * The injected dependency. Absent is meaningful, not a default: an instance
 * without one is not provisioned with the structured backend, which is the
 * SPEC's `structured_search_unavailable` trigger.
 */
export interface StructuredQueryReader {
  readStructuredQuery(
    request: ValidatedStructuredQuery
  ): Promise<StructuredReadOutcome>;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

const ENCODER = new TextEncoder();

/** The context fields, proved non-empty once so each emit site stays flat. */
interface WireContext {
  readonly queryDigest: string;
  readonly scopeBinding: string;
  readonly readRevision: string;
  readonly evidenceRef: string;
}

/**
 * Project a reader's outcome onto the frozen sibling, or refuse.
 *
 * `now` is the query instant the evidence lifetime is measured from. It is a
 * parameter so the emitted stamp is testable without freezing time globally,
 * and it is truncated to whole seconds because the contract's timestamp form
 * has no fractional part — the consumer refuses such a stamp rather than
 * normalizing it, so the producer must never write one.
 */
export function buildStructuredResult(
  request: ValidatedStructuredQuery,
  outcome: StructuredReadOutcome,
  now: Date = new Date()
): StructuredResultEnvelope {
  const instant = wholeSecondInstant(now);
  const queriedAt = wholeSecondStamp(instant);
  const expiresAt = wholeSecondStamp(
    instant + STRUCTURED_RESULT_EVIDENCE_TTL_DAYS * MILLISECONDS_PER_DAY
  );
  const context = readContext(outcome.context, outcome.kind);
  const maintenance = readMaintenance(outcome.context.maintenance);
  const envelope =
    outcome.kind === "list"
      ? buildList(request, outcome, context, queriedAt, expiresAt, maintenance)
      : buildCount(request, outcome, context, queriedAt, expiresAt, maintenance);
  // The one fit decision, on the whole sibling, after the page is complete.
  // There is deliberately no "drop the last row until it fits" path: the page
  // a snapshot was taken from must be the page the caller can re-read.
  if (encodedSize(envelope) > STRUCTURED_RESULT_MAX_BYTES) {
    throw new StructuredQueryError(
      `structured result is ${encodedSize(envelope)} UTF-8 bytes, over the ` +
        `${STRUCTURED_RESULT_MAX_BYTES} bound; narrow the request`,
      "result_too_large"
    );
  }
  return envelope;
}

function buildList(
  request: ValidatedStructuredQuery,
  outcome: StructuredListRead,
  context: WireContext,
  queriedAt: string,
  expiresAt: string,
  maintenance: StructuredResultMaintenance
): StructuredResultListEnvelope {
  if (request.operation !== "list") {
    refuseUnavailable(request.operation, outcome.kind);
  }
  // The validated request already bounded the page to `limit` <= 20, so a
  // longer page means the reader answered a wider question than it was asked.
  if (outcome.rows.length > STRUCTURED_RESULT_MAX_ROWS) {
    throw new StructuredQueryError(
      `structured read returned ${outcome.rows.length} rows, the page bound is ` +
        `${STRUCTURED_RESULT_MAX_ROWS}`,
      "result_too_large"
    );
  }
  return {
    schema: STRUCTURED_RESULT_SCHEMA,
    schema_version: STRUCTURED_RESULT_SCHEMA_VERSION,
    subject: request.subject,
    operation: "list",
    query_digest: context.queryDigest,
    scope_binding: context.scopeBinding,
    read_revision: context.readRevision,
    queried_at: queriedAt,
    maintenance,
    rows: outcome.rows.map((row) => readRow(row, request.subject, expiresAt)),
    next_cursor: readCursor(outcome.nextCursor),
  };
}

function buildCount(
  request: ValidatedStructuredQuery,
  outcome: StructuredCountRead,
  context: WireContext,
  queriedAt: string,
  expiresAt: string,
  maintenance: StructuredResultMaintenance
): StructuredResultCountEnvelope {
  if (request.operation !== "count") {
    refuseUnavailable(request.operation, outcome.kind);
  }
  if (!Number.isSafeInteger(outcome.count) || outcome.count < 0) {
    throw new StructuredQueryError(
      "structured count read returned a value outside the non-negative safe " +
        "integer range",
      "count_unavailable"
    );
  }
  return {
    schema: STRUCTURED_RESULT_SCHEMA,
    schema_version: STRUCTURED_RESULT_SCHEMA_VERSION,
    subject: request.subject,
    operation: "count",
    query_digest: context.queryDigest,
    scope_binding: context.scopeBinding,
    read_revision: context.readRevision,
    queried_at: queriedAt,
    maintenance,
    count: outcome.count,
    // The receipt restates the envelope's context so it can be cited on its
    // own; the consumer requires the two to agree member for member.
    count_receipt: {
      subject: request.subject,
      count: outcome.count,
      query_digest: context.queryDigest,
      scope_binding: context.scopeBinding,
      read_revision: context.readRevision,
      queried_at: queriedAt,
      coverage: STRUCTURED_RESULT_COUNT_COVERAGE,
      maintenance_revision: maintenance.maintenance_revision,
      maintenance,
      evidence_ref: context.evidenceRef,
      evidence_expires_at: expiresAt,
    },
  };
}

function readRow(
  row: StructuredRowRecord,
  subject: StructuredSubject,
  expiresAt: string
): StructuredResultRow {
  if (row.subject !== subject) {
    throw new StructuredQueryError(
      `structured read returned a ${row.subject} row for a ${subject} request`,
      "structured_search_unavailable"
    );
  }
  const evidence = readRowEvidence(row, expiresAt);
  if (row.subject === "entity") {
    return {
      id: readUuid(row.id, "row id"),
      canonical_name: readText(row.canonicalName, "canonical_name"),
      type: readEntityType(row.type),
      display_support_id: readUuid(row.displaySupportId, "display_support_id"),
      display_disagreement: readDisagreement(row.displayDisagreement),
      ...evidence,
    };
  }
  return {
    id: readUuid(row.id, "row id"),
    head: readEndpoint(row.head),
    relation_norm: readText(row.relationNorm, "relation_norm"),
    tail: readEndpoint(row.tail),
    valid_window: {
      from: readWindowBound(row.validWindow.from, "valid_window.from"),
      until: readWindowBound(row.validWindow.until, "valid_window.until"),
    },
    ...evidence,
  };
}

function readRowEvidence(
  row: StructuredRowRecord,
  expiresAt: string
): StructuredResultRowEvidence {
  const bounded = boundProvenance(row.supports);
  return {
    evidence_ref: readText(row.evidenceRef, "evidence_ref"),
    evidence_expires_at: expiresAt,
    provenance: bounded.entries,
    provenance_complete: bounded.complete,
    provenance_next_ref: bounded.nextRef,
  };
}

function readEndpoint(
  endpoint: StructuredEndpointRecord
): StructuredResultEndpoint {
  return {
    id: readUuid(endpoint.id, "endpoint id"),
    canonical_name: readText(endpoint.canonicalName, "endpoint canonical_name"),
    type: readEntityType(endpoint.type),
    display_support_id: readUuid(
      endpoint.displaySupportId,
      "endpoint display_support_id"
    ),
    display_disagreement: readDisagreement(endpoint.displayDisagreement),
  };
}

interface BoundedProvenance {
  readonly entries: readonly StructuredResultSupport[];
  readonly complete: boolean;
  readonly nextRef: string | null;
}

/**
 * Cut the inline prefix and declare the cut.
 *
 * Ordering is by support id because the consumer requires provenance in that
 * order — the ordering is what makes the cut point and a continuation resume
 * from the same place. `nextRef` is therefore the FIRST OMITTED support, which
 * is also where a continuation reads next; a duplicate id would make that
 * resume ambiguous, so two records claiming one identity are refused.
 */
function boundProvenance(
  supports: readonly StructuredSupportRecord[]
): BoundedProvenance {
  const ordered = [...supports].sort((left, right) =>
    left.supportId < right.supportId
      ? -1
      : left.supportId > right.supportId
        ? 1
        : 0
  );
  const inline = ordered.slice(0, STRUCTURED_RESULT_MAX_INLINE_SUPPORTS);
  const omitted = ordered[STRUCTURED_RESULT_MAX_INLINE_SUPPORTS];
  for (const [index, support] of ordered.entries()) {
    if (index > 0 && support.supportId === ordered[index - 1]!.supportId) {
      throw new StructuredQueryError(
        `structured row cites support "${support.supportId}" twice`,
        "structured_search_unavailable"
      );
    }
  }
  return {
    entries: inline.map(readSupport),
    complete: omitted === undefined,
    nextRef: omitted?.supportId ?? null,
  };
}

function readSupport(support: StructuredSupportRecord): StructuredResultSupport {
  return {
    support_id: readUuid(support.supportId, "provenance support_id"),
    source_ref: readText(support.sourceRef, "source_ref"),
    source_version: readText(support.sourceVersion, "source_version"),
    location: {
      document_id: readText(support.location.documentId, "location document_id"),
      version: readText(support.location.version, "location version"),
      unit: readUnit(support.location.unit),
    },
    extraction_ref: readText(support.extractionRef, "extraction_ref"),
    ...(support.span === undefined ? {} : { span: readSpan(support.span) }),
  };
}

function readSpan(span: {
  readonly start: number;
  readonly end: number;
}): StructuredResultSpan {
  for (const [name, value] of [
    ["start", span.start],
    ["end", span.end],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      refuseBackend(`provenance span.${name} is not a non-negative integer`);
    }
  }
  if (span.start >= span.end) {
    // A half-open interval must contain something; an empty one would point a
    // continuation at a range no character occupies.
    refuseBackend("provenance span is empty or reversed");
  }
  return { start: span.start, end: span.end };
}

function readCursor(cursor: string | null): string | null {
  if (cursor !== null && (typeof cursor !== "string" || cursor.length === 0)) {
    refuseBackend("structured next_cursor is not a non-empty string or null");
  }
  return cursor;
}

function readWindowBound(
  value: string | null,
  label: string
): string | null {
  if (value === null) return null;
  // A stored window is checked, never rewritten: normalizing it here would put
  // a spell nobody stored into a citable value.
  if (typeof value !== "string" || !WHOLE_SECOND_UTC.test(value)) {
    refuseBackend(`${label} is not a whole-second UTC instant or null`);
  }
  return value;
}

/**
 * `evidence_ref` belongs to the COUNT receipt only: a count is a citable fact
 * about the whole set and must carry its own reference, whereas every list row
 * cites itself and a list envelope has no context-level reference. Requiring it
 * for a list would refuse an empty page, which is a successful empty list and
 * the SPEC's answer for no-match — not a backend failure.
 */
function readContext(
  context: StructuredReadContext,
  kind: StructuredReadOutcome["kind"]
): WireContext {
  return {
    queryDigest: readText(context.queryDigest, "query_digest"),
    scopeBinding: readText(context.scopeBinding, "scope_binding"),
    readRevision: readText(context.readRevision, "read_revision"),
    evidenceRef:
      kind === "count" ? readText(context.evidenceRef, "evidence_ref") : "",
  };
}

/**
 * Project the maintenance summary, refusing a status that cannot be reported
 * truthfully. The consumer recomputes these invariants, so a summary that
 * fails here would arrive as an opaque contract refusal instead of the SPEC's
 * maintenance code.
 */
function readMaintenance(
  record: StructuredMaintenanceRecord
): StructuredResultMaintenance {
  if (!Number.isSafeInteger(record.sourcesInScope) || record.sourcesInScope < 0) {
    refuseMaintenance("sources_in_scope is not a non-negative integer");
  }
  if (
    !Number.isSafeInteger(record.publishedSources) ||
    record.publishedSources < 0 ||
    record.publishedSources > record.sourcesInScope
  ) {
    refuseMaintenance("published_sources is outside 0..sources_in_scope");
  }
  return {
    maintenance_revision: readText(
      record.maintenanceRevision,
      "maintenance_revision"
    ),
    sources_in_scope: record.sourcesInScope,
    published_sources: record.publishedSources,
    desired_index: readMaintenanceStates(
      record.desiredIndex,
      "desired_index",
      record.sourcesInScope
    ),
    conflict_checks: readMaintenanceStates(
      record.conflictChecks,
      "conflict_checks",
      record.sourcesInScope
    ),
    ruleset_revision: readText(record.rulesetRevision, "ruleset_revision"),
    coverage: STRUCTURED_RESULT_MAINTENANCE_COVERAGE,
  };
}

/**
 * One maintenance dimension must account for every source in scope: the five
 * closed states, no other key, and a sum equal to `sourcesInScope`. A dimension
 * that under- or over-counts describes a corpus this read did not see, and the
 * consumer recomputes the same sum, so emitting one would arrive there as an
 * opaque contract refusal instead of the SPEC's maintenance code.
 */
function readMaintenanceStates(
  states: Readonly<Record<string, number>>,
  label: string,
  sourcesInScope: number
): StructuredResultMaintenanceStates {
  const keys = Object.keys(states).sort();
  const expected = [...STRUCTURED_RESULT_MAINTENANCE_STATES].sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    refuseMaintenance(`${label} does not name exactly the five closed states`);
  }
  let total = 0;
  for (const state of STRUCTURED_RESULT_MAINTENANCE_STATES) {
    const count = states[state];
    if (!Number.isSafeInteger(count) || count < 0) {
      refuseMaintenance(`${label}.${state} is not a non-negative integer`);
    }
    total += count;
  }
  if (total !== sourcesInScope) {
    refuseMaintenance(
      `${label} accounts for ${total} of ${sourcesInScope} sources in scope`
    );
  }
  return { ...states };
}

/**
 * UTF-8 byte length of the encoded value. This is the same measure the consumer
 * takes: its canonical encoder escapes only quotes, backslashes, and control
 * characters — identical to `JSON.stringify` — and sorting keys cannot change
 * the total length, so the two agree on every value this module can emit.
 */
function encodedSize(value: unknown): number {
  return ENCODER.encode(JSON.stringify(value)).length;
}

const WHOLE_SECOND_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

function wholeSecondInstant(now: Date): number {
  const milliseconds = now.getTime();
  if (!Number.isFinite(milliseconds)) {
    throw new StructuredQueryError(
      "structured result cannot be stamped without a valid clock reading",
      "structured_search_unavailable"
    );
  }
  return Math.floor(milliseconds / 1000) * 1000;
}

function wholeSecondStamp(milliseconds: number): string {
  return new Date(milliseconds).toISOString().replace(/\.000Z$/, "Z");
}

function readUuid(value: string, label: string): string {
  if (readUuidShape(value, "preserve") === undefined) {
    refuseBackend(`${label} is not a canonical UUID`);
  }
  return value;
}

function readText(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    refuseBackend(`${label} is not a non-empty string`);
  }
  return value;
}

function readDisagreement(value: boolean): boolean {
  if (typeof value !== "boolean") {
    refuseBackend("display_disagreement is not a boolean");
  }
  return value;
}

function readEntityType(value: string): string {
  if (!(ENTITY_TYPES as readonly string[]).includes(value)) {
    refuseBackend(`entity type "${value}" is outside the closed catalog`);
  }
  return value;
}

function readUnit(unit: number): number {
  // A locator's unit is one-based, so 0 addresses nothing.
  if (!Number.isSafeInteger(unit) || unit < 1) {
    refuseBackend("location unit is not a one-based integer");
  }
  return unit;
}

function refuseUnavailable(
  requested: StructuredOperation,
  answered: StructuredReadOutcome["kind"]
): never {
  throw new StructuredQueryError(
    `structured read answered "${answered}" for a "${requested}" request`,
    "structured_search_unavailable"
  );
}

function refuseMaintenance(reason: string): never {
  throw new StructuredQueryError(
    `structured maintenance status cannot be reported: ${reason}`,
    "maintenance_status_unavailable"
  );
}

/**
 * A reader that cannot back a field it is responsible for. This is the SPEC's
 * second `structured_search_unavailable` trigger — the structured backend
 * failing during execution — and it is deliberately NOT a request-side code:
 * the request was valid, so retrying an unchanged request cannot help beyond
 * the code's declared retryability.
 */
function refuseBackend(reason: string): never {
  throw new StructuredQueryError(
    `structured backend produced an uncitable result: ${reason}`,
    "structured_search_unavailable"
  );
}