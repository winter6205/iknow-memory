/**
 * T4 (graph-index-standard-fast): the fast NLP extract method — pure text →
 * mixed zh/en terms → child co-occurrence edges → percentile prune. NO LLM
 * anywhere: every function here is pure over its text input, and the seam
 * tests in method.test.ts / pipeline.test.ts additionally prove the fast leg
 * never dials a (poisoned) FakeLLMClient.
 *
 * Contract sources:
 *  - spec assumption 4 + SC4: mixed Chinese/English regex, NOT English-only;
 *    empty Fast graph on Chinese 资料 is a typed job fail (FAST_EMPTY_GRAPH).
 *  - ADR-0077 / spec assumption 5: co-occurrence keyed by the pushed child
 *    (the chunk row IS the in-window child — no second cut, ADR-0004).
 *  - ADR-0073: edge weight starts as the co-occurrence count, a PMI-style
 *    score log2(w·S / (s_head·s_tail)) over the child's sentences ranks
 *    chance pairs of frequent terms below pairs that actually travel
 *    together, and the prune drops edges strictly under the weakPercentile
 *    (default 40th) of THIS edge set. Thresholds are index-job config.
 *
 * Boundary classes (test.md): normal (mixed/zh-only/en-only fixtures),
 * empty (whitespace chunk → EMPTY_CHUNK), stopword-only input, prune
 * threshold exactly at/below/above, invalid option values clamped, and the
 * no-LLM guarantee (module shape: no client parameter exists to pass one).
 */
import { describe, expect, it } from "vitest";

import {
  FAST_DEFAULT_WEAK_PERCENTILE,
  FAST_EMPTY_GRAPH_CODE,
  FAST_EXTRACTOR_TAG,
  FAST_RELATION_NORM,
  FAST_RELATION_RAW,
  buildCoOccurrenceEdges,
  containsCjk,
  extractFastChunk,
  extractFastTerms,
  pruneFastEdges,
  scoreFastEdges,
  type FastCooccurrenceEdge,
} from "../../src/core/extraction/fast.js";
import { EMPTY_CHUNK_CODE } from "../../src/core/extraction/extract.js";
import type { ExtractionOutput } from "../../src/core/extraction/types.js";

/**
 * Unit-test edge factory. Disjoint pairs with count == weight and a shared
 * window make the PMI algebra come out distinct and hand-checkable:
 * pmi = log2(w·15 / w²) = log2(15/w).
 */
function edge(
  head: string,
  tail: string,
  weight: number,
  headCount = weight,
  tailCount = weight,
  window = 15
): FastCooccurrenceEdge {
  return { head, tail, weight, headCount, tailCount, window, evidence: "e" };
}

/** The canonical mixed zh/en fixture (ADR-0076 product default). */
const MIXED = "Alice 与 Bob 在 Acme 实验室 合作";

/** Two-sentence Chinese child: 张伟/上海 travel; 李娜×入职 pairs never do. */
const HUAXI = "李娜 祝 张伟 结婚 于 上海。张伟 入职 上海 公司。";

// ─── term extraction: mixed zh/en regex ──────────────────────────────────

describe("extractFastTerms", () => {
  it("finds English and Chinese terms in one mixed chunk, first-occurrence order", () => {
    expect(extractFastTerms(MIXED)).toEqual([
      { term: "alice", occurrences: 1 },
      { term: "bob", occurrences: 1 },
      { term: "acme", occurrences: 1 },
      { term: "实验室", occurrences: 1 },
      { term: "合作", occurrences: 1 },
    ]);
  });

  it("is NOT English-only: a Chinese-only chunk still yields terms (SC4)", () => {
    const terms = extractFastTerms("张伟 结婚 于 上海");
    expect(terms.map((t) => t.term)).toEqual(["张伟", "结婚", "上海"]);
  });

  it("normalizes to the merge layer's canonical form and folds repeats", () => {
    expect(extractFastTerms("ACME acme  Acme")).toEqual([
      { term: "acme", occurrences: 3 },
    ]);
  });

  it("drops English stopwords and single-letter/number tokens", () => {
    expect(extractFastTerms("the a 7 is an")).toEqual([]);
  });

  it("splits Chinese runs on function-word characters and keeps the rest", () => {
    // 是 is a split-on stop char; segments shorter than 2 die with it.
    expect(extractFastTerms("深圳是经济特区")).toEqual([
      { term: "深圳", occurrences: 1 },
      { term: "经济特区", occurrences: 1 },
    ]);
  });

  it("drops Chinese runs longer than the term cap (unsegmented noise)", () => {
    expect(extractFastTerms("哈佛商学院研究生课程深度学习讲座")).toEqual([]);
  });

  it("keeps hyphenated technical tokens as one term", () => {
    expect(extractFastTerms("deep-learning rocks")).toEqual([
      { term: "deep-learning", occurrences: 1 },
      { term: "rocks", occurrences: 1 },
    ]);
  });
});

describe("containsCjk", () => {
  it("is true for Chinese text and false otherwise", () => {
    expect(containsCjk("实验室")).toBe(true);
    expect(containsCjk("Alice works at Acme")).toBe(false);
    expect(containsCjk("")).toBe(false);
  });
});

// ─── child co-occurrence (ADR-0077) ───────────────────────────────────────

describe("buildCoOccurrenceEdges", () => {
  it("keys co-occurrence on the child: every term pair inside one chunk forms an edge", () => {
    const edges = buildCoOccurrenceEdges(MIXED);
    // 5 terms → C(5,2) = 10 pairs, head before tail in first-occurrence order.
    expect(edges).toHaveLength(10);
    const aliceBob = edges.find((e) => e.head === "alice" && e.tail === "bob");
    expect(aliceBob).toBeDefined();
    // One child, one sentence, both terms in it → joint count 1; the sentence
    // itself is the evidence span.
    expect(aliceBob?.weight).toBe(1);
    expect(aliceBob?.evidence).toBe(MIXED);
    // PMI inputs: each term sits in 1 of the child's 1 sentences.
    expect(aliceBob?.headCount).toBe(1);
    expect(aliceBob?.tailCount).toBe(1);
    expect(aliceBob?.window).toBe(1);
  });

  it("weights a pair by its joint sentence count inside the child (ADR-0073 count start)", () => {
    const edges = buildCoOccurrenceEdges(HUAXI);
    const traveling = edges.find(
      (e) => e.head === "张伟" && e.tail === "上海"
    );
    // 张伟 and 上海 share BOTH sentences → weight 2, first such sentence is
    // the evidence span.
    expect(traveling?.weight).toBe(2);
    expect(traveling?.evidence).toBe("李娜 祝 张伟 结婚 于 上海");
    const chance = edges.find((e) => e.head === "李娜" && e.tail === "入职");
    // Different sentences: still ONE child shared (ADR-0077 keeps the edge),
    // but the joint count is 0 and the whole child is the only evidence.
    expect(chance?.weight).toBe(0);
    expect(chance?.evidence).toBe(HUAXI);
  });

  it("does not substring-match Latin terms inside longer words", () => {
    const edges = buildCoOccurrenceEdges(
      "car parked。carbon emitted。car driven。carbon released。"
    );
    const pair = edges.find((e) => e.head === "car" && e.tail === "carbon");
    // Without the token-boundary guard, "carbon" would count as a "car"
    // sighting and fake a joint weight; with it the pair never travels.
    expect(pair).toBeDefined();
    expect(pair?.weight).toBe(0);
  });

  it("yields no edges for fewer than two terms (single Chinese term, stopwords, empty)", () => {
    expect(buildCoOccurrenceEdges("华为")).toEqual([]);
    expect(buildCoOccurrenceEdges("the of and")).toEqual([]);
    expect(buildCoOccurrenceEdges("")).toEqual([]);
  });
});

// ─── PMI score + prune (ADR-0073, fast only) ─────────────────────────────

describe("scoreFastEdges", () => {
  it("ranks a chance pair of frequent terms below a rare pair that travels together", () => {
    const hubEdge = (tail: string): FastCooccurrenceEdge => ({
      head: "h",
      tail,
      weight: 1,
      headCount: 4,
      tailCount: 1,
      window: 5,
      evidence: "e",
    });
    const rarePair: FastCooccurrenceEdge = {
      head: "p",
      tail: "q",
      weight: 1,
      headCount: 1,
      tailCount: 1,
      window: 5,
      evidence: "e",
    };
    const scored = scoreFastEdges([
      hubEdge("u1"),
      hubEdge("u2"),
      hubEdge("u3"),
      hubEdge("u4"),
      rarePair,
    ]);
    const hub = scored.find((e) => e.head === "h" && e.tail === "u1");
    const rare = scored.find((e) => e.head === "p" && e.tail === "q");
    expect(hub!.pmi).toBeLessThan(rare!.pmi);
  });

  it("gives a never-traveled pair negative infinity (always below any finite edge)", () => {
    const scored = scoreFastEdges([edge("a", "b", 0)]);
    expect(scored[0]!.pmi).toBe(Number.NEGATIVE_INFINITY);
  });

  it("handles the empty edge set without division blow-ups", () => {
    expect(scoreFastEdges([])).toEqual([]);
  });
});

describe("pruneFastEdges", () => {
  // Disjoint weights 1..5 → pmi = log2(15/w), all distinct; ascending order
  // is (i,j) < (g,h) < (e,f) < (c,d) < (a,b).
  const FIVE = [
    edge("a", "b", 1),
    edge("c", "d", 2),
    edge("e", "f", 3),
    edge("g", "h", 4),
    edge("i", "j", 5),
  ];

  it("drops the edges under the default 40th percentile (2 of 5 here)", () => {
    const kept = pruneFastEdges(FIVE);
    expect(kept.map((e) => `${e.head}-${e.tail}`)).toEqual([
      "a-b",
      "c-d",
      "e-f",
    ]);
  });

  it("boundary: percentile 0 keeps everything; percentile 100 keeps only the max", () => {
    expect(pruneFastEdges(FIVE, { weakPercentile: 0 })).toHaveLength(5);
    const onlyMax = pruneFastEdges(FIVE, { weakPercentile: 100 });
    expect(onlyMax.map((e) => `${e.head}-${e.tail}`)).toEqual(["a-b"]);
  });

  it("keeps a uniform child graph intact (nothing is relatively weak)", () => {
    const uniform = buildCoOccurrenceEdges(MIXED);
    expect(pruneFastEdges(uniform)).toEqual(uniform);
  });

  it("minDegree drops leaf edges to a fixed point (rare nodes go with them)", () => {
    const graph = [
      edge("a", "b", 1, 1, 1, 15),
      edge("b", "c", 1, 1, 1, 15),
      edge("c", "a", 1, 1, 1, 15),
      edge("a", "d", 1, 1, 1, 15),
    ];
    const kept = pruneFastEdges(graph, { minDegree: 2 });
    expect(kept.map((e) => `${e.head}-${e.tail}`)).toEqual([
      "a-b",
      "b-c",
      "c-a",
    ]);
  });

  it("clamps junk option values instead of failing (invalid input class)", () => {
    // Out-of-range percentiles clamp to [0, 100]; minDegree floors at 1.
    expect(
      pruneFastEdges(FIVE, { weakPercentile: -5, minDegree: 0 })
    ).toHaveLength(5);
    expect(
      pruneFastEdges(FIVE, { weakPercentile: 500, minDegree: -3 })
    ).toHaveLength(1);
  });

  it("empty input prunes to empty", () => {
    expect(pruneFastEdges([])).toEqual([]);
  });

  it("names the tunable default the ticket pins", () => {
    expect(FAST_DEFAULT_WEAK_PERCENTILE).toBe(40);
  });
});

// ─── chunk-level outcome (typed union the seam consumes) ──────────────────

describe("extractFastChunk", () => {
  it("turns a mixed zh/en child into fully-formed co-occurrence triples", () => {
    const result = extractFastChunk({ id: "chunk-1", content: MIXED });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("narrow");
    const outputs = result.outputs as ExtractionOutput[];
    expect(outputs).toHaveLength(10);
    for (const out of outputs) {
      expect(out.relationRaw).toBe(FAST_RELATION_RAW);
      expect(out.relationNorm).toBe(FAST_RELATION_NORM);
      expect(out.headType).toBe("concept");
      expect(out.tailType).toBe("concept");
      expect(out.extractor).toBe(FAST_EXTRACTOR_TAG);
      // Confidence stays in [0,1] and the weight-1 default maps to 0.5.
      expect(out.confidence).toBe(0.5);
      // The evidence span must ground (persist's SC7 gate re-checks it).
      expect(MIXED.includes(out.evidenceSpan)).toBe(true);
      expect(out.description.length).toBeGreaterThan(0);
    }
    const first = outputs[0]!;
    expect(first.head).toBe("alice");
    expect(first.tail).toBe("bob");
  });

  it("keeps traveling pairs through the default prune and weights a two-sentence pair up", () => {
    const result = extractFastChunk({ id: "chunk-1", content: HUAXI });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("narrow");
    const traveling = result.outputs.find(
      (o) => o.head === "张伟" && o.tail === "上海"
    );
    // Weight 2 → confidence 2/3 (w/(w+1)).
    expect(traveling).toBeDefined();
    expect(traveling?.confidence).toBeCloseTo(2 / 3, 10);
    // The four never-traveled cross-sentence pairs score -inf and fall under
    // the default 40th percentile.
    expect(
      result.outputs.some((o) => o.head === "李娜" && o.tail === "入职")
    ).toBe(false);
    expect(result.outputs).toHaveLength(11);
  });

  it("fails the empty-whitespace chunk with EMPTY_CHUNK before any work", () => {
    const result = extractFastChunk({ id: "chunk-1", content: "   " });
    expect(result).toMatchObject({
      kind: "failed",
      errorCode: EMPTY_CHUNK_CODE,
    });
  });

  it("fails with FAST_EMPTY_GRAPH when a Chinese child yields no edges (typed job fail)", () => {
    const stopWordOnly = extractFastChunk({
      id: "chunk-1",
      content: "的了 于 与 之",
    });
    expect(stopWordOnly.kind).toBe("failed");
    if (stopWordOnly.kind !== "failed") throw new Error("narrow");
    expect(stopWordOnly.errorCode).toBe(FAST_EMPTY_GRAPH_CODE);
    expect(stopWordOnly.errorMsg).toContain("chunk-1");

    // Chinese content WITH one term but no pair is still an empty graph.
    const singleTerm = extractFastChunk({ id: "chunk-2", content: "华为" });
    expect(singleTerm).toMatchObject({
      kind: "failed",
      errorCode: FAST_EMPTY_GRAPH_CODE,
    });
  });

  it("an English stopword-only child is a normal zero-output chunk, not a fail", () => {
    const result = extractFastChunk({ id: "chunk-1", content: "the of and" });
    expect(result).toEqual({ kind: "ok", outputs: [] });
  });

  it("applies prune option overrides (thresholds are index-job config)", () => {
    const text = "aa bb cc。aa bb dd。aa bb ee。aa bb ff。";
    const strict = extractFastChunk(
      { id: "c", content: text },
      { weakPercentile: 0 }
    );
    const defaultCut = extractFastChunk({ id: "c", content: text });
    expect(strict.kind).toBe("ok");
    expect(defaultCut.kind).toBe("ok");
    if (strict.kind !== "ok" || defaultCut.kind !== "ok")
      throw new Error("narrow");
    // 15 candidate pairs; the default cut removes the six -inf chance pairs.
    expect(strict.outputs).toHaveLength(15);
    expect(defaultCut.outputs).toHaveLength(9);
  });

  it("is deterministic: the same child always produces the same outputs", () => {
    const a = extractFastChunk({ id: "c", content: MIXED });
    const b = extractFastChunk({ id: "c", content: MIXED });
    expect(a).toEqual(b);
  });
});
