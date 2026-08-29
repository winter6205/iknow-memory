/**
 * Provenance-strict gold loader (specs/p0-eval.md A7, A8, A9, SC11).
 *
 * SC11: a gold triple that cannot name its model id, prompt hash, source
 * chunk, raw output and filter verdict is not gold — it is an
 * unattributable number. Each missing or contradictory field is a typed
 * error naming the offending triple, so a stale gold model's leftovers
 * can never keep scoring under a new ruler's header.
 *
 * `relation_norm` is checked against the extraction vocabulary rather
 * than a copy of it, so gold and extract always answer to the same
 * closed relation set.
 */
import { ALLOWED, UNMAPPED } from "../extraction/vocabulary.js";
import {
  asNonBlankString,
  asRecord,
  readJsonFixture,
  type FixtureReadFailure,
} from "./fixture-io.js";
import { ExtractionGoldError, type ExtractionGoldErrorCode } from "./errors.js";
import type {
  ChunkSnapshot,
  FilterVerdict,
  GoldProvenance,
  GoldSet,
  GoldTriple,
} from "./types.js";

const READ_FAILURE_CODES: Record<FixtureReadFailure, ExtractionGoldErrorCode> =
  {
    missing: "GOLD_FILE_MISSING",
    empty: "GOLD_FILE_EMPTY",
    malformed: "GOLD_MALFORMED",
  };

const FILTER_VERDICTS: readonly FilterVerdict[] = ["accept", "reject"];

/** Mandatory SC11 provenance fields, in the order they are reported. */
const REQUIRED_PROVENANCE_FIELDS = [
  "model_id",
  "prompt_hash",
  "chunk_id",
  "raw_output",
  "filter_verdict",
] as const;

/** Read + validate a gold set from disk. */
export function loadGoldSet(path: string): GoldSet {
  const read = readJsonFixture(path);
  if (!read.ok) {
    throw new ExtractionGoldError(
      `gold set "${path}" is unusable (${read.reason}): ${read.detail}`,
      READ_FAILURE_CODES[read.reason]
    );
  }
  return parseGoldSet(read.value, path);
}

/**
 * Validate an already-parsed gold payload. `source` names the fixture in
 * every error message (a path, or "inline" for a literal in a test).
 *
 * An empty triple list is accepted: "the gold model found nothing in
 * this snapshot" is a real outcome the scorer must report as such, not a
 * fixture fault to throw on.
 */
export function parseGoldSet(raw: unknown, source: string): GoldSet {
  const root = asRecord(raw);
  if (root === undefined) {
    throw malformed(source, "top level must be a JSON object");
  }
  const snapshotId = asNonBlankString(root["snapshot_id"]);
  const goldModel = asNonBlankString(root["gold_model"]);
  const promptHash = asNonBlankString(root["prompt_hash"]);
  if (
    snapshotId === undefined ||
    goldModel === undefined ||
    promptHash === undefined
  ) {
    throw malformed(
      source,
      `"snapshot_id", "gold_model" and "prompt_hash" must all be non-blank strings`
    );
  }
  const rawTriples = root["triples"];
  if (!Array.isArray(rawTriples)) {
    throw malformed(source, `"triples" must be an array`);
  }

  const triples = rawTriples.map((entry, i) =>
    parseGoldTriple(entry, i, source, goldModel, promptHash)
  );
  return {
    snapshot_id: snapshotId,
    gold_model: goldModel,
    prompt_hash: promptHash,
    triples,
  };
}

/**
 * Cross-check a gold set against the snapshot it claims to describe:
 * both the ruler identity (A9) and every cited chunk id. Kept separate
 * from parsing so a gold file can be validated on its own, and so the
 * mismatch message can name both artifacts.
 */
export function assertGoldMatchesSnapshot(
  gold: GoldSet,
  snapshot: ChunkSnapshot
): void {
  if (gold.snapshot_id !== snapshot.id) {
    throw new ExtractionGoldError(
      `gold set was built against snapshot "${gold.snapshot_id}" but was checked against snapshot "${snapshot.id}": a different snapshot is a new ruler, not a continuation (specs/p0-eval.md A9)`,
      "GOLD_SNAPSHOT_MISMATCH"
    );
  }
  const known = new Set(snapshot.chunks.map((chunk) => chunk.id));
  for (const triple of gold.triples) {
    const chunkId = triple.provenance.chunk_id;
    if (!known.has(chunkId)) {
      throw new ExtractionGoldError(
        `gold triple ${describe(triple)} cites chunk "${chunkId}", which snapshot "${snapshot.id}" does not contain`,
        "GOLD_CHUNK_UNKNOWN"
      );
    }
  }
}

function parseGoldTriple(
  raw: unknown,
  index: number,
  source: string,
  goldModel: string,
  promptHash: string
): GoldTriple {
  const entry = asRecord(raw);
  if (entry === undefined) {
    throw invalidTriple(source, `[${index}]`, "must be a JSON object");
  }
  const label = `[${index}]`;
  const head = asNonBlankString(entry["head"]);
  const tail = asNonBlankString(entry["tail"]);
  if (head === undefined || tail === undefined) {
    throw invalidTriple(
      source,
      label,
      `"head" and "tail" must both be non-blank strings`
    );
  }
  const relationNorm = asNonBlankString(entry["relation_norm"]);
  if (relationNorm === undefined) {
    throw invalidTriple(
      source,
      label,
      `"relation_norm" must be a non-blank string`
    );
  }
  if (relationNorm !== UNMAPPED && !ALLOWED.includes(relationNorm)) {
    throw invalidTriple(
      source,
      label,
      `"relation_norm" is "${relationNorm}", which is neither a vocabulary term nor the ${UNMAPPED} sentinel`
    );
  }
  const evidenceSpan = asNonBlankString(entry["evidence_span"]);
  if (evidenceSpan === undefined) {
    throw invalidTriple(
      source,
      label,
      `"evidence_span" must be a non-blank string`
    );
  }
  const confidence = entry["confidence"];
  if (
    typeof confidence !== "number" ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  ) {
    throw invalidTriple(
      source,
      label,
      `"confidence" must be a number in [0,1], got ${String(confidence)}`
    );
  }
  return {
    head,
    relation_norm: relationNorm,
    tail,
    evidence_span: evidenceSpan,
    confidence,
    provenance: parseProvenance(
      entry["provenance"],
      label,
      source,
      goldModel,
      promptHash
    ),
  };
}

function parseProvenance(
  raw: unknown,
  label: string,
  source: string,
  goldModel: string,
  promptHash: string
): GoldProvenance {
  const entry = asRecord(raw);
  if (entry === undefined) {
    throw missingProvenance(source, label, "provenance");
  }
  for (const field of REQUIRED_PROVENANCE_FIELDS) {
    if (asNonBlankString(entry[field]) === undefined) {
      throw missingProvenance(source, label, field);
    }
  }
  const verdict = entry["filter_verdict"] as FilterVerdict;
  if (!FILTER_VERDICTS.includes(verdict)) {
    throw new ExtractionGoldError(
      `gold triple ${label} in "${source}" has filter verdict "${String(entry["filter_verdict"])}"; only ${FILTER_VERDICTS.join(" / ")} are recorded`,
      "GOLD_PROVENANCE_INVALID"
    );
  }
  const modelId = entry["model_id"] as string;
  const triplePromptHash = entry["prompt_hash"] as string;
  if (modelId !== goldModel) {
    throw mismatchedProvenance(
      source,
      label,
      `model id "${modelId}" does not match the gold set's model "${goldModel}"`
    );
  }
  if (triplePromptHash !== promptHash) {
    throw mismatchedProvenance(
      source,
      label,
      `prompt hash "${triplePromptHash}" does not match the gold set's prompt hash "${promptHash}"`
    );
  }
  const provenance: GoldProvenance = {
    model_id: modelId,
    prompt_hash: triplePromptHash,
    chunk_id: entry["chunk_id"] as string,
    raw_output: entry["raw_output"] as string,
    filter_verdict: verdict,
  };
  const reason = asNonBlankString(entry["filter_reason"]);
  if (reason !== undefined) provenance.filter_reason = reason;
  const seed = entry["seed"];
  if (typeof seed === "number" && Number.isFinite(seed)) {
    provenance.seed = seed;
  }
  return provenance;
}

/** Short human label for a triple in cross-check messages. */
function describe(triple: GoldTriple): string {
  return `"${triple.head}" -[${triple.relation_norm}]-> "${triple.tail}"`;
}

function malformed(source: string, detail: string): ExtractionGoldError {
  return new ExtractionGoldError(
    `gold set "${source}" is malformed: ${detail}`,
    "GOLD_MALFORMED"
  );
}

function invalidTriple(
  source: string,
  label: string,
  detail: string
): ExtractionGoldError {
  return new ExtractionGoldError(
    `gold triple ${label} in "${source}" is invalid: ${detail}`,
    "GOLD_TRIPLE_INVALID"
  );
}

function missingProvenance(
  source: string,
  label: string,
  field: string
): ExtractionGoldError {
  return new ExtractionGoldError(
    `gold triple ${label} in "${source}" is missing provenance field "${field}": every gold triple records model id, prompt hash, chunk id, raw output and filter verdict (specs/p0-eval.md SC11)`,
    "GOLD_PROVENANCE_MISSING"
  );
}

function mismatchedProvenance(
  source: string,
  label: string,
  detail: string
): ExtractionGoldError {
  return new ExtractionGoldError(
    `gold triple ${label} in "${source}" carries foreign provenance: ${detail}`,
    "GOLD_PROVENANCE_MISMATCH"
  );
}
