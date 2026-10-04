/**
 * Identity for immutable source versions and the supports extracted from
 * them.
 *
 * Every rule in this file is a refusal, and the refusals exist because the
 * alternative is a false provenance claim: a support whose locator does not
 * resolve to its source version, a span that is not a code-point interval, or
 * a version key reused for content that changed. Both backends run exactly
 * these functions, so the in-memory store cannot admit a support Postgres
 * would refuse — the agreement is what makes occurrence identity mean the
 * same thing on either side.
 */
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import {
  EVIDENCE_FAILURE,
  EVIDENCE_SUBJECT_KIND,
  type CompanySourceLocator,
  type EvidenceFailureToken,
  type EvidenceSpan,
  type EvidenceSubjectKind,
  type NewSourceVersion,
  type SourceLocatorBinding,
  type SupportOccurrence,
} from "../types.js";
import { GraphragError } from "../errors.js";

/**
 * A code-point offset inside one frozen unit is an int4 column, so the
 * storage's own limit is where the validator draws the line: accepting a
 * larger number would fail at the database instead of at the contract.
 */
const MAX_CODE_POINT = 2_147_483_647;

/** The stored spelling of an absent span, so occurrence identity is one key. */
export const SPAN_ABSENT = -1;

/** The closed company-locator key set (ADR 0088); an extra key is a second identity. */
const COMPANY_LOCATOR_KEYS = ["document_id", "unit", "version"];

const SUBJECT_KINDS: readonly string[] = Object.values(EVIDENCE_SUBJECT_KIND);

const ISO_INSTANT_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

/** ECMAScript's representable instant range, one millisecond either side. */
const MAX_INSTANT_MS = 8_640_000_000_000_000;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/** A validated occurrence, flattened to what the tables actually store. */
export interface NormalizedSupport {
  readonly subject: EvidenceSubjectKind;
  readonly result_id: string;
  readonly source_ref: string;
  readonly source_version: string;
  readonly location: CompanySourceLocator;
  readonly span: EvidenceSpan | null;
  readonly extraction_ref: string;
  readonly extracted_at: string;
}

/** A validated source version, with its manifest in one comparable spelling. */
export interface NormalizedSourceVersion {
  /** Empty means the store mints the id. */
  readonly source_version_id: string;
  readonly source_ref: string;
  readonly source_version: string;
  readonly content_digest: string;
  readonly origin_object_ref: string;
  readonly parser_revision: string;
  readonly unit_manifest: Record<string, unknown>;
  readonly unit_manifest_canonical: string;
  readonly created_at: string;
}

/**
 * A uuid-typed field, checked at the seam.
 *
 * Without this the two stores diverge on the same input: PostgreSQL answers a
 * malformed id with a cast error the caller has to translate, while an
 * in-memory Map answers it with a miss. Refusing both here is what makes
 * "not found" mean one thing.
 */
export function assertUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw evidenceError(
      EVIDENCE_FAILURE.MALFORMED_CONTRACT,
      `${field} must be a uuid, got ${JSON.stringify(value)}`
    );
  }
  return value;
}

/** The lifecycle facts a source version's stamps carry. */
export type SourceVersionStamp =
  "retired_at" | "payload_collected_at" | "obligations_stopped_at";

/** A typed contract refusal, carrying the token a host classifies on. */
export function evidenceError(
  failure: EvidenceFailureToken,
  message: string
): GraphragError {
  return new GraphragError(message, "INVALID_INPUT", failure);
}

/** A non-empty, non-blank string field. */
export function assertFilled(
  value: unknown,
  field: string,
  failure: EvidenceFailureToken = EVIDENCE_FAILURE.MALFORMED_CONTRACT
): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw evidenceError(failure, `${field} must be a non-empty string`);
  }
  return value;
}

export function isPlainRecord(
  value: unknown
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[]
): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === keys.length &&
    actual.every((key, index) => key === keys[index])
  );
}

/**
 * One caller-supplied instant, parsed. The shape is required as well as the
 * value: a date-only or offset-less string is ambiguous, and a lifetime is a
 * promise about one specific instant.
 */
export function assertInstant(value: unknown, field: string): number {
  if (typeof value !== "string" || !ISO_INSTANT_RE.test(value)) {
    throw evidenceError(
      EVIDENCE_FAILURE.MALFORMED_CONTRACT,
      `${field} must be an ISO 8601 datetime with a timezone, got "${String(value)}"`
    );
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed) || Math.abs(parsed) > MAX_INSTANT_MS) {
    throw evidenceError(
      EVIDENCE_FAILURE.MALFORMED_CONTRACT,
      `${field} is not a representable instant, got "${value}"`
    );
  }
  return parsed;
}

/** Canonical ISO text for one instant, so two spellings of it are one value. */
export function instantText(value: unknown, field: string): string {
  return new Date(assertInstant(value, field)).toISOString();
}

/** Lowercase hex SHA-256 of original content — the one digest shape here. */
export function contentDigestOf(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * JSON text with object keys ordered, so two spellings of one value compare
 * equal. Only called on a value that already serialized: a cycle was refused
 * before this point, which is what keeps the recursion from being a hang.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (isPlainRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** JSON text for a value that must be retained, refusing what cannot be. */
function jsonText(value: unknown, field: string): string {
  try {
    const text = JSON.stringify(value);
    if (text === undefined) throw new Error("not serializable");
    return text;
  } catch (err) {
    throw evidenceError(
      EVIDENCE_FAILURE.MALFORMED_CONTRACT,
      `${field} must be serializable JSON: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}

/**
 * One company locator. The key set is checked against the whole, not a
 * subset: an extra `kind` or `page` key would give the same frozen unit a
 * second identity, which is the mistake the closed set exists to prevent.
 */
function companyLocatorOf(value: unknown, field: string): CompanySourceLocator {
  if (!isPlainRecord(value) || !hasExactKeys(value, COMPANY_LOCATOR_KEYS)) {
    throw evidenceError(
      EVIDENCE_FAILURE.MALFORMED_CONTRACT,
      `${field} must be exactly {document_id, version, unit}`
    );
  }
  const documentId = assertFilled(value["document_id"], `${field}.document_id`);
  const version = assertFilled(value["version"], `${field}.version`);
  return {
    document_id: documentId,
    version,
    unit: codePointBound(value["unit"], `${field}.unit`),
  };
}

/** A one-based ordinal, bounded by the column that stores it. */
function codePointBound(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw evidenceError(
      EVIDENCE_FAILURE.MALFORMED_CONTRACT,
      `${field} must be an integer >= 1, got ${JSON.stringify(value)}`
    );
  }
  if (value > MAX_CODE_POINT) {
    throw evidenceError(
      EVIDENCE_FAILURE.MALFORMED_CONTRACT,
      `${field} ${value} exceeds the storable ordinal range`
    );
  }
  return value;
}

/**
 * An optional half-open code-point interval. Absent is a legitimate value —
 * it is what makes structured evidence possible without a quotation — so
 * `null`/`undefined` normalize to `null` rather than being refused.
 */
function spanOf(value: unknown, field: string): EvidenceSpan | null {
  if (value === undefined || value === null) return null;
  if (!isPlainRecord(value) || !hasExactKeys(value, ["end", "start"])) {
    throw evidenceError(
      EVIDENCE_FAILURE.MALFORMED_CONTRACT,
      `${field} must be exactly {start, end} when present`
    );
  }
  const start = boundOffset(value["start"], `${field}.start`);
  const end = boundOffset(value["end"], `${field}.end`);
  if (end <= start) {
    throw evidenceError(
      EVIDENCE_FAILURE.MALFORMED_CONTRACT,
      `${field} must be a non-empty half-open interval: start ${start} end ${end}`
    );
  }
  return { start, end };
}

/** A non-negative code-point offset, bounded by the column that stores it. */
function boundOffset(value: unknown, field: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_CODE_POINT
  ) {
    throw evidenceError(
      EVIDENCE_FAILURE.MALFORMED_CONTRACT,
      `${field} must be a code-point offset in 0..${MAX_CODE_POINT}, got ${JSON.stringify(value)}`
    );
  }
  return value;
}

/**
 * Occurrence identity: (subject, result, source, version, canonical location,
 * span-or-absent). The in-memory store keys its join on this text while
 * PostgreSQL enforces the same tuple as a unique constraint, so the two
 * cannot disagree about when a repeated extraction is the same occurrence.
 */
export function supportOccurrenceKey(support: NormalizedSupport): string {
  return JSON.stringify([
    support.subject,
    support.result_id,
    support.source_ref,
    support.source_version,
    support.location.document_id,
    support.location.version,
    support.location.unit,
    support.span?.start ?? SPAN_ABSENT,
    support.span?.end ?? SPAN_ABSENT,
  ]);
}

/** Validate one extracted occurrence into its stored spelling. */
export function normalizeOccurrence(
  input: SupportOccurrence
): NormalizedSupport {
  if (!isPlainRecord(input)) {
    throw evidenceError(
      EVIDENCE_FAILURE.MALFORMED_CONTRACT,
      "support occurrence must be a record"
    );
  }
  const subject = input.subject;
  if (typeof subject !== "string" || !SUBJECT_KINDS.includes(subject)) {
    throw evidenceError(
      EVIDENCE_FAILURE.MALFORMED_CONTRACT,
      `support subject must be one of ${SUBJECT_KINDS.join("|")}, got ${JSON.stringify(subject)}`
    );
  }
  return {
    subject: subject as EvidenceSubjectKind,
    result_id: assertFilled(input.result_id, "support result_id"),
    source_ref: assertFilled(input.source_ref, "support source_ref"),
    source_version: assertFilled(
      input.source_version,
      "support source_version"
    ),
    location: companyLocatorOf(input.location, "support location"),
    span: spanOf(input.span, "support span"),
    extraction_ref: assertFilled(input.extraction_ref, "extraction_ref"),
    extracted_at: instantText(input.extractedAt, "extracted_at"),
  };
}

/** Validate one supplied source version. */
export function normalizeSourceVersion(
  input: NewSourceVersion
): NormalizedSourceVersion {
  if (!isPlainRecord(input)) {
    throw evidenceError(
      EVIDENCE_FAILURE.MALFORMED_CONTRACT,
      "source version must be a record"
    );
  }
  if (!isPlainRecord(input.unit_manifest)) {
    throw evidenceError(
      EVIDENCE_FAILURE.MALFORMED_CONTRACT,
      "unit_manifest must be the frozen-unit manifest record"
    );
  }
  const manifest = input.unit_manifest;
  const manifestJson = jsonText(manifest, "unit_manifest");
  return {
    source_version_id:
      input.source_version_id === undefined
        ? ""
        : assertUuid(input.source_version_id, "source_version_id"),
    source_ref: assertFilled(input.source_ref, "source_ref"),
    source_version: assertFilled(input.source_version, "source_version"),
    content_digest: contentDigestField(input.content_digest),
    origin_object_ref: assertFilled(
      input.origin_object_ref,
      "origin_object_ref"
    ),
    parser_revision: assertFilled(input.parser_revision, "parser_revision"),
    unit_manifest: manifest,
    unit_manifest_canonical: canonicalJson(
      JSON.parse(manifestJson) as Record<string, unknown>
    ),
    created_at: instantText(input.created_at, "created_at"),
  };
}

/** Uppercase or truncated digests are refused: the shape is one convention. */
function contentDigestField(value: unknown): string {
  if (typeof value !== "string" || !SHA256_HEX_RE.test(value)) {
    throw evidenceError(
      EVIDENCE_FAILURE.MALFORMED_CONTRACT,
      "content_digest must be a lowercase hex sha256 of the original content"
    );
  }
  return value;
}

/** Validate one locator binding; the source version must already exist. */
export function normalizeLocatorBinding(
  input: SourceLocatorBinding
): SourceLocatorBinding {
  if (!isPlainRecord(input)) {
    throw evidenceError(
      EVIDENCE_FAILURE.MALFORMED_CONTRACT,
      "locator binding must be a record"
    );
  }
  return {
    source_version_id: assertFilled(
      input.source_version_id,
      "source_version_id"
    ),
    // Only the locator triple goes through the closed key set: the binding's
    // own `source_version_id` is not a locator field.
    ...companyLocatorOf(
      {
        document_id: input.document_id,
        version: input.version,
        unit: input.unit,
      },
      "locator"
    ),
  };
}

/**
 * Rebuild a support's wire locator from its stored columns. The shape is
 * rebuilt on the way out rather than stored as one JSON blob, so occurrence
 * identity stays a key the database can enforce.
 */
export function locationOfColumns(
  row: Record<string, unknown>
): CompanySourceLocator {
  return companyLocatorOf(
    {
      document_id: row.document_id,
      version: row.unit_version,
      unit: row.unit,
    },
    "stored location"
  );
}

/** The span a stored row names, or `null` for the absent spelling. */
export function spanOfColumns(
  row: Record<string, unknown>
): EvidenceSpan | null {
  if (Number(row.span_start) === SPAN_ABSENT) return null;
  return { start: Number(row.span_start), end: Number(row.span_end) };
}

/** Serialized byte cost of a value plus its context, for the bounded envelope. */
export function envelopeBytes(value: unknown, context: unknown): number {
  return Buffer.byteLength(
    JSON.stringify([jsonText(value, "evidence value"), context]),
    "utf8"
  );
}
