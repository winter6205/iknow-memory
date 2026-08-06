import { describe, it, expect } from "vitest";
import { computeEntityEmbeddingText } from "../../src/core/entities/embedding.js";

describe("computeEntityEmbeddingText", () => {
  it("joins canonicalName and description with ' | '", () => {
    expect(computeEntityEmbeddingText("Alice", "works at Acme")).toBe(
      "Alice | works at Acme"
    );
  });

  it("does not throw and preserves the delimiter for an empty description", () => {
    expect(computeEntityEmbeddingText("Alice", "")).toBe("Alice | ");
  });
});
