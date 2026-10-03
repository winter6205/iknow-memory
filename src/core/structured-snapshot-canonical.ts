/**
 * Type-preserving canonical bytes and digest for the structured-result
 * snapshot.
 *
 * A NEW contract beside ADR 0092's legacy textified digest, not a
 * replacement: that profile collapses `30`, `"30"` and `30.0` onto
 * overlapping text, which is exactly what a structured claim must not do.
 * Nothing here routes through it, and the two digest spellings stay
 * deliberately distinct (bare hex here, `sha256:` there) so an accidental
 * cross-profile comparison fails loudly instead of appearing to agree.
 *
 * Four rules, each spelled out rather than left to a JSON library default:
 *
 * 1. **Types stay distinct.** `null`, `true`, `"1"` and `1` must not
 *    collide, or a claim could verify against a value the producer never
 *    sent. Numbers that are non-finite, fractional, or beyond the safe
 *    integer range are refused rather than coerced: a snapshot is a contract
 *    value, and a silent `NaN` spelling would enter the digest under text no
 *    producer wrote. Accepted integers normalize to base-10 text with zero as
 *    `0`, which is what makes a decoded `1.0` and a wire `1` agree (ADR 0093:
 *    one version, two spellings).
 * 2. **Keys sort by UTF-8 bytes** and array order is preserved, so a support
 *    array's required stable ordering survives the digest. For valid scalars
 *    UTF-8 byte order equals code-point order, but the encoded bytes are
 *    sorted anyway: the spec names bytes, and the property should hold by
 *    construction rather than by an encoding coincidence. It is not one --
 *    UTF-16 code-unit order, which is what a plain JS string sort yields,
 *    disagrees with code-point order above U+FFFF.
 * 3. **Strings escape explicitly.** `"` and `\`, then U+0000-U+001F as
 *    lowercase `\u00xx`. Every other scalar is emitted directly in UTF-8 with
 *    no Unicode normalization. `JSON.stringify` would emit `\n`/`\t`/`\b`
 *    short escapes and escape non-ASCII: a library default, not a contract.
 * 4. **Literals are literal.** `null`/`true`/`false`, recursing into every
 *    nested value including maintenance and count metadata.
 *
 * An unpaired surrogate is refused here rather than at the boundary. Node
 * strings can hold lone surrogates, and a repaired one would enter the digest
 * as bytes the producer never sent.
 *
 * Python authority: `fin/host/structured_snapshot.py`. The shared golden
 * vectors are `data/conformance/evidence/structured_snapshot/digest_worksheet.json`
 * in the fin worktree; both runtimes are asserted against that one file.
 */
import { createHash } from "node:crypto";

/**
 * The safe-integer ceiling, 2**53 - 1: the largest integer a double
 * represents exactly. A number beyond it may already have lost precision in
 * the producer's JSON text, so accepting it would digest a value the
 * producer never measured.
 */
export const SAFE_INTEGER_MAX = Number.MAX_SAFE_INTEGER;

/**
 * A value the v1 canonical profile cannot encode.
 *
 * `reason` is the machine-readable cause, shared verbatim with the Python
 * host because the golden worksheet compares reason strings across runtimes.
 * It is raised, never returned as an empty success: an unencodable value is
 * a malformed contract, not a missing one.
 */
export class StructuredSnapshotCanonicalError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = "StructuredSnapshotCanonicalError";
    this.reason = reason;
  }
}

function refuse(reason: string): never {
  throw new StructuredSnapshotCanonicalError(reason);
}

/**
 * The type name a refusal reason quotes. The worksheet compares reason
 * strings across runtimes, so a JS value reports the name the Python host
 * would see for the same conceptual value; a value outside the JSON space
 * falls back to its own constructor name, which no Python side can produce.
 */
function typeName(value: unknown): string {
  if (value === null) return "NoneType";
  if (Array.isArray(value)) return "list";
  if (value instanceof Set) return "set";
  switch (typeof value) {
    case "boolean":
      return "bool";
    case "string":
      return "str";
    case "number":
      return Number.isInteger(value) ? "int" : "float";
    // JSON has no `undefined`, so it has no Python counterpart either.
    case "undefined":
      return "undefined";
    default:
      return (value as { constructor?: { name?: string } }).constructor?.name ?? "object";
  }
}

/** A string carrying a lone surrogate; `Buffer.from` would repair it to U+FFFD. */
function hasLoneSurrogate(value: string): boolean {
  for (const char of value) {
    if (char.length === 1) {
      const code = char.charCodeAt(0);
      if (code >= 0xd800 && code <= 0xdfff) return true;
    }
  }
  return false;
}

function canonicalString(value: string): string {
  let out = '"';
  for (const char of value) {
    // A well-formed pair iterates as one two-unit string; a lone surrogate
    // iterates as one single-unit string, which is the only way to tell them
    // apart here.
    if (char.length === 1) {
      const code = char.charCodeAt(0);
      if (code >= 0xd800 && code <= 0xdfff) {
        refuse("string carries an unpaired surrogate");
      }
    }
    if (char === '"') {
      out += '\\"';
    } else if (char === "\\") {
      out += "\\\\";
    } else {
      const code = char.codePointAt(0) ?? 0;
      out += code <= 0x1f ? `\\u${code.toString(16).padStart(4, "0")}` : char;
    }
  }
  return `${out}"`;
}

function canonicalNumber(value: number): string {
  if (!Number.isFinite(value)) refuse("number is not finite");
  if (!Number.isInteger(value)) refuse("number has a fractional decoded value");
  if (Math.abs(value) > SAFE_INTEGER_MAX) refuse("number is outside the safe integer range");
  // `String(-0)` is "0" and `String(1.0)` is "1", the same base-10 integer text
  // Python's `str(int(...))` produces for the equivalent value.
  return String(value);
}

/**
 * The sort key for an object key: its UTF-8 bytes, plus the escaped text that
 * goes into the output. Keys are validated before any value is encoded, so a
 * malformed key is refused ahead of a malformed value it sits beside.
 */
function canonicalKey(key: unknown): { bytes: Buffer; text: string } {
  if (typeof key !== "string") {
    refuse(`object key is not a string: ${typeName(key)}`);
  }
  if (hasLoneSurrogate(key)) {
    refuse("object key carries an unpaired surrogate");
  }
  return { bytes: Buffer.from(key, "utf8"), text: canonicalString(key) };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isMapping(
  value: unknown
): value is Record<string, unknown> | Map<unknown, unknown> {
  return isPlainObject(value) || value instanceof Map;
}

/**
 * A `Map` is encoded as an object because it is JS's only carrier of a
 * non-string key, and a non-string key is a refusal the contract has to be
 * able to reach. Every other class instance is refused by name.
 */
function canonicalMapping(value: Record<string, unknown> | Map<unknown, unknown>): string {
  const entries = value instanceof Map ? [...value] : Object.entries(value);
  const keyed = entries
    .map(([key, item]) => ({ key: canonicalKey(key), item }))
    .sort((left, right) => Buffer.compare(left.key.bytes, right.key.bytes));
  return `{${keyed.map(({ key, item }) => `${key.text}:${canonicalValue(item)}`).join(",")}}`;
}

/** Encode one validated JSON value under the v1 canonical rules. */
export function canonicalValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalValue(item)).join(",")}]`;
  }
  if (isMapping(value)) return canonicalMapping(value);
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return canonicalString(value);
    case "number":
      return canonicalNumber(value);
    default:
      return refuse(`unsupported value type: ${typeName(value)}`);
  }
}

/** The canonical UTF-8 encoding of one validated JSON value. */
export function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(canonicalValue(value), "utf8");
}

/**
 * Lowercase hex SHA-256 of the canonical UTF-8 bytes.
 *
 * Bare hex, unlike the legacy `sha256:`-prefixed carrier: the spec names
 * "lowercase hexadecimal SHA-256" for this profile and prefixes it for no
 * reason.
 */
export function structuredSnapshotDigest(snapshot: unknown): string {
  if (!isMapping(snapshot)) {
    refuse("snapshot is not an object");
  }
  return createHash("sha256").update(canonicalBytes(snapshot)).digest("hex");
}
