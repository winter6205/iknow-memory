/**
 * Gold fixture schema + loader (specs/retrieve-p5.md SC3, A8).
 *
 * Gold is `query → set of relevant chunk ids`. Nothing else: no expected
 * ranking, no per-arm annotation, no relevance grades. A2 fixes the
 * metric as "hits in the fused top-5", so a richer gold shape would
 * describe something the scorer cannot read.
 *
 * The 8–15 band is a frozen decision (A8), enforced here rather than in a
 * lint script so `npm test` is the validate step — a gold set that grew
 * past 15 without a human deciding to grow it fails the suite instead of
 * quietly shifting every baseline number.
 */
import {
  asNonBlankString,
  asRecord,
  readJsonFixture,
  type FixtureReadFailure,
} from "./fixture-io.js";
import { GoldFixtureError, type GoldFixtureErrorCode } from "./errors.js";

/** Inclusive lower bound on gold size (A8). */
export const GOLD_MIN_QUERIES = 8;
/** Inclusive upper bound on gold size (A8); growing it is Ask-first. */
export const GOLD_MAX_QUERIES = 15;

/** One gold entry: a question and the chunks that should answer it. */
export interface GoldQuery {
  /** Stable id, used in the baseline JSON and in error messages. */
  id: string;
  /** The text handed to retrieve verbatim. */
  query: string;
  /** Distinct chunk ids considered relevant; never empty. */
  relevant: string[];
}

export interface GoldSet {
  /** Fixture version, recorded in the baseline so a diff is explainable. */
  version: string;
  /** Version of the seed corpus the ids point into. */
  corpus: string;
  queries: GoldQuery[];
}

const READ_FAILURE_CODES: Record<FixtureReadFailure, GoldFixtureErrorCode> = {
  missing: "GOLD_FILE_MISSING",
  empty: "GOLD_FILE_EMPTY",
  malformed: "GOLD_MALFORMED",
};

/** Read + validate a gold fixture from disk. */
export function loadGoldSet(path: string): GoldSet {
  const read = readJsonFixture(path);
  if (!read.ok) {
    throw new GoldFixtureError(
      `gold fixture "${path}" is unusable (${read.reason}): ${read.detail}`,
      READ_FAILURE_CODES[read.reason]
    );
  }
  return parseGoldSet(read.value, path);
}

/**
 * Validate an already-parsed gold payload. `source` names the fixture in
 * every error message (a path, or "inline" for a literal in a test).
 */
export function parseGoldSet(raw: unknown, source: string): GoldSet {
  const root = asRecord(raw);
  if (root === undefined) {
    throw malformed(source, "top level must be a JSON object");
  }
  const rawQueries = root["queries"];
  if (!Array.isArray(rawQueries)) {
    throw malformed(source, `"queries" must be an array`);
  }
  assertGoldSize(rawQueries.length, source);

  const version = asNonBlankString(root["version"]);
  const corpus = asNonBlankString(root["corpus"]);
  if (version === undefined || corpus === undefined) {
    throw malformed(
      source,
      `"version" and "corpus" must both be non-empty strings`
    );
  }

  const queries = rawQueries.map((entry, i) =>
    parseGoldQuery(entry, i, source)
  );
  assertUniqueIds(queries, source);
  return { version, corpus, queries };
}

/**
 * Zero queries and "wrong number of queries" are separate codes: the
 * first is an empty fixture (the operator pointed at the wrong file), the
 * second is a fixture that outgrew the frozen band.
 */
function assertGoldSize(count: number, source: string): void {
  if (count === 0) {
    throw new GoldFixtureError(
      `gold fixture "${source}" carries no queries`,
      "GOLD_EMPTY"
    );
  }
  if (count < GOLD_MIN_QUERIES || count > GOLD_MAX_QUERIES) {
    throw new GoldFixtureError(
      `gold fixture "${source}" has ${count} queries; gold v1 is frozen at ${GOLD_MIN_QUERIES}-${GOLD_MAX_QUERIES} inclusive (growing it is a human decision, see specs/retrieve-p5.md A8)`,
      "GOLD_SIZE_OUT_OF_RANGE"
    );
  }
}

function parseGoldQuery(
  raw: unknown,
  index: number,
  source: string
): GoldQuery {
  const entry = asRecord(raw);
  if (entry === undefined) {
    throw invalidQuery(source, `[${index}]`, "must be a JSON object");
  }
  const id = asNonBlankString(entry["id"]);
  const label = id ?? `[${index}]`;
  if (id === undefined) {
    throw invalidQuery(source, label, `"id" must be a non-empty string`);
  }
  const query = asNonBlankString(entry["query"]);
  if (query === undefined) {
    throw invalidQuery(source, label, `"query" must be a non-blank string`);
  }
  return {
    id,
    query,
    relevant: parseRelevant(entry["relevant"], label, source),
  };
}

/**
 * An empty relevant set is its own code, not a generic "invalid query":
 * it is the exact case SC2 calls out, where a lenient reader would hand
 * the scorer a zero denominator.
 */
function parseRelevant(raw: unknown, label: string, source: string): string[] {
  if (!Array.isArray(raw)) {
    throw invalidQuery(source, label, `"relevant" must be an array`);
  }
  const ids: string[] = [];
  for (const value of raw) {
    const id = asNonBlankString(value);
    if (id === undefined) {
      throw invalidQuery(
        source,
        label,
        `"relevant" entries must be non-empty chunk ids`
      );
    }
    ids.push(id);
  }
  if (ids.length === 0) {
    throw new GoldFixtureError(
      `gold query "${label}" in "${source}" has an empty relevant set: R@5 has no denominator without at least one relevant chunk id`,
      "GOLD_RELEVANT_EMPTY"
    );
  }
  return ids;
}

/**
 * Ids key the baseline JSON, so a duplicate would silently overwrite one
 * query's numbers with another's rather than producing a visible clash.
 */
function assertUniqueIds(queries: readonly GoldQuery[], source: string): void {
  const seen = new Set<string>();
  for (const query of queries) {
    if (seen.has(query.id)) {
      throw invalidQuery(
        source,
        query.id,
        "id is used by more than one gold query"
      );
    }
    seen.add(query.id);
  }
}

function malformed(source: string, detail: string): GoldFixtureError {
  return new GoldFixtureError(
    `gold fixture "${source}" is malformed: ${detail}`,
    "GOLD_MALFORMED"
  );
}

function invalidQuery(
  source: string,
  label: string,
  detail: string
): GoldFixtureError {
  return new GoldFixtureError(
    `gold query "${label}" in "${source}" is invalid: ${detail}`,
    "GOLD_QUERY_INVALID"
  );
}
