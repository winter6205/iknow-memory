/**
 * Pure P@5 / R@5 scorer (specs/retrieve-p5.md T1, SC1–SC3 + the SC9
 * empty / negative / overflow classes that do not need a CLI).
 *
 * Everything here is single-process arithmetic over string ids: no
 * embedder, no storage, no network. That is the point of splitting the
 * scorer out of the runner — the metric contract (denominator is always
 * 5, an empty gold relevant set is an error rather than a free 1.0) is
 * provable without standing anything up.
 */
import { describe, it, expect } from "vitest";

import {
  RANK_CUTOFF,
  scoreAtFive,
  summarizeScores,
} from "../../src/core/eval/score.js";
import {
  EvalScoringError,
  GoldFixtureError,
} from "../../src/core/eval/errors.js";

describe("scoreAtFive — fixed denominator (SC1)", () => {
  it("scores one hit in a two-chunk result as 1/5, not 1/2", () => {
    const score = scoreAtFive(["a", "b"], ["a"], "q1");

    expect(score.hits).toBe(1);
    expect(score.pAt5).toBeCloseTo(0.2, 12);
  });

  it("keeps the denominator at 5 when retrieve returned nothing", () => {
    const score = scoreAtFive([], ["a"], "q1");

    expect(score.top5).toEqual([]);
    expect(score.pAt5).toBe(0);
    expect(score.rAt5).toBe(0);
  });

  it("exposes the cutoff it scores at so callers cannot drift from it", () => {
    expect(RANK_CUTOFF).toBe(5);
  });
});

describe("scoreAtFive — recall (SC2)", () => {
  it("divides hits by the gold set size, not by 5", () => {
    const score = scoreAtFive(["a", "b"], ["a", "c"], "q1");

    expect(score.rAt5).toBeCloseTo(0.5, 12);
  });

  it("rejects an empty gold relevant set instead of scoring it 1.0", () => {
    let thrown: unknown;
    try {
      scoreAtFive(["a"], [], "q-empty-gold");
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(GoldFixtureError);
    const err = thrown as GoldFixtureError;
    expect(err.code).toBe("GOLD_RELEVANT_EMPTY");
    expect(err.message.length).toBeGreaterThan(0);
    expect(err.message).toContain("q-empty-gold");
  });
});

describe("scoreAtFive — duplicates counted once (SC9 negative)", () => {
  it("counts a chunk id repeated in the fused list as one hit", () => {
    const score = scoreAtFive(["a", "a"], ["a"], "q1");

    expect(score.hits).toBe(1);
    expect(score.pAt5).toBeCloseTo(0.2, 12);
    expect(score.rAt5).toBe(1);
  });

  it("collapses a repeat before the cutoff so it cannot eat a rank slot", () => {
    const score = scoreAtFive(["a", "a", "b", "c", "d", "e"], ["a", "e"], "q1");

    expect(score.top5).toEqual(["a", "b", "c", "d", "e"]);
    expect(score.hits).toBe(2);
    expect(score.pAt5).toBeCloseTo(0.4, 12);
    expect(score.rAt5).toBe(1);
  });

  it("counts a gold id listed twice once in the recall denominator", () => {
    const score = scoreAtFive(["a"], ["a", "a"], "q1");

    expect(score.rAt5).toBe(1);
  });
});

describe("scoreAtFive — overflow (SC9)", () => {
  it("ignores everything past rank 5 even when the caller asked for 100", () => {
    const retrieved = Array.from({ length: 100 }, (_, i) => `chunk-${i}`);

    const score = scoreAtFive(retrieved, ["chunk-7"], "q1");

    expect(score.top5).toHaveLength(5);
    expect(score.hits).toBe(0);
    expect(score.pAt5).toBe(0);
  });

  it("keeps a hit that sits exactly on rank 5", () => {
    const retrieved = Array.from({ length: 100 }, (_, i) => `chunk-${i}`);

    const score = scoreAtFive(retrieved, ["chunk-4"], "q1");

    expect(score.hits).toBe(1);
    expect(score.pAt5).toBeCloseTo(0.2, 12);
  });
});

describe("summarizeScores", () => {
  it("averages P@5 and R@5 across the scored queries", () => {
    const scores = [
      scoreAtFive(["a"], ["a"], "q1"), // 0.2 / 1.0
      scoreAtFive(["b", "c"], ["b", "c"], "q2"), // 0.4 / 1.0
      scoreAtFive(["x"], ["y"], "q3"), // 0.0 / 0.0
    ];

    const summary = summarizeScores(scores);

    expect(summary.queryCount).toBe(3);
    expect(summary.meanPAt5).toBeCloseTo((0.2 + 0.4 + 0) / 3, 12);
    expect(summary.meanRAt5).toBeCloseTo((1 + 1 + 0) / 3, 12);
  });

  it("refuses to average nothing instead of reporting NaN", () => {
    let thrown: unknown;
    try {
      summarizeScores([]);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(EvalScoringError);
    expect((thrown as EvalScoringError).message.length).toBeGreaterThan(0);
  });
});
