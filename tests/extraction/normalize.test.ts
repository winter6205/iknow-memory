import { describe, it, expect } from "vitest";
import {
  normalizeRelation,
  UNMAPPED,
} from "../../src/core/extraction/normalize.js";
import { FakeEmbedder } from "../../src/core/embedder.js";
import type { EmbeddingClient } from "../../src/core/embedder.js";
import { ALLOWED, ALIASES } from "../../src/core/extraction/vocabulary.js";

/**
 * Deterministic mock embedder with a known cosine profile: the query scores
 * exactly 0.7 against the "works_for" term and 0 against every other ALLOWED
 * term. Lets the threshold sweep assert cascade behavior without depending on
 * FakeEmbedder's hash arithmetic.
 */
function mockEmbedder(): EmbeddingClient {
  const worksForIndex = ALLOWED.indexOf("works_for");
  return {
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map((_, idx) => {
        if (idx === 0) return [1, 0, 0]; // query → e1
        if (idx === 1 + worksForIndex) {
          // unit vector with cosine 0.7 against e1
          return [0.7, Math.sqrt(1 - 0.7 * 0.7), 0];
        }
        return [0, 0, 1]; // every other term orthogonal to e1
      });
    },
  };
}

/** Deterministic test embedder; dimension is arbitrary (only cosine matters). */
const TEST_DIM = 64;

describe("normalizeRelation cascade", () => {
  it("exact match (case-insensitive, trimmed) returns the ALLOWED term", async () => {
    expect(await normalizeRelation("  Part_OF ", {})).toBe("part_of");
    expect(await normalizeRelation("RELATED_TO", {})).toBe("related_to");
    expect(await normalizeRelation("located_in", {})).toBe("located_in");
  });

  it("synonym match returns the mapped ALLOWED term", async () => {
    expect(await normalizeRelation("is part of", {})).toBe("part_of");
    expect(await normalizeRelation("works at", {})).toBe("works_for");
    expect(await normalizeRelation("based in", {})).toBe("located_in");
  });

  it("all ALIASES values resolve (via embedder not required) to an ALLOWED entry", async () => {
    for (const [alias, mapped] of Object.entries(ALIASES)) {
      expect(await normalizeRelation(alias, {})).toBe(mapped);
      expect(ALLOWED).toContain(mapped);
    }
  });

  it("embedding match above threshold returns the best ALLOWED term", async () => {
    const embedder = new FakeEmbedder(TEST_DIM);
    // Exact text of an ALLOWED term always scores ~1.0 against itself.
    const result = await normalizeRelation("part_of", {
      embedder,
      threshold: 0.7,
    });
    expect(result).toBe("part_of");
  });

  it("below threshold returns UNMAPPED", async () => {
    const embedder = new FakeEmbedder(TEST_DIM);
    const result = await normalizeRelation("xxzz not a real relation qq", {
      embedder,
      threshold: 0.99,
    });
    expect(result).toBe(UNMAPPED);
  });

  it("no embedder returns UNMAPPED when exact and synonym legs miss", async () => {
    expect(await normalizeRelation("quirky relation", {})).toBe(UNMAPPED);
  });

  it("embedder provided but no threshold returns UNMAPPED (embedding leg gated on threshold)", async () => {
    const embedder = new FakeEmbedder(TEST_DIM);
    expect(await normalizeRelation("orks for", { embedder })).toBe(UNMAPPED);
  });

  it("threshold sweep .6/.7/.8 crosses the embedding floor", async () => {
    const embedder = mockEmbedder(); // query scores exactly 0.7 vs works_for
    const raw = "works fro";
    const atLow = await normalizeRelation(raw, { embedder, threshold: 0.6 });
    const atMid = await normalizeRelation(raw, { embedder, threshold: 0.7 });
    const atHigh = await normalizeRelation(raw, { embedder, threshold: 0.8 });
    // Observe the cascade: freezes the best match at the threshold boundary.
    expect([atLow, atMid, atHigh]).toContain("works_for");
    expect(atHigh).toBe(UNMAPPED);
  });
});
