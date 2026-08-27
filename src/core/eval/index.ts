/**
 * Public surface of the **evaluation** capability
 * (specs/retrieve-p5.md).
 *
 * Everything the retrieve eval needs and nothing about how retrieval
 * works: fixtures in, scores out, baseline rendered. The capability
 * consumes `core/retrieval` through its caller (the eval CLI) rather than
 * importing it here, so the scorer stays provable without a store.
 */
export {
  CorpusFixtureError,
  EvalRunError,
  EvalScoringError,
  GoldFixtureError,
  BaselineWriteError,
  type CorpusFixtureErrorCode,
  type GoldFixtureErrorCode,
} from "./errors.js";
export {
  GOLD_MAX_QUERIES,
  GOLD_MIN_QUERIES,
  loadGoldSet,
  parseGoldSet,
  type GoldQuery,
  type GoldSet,
} from "./gold.js";
export {
  loadCorpus,
  parseCorpus,
  type EvalCorpus,
  type EvalCorpusChunk,
} from "./corpus.js";
export {
  RANK_CUTOFF,
  scoreAtFive,
  summarizeScores,
  type QueryScore,
  type ScoreSummary,
} from "./score.js";
export {
  armSetFromDebug,
  renderBaseline,
  writeBaselineAtomic,
  type BaselineQuery,
  type BaselineReport,
} from "./baseline.js";
export { seedCorpus } from "./seed.js";
export {
  DEFAULT_BASELINE_PATH,
  DEFAULT_CORPUS_PATH,
  DEFAULT_GOLD_PATH,
  REPO_ROOT,
} from "./paths.js";
