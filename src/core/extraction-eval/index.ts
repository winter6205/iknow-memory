/**
 * Public surface of the **extraction-eval** capability
 * (specs/p0-eval.md).
 *
 * Everything the eval CLI / scoring path needs and nothing about how
 * extraction works: frozen fixtures in (snapshot, gold), scoring out
 * (three axes + diagnostic). The capability consumes
 * `core/extraction/vocabulary` through its SSOT (ALLOWED + UNMAPPED)
 * but does not import the extract pipeline — the scorer is provable
 * without a live LLM.
 *
 * Deliberately separate from `core/eval` (the retrieve P@5 harness):
 * the two capabilities share neither fixtures, nor error taxonomy, nor
 * vocabulary, and mixing them would let a retrieve fixture mistake
 * read as an extraction-F1 regression.
 */
export {
  ChunkSnapshotError,
  ExtractionGoldError,
  FilterError,
  type ChunkSnapshotErrorCode,
  type ExtractionGoldErrorCode,
  type FilterErrorCode,
} from "./errors.js";
export {
  readJsonFixture,
  asRecord,
  asNonBlankString,
  type FixtureRead,
  type FixtureReadFailure,
} from "./fixture-io.js";
export {
  SNAPSHOT_MAX_CHUNKS,
  SNAPSHOT_MIN_CHUNKS,
  type ChunkSnapshot,
  type FilterVerdict,
  type GoldProvenance,
  type GoldSet,
  type GoldTriple,
  type SnapshotChunk,
} from "./types.js";
export { loadChunkSnapshot, parseChunkSnapshot } from "./snapshot.js";
export {
  assertGoldMatchesSnapshot,
  loadGoldSet,
  parseGoldSet,
} from "./gold.js";
export {
  foldEntity,
  tripleMatchKey,
  type TripleMatchFields,
} from "./match-key.js";
export {
  errorTypes,
  hallucinationRate,
  microF1,
  schemaRate,
  score,
  type ErrorType,
  type F1Result,
  type ScoreReport,
  type ScoringTriple,
} from "./scoring.js";
export {
  DEFAULT_NEGATION_CUES,
  filterTriple,
  type FilterContext,
  type FilterResult,
  type RejectReason,
} from "./filter.js";
export {
  driftGate,
  extractThresholds,
  releaseGate,
  type Axes,
  type BaselineEntry,
  type DriftOpts,
  type DriftResult,
  type ReleaseFailures,
  type ReleaseResult,
  type ReleaseThresholds,
} from "./gate.js";
