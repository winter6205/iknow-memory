/**
 * The fin golden worksheet is the cross-language contract for the v1 canonical
 * profile, so it is READ from the fin checkout rather than copied here: a second
 * copy of the vectors is a second source of truth, and drift between the two
 * runtimes is exactly what this suite exists to catch.
 *
 * Resolution order, and it fails loudly at every step rather than skipping:
 *   1. $FIN_STRUCTURED_SNAPSHOT_WORKSHEET — the supported way to point at a
 *      fin checkout whose path is not the default below.
 *   2. A sibling checkout at ../fin (the normal two-repo dev layout).
 * A missing worksheet is a FAILURE, not a skip: a silently skipped
 * cross-language suite is indistinguishable from one that passed.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  SAFE_INTEGER_MAX,
  StructuredSnapshotCanonicalError,
  canonicalBytes,
  canonicalValue,
  structuredSnapshotDigest,
} from "../../src/core/structured-snapshot-canonical.js";

const WORKSHEET_RELATIVE = "data/conformance/evidence/structured_snapshot/digest_worksheet.json";

function resolveWorksheetPath(): string {
  const candidates = [
    process.env.FIN_STRUCTURED_SNAPSHOT_WORKSHEET,
    resolve(dirname(fileURLToPath(import.meta.url)), "../../../fin", WORKSHEET_RELATIVE),
  ].filter((value): value is string => typeof value === "string" && value !== "");
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    "Cannot locate the fin structured-snapshot worksheet. Set " +
      "$FIN_STRUCTURED_SNAPSHOT_WORKSHEET to a fin checkout containing " +
      WORKSHEET_RELATIVE +
      ". Tried:\n  " +
      candidates.join("\n  "),
  );
}

const WORKSHEET_PATH = resolveWorksheetPath();

type Construction =
  | { kind: "float"; value: string }
  | { kind: "int"; value: number }
  | { kind: "surrogate_string" }
  | { kind: "unsupported_type" }
  | { kind: "non_string_key" };

interface SnapshotVector {
  case: string;
  note: string;
  snapshot: unknown;
  canonical_json: string;
  digest: string;
}

interface RefusalVector {
  case: string;
  construction: Construction;
  reason: string;
}

interface Worksheet {
  digest_form: string;
  encoding_rules: string[];
  snapshots: SnapshotVector[];
  refusals: RefusalVector[];
}

/**
 * Absent vectors are a hard failure, not a skip: this suite's only claim is
 * that the two runtimes agree, and a skipped suite is indistinguishable from
 * a passing one in an exit code.
 */
function loadWorksheet(): Worksheet {
  if (!existsSync(WORKSHEET_PATH)) {
    throw new Error(
      `Golden vector worksheet not found at ${WORKSHEET_PATH}.\n` +
        "These vectors are the shared fin/iknow contract for " +
        "fin.evidence.structured_snapshot v1; without them this suite cannot " +
        "verify anything and must not report success. Check out the fin " +
        "worktree at that path, or point WORKSHEET_PATH at it."
    );
  }
  return JSON.parse(readFileSync(WORKSHEET_PATH, "utf8")) as Worksheet;
}

const worksheet = loadWorksheet();

const NAMED_FLOATS: Record<string, number> = {
  nan: Number.NaN,
  inf: Number.POSITIVE_INFINITY,
  "-inf": Number.NEGATIVE_INFINITY,
};

function buildFloat(literal: string): number {
  const named: number | undefined = NAMED_FLOATS[literal];
  if (named !== undefined) return named;
  const parsed = Number(literal);
  if (Number.isNaN(parsed)) {
    throw new Error(`worksheet declares an unhandled float construction: ${literal}`);
  }
  return parsed;
}

function buildRefusal(construction: Construction): unknown {
  switch (construction.kind) {
    case "float":
      return buildFloat(construction.value);
    case "int":
      return construction.value;
    // A lone surrogate is representable in a Node string, so the refusal is
    // reachable rather than impossible.
    case "surrogate_string":
      return "\uD800";
    case "unsupported_type":
      return new Set(["x"]);
    // Python refuses an int-keyed dict; a Map is JS's only carrier of a
    // non-string key, so it is the equivalent construction.
    case "non_string_key":
      return new Map<unknown, unknown>([[1, "x"]]);
  }
}

function reasonOf(encode: () => string): string {
  try {
    encode();
  } catch (error) {
    if (error instanceof StructuredSnapshotCanonicalError) return error.reason;
    throw error;
  }
  throw new Error("expected a refusal, but the value encoded");
}

function refusalReasonOf(value: unknown): string {
  return reasonOf(() => canonicalValue(value));
}

describe("structured snapshot canonical encoding against the fin golden worksheet", () => {
  for (const vector of worksheet.snapshots) {
    it(`encodes ${vector.case} byte-for-byte`, () => {
      expect(canonicalValue(vector.snapshot)).toBe(vector.canonical_json);
      expect(
        Buffer.compare(
          canonicalBytes(vector.snapshot),
          Buffer.from(vector.canonical_json, "utf8")
        )
      ).toBe(0);
      expect(structuredSnapshotDigest(vector.snapshot)).toBe(vector.digest);
      expect(structuredSnapshotDigest(vector.snapshot)).toMatch(/^[0-9a-f]{64}$/);
    });
  }

  for (const vector of worksheet.refusals) {
    it(`refuses ${vector.case} with the declared reason`, () => {
      expect(refusalReasonOf(buildRefusal(vector.construction))).toBe(vector.reason);
    });
  }
});

describe("rules the worksheet payloads leave degenerate", () => {
  it("escapes U+0000-U+001F as lowercase \\u00xx instead of short escapes", () => {
    expect(canonicalValue({ k: "\n\t\b\r" })).toBe('{"k":"\\u000a\\u0009\\u0008\\u000d"}');
    expect(canonicalValue({ k: "\u0000" })).toBe('{"k":"\\u0000"}');
    // The library default this rule exists to reject.
    expect(JSON.stringify({ k: "\n" })).toBe('{"k":"\\n"}');
  });

  it('escapes only " and \\, never a forward slash', () => {
    expect(canonicalValue('"\\/')).toBe('"\\"\\\\/"');
  });

  it("emits U+007F and non-ASCII scalars directly in UTF-8", () => {
    expect(canonicalBytes("\u007f")).toEqual(Buffer.from([0x22, 0x7f, 0x22]));
    expect(canonicalValue("\u5317")).toBe('"\u5317"');
    // No Unicode normalization: the precomposed and decomposed spellings are
    // different values and must stay different.
    expect(canonicalValue("\u00e9")).not.toBe(canonicalValue("e\u0301"));
  });

  it("sorts keys by UTF-8 bytes, not UTF-16 code units", () => {
    const value: Record<string, number> = { "\u{10000}": 1, "\ue000": 2 };
    expect(canonicalValue(value)).toBe('{"\ue000":2,"\u{10000}":1}');
    // The default JS string sort disagrees above U+FFFF, so the byte sort is
    // the rule rather than an encoding coincidence.
    expect([...Object.keys(value)].sort()).toEqual(["\u{10000}", "\ue000"]);
  });

  it("preserves array order", () => {
    expect(canonicalValue([3, 1, 2])).toBe("[3,1,2]");
    expect(canonicalValue(["b", "a"])).toBe('["b","a"]');
  });

  it("normalizes accepted integers to base-10 text with zero as 0", () => {
    expect(canonicalValue([1, 1.0, -0, 0, SAFE_INTEGER_MAX])).toBe(
      `[1,1,0,0,${SAFE_INTEGER_MAX}]`
    );
  });

  it("keeps 1, \"1\" and true distinct", () => {
    expect(canonicalValue(1)).not.toBe(canonicalValue("1"));
    expect(canonicalValue(1)).not.toBe(canonicalValue(true));
    expect(canonicalValue("1")).not.toBe(canonicalValue(true));
    expect(structuredSnapshotDigest({ value: 1 })).not.toBe(
      structuredSnapshotDigest({ value: "1" })
    );
    expect(structuredSnapshotDigest({ value: 1 })).not.toBe(
      structuredSnapshotDigest({ value: true })
    );
  });

  it("accepts a well-formed surrogate pair but refuses a lone surrogate", () => {
    expect(canonicalValue("\u{1f600}")).toBe('"\u{1f600}"');
    expect(refusalReasonOf("\ud83d")).toBe("string carries an unpaired surrogate");
    expect(refusalReasonOf({ "\ud800": 1 })).toBe("object key carries an unpaired surrogate");
  });

  it("refuses a non-mapping snapshot at the digest entry", () => {
    expect(reasonOf(() => structuredSnapshotDigest([]))).toBe("snapshot is not an object");
    expect(reasonOf(() => structuredSnapshotDigest("nope"))).toBe("snapshot is not an object");
    expect(reasonOf(() => structuredSnapshotDigest(undefined))).toBe(
      "snapshot is not an object"
    );
  });
});
