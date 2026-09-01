/**
 * Micro-F1 match key (specs/p0-eval.md A8).
 *
 * A8 pins the key deliberately narrow: `relation_norm` as the extract
 * cascade already produced it, plus Unicode case-fold + trim on head and
 * tail — and nothing else. Any extra leniency here (collapsing inner
 * whitespace, alias-mapping entities, canonical merge) would silently
 * inflate extraction F1, so the "does NOT merge" cases are tested as
 * hard as the "does match" cases.
 */
import { describe, it, expect } from "vitest";

import { tripleMatchKey } from "../../src/core/extraction-eval/match-key.js";

describe("triple match key (A8)", () => {
  it("treats case and surrounding whitespace on head and tail as the same triple", () => {
    const gold = tripleMatchKey({
      head: "Alice Chen",
      relation_norm: "works_for",
      tail: "Acme Corp",
    });
    const predicted = tripleMatchKey({
      head: "  alice CHEN ",
      relation_norm: "works_for",
      tail: "\tACME corp\n",
    });

    expect(predicted).toBe(gold);
  });

  it("case-folds non-ASCII entity names", () => {
    expect(
      tripleMatchKey({
        head: "ÜRÜMQI",
        relation_norm: "located_in",
        tail: "XINJIANG",
      })
    ).toBe(
      tripleMatchKey({
        head: "ürümqi",
        relation_norm: "located_in",
        tail: "xinjiang",
      })
    );
  });

  it("keeps inner whitespace differences distinct — case-fold and trim only", () => {
    expect(
      tripleMatchKey({
        head: "Alice  Chen",
        relation_norm: "works_for",
        tail: "Acme",
      })
    ).not.toBe(
      tripleMatchKey({
        head: "Alice Chen",
        relation_norm: "works_for",
        tail: "Acme",
      })
    );
  });

  it("keeps entity variants distinct — no canonical merge on the eval path", () => {
    expect(
      tripleMatchKey({
        head: "Acme Corp",
        relation_norm: "located_in",
        tail: "Beijing",
      })
    ).not.toBe(
      tripleMatchKey({
        head: "Acme Corporation",
        relation_norm: "located_in",
        tail: "Beijing",
      })
    );
  });

  it("separates triples that differ only by relation", () => {
    expect(
      tripleMatchKey({
        head: "Alice",
        relation_norm: "works_for",
        tail: "Acme",
      })
    ).not.toBe(
      tripleMatchKey({ head: "Alice", relation_norm: "owns", tail: "Acme" })
    );
  });

  it("separates a triple from its reverse", () => {
    expect(
      tripleMatchKey({
        head: "Alice",
        relation_norm: "knows",
        tail: "Bob",
      })
    ).not.toBe(
      tripleMatchKey({ head: "Bob", relation_norm: "knows", tail: "Alice" })
    );
  });

  it("does not let punctuation inside an entity forge a different triple's key", () => {
    expect(
      tripleMatchKey({
        head: "Alice|works_for",
        relation_norm: "knows",
        tail: "Bob",
      })
    ).not.toBe(
      tripleMatchKey({
        head: "Alice",
        relation_norm: "works_for",
        tail: "knows|Bob",
      })
    );
  });
});
