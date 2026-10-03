/**
 * Persistent structured-result identity (structured corpus query, Q-ID).
 *
 * Two result subjects, two very different identity questions:
 *
 *   - An ENTITY result's identity is the entity's existing UUID. This module
 *     only canonicalizes and validates that UUID; it never mints one. Entity
 *     identity belongs to the `entities` table's write boundary, and a second
 *     scheme here would split one entity into two results.
 *
 *   - A RELATION ASSERTION's identity is a deterministic function of the exact
 *     normalized tuple `(canonical head entity UUID, relation_norm, canonical
 *     tail entity UUID, valid_window)`. One exact tuple gets one ID, forever:
 *     repeated support from a second source resolves to the same ID, and an
 *     extraction/index rebuild re-derives the same ID. A *changed* tuple gets a
 *     new ID — a versioned correction, never a silent merge by similarity,
 *     co-occurrence, confidence, source frequency, or recency. The write layer's
 *     existing overlap dedup (`core/extraction/dedup.ts`) does merge overlapping
 *     windows; identity deliberately does not, and keeping the two apart is the
 *     point of deriving the ID from the whole tuple.
 *
 * Everything here is pure and Postgres-free: the same functions back the
 * in-memory and the Postgres registration store.
 */
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import { ENTITY_TYPES, type EntityType } from "../extraction/entity-type.js";

/**
 * Version of the tuple→UUID derivation. Part of the hashed serialization, so
 * bumping it makes the same tuple derive a DIFFERENT id instead of colliding
 * with the identity it would correct. A correction therefore creates a new
 * identity rather than mutating a registered one, and every registered row
 * records the version it was minted under.
 */
export const RELATION_ASSERTION_IDENTITY_VERSION = 1;

/**
 * Frozen RFC 4122 namespace for the relation-assertion derivation. Changing it
 * re-derives every assertion id in the corpus, so it is a one-way door — the
 * `v`-prefixed domain tag below is the second half of that protection.
 */
export const RELATION_ASSERTION_IDENTITY_NAMESPACE =
  "0f3d2b1a-5c48-4e6d-9a70-8b1c2d3e4f50";

/**
 * Domain tag mixed into every serialization. It is length-prefixed like the
 * tuple fields, so a future identity derivation can claim the same namespace
 * without ever colliding with these ids.
 */
const RELATION_ASSERTION_IDENTITY_DOMAIN = "iknow.structured_relation_identity";

/**
 * Wire value for an unbounded interval endpoint. The accepted timestamp grammar
 * below cannot produce a NUL, so this marker can never collide with a real
 * endpoint — which is what keeps `from: null` distinguishable from an empty
 * string in the length-prefixed encoding.
 */
const UNBOUNDED_ENDPOINT = "\u0000";

const UUID_SHAPE_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * What a UUID boundary does with the CASE of a value it has accepted. The two
 * boundaries need opposite things from the same shape, so the policy is a named
 * input of one shared primitive rather than two validators that could drift:
 *
 *   - `preserve` — the structured REQUEST boundary (`request.ts`). PostgreSQL's
 *     `uuid` comparison is case-insensitive, so an id the caller spelled in
 *     uppercase still matches the stored lowercase row. Folding it here would
 *     silently change what the caller sent.
 *   - `canonicalize` — the identity boundary (this module). Every spelling of
 *     one entity must derive ONE id, so folding is the entire point.
 */
export type UuidCasePolicy = "preserve" | "canonicalize";

/**
 * The one UUID shape check both structured boundaries share.
 *
 * Returns `undefined` when the value is not the strict 8-4-4-4-12 hex spelling,
 * and leaves the refusal to the caller: the two boundaries refuse with
 * different vocabularies (`invalid_value` at the request edge,
 * `StructuredIdentityError` with a `field` here), and neither owns the other's.
 *
 * The shape is deliberately strict on BOTH policies — braced and `urn:uuid:`
 * forms are decorator spellings that `normalizeEntityId` strips before it gets
 * here. Accepting them in the primitive would silently widen the request
 * boundary as well.
 */
export function readUuidShape(
  raw: string,
  policy: UuidCasePolicy
): string | undefined {
  if (typeof raw !== "string" || !UUID_SHAPE_RE.test(raw)) {
    return undefined;
  }
  return policy === "canonicalize" ? raw.toLowerCase() : raw;
}

/**
 * Accepted endpoint grammar: a whole-second UTC instant, optionally with a
 * fractional part and/or a numeric offset. Deliberately narrow — anything that
 * would have to be WIDENED by assumption (a date with no time, a minute-precision
 * time, a bare local time with no offset) is refused rather than guessed.
 */
const ENDPOINT_RE =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?([Zz]|[+-]\d{2}(?::?\d{2})?(?::?\d{2})?)$/;

const CANONICAL_ENDPOINT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/**
 * A refusal to register an identity. `code` reuses the query contract's
 * `invalid_value` rather than inventing a new error word: the value violates a
 * declared type or bound, which is exactly what `invalid_value` already means
 * at the request boundary. `field` names the offending input so an
 * operator-facing handler can act on it instead of pattern-matching prose.
 */
export class StructuredIdentityError extends Error {
  readonly code = "invalid_value" as const;

  constructor(
    message: string,
    readonly field: string
  ) {
    super(message);
    this.name = "StructuredIdentityError";
  }
}

/** A half-open `[from, until)` business-validity interval, whole-second UTC. */
export interface NormalizedValidWindow {
  /** Left-closed bound (inclusive), or null when unbounded below. */
  readonly from: string | null;
  /** Right-open bound (exclusive), or null when unbounded above. */
  readonly until: string | null;
}

/** The caller-supplied interval, before normalization. */
export interface ValidWindowInput {
  readonly from: string | null;
  readonly until: string | null;
}

/**
 * The two endpoints of a validity interval, as the `field` a refusal names.
 *
 * A closed union rather than a bare string because `field` is what an
 * operator-facing handler ACTS on: a refusal raised while reading the `until`
 * offset must not be reported as a `from` problem, or the handler sends the
 * caller to fix the wrong bound. Typing it makes that drift a compile error at
 * every refusal site below.
 */
export type ValidWindowField = "valid_window.from" | "valid_window.until";

/** The exact normalized tuple a relation assertion's identity is derived from. */
export interface RelationAssertionTuple {
  readonly headEntityId: string;
  readonly relationNorm: string;
  readonly tailEntityId: string;
  readonly validWindow: NormalizedValidWindow;
  readonly identityVersion: number;
}

/** Raw extracted relation assertion, before normalization. */
export interface RelationAssertionInput {
  readonly headEntityId: string;
  readonly relationNorm: string;
  readonly tailEntityId: string;
  readonly validWindow: ValidWindowInput;
  readonly identityVersion?: number;
}

function refuse(field: string, reason: string): never {
  throw new StructuredIdentityError(
    `structured identity refused ${field}: ${reason}`,
    field
  );
}

/**
 * Canonicalize an entity UUID. Uppercase, braced and `urn:uuid:` spellings all
 * name the SAME entity, so they must derive the same identity — otherwise one
 * entity would surface as several results. Only the shape is validated: the
 * `entities` table is the minting boundary, so there is no value here worth
 * refusing beyond "not a UUID".
 */
export function normalizeEntityId(raw: string): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    return refuse("entity_id", "must be a non-empty UUID string");
  }
  let candidate = raw.trim();
  if (candidate.toLowerCase().startsWith("urn:uuid:")) {
    candidate = candidate.slice("urn:uuid:".length);
  }
  if (candidate.startsWith("{") && candidate.endsWith("}")) {
    candidate = candidate.slice(1, -1);
  }
  candidate = candidate.trim();
  const canonical = readUuidShape(candidate, "canonicalize");
  if (canonical === undefined) {
    return refuse("entity_id", `${raw} is not a canonical UUID`);
  }
  return canonical;
}

/**
 * Canonicalize a persisted `relation_norm`. Trim + case-fold is the same
 * canonicalization the persist boundary applies to an LLM-claimed norm
 * (`core/extraction/persist.ts`), so the surface forms that reach the identity
 * layer keep naming one relation instead of one relation per spelling. The
 * vocabulary has no two members differing only in case, so folding cannot
 * equate two distinct relations.
 */
export function normalizeRelationNorm(raw: string): string {
  if (typeof raw !== "string") {
    return refuse("relation_norm", "must be a string");
  }
  const canonical = raw.trim().toLowerCase();
  if (canonical === "") {
    return refuse("relation_norm", "must not be empty");
  }
  return canonical;
}

/**
 * Validate an entity type against the closed `EntityType` catalog.
 *
 * Deliberately NOT `normalizeEntityType` (core/extraction/entity-type.ts):
 * that mapper turns LLM surface forms ("human", "org", "Location") into
 * catalog members for the EXTRACT path, and it returns `null` for unknown
 * types. An already-persisted `entities.type` has passed that mapper and the
 * table CHECK, so re-mapping it here could only widen the closed catalog that
 * the identity DDL derives its CHECK from.
 */
export function requireEntityType(raw: string): EntityType {
  if (typeof raw !== "string") {
    return refuse("entity_type", "must be a string");
  }
  const found = ENTITY_TYPES.find((type) => type === raw);
  if (found === undefined) {
    return refuse(
      "entity_type",
      `${raw} is outside the closed EntityType catalog (${ENTITY_TYPES.join(", ")})`
    );
  }
  return found;
}

/**
 * Signed minute offset of a parsed endpoint, or 0 for `Z`. `field` is the
 * endpoint this offset was read from, so a refusal names the bound the caller
 * actually has to fix.
 */
function offsetMinutesOf(
  offset: string | undefined,
  field: ValidWindowField
): number {
  if (offset === undefined || offset === "Z" || offset === "z") return 0;
  const sign = offset.startsWith("-") ? -1 : 1;
  const digits = offset.slice(1).replace(/:/g, "");
  const hours = Number(digits.slice(0, 2));
  const minutes = Number(digits.slice(2, 4) || "0");
  const seconds = Number(digits.slice(4, 6) || "0");
  // A sub-minute offset lands the UTC instant between two whole seconds, so the
  // canonical whole-second form cannot represent it without inventing a value.
  if (seconds !== 0) {
    return refuse(
      field,
      "an offset with a seconds component is not losslessly convertible to whole-second UTC"
    );
  }
  if (hours > 23 || minutes > 59) {
    return refuse(field, `offset ${offset} is out of range`);
  }
  return sign * (hours * 60 + minutes);
}

function normalizeEndpoint(raw: string, field: ValidWindowField): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    return refuse(field, "must be a non-empty timestamp string");
  }
  const match = ENDPOINT_RE.exec(raw.trim());
  if (match === null) {
    return refuse(
      field,
      `${raw} is outside the accepted YYYY-MM-DDTHH:mm:ss(±offset) encoding`
    );
  }
  const [, year, month, day, hour, minute, second, fraction, offset] = match;
  if (Number(second) > 59) {
    // A leap second is a real instant, but not one the POSIX timeline this
    // corpus stores can name; rounding it down would name a different second.
    return refuse(field, `${raw} is not a whole second (leap second :60)`);
  }
  // Rounding a nonzero fraction would equate an assertion that never held at
  // the rounded second with one that did. `.000` names the same whole second,
  // so it is the one fraction that is losslessly acceptable.
  if (fraction !== undefined && /[1-9]/.test(fraction)) {
    return refuse(
      field,
      `${raw} carries nonzero fractional seconds; rounding them would invent equivalence`
    );
  }
  // setUTCFullYear, not the Date.UTC year argument: Date.UTC maps 0–99 onto
  // 1900–1999, which would silently re-date a low-year endpoint.
  const local = new Date(0);
  local.setUTCFullYear(
    Number(year),
    Number(month) - 1,
    Number(day)
  );
  local.setUTCHours(Number(hour), Number(minute), Number(second), 0);
  if (
    local.getUTCFullYear() !== Number(year) ||
    local.getUTCMonth() !== Number(month) - 1 ||
    local.getUTCDate() !== Number(day) ||
    local.getUTCHours() !== Number(hour) ||
    local.getUTCMinutes() !== Number(minute) ||
    local.getUTCSeconds() !== Number(second)
  ) {
    // The calendar date does not exist (e.g. 2024-02-30). `Date` would roll it
    // over to the next month; refused instead of rolled.
    return refuse(field, `${raw} is not a real calendar instant`);
  }
  const shifted = new Date(local.getTime() - offsetMinutesOf(offset, field) * 60_000);
  const canonical = shifted.toISOString().replace(/\.000Z$/, "Z");
  if (!CANONICAL_ENDPOINT_RE.test(canonical)) {
    return refuse(
      field,
      `${raw} does not fall inside the representable YYYY-MM-DDTHH:mm:ssZ range once converted to UTC`
    );
  }
  return canonical;
}

/**
 * Normalize a business-validity interval to strict whole-second UTC, then
 * refuse an interval that cannot be a half-open range.
 *
 * The SPEC's rule, in the order the checks run: a nonzero fractional part is
 * rejected rather than rounded; offset conversion happens only when lossless;
 * null endpoints stay null (unbounded) rather than being pinned to a sentinel
 * date; and with both endpoints present the interval must be non-empty, i.e.
 * `from < until` — a zero-length or reversed interval is refused BEFORE it can
 * be registered, not repaired.
 *
 * `undefined` is refused on either side rather than coerced to `null`.
 * `ValidWindowInput` declares `string | null`, so an `undefined` endpoint is a
 * LOST endpoint, and reading it as unbounded would silently widen the
 * assertion's scope and derive a different persistent id with no refusal.
 */
export function normalizeValidWindow(
  input: ValidWindowInput
): NormalizedValidWindow {
  const from = normalizeEndpointOrUnbounded(input.from, "valid_window.from");
  const until = normalizeEndpointOrUnbounded(input.until, "valid_window.until");
  if (from !== null && until !== null) {
    // Both endpoints are now fixed-width, zero-padded, UTC, so their string
    // order IS their chronological order.
    if (from === until) {
      return refuse(
        "valid_window",
        `[${from}, ${until}) is empty; a half-open interval needs from < until`
      );
    }
    if (from > until) {
      return refuse(
        "valid_window",
        `[${from}, ${until}) is reversed; a half-open interval needs from < until`
      );
    }
  }
  return { from, until };
}

/**
 * One endpoint: `null` is the declared unbounded case, a string is normalized,
 * and `undefined` — outside the declared `string | null` — is a lost endpoint
 * and is refused instead of being read as unbounded.
 */
function normalizeEndpointOrUnbounded(
  raw: string | null,
  field: ValidWindowField
): string | null {
  if (raw === undefined) {
    return refuse(
      field,
      "is undefined; use null for an unbounded endpoint — a missing endpoint " +
        "is a lost endpoint, not an open-ended one"
    );
  }
  return raw === null ? null : normalizeEndpoint(raw, field);
}

/**
 * Length-prefix one serialized field. The `<utf8ByteLength>:` prefix is what
 * makes the encoding unambiguous: a bare separator join lets a value that
 * happens to contain the separator shift a field boundary and make two DIFFERENT
 * tuples serialize identically, which would merge two assertions into one id.
 */
function prefixedField(value: string): string {
  return `${Buffer.byteLength(value, "utf8")}:${value}`;
}

/**
 * Canonical, unambiguous serialization of the exact identity tuple.
 *
 * Every component — the domain tag, the version, both UUIDs, the norm and both
 * window endpoints — is length-prefixed, so the concatenation is decodable and
 * no value's content can be mistaken for a field boundary. The identity version
 * is inside the hashed bytes, which is what lets a future correction derive a
 * new id for the same tuple instead of colliding with this one.
 */
export function serializeRelationAssertionTuple(
  tuple: RelationAssertionTuple
): string {
  assertIdentityVersion(tuple.identityVersion);
  return [
    prefixedField(RELATION_ASSERTION_IDENTITY_DOMAIN),
    prefixedField(`v${tuple.identityVersion}`),
    prefixedField(tuple.headEntityId),
    prefixedField(tuple.relationNorm),
    prefixedField(tuple.tailEntityId),
    prefixedField(tuple.validWindow.from ?? UNBOUNDED_ENDPOINT),
    prefixedField(tuple.validWindow.until ?? UNBOUNDED_ENDPOINT),
  ].join("");
}

function assertIdentityVersion(version: number): void {
  if (
    typeof version !== "number" ||
    !Number.isSafeInteger(version) ||
    version < 1
  ) {
    return refuse(
      "identity_version",
      `${String(version)} is not a positive safe integer`
    );
  }
}

/**
 * Content digest of the canonical serialization. Stored beside the identity so
 * the database can enforce "one exact tuple, one id" with a UNIQUE index, and so
 * a stored row can be audited by re-serializing its own columns.
 */
export function relationAssertionTupleDigest(
  tuple: RelationAssertionTuple
): string {
  return createHash("sha256")
    .update(serializeRelationAssertionTuple(tuple), "utf8")
    .digest("hex");
}

/**
 * RFC 4122 §4.3 name-based UUID (SHA-1, version 5) over the canonical
 * serialization, namespaced per RELATION_ASSERTION_IDENTITY_NAMESPACE.
 *
 * SHA-1 is used as a deterministic name-based hash, not as a security
 * primitive: nothing here resists an adversary, and 128 truncated bits separate
 * corpus-sized tuple populations far beyond collision. Version 5 in the nibble
 * is the signal that this id is DERIVED, so it is never confused with the
 * random `randomUUID()` ids the entity table mints.
 */
function uuidV5(namespace: string, name: string): string {
  const namespaceBytes = Buffer.from(namespace.replace(/-/g, ""), "hex");
  if (namespaceBytes.length !== 16) {
    return refuse("identity_namespace", `${namespace} is not a UUID`);
  }
  const bytes = Buffer.from(
    createHash("sha1")
      .update(namespaceBytes)
      .update(name, "utf8")
      .digest()
      .subarray(0, 16)
  );
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

/**
 * The persistent id of one exact normalized relation-assertion tuple.
 *
 * Deterministic and pure: the same tuple always derives the same UUID, which is
 * what makes repeated support collapse onto one assertion and a rebuild
 * re-derive the same identity. Requires a normalized tuple
 * (`normalizeRelationAssertion`); this function deliberately does not re-derive
 * a canonical form from arbitrary input.
 */
export function deriveRelationAssertionId(
  tuple: RelationAssertionTuple
): string {
  return uuidV5(
    RELATION_ASSERTION_IDENTITY_NAMESPACE,
    serializeRelationAssertionTuple(tuple)
  );
}

/**
 * Normalize raw extracted values into the exact identity tuple, refusing the
 * same values `deriveRelationAssertionId`'s contract assumes away. This is the
 * one entry point callers should use: a caller cannot reach the derivation
 * with an un-canonicalized UUID, an un-folded norm, or a non-whole-second or
 * empty/reversed window.
 */
export function normalizeRelationAssertion(
  input: RelationAssertionInput
): RelationAssertionTuple {
  const identityVersion = input.identityVersion ?? RELATION_ASSERTION_IDENTITY_VERSION;
  return {
    headEntityId: normalizeEntityId(input.headEntityId),
    relationNorm: normalizeRelationNorm(input.relationNorm),
    tailEntityId: normalizeEntityId(input.tailEntityId),
    validWindow: normalizeValidWindow(input.validWindow),
    identityVersion,
  };
}
