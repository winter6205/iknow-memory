/**
 * Three-axis scoring for the extraction-eval capability
 * (specs/p0-eval.md SC4, SC5, SC6, SC7, A1, A4).
 *
 * The hand-rolled micro-F1 case in SC4 is the spec's own worked example:
 * gold 3 + pred 3 with two exact matches + one spurious → P=R=2/3,
 * F1 = 2PR/(P+R) = 2/3. Any change that nudges the precision or recall
 * off those numbers is a regression to catch here, not a release-day
 * surprise.
 *
 * The five error types in SC7 are deliberately diagnostic only: the
 * score bundle carries them so a regression review can read WHY the
 * numbers moved, but no error type ever feeds the gate. The mixed-input
 * test below is the one place the suite forces every type to appear at
 * once.
 *
 * Everything runs off in-memory data — no live LLM, no Postgres, no
 * clock. The scorer is the only pure-CPU path that turns frozen gold
 * triples and raw predicted outputs into the three axes.
 */
import { describe, it, expect } from "vitest";

import {
  errorTypes,
  hallucinationRate,
  microF1,
  schemaRate,
  score,
  type ErrorType,
  type ScoringTriple,
} from "../../src/core/extraction-eval/scoring.js";
import { UNMAPPED } from "../../src/core/extraction/vocabulary.js";

/** Tiny triple builder so each test reads as a table of facts. */
function t(
  partial: Partial<ScoringTriple> & {
    head: string;
    relationNorm: string;
    tail: string;
  }
): ScoringTriple {
  return {
    head: partial.head,
    relationNorm: partial.relationNorm,
    tail: partial.tail,
    evidenceSpan: partial.evidenceSpan ?? "",
    chunkId: partial.chunkId,
  };
}

const ALL_ERROR_TYPES: readonly ErrorType[] = [
  "spurious",
  "wrong-relation",
  "wrong-entity",
  "incomplete",
  "schema-violation",
];

describe("microF1 (SC4)", () => {
  it("computes the hand-rolled 2/3 P=R F1 case from the spec", () => {
    const gold: ScoringTriple[] = [
      t({ head: "Alice", relationNorm: "works_for", tail: "Acme" }),
      t({ head: "Bob", relationNorm: "works_for", tail: "Initech" }),
      t({ head: "Carol", relationNorm: "works_for", tail: "Hooli" }),
    ];
    const pred: ScoringTriple[] = [
      t({ head: "Alice", relationNorm: "works_for", tail: "Acme" }),
      t({ head: "Bob", relationNorm: "works_for", tail: "Initech" }),
      t({ head: "Dave", relationNorm: "works_for", tail: "Pied Piper" }),
    ];

    const result = microF1(gold, pred);

    expect(result.precision).toBe(2 / 3);
    expect(result.recall).toBe(2 / 3);
    expect(result.f1).toBeCloseTo(2 / 3, 10);
  });

  it("returns F1 = 1 on a perfect prediction", () => {
    const gold = [t({ head: "A", relationNorm: "works_for", tail: "B" })];
    const pred = [t({ head: "A", relationNorm: "works_for", tail: "B" })];

    const result = microF1(gold, pred);

    expect(result.precision).toBe(1);
    expect(result.recall).toBe(1);
    expect(result.f1).toBe(1);
  });

  it("returns F1 = 0 when nothing matches", () => {
    const gold = [t({ head: "A", relationNorm: "works_for", tail: "B" })];
    const pred = [t({ head: "X", relationNorm: "knows", tail: "Y" })];

    const result = microF1(gold, pred);

    expect(result.precision).toBe(0);
    expect(result.recall).toBe(0);
    expect(result.f1).toBe(0);
  });

  it("ignores case and surrounding whitespace on head and tail (match key)", () => {
    const gold = [
      t({ head: "Alice Chen", relationNorm: "works_for", tail: "Acme Corp" }),
    ];
    const pred = [
      t({
        head: "  alice CHEN ",
        relationNorm: "works_for",
        tail: "\tACME corp\n",
      }),
    ];

    const result = microF1(gold, pred);

    expect(result.precision).toBe(1);
    expect(result.recall).toBe(1);
    expect(result.f1).toBe(1);
  });

  it("does not let inner whitespace differences collapse into a match (A8)", () => {
    const gold = [
      t({ head: "Alice Chen", relationNorm: "works_for", tail: "Acme" }),
    ];
    const pred = [
      t({ head: "Alice  Chen", relationNorm: "works_for", tail: "Acme" }),
    ];

    const result = microF1(gold, pred);

    expect(result.precision).toBe(0);
    expect(result.recall).toBe(0);
    expect(result.f1).toBe(0);
  });
});

describe("microF1 boundary: empty inputs", () => {
  it("returns 0 across the board on empty gold AND empty pred", () => {
    const result = microF1([], []);
    expect(result.precision).toBe(0);
    expect(result.recall).toBe(0);
    expect(result.f1).toBe(0);
  });

  it("returns recall=0 when gold is empty but pred has entries", () => {
    const pred = [t({ head: "X", relationNorm: "works_for", tail: "Y" })];

    const result = microF1([], pred);

    expect(result.precision).toBe(0);
    expect(result.recall).toBe(0);
    expect(result.f1).toBe(0);
  });

  it("returns precision=0 when pred is empty but gold has entries", () => {
    const gold = [t({ head: "X", relationNorm: "works_for", tail: "Y" })];

    const result = microF1(gold, []);

    expect(result.precision).toBe(0);
    expect(result.recall).toBe(0);
    expect(result.f1).toBe(0);
  });
});

describe("microF1 boundary: overflow", () => {
  it("finishes 10k+ triples without quadratic blow-up", () => {
    const gold: ScoringTriple[] = Array.from({ length: 10001 }, (_, i) =>
      t({ head: `H${i}`, relationNorm: "works_for", tail: `T${i}` })
    );
    // Drop the last gold so recall is strictly < 1 and the formula has to do real work.
    const pred: ScoringTriple[] = gold.slice(0, 10000);

    const start = Date.now();
    const result = microF1(gold, pred);
    const elapsed = Date.now() - start;

    expect(result.recall).toBeCloseTo(10000 / 10001, 5);
    expect(result.precision).toBe(1);
    expect(elapsed).toBeLessThan(2000);
  });
});

describe("schemaRate (SC5)", () => {
  it("returns 1 when every relation_norm is a vocabulary term", () => {
    const pred = [
      t({ head: "A", relationNorm: "works_for", tail: "B" }),
      t({ head: "C", relationNorm: "knows", tail: "D" }),
      t({ head: "E", relationNorm: "instance_of", tail: "F" }),
    ];

    expect(schemaRate(pred)).toBe(1);
  });

  it("returns < 1 when any relation_norm is UNMAPPED", () => {
    const pred = [
      t({ head: "A", relationNorm: "works_for", tail: "B" }),
      t({ head: "C", relationNorm: UNMAPPED, tail: "D" }),
      t({ head: "E", relationNorm: "knows", tail: "F" }),
    ];

    expect(schemaRate(pred)).toBeLessThan(1);
    expect(schemaRate(pred)).toBeCloseTo(2 / 3);
  });

  it("returns < 1 when any relation_norm is outside the vocabulary (and not UNMAPPED)", () => {
    const pred = [
      t({ head: "A", relationNorm: "works_for", tail: "B" }),
      t({ head: "C", relationNorm: "invented_by", tail: "D" }),
    ];

    expect(schemaRate(pred)).toBeLessThan(1);
    expect(schemaRate(pred)).toBeCloseTo(0.5);
  });

  it("returns 1 (vacuous truth) on an empty prediction list", () => {
    expect(schemaRate([])).toBe(1);
  });
});

describe("hallucinationRate (SC6)", () => {
  it("returns 1 when the evidence span is not a substring of the chunk text", () => {
    const pred: ScoringTriple[] = [
      {
        head: "A",
        relationNorm: "works_for",
        tail: "B",
        evidenceSpan: "this string is not in chunk",
        chunkId: "chunk-1",
      },
    ];
    const chunkTextById = new Map<string, string>([
      ["chunk-1", "lorem ipsum dolor sit amet"],
    ]);

    expect(hallucinationRate(pred, chunkTextById)).toBe(1);
  });

  it("returns 0 when the evidence span is a verbatim substring of the chunk text", () => {
    const pred: ScoringTriple[] = [
      {
        head: "Alice",
        relationNorm: "works_for",
        tail: "Acme",
        evidenceSpan: "Alice works for Acme",
        chunkId: "chunk-1",
      },
    ];
    const chunkTextById = new Map<string, string>([
      ["chunk-1", "Alice works for Acme Corp in Beijing."],
    ]);

    expect(hallucinationRate(pred, chunkTextById)).toBe(0);
  });

  it("returns the right fraction for a mixed batch", () => {
    const pred: ScoringTriple[] = [
      {
        head: "A",
        relationNorm: "works_for",
        tail: "B",
        evidenceSpan: "Alice works for Acme",
        chunkId: "chunk-1",
      },
      {
        head: "C",
        relationNorm: "works_for",
        tail: "D",
        evidenceSpan: "totally made up span",
        chunkId: "chunk-1",
      },
      {
        head: "E",
        relationNorm: "works_for",
        tail: "F",
        evidenceSpan: "Charlie works for Hooli",
        chunkId: "chunk-1",
      },
    ];
    const chunkTextById = new Map<string, string>([
      ["chunk-1", "Alice works for Acme. Charlie works for Hooli."],
    ]);

    expect(hallucinationRate(pred, chunkTextById)).toBeCloseTo(1 / 3);
  });

  it("treats a missing chunk in the map as hallucinated", () => {
    const pred: ScoringTriple[] = [
      {
        head: "A",
        relationNorm: "works_for",
        tail: "B",
        evidenceSpan: "anything",
        chunkId: "chunk-missing",
      },
    ];

    expect(hallucinationRate(pred, new Map())).toBe(1);
  });

  it("treats an absent chunkId as hallucinated", () => {
    const pred: ScoringTriple[] = [
      t({
        head: "A",
        relationNorm: "works_for",
        tail: "B",
        evidenceSpan: "anything",
      }),
    ];

    expect(hallucinationRate(pred, new Map())).toBe(1);
  });

  it("treats empty chunk text as grounding nothing (non-empty spans hallucinated)", () => {
    const pred: ScoringTriple[] = [
      {
        head: "A",
        relationNorm: "works_for",
        tail: "B",
        evidenceSpan: "Alice",
        chunkId: "chunk-1",
      },
    ];
    const chunkTextById = new Map<string, string>([["chunk-1", ""]]);

    expect(hallucinationRate(pred, chunkTextById)).toBe(1);
  });

  it("returns 0 on empty input", () => {
    expect(hallucinationRate([], new Map())).toBe(0);
  });
});

describe("hallucinationRate boundary: overflow", () => {
  it("finishes 10k+ triples against an oversized chunk without stack overflow", () => {
    const hugeText = "x".repeat(100_000);
    const pred: ScoringTriple[] = Array.from({ length: 10_001 }, (_, i) => ({
      head: `H${i}`,
      relationNorm: "works_for",
      tail: `T${i}`,
      // Short evidence spans so the substring search is fast; the
      // point of this test is the loop count, not string-matcher cost.
      // The span is absent from the body so every triple is hallucinated.
      evidenceSpan: "missing",
      chunkId: "chunk-1",
    }));
    const chunkTextById = new Map<string, string>([["chunk-1", hugeText]]);

    const start = Date.now();
    const rate = hallucinationRate(pred, chunkTextById);
    const elapsed = Date.now() - start;

    expect(rate).toBe(1);
    expect(elapsed).toBeLessThan(2000);
  });
});

describe("errorTypes (SC7)", () => {
  it("classifies a mixed input with exactly one error type per mis-prediction, covering all five types", () => {
    const gold: ScoringTriple[] = [
      t({ head: "Alice", relationNorm: "works_for", tail: "Acme" }), // 0: matched exactly
      t({ head: "Carol", relationNorm: "knows", tail: "Dave" }), // 1: pred has wrong entity
      t({ head: "Eve", relationNorm: "owns", tail: "Mall" }), // 2: pred has wrong relation
      t({ head: "Frank", relationNorm: "created_by", tail: "Paper" }), // 3: no pred matches → incomplete
      t({ head: "Gus", relationNorm: "invented_by", tail: "Trick" }), // 4: relation outside vocabulary → schema-violation
    ];
    const pred: ScoringTriple[] = [
      t({ head: "Alice", relationNorm: "works_for", tail: "Acme" }), // 0: exact match (no error)
      t({ head: "Carol", relationNorm: "knows", tail: "Mall" }), // 1: wrong-entity (relation matches, tail differs)
      t({ head: "Eve", relationNorm: "causes", tail: "Mall" }), // 2: wrong-relation (head/tail match, relation differs)
      t({ head: "Zoe", relationNorm: "mentions", tail: "Yoyodyne" }), // 3: spurious (no head/tail or relation overlap)
      t({ head: "Vince", relationNorm: "invented_by", tail: "Widget" }), // 4: schema-violation
    ];

    const errors = errorTypes(gold, pred);

    // Pred side: every mis-predicted triple has exactly one type.
    expect(errors.get("pred:0")).toBeUndefined();
    expect(errors.get("pred:1")).toBe("wrong-entity");
    expect(errors.get("pred:2")).toBe("wrong-relation");
    expect(errors.get("pred:3")).toBe("spurious");
    expect(errors.get("pred:4")).toBe("schema-violation");

    // Gold side: every unmatched triple is exactly one type.
    expect(errors.get("gold:0")).toBeUndefined();
    expect(errors.get("gold:1")).toBe("incomplete");
    expect(errors.get("gold:2")).toBe("incomplete");
    expect(errors.get("gold:3")).toBe("incomplete");
    expect(errors.get("gold:4")).toBe("schema-violation");

    // The five diagnostic types are all present in the map — none is
    // missing from the mis-prediction surface.
    const seen = new Set(errors.values());
    for (const want of ALL_ERROR_TYPES) {
      expect(seen.has(want)).toBe(true);
    }

    // And every value is one of the five allowed types.
    for (const type of errors.values()) {
      expect(ALL_ERROR_TYPES).toContain(type);
    }
  });

  it("marks every gold triple as incomplete when pred is empty", () => {
    const gold: ScoringTriple[] = [
      t({ head: "A", relationNorm: "works_for", tail: "B" }),
      t({ head: "C", relationNorm: "knows", tail: "D" }),
    ];

    const errors = errorTypes(gold, []);

    expect(errors.get("gold:0")).toBe("incomplete");
    expect(errors.get("gold:1")).toBe("incomplete");
    expect(errors.size).toBe(2);
  });

  it("marks every pred triple as spurious when gold is empty", () => {
    const pred: ScoringTriple[] = [
      t({ head: "A", relationNorm: "works_for", tail: "B" }),
      t({ head: "C", relationNorm: "knows", tail: "D" }),
    ];

    const errors = errorTypes([], pred);

    expect(errors.get("pred:0")).toBe("spurious");
    expect(errors.get("pred:1")).toBe("spurious");
    expect(errors.size).toBe(2);
  });

  it("returns an empty map when both sides are empty", () => {
    const errors = errorTypes([], []);
    expect(errors.size).toBe(0);
  });

  it("gives a UNMAPPED pred triple the schema-violation type, not a partial-match type", () => {
    const gold: ScoringTriple[] = [
      t({ head: "A", relationNorm: "works_for", tail: "B" }),
    ];
    const pred: ScoringTriple[] = [
      t({ head: "A", relationNorm: UNMAPPED, tail: "B" }),
    ];

    const errors = errorTypes(gold, pred);

    expect(errors.get("pred:0")).toBe("schema-violation");
  });
});

describe("score bundle", () => {
  it("returns the three axes plus the diagnostic map", () => {
    const gold: ScoringTriple[] = [
      t({ head: "Alice", relationNorm: "works_for", tail: "Acme" }),
      t({ head: "Bob", relationNorm: "works_for", tail: "Initech" }),
      t({ head: "Carol", relationNorm: "works_for", tail: "Hooli" }),
    ];
    const pred: ScoringTriple[] = [
      t({
        head: "Alice",
        relationNorm: "works_for",
        tail: "Acme",
        evidenceSpan: "Alice works for Acme",
        chunkId: "chunk-1",
      }),
      t({
        head: "Bob",
        relationNorm: "works_for",
        tail: "Initech",
        evidenceSpan: "Bob works for Initech",
        chunkId: "chunk-1",
      }),
      t({
        head: "Dave",
        relationNorm: "mentions",
        tail: "Pied Piper",
        evidenceSpan: "this is not in the chunk",
        chunkId: "chunk-1",
      }),
    ];
    const chunkTextById = new Map<string, string>([
      ["chunk-1", "Alice works for Acme. Bob works for Initech."],
    ]);

    const report = score(gold, pred, chunkTextById);

    expect(report.f1.precision).toBe(2 / 3);
    expect(report.f1.recall).toBe(2 / 3);
    expect(report.f1.f1).toBeCloseTo(2 / 3);
    expect(report.schemaRate).toBe(1);
    expect(report.hallucinationRate).toBeCloseTo(1 / 3);
    expect(report.errors.get("pred:2")).toBe("spurious");
    expect(report.errors.get("gold:2")).toBe("incomplete");
  });
});
