/**
 * Frozen chunk snapshot loader (specs/p0-eval.md A5, A9, SC8).
 *
 * The snapshot is the corpus the gold model read, frozen in git so an
 * extraction-F1 series stays comparable across runs. The 10–40 band is
 * enforced here rather than in a lint script so `npm test` is the
 * validate step: a snapshot that silently grew past 40 fails the suite
 * instead of quietly moving every baseline number.
 */
import {
  asNonBlankString,
  asRecord,
  readJsonFixture,
  type FixtureReadFailure,
} from "./fixture-io.js";
import { ChunkSnapshotError, type ChunkSnapshotErrorCode } from "./errors.js";
import {
  SNAPSHOT_MAX_CHUNKS,
  SNAPSHOT_MIN_CHUNKS,
  type ChunkSnapshot,
  type SnapshotChunk,
} from "./types.js";

const READ_FAILURE_CODES: Record<FixtureReadFailure, ChunkSnapshotErrorCode> = {
  missing: "SNAPSHOT_FILE_MISSING",
  empty: "SNAPSHOT_FILE_EMPTY",
  malformed: "SNAPSHOT_MALFORMED",
};

/** Read + validate a chunk snapshot from disk. */
export function loadChunkSnapshot(path: string): ChunkSnapshot {
  const read = readJsonFixture(path);
  if (!read.ok) {
    throw new ChunkSnapshotError(
      `chunk snapshot "${path}" is unusable (${read.reason}): ${read.detail}`,
      READ_FAILURE_CODES[read.reason]
    );
  }
  return parseChunkSnapshot(read.value, path);
}

/**
 * Validate an already-parsed snapshot payload. `source` names the
 * fixture in every error message (a path, or "inline" for a literal in a
 * test).
 */
export function parseChunkSnapshot(
  raw: unknown,
  source: string
): ChunkSnapshot {
  const root = asRecord(raw);
  if (root === undefined) {
    throw malformed(source, "top level must be a JSON object");
  }
  const id = asNonBlankString(root["id"]);
  if (id === undefined) {
    throw malformed(source, `"id" must be a non-blank snapshot id`);
  }
  const rawChunks = root["chunks"];
  if (!Array.isArray(rawChunks)) {
    throw malformed(source, `"chunks" must be an array`);
  }
  assertSnapshotSize(rawChunks.length, source);

  const chunks = rawChunks.map((entry, i) => parseChunk(entry, i, source));
  assertUniqueChunkIds(chunks, source);
  return { id, chunks };
}

/**
 * Zero chunks and "wrong number of chunks" are separate codes: the first
 * says the operator pointed at an empty file, the second says a frozen
 * snapshot outgrew its band.
 */
function assertSnapshotSize(count: number, source: string): void {
  if (count === 0) {
    throw new ChunkSnapshotError(
      `chunk snapshot "${source}" carries no chunks`,
      "SNAPSHOT_EMPTY"
    );
  }
  if (count < SNAPSHOT_MIN_CHUNKS || count > SNAPSHOT_MAX_CHUNKS) {
    throw new ChunkSnapshotError(
      `chunk snapshot "${source}" has ${count} chunks; snapshot v1 is frozen at ${SNAPSHOT_MIN_CHUNKS}-${SNAPSHOT_MAX_CHUNKS} inclusive (growing it is a human decision, see specs/p0-eval.md A5)`,
      "SNAPSHOT_SIZE_OUT_OF_RANGE"
    );
  }
}

function parseChunk(
  raw: unknown,
  index: number,
  source: string
): SnapshotChunk {
  const entry = asRecord(raw);
  if (entry === undefined) {
    throw invalidChunk(source, `[${index}]`, "must be a JSON object");
  }
  const id = asNonBlankString(entry["id"]);
  const label = id ?? `[${index}]`;
  if (id === undefined) {
    throw invalidChunk(source, label, `"id" must be a non-blank string`);
  }
  const content = asNonBlankString(entry["content"]);
  if (content === undefined) {
    throw invalidChunk(source, label, `"content" must be a non-blank string`);
  }
  const sourceRef = asNonBlankString(entry["source_ref"]);
  if (sourceRef === undefined) {
    throw invalidChunk(
      source,
      label,
      `"source_ref" must be a non-blank string`
    );
  }
  return { id, content, source_ref: sourceRef };
}

/**
 * Ids key gold provenance, so a duplicate would make "which chunk did
 * this triple come from" unanswerable.
 */
function assertUniqueChunkIds(
  chunks: readonly SnapshotChunk[],
  source: string
): void {
  const seen = new Set<string>();
  for (const chunk of chunks) {
    if (seen.has(chunk.id)) {
      throw new ChunkSnapshotError(
        `chunk snapshot "${source}" uses chunk id "${chunk.id}" more than once`,
        "SNAPSHOT_DUPLICATE_CHUNK_ID"
      );
    }
    seen.add(chunk.id);
  }
}

function malformed(source: string, detail: string): ChunkSnapshotError {
  return new ChunkSnapshotError(
    `chunk snapshot "${source}" is malformed: ${detail}`,
    "SNAPSHOT_MALFORMED"
  );
}

function invalidChunk(
  source: string,
  label: string,
  detail: string
): ChunkSnapshotError {
  return new ChunkSnapshotError(
    `chunk "${label}" in snapshot "${source}" is invalid: ${detail}`,
    "SNAPSHOT_CHUNK_INVALID"
  );
}
