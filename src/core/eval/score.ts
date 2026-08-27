/**
 * Pure P@5 / R@5 scoring (specs/retrieve-p5.md SC1–SC2).
 *
 * No I/O, no clock, no dependency on how the ranking was produced — the
 * scorer sees a list of chunk ids and a set of relevant chunk ids and
 * nothing else. That separation is what makes the metric contract
 * testable without an embedder, a store, or a graph engine.
 *
 * Two rules the spec is explicit about, both easy to get wrong:
 *
 *   - **P@5's denominator is always 5.** A run that returns 2 chunks and
 *     gets both right scored 1.0 would let a retrieval regression that
 *     shrinks the result list look like an improvement. The 3 slots that
 *     were never filled are misses.
 *   - **An empty gold relevant set is a fixture bug, not a free 1.0.**
 *     R@5 would divide by zero; reporting 1.0 (or 0) would bury a broken
 *     gold entry inside a plausible-looking mean.
 */
import { EvalScoringError, GoldFixtureError } from "./errors.js";

/**
 * The rank the metric cuts at. Exported so callers (and the CLI, which
 * may ask retrieve for more than this) read the cutoff from one place
 * instead of re-typing `5`.
 */
export const RANK_CUTOFF = 5;

/** One query's outcome against the gold set. */
export interface QueryScore {
  /** Deduplicated fused ids, cut to `RANK_CUTOFF`. */
  top5: string[];
  /** How many of `top5` are relevant. */
  hits: number;
  /** hits / RANK_CUTOFF — the denominator never shrinks. */
  pAt5: number;
  /** hits / |distinct relevant ids|. */
  rAt5: number;
}

/** Run-level roll-up over the scored queries. */
export interface ScoreSummary {
  queryCount: number;
  meanPAt5: number;
  meanRAt5: number;
}

/**
 * Score one query's fused ranking.
 *
 * `queryLabel` is only used to name the offending query when the gold
 * entry is unusable — an error that says which query broke is the
 * difference between a 10-second and a 10-minute fixture fix.
 *
 * Duplicates are collapsed on both sides before anything is counted. A
 * chunk id repeated in the fused list is one retrieved chunk, so letting
 * it occupy two of the five slots would silently narrow the window the
 * metric looks at; a gold id listed twice is one relevant chunk, so
 * leaving it in the denominator would cap R@5 below 1.0 for a perfect
 * run.
 */
export function scoreAtFive(
  retrievedIds: readonly string[],
  relevantIds: readonly string[],
  queryLabel: string
): QueryScore {
  const relevant = new Set(relevantIds);
  if (relevant.size === 0) {
    throw new GoldFixtureError(
      `gold query "${queryLabel}" has an empty relevant set: R@5 is undefined for it, so the fixture must name at least one relevant chunk id`,
      "GOLD_RELEVANT_EMPTY"
    );
  }

  const top5 = [...new Set(retrievedIds)].slice(0, RANK_CUTOFF);
  const hits = top5.filter((id) => relevant.has(id)).length;

  return {
    top5,
    hits,
    pAt5: hits / RANK_CUTOFF,
    rAt5: hits / relevant.size,
  };
}

/**
 * Average P@5 / R@5 across a run.
 *
 * An empty input is refused rather than averaged: `0/0` is NaN and any
 * substituted constant would be indistinguishable from a real measured
 * value in the baseline file.
 */
export function summarizeScores(scores: readonly QueryScore[]): ScoreSummary {
  if (scores.length === 0) {
    throw new EvalScoringError(
      "cannot summarize an empty score list: an eval run must score at least one gold query before a mean P@5 / R@5 exists"
    );
  }
  let sumP = 0;
  let sumR = 0;
  for (const score of scores) {
    sumP += score.pAt5;
    sumR += score.rAt5;
  }
  return {
    queryCount: scores.length,
    meanPAt5: sumP / scores.length,
    meanRAt5: sumR / scores.length,
  };
}
