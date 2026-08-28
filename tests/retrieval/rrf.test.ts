/**
 * Pure-function tests for Reciprocal Rank Fusion.
 *
 * `rrfFuse` takes a list of arms rather than a fixed (vector, graph) pair
 * (#64): production fuses vector + BM25, the SQL graph arm is archived off
 * that path (#58), and the algorithm itself is unchanged at k=60. Covers
 * every fusion branch: single-arm, dual-arm, same-id soft merge, per-arm
 * weighting, empty input, limit truncation, invalid ranks, and the
 * deterministic tie-break (rrfScore desc, then arm order, then chunk id).
 */
import { describe, it, expect } from "vitest";
import { rrfFuse, RRF_K } from "../../src/core/retrieval/rrf.js";
import type {
  ArmHit,
  ArmName,
  ArmResult,
  RetrieveConfig,
} from "../../src/core/retrieval/types.js";

/**
 * Equal weights across arms. Most cases assert the k=60 rank math, which
 * is easiest to read when the weight is 1; the weighting cases below
 * override w_vec / w_bm25 explicitly.
 */
const CFG: RetrieveConfig = {
  w_vec: 1,
  w_bm25: 1,
  w_graph: 1,
  bm25Enabled: true,
  graphEnabled: true,
  rerankEnabled: false,
  entityLinkTopK: 8,
  candidateCap: 50,
  graphArmFloor: 3,
};

/**
 * The shipped production weights (#69/#70): vector 0.7 / BM25 0.15 /
 * graph 0.15.
 */
const PROD_CFG: RetrieveConfig = {
  ...CFG,
  w_vec: 0.7,
  w_bm25: 0.15,
  w_graph: 0.15,
};

/** Build a single ArmHit with sensible defaults; override via patch. */
function hit(patch: Partial<ArmHit> & { id: string }): ArmHit {
  return {
    arm: patch.arm ?? "vector",
    rank: patch.rank ?? 1,
    score: patch.score ?? 0,
    content: patch.content ?? `content of ${patch.id}`,
    source_ref: patch.source_ref ?? "src/default",
    valid_window: patch.valid_window ?? ["2024-01-01T00:00:00Z", null],
    id: patch.id,
  };
}

/** Build an ArmResult for a given arm over a list of hits. */
function result(arm: ArmName, hits: ArmHit[]): ArmResult {
  return { arm, hits, belowFloor: false };
}

describe("rrfFuse", () => {
  it("uses k=60 as the RRF denominator constant (exported)", () => {
    expect(RRF_K).toBe(60);
  });

  it("ranks a single vector arm by 1/(k+rank)", () => {
    const out = rrfFuse(
      [
        result("vector", [
          hit({ id: "a", rank: 1 }),
          hit({ id: "b", rank: 2 }),
        ]),
      ],
      CFG,
      10
    );
    expect(out.map((f) => f.id)).toEqual(["a", "b"]);
    expect(out[0]?.arms).toEqual(["vector"]);
    expect(out[0]?.rrfScore).toBeCloseTo(1 / 61, 10);
    expect(out[1]?.rrfScore).toBeCloseTo(1 / 62, 10);
  });

  it("ranks BM25-only hits into the fusion (no vector contribution)", () => {
    const out = rrfFuse(
      [
        result("vector", []),
        result("bm25", [
          hit({ id: "lex-1", rank: 1, arm: "bm25" }),
          hit({ id: "lex-2", rank: 2, arm: "bm25" }),
        ]),
      ],
      CFG,
      10
    );
    expect(out.map((f) => f.id)).toEqual(["lex-1", "lex-2"]);
    expect(out[0]?.arms).toEqual(["bm25"]);
    expect(out[0]?.rrfScore).toBeCloseTo(1 / 61, 10);
  });

  it("soft-merges a chunk found by both vector and BM25 into one summed hit", () => {
    const out = rrfFuse(
      [
        result("vector", [hit({ id: "same", rank: 1, content: "v" })]),
        result("bm25", [
          hit({ id: "same", rank: 2, arm: "bm25", content: "b" }),
        ]),
      ],
      CFG,
      10
    );
    expect(out).toHaveLength(1);
    const fused = out[0]!;
    expect(fused.rrfScore).toBeCloseTo(1 / 61 + 1 / 62, 10);
    expect(fused.arms).toEqual(["vector", "bm25"]);
    // Agreement across arms must beat either arm alone.
    expect(fused.rrfScore).toBeGreaterThan(1 / 61);
  });

  it("weights each arm by its own config knob", () => {
    const out = rrfFuse(
      [
        result("vector", [hit({ id: "v", rank: 1 })]),
        result("bm25", [hit({ id: "b", rank: 1, arm: "bm25" })]),
      ],
      PROD_CFG,
      10
    );
    // Same rank in both arms, so the 0.7 / 0.15 split is the only thing
    // separating them — the vector hit must come first.
    expect(out.map((f) => f.id)).toEqual(["v", "b"]);
    expect(out[0]?.rrfScore).toBeCloseTo(0.7 / 61, 10);
    expect(out[1]?.rrfScore).toBeCloseTo(0.15 / 61, 10);
  });

  it("lets a strong BM25 hit outrank a weak vector hit despite the lower weight", () => {
    const out = rrfFuse(
      [
        // 0.7 / (60 + 40) = 0.007
        result("vector", [hit({ id: "v", rank: 40 })]),
        // 0.15 / (60 + 1) ≈ 0.00246 — still behind
        result("bm25", [hit({ id: "b", rank: 1, arm: "bm25" })]),
      ],
      PROD_CFG,
      10
    );
    expect(out.map((f) => f.id)).toEqual(["v", "b"]);

    const flipped = rrfFuse(
      [
        // 0.7 / (60 + 500) = 0.00125
        result("vector", [hit({ id: "v", rank: 500 })]),
        // 0.15 / 61 ≈ 0.00246 — lexical wins on rank quality
        result("bm25", [hit({ id: "b", rank: 1, arm: "bm25" })]),
      ],
      PROD_CFG,
      10
    );
    expect(flipped.map((f) => f.id)).toEqual(["b", "v"]);
  });

  it("fuses three arms when an archived graph arm is explicitly supplied", () => {
    // The graph arm no longer runs by default (#58), but the fusion
    // function stays N-arm so injected-config tests keep working.
    const out = rrfFuse(
      [
        result("vector", [hit({ id: "v", rank: 1 })]),
        result("bm25", [hit({ id: "b", rank: 1, arm: "bm25" })]),
        result("graph", [hit({ id: "g", rank: 1, arm: "graph" })]),
      ],
      CFG,
      10
    );
    expect(out.map((f) => f.id)).toEqual(["v", "b", "g"]);
  });

  // SC10 (partial, config half): the weight table must read `w_graph`
  // from the SAME production config the server loads, so the graph arm
  // fuses as a first-class weighted arm rather than at some hardcoded
  // value. k stays 60.
  it("SC10: weights the graph arm by w_graph under the production defaults", () => {
    const out = rrfFuse(
      [
        result("vector", [hit({ id: "v", rank: 1 })]),
        result("bm25", [hit({ id: "b", rank: 1, arm: "bm25" })]),
        result("graph", [hit({ id: "g", rank: 1, arm: "graph" })]),
      ],
      PROD_CFG,
      10
    );
    expect(out.map((f) => f.id)).toEqual(["v", "b", "g"]);
    expect(out[0]?.rrfScore).toBeCloseTo(0.7 / 61, 10);
    // BM25 and graph carry the same 0.15, so an equal rank must yield an
    // equal score — the graph arm is not discounted anywhere in fusion.
    expect(out[1]?.rrfScore).toBeCloseTo(0.15 / 61, 10);
    expect(out[2]?.rrfScore).toBeCloseTo(0.15 / 61, 10);
  });

  it("SC10: soft-merges one chunk found by all three arms into a single hit", () => {
    const out = rrfFuse(
      [
        result("vector", [hit({ id: "same", rank: 1 })]),
        result("bm25", [hit({ id: "same", rank: 2, arm: "bm25" })]),
        result("graph", [hit({ id: "same", rank: 3, arm: "graph" })]),
      ],
      PROD_CFG,
      10
    );
    expect(out).toHaveLength(1);
    const fused = out[0]!;
    expect(fused.arms).toEqual(["vector", "bm25", "graph"]);
    expect(fused.rrfScore).toBeCloseTo(0.7 / 61 + 0.15 / 62 + 0.15 / 63, 10);
    // Three-arm agreement must beat what the vector arm alone would give.
    expect(fused.rrfScore).toBeGreaterThan(0.7 / 61);
  });

  it("returns [] for no arms at all", () => {
    expect(rrfFuse([], CFG, 10)).toEqual([]);
  });

  it("returns [] when every arm is empty", () => {
    expect(
      rrfFuse([result("vector", []), result("bm25", [])], CFG, 10)
    ).toEqual([]);
  });

  it("truncates to the top `limit` fused hits by score", () => {
    const out = rrfFuse(
      [
        result("vector", [
          hit({ id: "a", rank: 1 }),
          hit({ id: "b", rank: 2 }),
          hit({ id: "c", rank: 3 }),
        ]),
      ],
      CFG,
      2
    );
    expect(out.map((f) => f.id)).toEqual(["a", "b"]);
  });

  it("returns [] when limit is <= 0", () => {
    const arms = [result("vector", [hit({ id: "a", rank: 1 })])];
    expect(rrfFuse(arms, CFG, 0)).toEqual([]);
    expect(rrfFuse(arms, CFG, -1)).toEqual([]);
  });

  it("skips hits with rank < 1 (boundary: invalid rank ignored)", () => {
    const out = rrfFuse(
      [
        result("vector", [
          hit({ id: "bad", rank: 0 }),
          hit({ id: "neg", rank: -5 }),
          hit({ id: "ok", rank: 1 }),
        ]),
      ],
      CFG,
      10
    );
    expect(out.map((f) => f.id)).toEqual(["ok"]);
  });

  it("breaks equal-score ties deterministically: arm order, then id ascending", () => {
    const out = rrfFuse(
      [
        result("vector", [
          hit({ id: "b", rank: 1 }),
          hit({ id: "a", rank: 1 }),
        ]),
        result("bm25", [hit({ id: "c", rank: 1, arm: "bm25" })]),
      ],
      CFG,
      10
    );
    // All three score 1/61 under equal weights. Vector arm first (a, b),
    // then bm25 (c); within an arm, id ascending.
    expect(out.map((f) => f.id)).toEqual(["a", "b", "c"]);
  });

  it("is insensitive to the order arms are passed in", () => {
    const vector = result("vector", [hit({ id: "v", rank: 2 })]);
    const bm25 = result("bm25", [hit({ id: "b", rank: 1, arm: "bm25" })]);
    expect(rrfFuse([vector, bm25], PROD_CFG, 10).map((f) => f.id)).toEqual(
      rrfFuse([bm25, vector], PROD_CFG, 10).map((f) => f.id)
    );
  });
});
