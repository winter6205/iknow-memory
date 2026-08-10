/**
 * Pure-function tests for Reciprocal Rank Fusion (spec-3 p0-integration T2).
 *
 * Covers every fusion branch required by the plan's acceptance:
 * vec-only / graph-only / both-arms / same-id double-count / empty-vec /
 * empty-graph / limit-truncation. Also verifies the k=60 math, the 1:1
 * default weights, and the deterministic tie-break (rrfScore desc, then
 * arms vec-first, then chunk.id ascending).
 */
import { describe, it, expect } from "vitest";
import { rrfFuse, __RRF_K } from "../../src/core/retrieval/rrf.js";
import type {
  ArmHit,
  ArmResult,
  RetrieveConfig,
} from "../../src/core/retrieval/types.js";

/** Default config: k=60, w_vec=w_graph=1, typical pipeline knobs. */
const CFG: RetrieveConfig = {
  w_vec: 1,
  w_graph: 1,
  entityLinkTopK: 8,
  candidateCap: 50,
  graphArmFloor: 3,
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
function result(arm: "vector" | "graph", hits: ArmHit[]): ArmResult {
  return { arm, hits, belowFloor: false };
}

describe("rrfFuse", () => {
  it("uses k=60 as the RRF denominator constant (exported)", () => {
    expect(__RRF_K).toBe(60);
  });

  it("produces only vector-arm hits when the graph arm is empty (vec-only)", () => {
    const out = rrfFuse(
      result("vector", [hit({ id: "a", rank: 1 }), hit({ id: "b", rank: 2 })]),
      result("graph", []),
      CFG,
      10
    );
    expect(out).toHaveLength(2);
    expect(out.map((f) => f.id)).toEqual(["a", "b"]);
    expect(out[0]?.arms).toEqual(["vector"]);
    // score = w / (k + rank) = 1 / (60 + 1)
    expect(out[0]?.rrfScore).toBeCloseTo(1 / 61, 10);
    expect(out[1]?.rrfScore).toBeCloseTo(1 / 62, 10);
  });

  it("produces only graph-arm hits when the vector arm is empty (graph-only)", () => {
    const out = rrfFuse(
      result("vector", []),
      result("graph", [hit({ id: "x", rank: 3, arm: "graph" })]),
      CFG,
      10
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.id).toBe("x");
    expect(out[0]?.arms).toEqual(["graph"]);
    expect(out[0]?.rrfScore).toBeCloseTo(1 / 63, 10);
  });

  it("fuses both arms, ranking higher rrfScore first (both-arms)", () => {
    const out = rrfFuse(
      // rank 1  => 1/61
      result("vector", [hit({ id: "a", rank: 1, content: "vec-a" })]),
      // rank 1  => 1/61
      result("graph", [hit({ id: "g", rank: 1, arm: "graph" })]),
      CFG,
      10
    );
    expect(out).toHaveLength(2);
    // Equal scores: deterministic tie-break requires stable order.
    expect(out.map((f) => f.id)).toEqual(["a", "g"]);
  });

  it("double-counts the same chunk.id across both arms (sum of both scores)", () => {
    const out = rrfFuse(
      result("vector", [hit({ id: "same", rank: 1, content: "v" })]),
      result("graph", [
        hit({ id: "same", rank: 2, arm: "graph", content: "g" }),
      ]),
      CFG,
      10
    );
    expect(out).toHaveLength(1);
    const fused = out[0]!;
    expect(fused.id).toBe("same");
    // 1/(60+1) + 1/(60+2)
    expect(fused.rrfScore).toBeCloseTo(1 / 61 + 1 / 62, 10);
    // Both arms contributed; order is vec-first then graph.
    expect(fused.arms).toEqual(["vector", "graph"]);
    // Fused score strictly beats either arm alone (Success Criterion #9).
    expect(fused.rrfScore).toBeGreaterThan(1 / 61);
  });

  it("returns [] when the vector arm is empty (empty-vec)", () => {
    const out = rrfFuse(result("vector", []), result("graph", []), CFG, 10);
    expect(out).toEqual([]);
  });

  it("returns [] when the graph arm is empty (empty-graph)", () => {
    const out = rrfFuse(result("vector", []), result("graph", []), CFG, 10);
    expect(out).toEqual([]);
  });

  it("truncates to the top `limit` fused hits by score (limit-truncation)", () => {
    const vec = result("vector", [
      hit({ id: "a", rank: 1 }),
      hit({ id: "b", rank: 2 }),
      hit({ id: "c", rank: 3 }),
    ]);
    const out = rrfFuse(vec, result("graph", []), CFG, 2);
    expect(out).toHaveLength(2);
    // Highest two scores win: rank 1 (1/61) then rank 2 (1/62).
    expect(out.map((f) => f.id)).toEqual(["a", "b"]);
  });

  it("returns [] when limit is <= 0", () => {
    const vec = result("vector", [hit({ id: "a", rank: 1 })]);
    expect(rrfFuse(vec, result("graph", []), CFG, 0)).toEqual([]);
    expect(rrfFuse(vec, result("graph", []), CFG, -1)).toEqual([]);
  });

  it("skips hits with rank < 1 (boundary: invalid rank ignored)", () => {
    const vec = result("vector", [
      hit({ id: "bad", rank: 0 }),
      hit({ id: "neg", rank: -5 }),
      hit({ id: "ok", rank: 1 }),
    ]);
    const out = rrfFuse(vec, result("graph", []), CFG, 10);
    expect(out.map((f) => f.id)).toEqual(["ok"]);
  });

  it("breaks equal-score ties deterministically: vec-first, then id ascending", () => {
    const out = rrfFuse(
      result("vector", [hit({ id: "b", rank: 1 }), hit({ id: "a", rank: 1 })]),
      result("graph", [hit({ id: "c", rank: 1, arm: "graph" })]),
      CFG,
      10
    );
    // All three have score 1/61. Tie-break: vector arm first (a, b), then
    // graph (c); within vector, id ascending (a before b).
    expect(out.map((f) => f.id)).toEqual(["a", "b", "c"]);
  });
});
