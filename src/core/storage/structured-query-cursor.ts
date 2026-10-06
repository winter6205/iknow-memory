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
 *
 * The payload is AUTHENTICATED, not merely encoded. Encoding is what stops a
 * caller reading the position out of the text; signing is what stops it
 * putting a position of its own choosing back in. The other seven fields are
 * all re-verified against the reads of the receiving transaction, and `aft` is
 * not — it is a claim about where the result set ends, and it is applied raw —
 * so it is covered by the MAC instead.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

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
 * The key that authenticates a cursor.
 *
 * A position is a CLAIM about where a result set ends, not a fact the reader can
 * re-derive: every other field is checked against the transaction and then the
 * position is applied raw. Without a signature, a caller who base64-decodes a
 * cursor and rewrites `aft` passes every remaining check and silently resumes
 * past rows it never received — a complete-looking page with a hole in it.
 * Signing the whole canonical payload is what makes "this build minted this,
 * at this position" a checkable fact rather than an assumption.
 *
 * The key is INJECTED, never defaulted, and `requireCursorKey` refuses a short
 * one at composition time: a reader that cannot authenticate its own cursors
 * must not be constructible, because the alternative to supplying a key is not
 * a weaker check but a reader that cannot tell a resumed page from a forged
 * position.
 */
export type StructuredQueryCursorKey = Buffer;

const MINIMUM_CURSOR_KEY_BYTES = 32;

/**
 * Refuse a key too short to authenticate anything, before a reader exists.
 *
 * A zero-length key HMACs perfectly well and is trivially reproducible by
 * anyone, which is the exact failure the signature exists to prevent — so it is
 * rejected at the composition boundary rather than discovered in production.
 */
export function requireCursorKey(key: StructuredQueryCursorKey): StructuredQueryCursorKey {
  if (!Buffer.isBuffer(key) || key.length < MINIMUM_CURSOR_KEY_BYTES) {
    throw new Error(
      `a structured query cursor key needs at least ${MINIMUM_CURSOR_KEY_BYTES} bytes`
    );
  }
  return key;
}

/**
 * Encode one cursor, authenticated.
 *
 * The text is `base64url(canonical JSON)` + `.` + `base64url(HMAC-SHA256)`, so
 * the position cannot be edited without the key: every field it carries,
 * `aft` included, is covered by the MAC, and the reader verifies the MAC before
 * it decodes anything.
 */
export function encodeStructuredQueryCursor(
  payload: StructuredQueryCursorPayload,
  key: StructuredQueryCursorKey
): string {
  const body = Buffer.from(canonicalJson(payload), "utf8").toString("base64url");
  return `${body}.${cursorMac(body, key)}`;
}

function cursorMac(body: string, key: StructuredQueryCursorKey): string {
  return createHmac("sha256", key).update(body, "utf8").digest("base64url");
}

/**
 * Decode one cursor, or refuse it whole.
 *
 * A value that is not base64url text, not canonical JSON, not a record, not a
 * record with EXACTLY this cursor's keys, or not signed by this deployment's
 * key, is `null`. There is no partial decode and no "recovered" field, because a
 * cursor whose half was understood is a position this build never issued.
 */
export function decodeStructuredQueryCursor(
  raw: string,
  key: StructuredQueryCursorKey
): StructuredQueryCursorPayload | null {
  if (raw.length === 0 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(raw)) return null;
  const separator = raw.indexOf(".");
  const body = raw.slice(0, separator);
  const presented = raw.slice(separator + 1);
  // Constant-time comparison: a MAC that can be probed byte by byte is not a
  // signature, and this branch runs on untrusted text.
  const expected = Buffer.from(cursorMac(body, key), "utf8");
  const offered = Buffer.from(presented, "utf8");
  if (expected.length !== offered.length) return null;
  if (!timingSafeEqual(expected, offered)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
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