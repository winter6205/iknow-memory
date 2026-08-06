import { describe, it, expect } from "vitest";
import {
  mergeEntitiesWithGating,
  normalizeAlias,
  type CandidateEntity,
  type Embedder,
  type GrayZoneLog,
} from "../../src/core/entities/merge.js";
import { DEFAULT_MERGE_CONFIG } from "../../src/core/entities/types.js";
import { cosineSimilarity } from "../../src/core/cosine.js";

/**
 * Deterministic test embedder: hashes each input to a fixed-length vector.
 * Tests use the `overrides` map to pin the exact cosine values for the
 * specific strings the merge gate reads, while any incidental string falls
 * back to the hash. Same text → same vector; cosine via `src/core/cosine.ts`.
 */
const DIM = 8;

function basisVector(index: number): number[] {
  const out = new Array<number>(DIM).fill(0);
  out[index % DIM] = 1;
  return out;
}

function hashVec(text: string): number[] {
  const out = new Array<number>(DIM);
  let acc = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    acc ^= text.charCodeAt(i);
    acc = Math.imul(acc, 0x01000193) >>> 0;
  }
  let state = (acc ^ 0x9e3779b9) >>> 0;
  for (let i = 0; i < DIM; i += 1) {
    state = Math.imul(state ^ (i + 1), 0x85ebca6b) >>> 0;
    state ^= state >>> 13;
    state = Math.imul(state, 0xc2b2ae35) >>> 0;
    state ^= state >>> 16;
    out[i] = (state / 0xffffffff) * 2 - 1;
  }
  return out;
}

function makeFakeEmbedder(overrides: Record<string, number[]> = {}): Embedder {
  return {
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map((t) => overrides[t] ?? hashVec(t));
    },
  };
}

function candidate(over: Partial<CandidateEntity>): CandidateEntity {
  return {
    id: "cand-1",
    canonicalName: "Alice",
    type: "person",
    description: "a software engineer at Acme corp",
    ...over,
  };
}

function graySpy() {
  const entries: GrayZoneLog[] = [];
  return { entries, fn: (e: GrayZoneLog) => entries.push(e) };
}

describe("normalizeAlias", () => {
  it("lowercases, trims, and collapses whitespace", () => {
    expect(normalizeAlias("  Alice   Smith  ")).toBe("alice smith");
  });
});

describe("mergeEntitiesWithGating — L0", () => {
  it("merges two entities with the same normalized name and same type", async () => {
    const embedder = makeFakeEmbedder();
    const out = await mergeEntitiesWithGating(
      { canonicalName: "alice smith", type: "person", description: "engineer" },
      [
        candidate({
          id: "cand-1",
          canonicalName: "Alice Smith",
          type: "person",
        }),
      ],
      { embedder, config: DEFAULT_MERGE_CONFIG }
    );
    expect(out.decision).toEqual({
      kind: "merge",
      into: "cand-1",
      via: "L0",
      observedCosine: 1.0,
    });
    expect(out.canonicalId).toBe("cand-1");
  });
});

describe("mergeEntitiesWithGating — L1 type reject", () => {
  it("rejects at L1 when same name has different type, emitting a structured log", async () => {
    const embedder = makeFakeEmbedder();
    const spy = graySpy();
    const out = await mergeEntitiesWithGating(
      { canonicalName: "Alice", type: "person", description: "engineer" },
      [candidate({ id: "cand-1", canonicalName: "Alice", type: "company" })],
      { embedder, config: DEFAULT_MERGE_CONFIG, logGrayZone: spy.fn }
    );
    expect(out.decision).toEqual({
      kind: "reject",
      reason: "type-mismatch",
      level: "L1",
    });
    expect(
      spy.entries.some((e) => e.level === "L1" && e.reason === "type-mismatch")
    ).toBe(true);
  });
});

describe("mergeEntitiesWithGating — L2 description-cosine floor", () => {
  it("rejects at L2 when description cosine is below the 0.30 floor", async () => {
    // Names differ so L0 doesn't fire; types match; descriptions are long
    // and chosen so their cosine is below the floor.
    const descA =
      "completely unrelated topic about rocket manufacturing plants";
    const descB =
      "totally different subject about fine dining and cooking schools";
    const embedder = makeFakeEmbedder({
      [descA]: basisVector(0),
      [descB]: basisVector(1),
    });
    const spy = graySpy();
    const out = await mergeEntitiesWithGating(
      { canonicalName: "rocket-co", type: "company", description: descA },
      [
        candidate({
          id: "cand-1",
          canonicalName: "rocket-inc",
          type: "company",
          description: descB,
        }),
      ],
      { embedder, config: DEFAULT_MERGE_CONFIG, logGrayZone: spy.fn }
    );
    expect(out.decision.kind).toBe("reject");
    if (out.decision.kind !== "reject") return;
    expect(out.decision.level).toBe("L2");
    expect(typeof out.decision.observedCosine).toBe("number");
    expect(out.decision.observedCosine!).toBeLessThan(0.3);
    expect(spy.entries.some((e) => e.level === "L2")).toBe(true);
  });

  it("skips L2 when descriptions are shorter than minDescriptionLength, proceeds to L3 without throwing", async () => {
    // Short descriptions → L2 skips. Embedding-text vectors set orthogonal
    // so L3 produces a deterministic gray-zone reject.
    const nameA = "Alice";
    const nameB = "Alicia";
    const descA = "tiny"; // < 8 chars
    const descB = "short"; // < 8 chars
    const embedder = makeFakeEmbedder({
      [`${nameA} | ${descA}`]: basisVector(0),
      [`${nameB} | ${descB}`]: basisVector(1),
    });
    const spy = graySpy();
    const out = await mergeEntitiesWithGating(
      { canonicalName: nameA, type: "person", description: descA },
      [
        candidate({
          id: "cand-1",
          canonicalName: nameB,
          type: "person",
          description: descB,
        }),
      ],
      { embedder, config: DEFAULT_MERGE_CONFIG, logGrayZone: spy.fn }
    );
    // No L2 rejection: L2 was skipped (short descriptions).
    expect(spy.entries.some((e) => e.level === "L2")).toBe(false);
    // L3 ran: orthogonal vectors → below threshold → gray-zone reject.
    expect(out.decision.kind).toBe("reject");
    if (out.decision.kind !== "reject") return;
    expect(out.decision.level).toBe("L3");
  });
});

describe("mergeEntitiesWithGating — L3 name+description cosine mid threshold", () => {
  it("merges at L3 when name+desc cosine is at/above the 0.50 threshold", async () => {
    // Identical description for both → L2 desc cosine = 1 (passes).
    // Identical embedding-text vectors → L3 cosine = 1 (merges).
    const desc =
      "a long shared description for both entities in this test case";
    const nameA = "Alice";
    const nameB = "Alicia";
    const embedder = makeFakeEmbedder({
      [desc]: basisVector(0),
      [`${nameA} | ${desc}`]: basisVector(0),
      [`${nameB} | ${desc}`]: basisVector(0),
    });
    const out = await mergeEntitiesWithGating(
      { canonicalName: nameA, type: "person", description: desc },
      [
        candidate({
          id: "cand-1",
          canonicalName: nameB,
          type: "person",
          description: desc,
        }),
      ],
      { embedder, config: DEFAULT_MERGE_CONFIG }
    );
    expect(out.decision.kind).toBe("merge");
    if (out.decision.kind !== "merge") return;
    expect(out.decision.via).toBe("L3");
    expect(out.decision.into).toBe("cand-1");
    expect(out.decision.observedCosine).toBeGreaterThanOrEqual(0.5);
  });

  it("rejects at L3 (gray zone) when name+desc cosine is below the 0.50 threshold in single-floor mode", async () => {
    const desc =
      "a long shared description for both entities in this test case";
    const nameA = "Alice";
    const nameB = "Alicia";
    const embedder = makeFakeEmbedder({
      [desc]: basisVector(0), // same → L2 cosine 1, passes L2
      [`${nameA} | ${desc}`]: basisVector(0),
      [`${nameB} | ${desc}`]: basisVector(1), // orthogonal → L3 cosine 0, below 0.50
    });
    const spy = graySpy();
    const out = await mergeEntitiesWithGating(
      { canonicalName: nameA, type: "person", description: desc },
      [
        candidate({
          id: "cand-1",
          canonicalName: nameB,
          type: "person",
          description: desc,
        }),
      ],
      { embedder, config: DEFAULT_MERGE_CONFIG, logGrayZone: spy.fn }
    );
    expect(out.decision.kind).toBe("reject");
    if (out.decision.kind !== "reject") return;
    expect(out.decision.level).toBe("L3");
    expect(spy.entries.some((e) => e.level === "L3")).toBe(true);
  });
});

describe("mergeEntitiesWithGating — created-new", () => {
  it("returns created-new when no candidate matches any gate", async () => {
    const embedder = makeFakeEmbedder();
    const out = await mergeEntitiesWithGating(
      {
        canonicalName: "Zelda",
        type: "person",
        description: "a hero of hyrule",
      },
      [candidate({ id: "cand-1", canonicalName: "Alice", type: "company" })], // type differs → L1 skip; no same-type candidates
      { embedder, config: DEFAULT_MERGE_CONFIG }
    );
    expect(out.decision).toBe("created-new");
  });
});

describe("cosineSimilarity (sanity for the fake embedder)", () => {
  it("scores identical vectors as cosine 1", () => {
    const v = basisVector(2);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 5);
  });

  it("scores orthogonal basis vectors as cosine 0", () => {
    expect(cosineSimilarity(basisVector(0), basisVector(1))).toBeCloseTo(0, 5);
  });
});
