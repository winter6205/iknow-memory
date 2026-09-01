/**
 * Eval filter — accept path plus four reject reasons (specs/p0-eval.md SC10, A4).
 *
 * SC10 names the four reject reasons the code filter must encode:
 *   no-grounding, relation-not-norm, entity-not-normalized, negated.
 * A4 requires the filter to be pure: no LLM, no I/O, no clock. Each reason
 * below has a hard test so a regression that silently drops a reason (or
 * flips the verdict on a clean triple) is caught by `npm test`.
 *
 * The grep guard at the bottom is the A4 / SC10 protection against
 * re-introducing a hard-coded ALLOWED copy in the filter module itself —
 * the vocabulary is the SSOT, imported only.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  filterTriple,
  FilterError,
  type RejectReason,
} from "../../src/core/extraction-eval/index.js";
import type { ExtractionOutput } from "../../src/core/extraction/types.js";

const FILTER_MODULE_PATH = fileURLToPath(
  new URL("../../src/core/extraction-eval/filter.ts", import.meta.url)
);

/**
 * Build a triple that the filter should accept on every axis (grounding,
 * vocabulary, entity form, negation). Default values are picked so:
 *
 *   - head/tail are already in normalizeAlias form (lowercased + trimmed +
 *     whitespace-collapsed), so a normalizer-aware filter accepts them.
 *   - evidenceSpan is a literal substring of `DEFAULT_CHUNK`.
 *   - description carries no negation cue.
 *
 * Each reason-specific test below overrides only the field that
 * triggers the reason, leaving every other axis clean. That isolates the
 * reason under test from incidental hits on a different axis — a
 * regression in any single reason is caught here, not masked by an
 * earlier rule firing first.
 */
const DEFAULT_CHUNK = "alice chen works for acme corp in beijing.";

function makeTriple(
  overrides: Partial<ExtractionOutput> = {}
): ExtractionOutput {
  return {
    head: "alice chen",
    headType: "person",
    relationRaw: "works for",
    relationNorm: "works_for",
    tail: "acme corp",
    tailType: "organization",
    description: "alice is employed by acme.",
    evidenceSpan: "alice chen works for acme corp",
    confidence: 0.9,
    ...overrides,
  };
}

function isReject(
  result: ReturnType<typeof filterTriple>
): asserts result is { accept: false; reason: RejectReason } {
  if (result.accept) {
    throw new Error(
      `expected reject, got accept (triple=${JSON.stringify(result)})`
    );
  }
}

describe("filterTriple — accept path (SC10)", () => {
  it("accepts a clean, normalized, grounded, non-negated triple", () => {
    const triple = makeTriple();

    const result = filterTriple(triple, DEFAULT_CHUNK);

    expect(result).toEqual({ accept: true });
  });

  it("accepts when the evidence span is a literal substring of the chunk", () => {
    const chunk =
      "bob founded beta labs. bob founded beta labs in 2018. he is ceo there.";
    const triple = makeTriple({
      head: "bob",
      relationNorm: "owns",
      tail: "beta labs",
      evidenceSpan: "bob founded beta labs",
      description: "bob is the founder.",
    });

    const result = filterTriple(triple, chunk);

    expect(result.accept).toBe(true);
  });
});

describe("filterTriple — no-grounding reject (SC10)", () => {
  it("rejects when the evidence span is not a substring of the chunk text", () => {
    const triple = makeTriple({
      evidenceSpan: "alice chen reports to the ceo of acme corp",
    });

    const result = filterTriple(triple, DEFAULT_CHUNK);

    isReject(result);
    expect(result.reason).toBe("no-grounding");
  });

  it("rejects with no-grounding when the chunk text is empty (boundary class empty)", () => {
    const triple = makeTriple();

    const result = filterTriple(triple, "");

    isReject(result);
    expect(result.reason).toBe("no-grounding");
  });

  it("rejects with no-grounding when the evidence span is empty", () => {
    const triple = makeTriple({ evidenceSpan: "" });

    const result = filterTriple(triple, DEFAULT_CHUNK);

    isReject(result);
    expect(result.reason).toBe("no-grounding");
  });

  it("checks grounding order — surfaces hallucination before vocabulary issues", () => {
    const triple = makeTriple({
      relationNorm: "UNMAPPED",
      evidenceSpan: "fabricated evidence not in chunk",
    });

    const result = filterTriple(triple, DEFAULT_CHUNK);

    isReject(result);
    // Spec ordering: no-grounding is checked first so a fabricated
    // evidence span is reported as hallucination, not as a vocabulary
    // issue.
    expect(result.reason).toBe("no-grounding");
  });
});

describe("filterTriple — relation-not-norm reject (SC10)", () => {
  it("rejects when relationNorm equals the UNMAPPED sentinel", () => {
    const triple = makeTriple({ relationNorm: "UNMAPPED" });

    const result = filterTriple(triple, DEFAULT_CHUNK);

    isReject(result);
    expect(result.reason).toBe("relation-not-norm");
  });

  it("rejects when relationNorm is a free-form string not in ALLOWED", () => {
    const triple = makeTriple({ relationNorm: "employs_but_casually" });

    const result = filterTriple(triple, DEFAULT_CHUNK);

    isReject(result);
    expect(result.reason).toBe("relation-not-norm");
  });

  it("accepts every vocabulary term (sanity check on ALLOWED import)", () => {
    const allowed = [
      "related_to",
      "part_of",
      "located_in",
      "caused",
      "mentions",
      "supersedes",
    ];
    for (const relationNorm of allowed) {
      const triple = makeTriple({
        relationNorm,
        head: "x",
        tail: "y",
        evidenceSpan: "x mentions y in passing",
        description: "x and y are discussed together",
      });
      const chunk = "x mentions y in passing; nothing else here.";

      const result = filterTriple(triple, chunk);

      expect(result.accept).toBe(true);
    }
  });
});

describe("filterTriple — entity-not-normalized reject (SC10)", () => {
  it("rejects a head whose normalized form differs from itself (extra whitespace)", () => {
    const triple = makeTriple({
      head: "  alice  chen  ",
    });

    const result = filterTriple(triple, DEFAULT_CHUNK);

    isReject(result);
    expect(result.reason).toBe("entity-not-normalized");
  });

  it("rejects a tail with mixed case that normalizeAlias would fold", () => {
    const triple = makeTriple({
      tail: "ACME  corp",
    });

    const result = filterTriple(triple, DEFAULT_CHUNK);

    isReject(result);
    expect(result.reason).toBe("entity-not-normalized");
  });

  it("rejects a blank head as entity-not-normalized", () => {
    const triple = makeTriple({ head: "" });

    const result = filterTriple(triple, DEFAULT_CHUNK);

    isReject(result);
    expect(result.reason).toBe("entity-not-normalized");
  });

  it("rejects a whitespace-only tail as entity-not-normalized", () => {
    const triple = makeTriple({ tail: "   " });

    const result = filterTriple(triple, DEFAULT_CHUNK);

    isReject(result);
    expect(result.reason).toBe("entity-not-normalized");
  });
});

describe("filterTriple — negated reject (SC10)", () => {
  it("rejects when the description contains the 'not' cue", () => {
    const triple = makeTriple({
      description: "alice is not employed by acme.",
    });

    const result = filterTriple(triple, DEFAULT_CHUNK);

    isReject(result);
    expect(result.reason).toBe("negated");
  });

  it("rejects when the evidence span contains the 'never' cue", () => {
    // The evidence span must be a substring of the chunk so grounding
    // passes and the negation cue is what surfaces the reject — not the
    // earlier no-grounding branch.
    const chunk = "alice chen never worked for acme corp in beijing.";
    const triple = makeTriple({
      evidenceSpan: "alice chen never worked for acme corp",
    });

    const result = filterTriple(triple, chunk);

    isReject(result);
    expect(result.reason).toBe("negated");
  });

  it("rejects when the description contains the contracted n't cue", () => {
    const triple = makeTriple({
      description: "alice doesn't work for acme.",
    });

    const result = filterTriple(triple, DEFAULT_CHUNK);

    isReject(result);
    expect(result.reason).toBe("negated");
  });

  it("rejects when the description contains the 'no' cue as a standalone word", () => {
    const triple = makeTriple({
      description: "there is no relation between alice and acme.",
    });

    const result = filterTriple(triple, DEFAULT_CHUNK);

    isReject(result);
    expect(result.reason).toBe("negated");
  });

  it("accepts a description with the substring 'not' embedded in a normalized entity name", () => {
    // "no" appears inside the head "northwest corp" but the regex uses
    // \b word-boundaries, so the cue must not trip. Same-shape test as
    // the others: only the head changes, so a regression that fires
    // negation from a head substring would surface here.
    const triple = makeTriple({
      head: "northwest corp",
      tail: "acme corp",
      description: "northwest corp and acme corp are discussed together.",
      evidenceSpan: "alice chen works for acme corp",
    });

    const result = filterTriple(triple, DEFAULT_CHUNK);

    expect(result.accept).toBe(true);
  });
});

describe("filterTriple — malformed input (boundary class negative)", () => {
  it("throws FilterError when relationNorm is not a string", () => {
    const triple = makeTriple({ relationNorm: 42 as unknown as string });

    expect(() => filterTriple(triple, "any chunk")).toThrow(FilterError);
  });

  it("throws FilterError when confidence is not a number", () => {
    const triple = makeTriple({ confidence: "0.9" as unknown as number });

    expect(() => filterTriple(triple, "any chunk")).toThrow(FilterError);
  });

  it("does NOT throw when relationNorm is a blank string — typed reject only on known shape violations", () => {
    // Empty relationNorm (a string) is a shape the filter can answer
    // about: it's not in ALLOWED, so the typed reject is relation-not-norm,
    // not a thrown FilterError.
    const triple = makeTriple({ relationNorm: "" });

    const result = filterTriple(triple, DEFAULT_CHUNK);

    isReject(result);
    expect(result.reason).toBe("relation-not-norm");
  });
});

describe("filterTriple — purity (A4)", () => {
  it("returns identical results across repeated calls with the same input", () => {
    const triple = makeTriple();

    const first = filterTriple(triple, DEFAULT_CHUNK);
    const second = filterTriple(triple, DEFAULT_CHUNK);

    expect(second).toEqual(first);
  });

  it("does not depend on chunkText identity — only on its contents", () => {
    const triple = makeTriple();
    const a = filterTriple(
      triple,
      "alice chen works for acme corp in beijing."
    );
    const b = filterTriple(
      triple,
      "alice chen works for acme corp in beijing."
    );

    expect(a).toEqual(b);
  });
});

describe("filter module — vocabulary SSOT guard (SC10)", () => {
  /**
   * SC10 forbids a hard-coded copy of ALLOWED inside the filter module.
   * The vocabulary SSOT lives at `src/core/extraction/vocabulary.ts`
   * and must be the only place ALLOWED is defined. Any regression that
   * re-inlines the list here breaks the rule that gold, filter, and
   * extract answer to the same closed relation set.
   */
  it("does not declare its own ALLOWED array or const ALLOWED", () => {
    const source = readFileSync(FILTER_MODULE_PATH, "utf8");
    const lines = source.split("\n");

    const offenders: string[] = [];
    for (const line of lines) {
      const stripped = line.replace(/\/\/.*$/, "");
      // Forbid `const ALLOWED`, `let ALLOWED`, `var ALLOWED`,
      // and the inline `ALLOWED: readonly string[] = [...]` shape.
      if (/\b(?:const|let|var)\s+ALLOWED\b/.test(stripped)) {
        offenders.push(line);
      }
      if (/ALLOWED\s*:\s*readonly\s+string\[\]\s*=\s*\[/.test(stripped)) {
        offenders.push(line);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("imports ALLOWED from the extraction vocabulary module", () => {
    const source = readFileSync(FILTER_MODULE_PATH, "utf8");
    expect(source).toMatch(
      /import\s*\{[^}]*\bALLOWED\b[^}]*\}\s*from\s*["'][^"']*vocabulary\.js["']/
    );
  });

  it("imports normalizeAlias from the entity merge module (entity-not-normalized uses it)", () => {
    const source = readFileSync(FILTER_MODULE_PATH, "utf8");
    expect(source).toMatch(
      /import\s*\{[^}]*\bnormalizeAlias\b[^}]*\}\s*from\s*["'][^"']*entities\/merge\.js["']/
    );
  });
});

describe("filter module — config injection", () => {
  it("honors a custom negation-cue list when supplied", () => {
    const triple = makeTriple({
      description: "alice is not at acme corp.",
    });

    const result = filterTriple(triple, DEFAULT_CHUNK, {
      negationCues: [/\bnot\b/],
    });

    isReject(result);
    expect(result.reason).toBe("negated");
  });
});
