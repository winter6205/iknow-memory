/**
 * The query continuation token and the digest that names a query (QP6).
 *
 * Why this codec is not `evidence-continuation.ts`'s: that cursor binds the
 * membership of one FROZEN grant, and a grant is issued after a read has already
 * answered. A list cursor has to be decidable BEFORE the page is read, because
 * it is the thing that says "continue from here, in that revision". So the
 * payload here binds the QUERY, the SCOPE, and the read revision instead — and
 * inherits the discipline rather than the payload: base64url over canonical JSON,
 * an exact key-set match, no partial decode, and every field re-verified against
 * the reads of the transaction that received it.
 *
 * The expiry is carried, never recomputed. A continuation reads `exp` off the
 * cursor it was given, so a caller walking a long result set cannot extend its
 * own window one page at a time.
 */
import { createHash } from "node:crypto";

import { canonicalJson } from "./evidence-source.js";
import type {
  ValidatedStructuredFilter,
  ValidatedStructuredQuery,
} from "../structured/request.js";

/** The cursor dialect this build mints. A different value is not this cursor. */
export const STRUCTURED_QUERY_CURSOR_VERSION = "sq1";

/**
 * The fixed lifetime, measured from the first page. Continuation never renews
 * it, so this is the whole window a caller has to finish walking a result set.
 */
export const STRUCTURED_QUERY_CURSOR_LIFETIME_MS = 10 * 60_000;

/** What one issued cursor carries. Every field is verified before it is believed. */
export interface StructuredQueryCursorPayload {
  /** Cursor dialect. */
  readonly v: string;
  /** Canonical digest of the validated subject and predicates. */
  readonly q: string;
  /** Subject the page was taken under. */
  readonly s: string;
  /** Owner scope binding the page was admitted under. */
  readonly o: string;
  /** Reader binding that selected the view. */
  readonly r: string;
  /** Read revision the page was taken in. */
  readonly rev: string;
  /** The FIXED expiry, carried forward unchanged by every continuation. */
  readonly exp: string;
  /** Exclusive UUID lower bound: the next page starts strictly above this id. */
  readonly aft: string;
}

/**
 * The exact key set a cursor may carry, in the SORTED order `canonicalJson`
 * emits. Comparing against this list — rather than checking membership — is what
 * makes a cursor with an extra or missing field a refusal instead of a decode
 * that quietly tolerates an unknown key.
 */
const PAYLOAD_KEYS = [
  "aft",
  "exp",
  "o",
  "q",
  "r",
  "rev",
  "s",
  "v",
] as const;

/**
 * The canonical digest of a query.
 *
 * Operation, page size, cursor, revision and scope are excluded on purpose: list
 * and count of the same predicates must share one digest, or a count could not be
 * shown to belong to the list it was derived from. Filters are sorted so request
 * order does not change the identity of the question, and `in` values are sorted
 * for the same reason.
 */
export function structuredQueryDigest(
  request: ValidatedStructuredQuery
): string {
  const filters = [...request.filters].map(canonicalFilter);
  const canonical = {
    subject: request.subject,
    filters: filters.sort((left, right) =>
      left.field < right.field ? -1 : left.field > right.field ? 1 : 0
    ),
    relationship:
      request.relationship === undefined
        ? null
        : {
            anchor_entity_id: request.relationship.anchorEntityId,
            direction: request.relationship.direction,
          },
  };
  return createHash("sha256").update(canonicalJson(canonical), "utf8").digest("hex");
}

function canonicalFilter(
  filter: ValidatedStructuredFilter
): { field: string; op: "eq"; value: string } | {
  field: string;
  op: "in";
  values: string[];
} {
  return filter.op === "eq"
    ? { field: filter.field, op: "eq", value: filter.value }
    : { field: filter.field, op: "in", values: [...filter.values].sort() };
}

/**
 * Encode one cursor.
 *
 * The text is base64url over canonical JSON, so a caller cannot read a position
 * out of it or hand-build one: every field it would need is verified against the
 * transaction that receives it before the position is used.
 */
export function encodeStructuredQueryCursor(
  payload: StructuredQueryCursorPayload
): string {
  return Buffer.from(canonicalJson(payload), "utf8").toString("base64url");
}

/**
 * Decode one cursor, or refuse it whole.
 *
 * A value that is not base64url text, not canonical JSON, not a record, or not a
 * record with EXACTLY this cursor's keys, is `null`. There is no partial decode
 * and no "recovered" field, because a cursor whose half was understood is a
 * position this build never issued.
 */
export function decodeStructuredQueryCursor(
  raw: string
): StructuredQueryCursorPayload | null {
  if (raw.length === 0 || !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== PAYLOAD_KEYS.length ||
    keys.some((key, index) => key !== PAYLOAD_KEYS[index])
  ) {
    return null;
  }

  if (PAYLOAD_KEYS.some((key) => !isFilledText(record[key]))) return null;
  return {
    v: record.v as string,
    q: record.q as string,
    s: record.s as string,
    o: record.o as string,
    r: record.r as string,
    rev: record.rev as string,
    exp: record.exp as string,
    aft: record.aft as string,
  };
}

function isFilledText(value: unknown): boolean {
  return typeof value === "string" && value !== "";
}