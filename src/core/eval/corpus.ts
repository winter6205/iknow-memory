/**
 * Frozen seed corpus for the retrieve eval (specs/retrieve-p5.md A8).
 *
 * A baseline is only comparable across runs if the thing being searched
 * never moves, so the corpus is a git-tracked JSON file rather than
 * whatever happens to be in an operator's store. No web crawl, no LLM
 * expansion — A8 is explicit about both.
 *
 * The shape is deliberately the ingest-side chunk minus its embedding:
 * the runner embeds `content` with whatever `EmbeddingClient` it was
 * wired with, which is what lets FakeEmbedder produce a byte-stable
 * second run (SC6).
 */
import {
  asNonBlankString,
  asRecord,
  readJsonFixture,
  type FixtureReadFailure,
} from "./fixture-io.js";
import { CorpusFixtureError, type CorpusFixtureErrorCode } from "./errors.js";

/** One seed chunk, pre-embedding. */
export interface EvalCorpusChunk {
  id: string;
  content: string;
  source_ref: string;
  metadata: Record<string, unknown>;
  /** ISO 8601. */
  valid_from: string;
  /** ISO 8601, or null for "valid forever". */
  valid_until: string | null;
}

export interface EvalCorpus {
  version: string;
  chunks: EvalCorpusChunk[];
}

const READ_FAILURE_CODES: Record<FixtureReadFailure, CorpusFixtureErrorCode> = {
  missing: "CORPUS_FILE_MISSING",
  empty: "CORPUS_FILE_EMPTY",
  malformed: "CORPUS_MALFORMED",
};

/** Read + validate a seed corpus from disk. */
export function loadCorpus(path: string): EvalCorpus {
  const read = readJsonFixture(path);
  if (!read.ok) {
    throw new CorpusFixtureError(
      `eval corpus "${path}" is unusable (${read.reason}): ${read.detail}`,
      READ_FAILURE_CODES[read.reason]
    );
  }
  return parseCorpus(read.value, path);
}

/** Validate an already-parsed corpus payload. */
export function parseCorpus(raw: unknown, source: string): EvalCorpus {
  const root = asRecord(raw);
  if (root === undefined) {
    throw malformed(source, "top level must be a JSON object");
  }
  const rawChunks = root["chunks"];
  if (!Array.isArray(rawChunks)) {
    throw malformed(source, `"chunks" must be an array`);
  }
  if (rawChunks.length === 0) {
    throw new CorpusFixtureError(
      `eval corpus "${source}" carries no chunks`,
      "CORPUS_EMPTY"
    );
  }
  const version = asNonBlankString(root["version"]);
  if (version === undefined) {
    throw malformed(source, `"version" must be a non-empty string`);
  }

  const chunks = rawChunks.map((entry, i) => parseChunk(entry, i, source));
  assertUniqueIds(chunks, source);
  return { version, chunks };
}

function parseChunk(
  raw: unknown,
  index: number,
  source: string
): EvalCorpusChunk {
  const entry = asRecord(raw);
  if (entry === undefined) {
    throw invalidChunk(source, `[${index}]`, "must be a JSON object");
  }
  const id = asNonBlankString(entry["id"]);
  const label = id ?? `[${index}]`;
  if (id === undefined) {
    throw invalidChunk(source, label, `"id" must be a non-empty string`);
  }
  const content = asNonBlankString(entry["content"]);
  if (content === undefined) {
    throw invalidChunk(source, label, `"content" must be non-blank text`);
  }
  const sourceRef = asNonBlankString(entry["source_ref"]);
  if (sourceRef === undefined) {
    throw invalidChunk(
      source,
      label,
      `"source_ref" must be a non-empty string`
    );
  }
  return {
    id,
    content,
    source_ref: sourceRef,
    metadata: asRecord(entry["metadata"]) ?? {},
    valid_from: parseTimestamp(entry["valid_from"], label, source),
    valid_until: parseNullableTimestamp(entry["valid_until"], label, source),
  };
}

/**
 * Timestamps are validated here rather than left to the storage backend:
 * an unparseable `valid_from` would make the chunk invisible to every
 * query and drop the baseline to zero with no explanation.
 */
function parseTimestamp(raw: unknown, label: string, source: string): string {
  const value = asNonBlankString(raw);
  if (value === undefined || Number.isNaN(Date.parse(value))) {
    throw invalidChunk(
      source,
      label,
      `"valid_from" must be an ISO 8601 timestamp`
    );
  }
  return value;
}

function parseNullableTimestamp(
  raw: unknown,
  label: string,
  source: string
): string | null {
  if (raw === null || raw === undefined) return null;
  const value = asNonBlankString(raw);
  if (value === undefined || Number.isNaN(Date.parse(value))) {
    throw invalidChunk(
      source,
      label,
      `"valid_until" must be an ISO 8601 timestamp or null`
    );
  }
  return value;
}

/**
 * Duplicate ids would make the gold ambiguous: last-write-wins in the
 * store means one of the two texts is scored and the other is not, with
 * nothing in the baseline saying which.
 */
function assertUniqueIds(
  chunks: readonly EvalCorpusChunk[],
  source: string
): void {
  const seen = new Set<string>();
  for (const chunk of chunks) {
    if (seen.has(chunk.id)) {
      throw new CorpusFixtureError(
        `eval corpus "${source}" repeats chunk id "${chunk.id}"`,
        "CORPUS_DUPLICATE_CHUNK_ID"
      );
    }
    seen.add(chunk.id);
  }
}

function malformed(source: string, detail: string): CorpusFixtureError {
  return new CorpusFixtureError(
    `eval corpus "${source}" is malformed: ${detail}`,
    "CORPUS_MALFORMED"
  );
}

function invalidChunk(
  source: string,
  label: string,
  detail: string
): CorpusFixtureError {
  return new CorpusFixtureError(
    `eval corpus chunk "${label}" in "${source}" is invalid: ${detail}`,
    "CORPUS_CHUNK_INVALID"
  );
}
