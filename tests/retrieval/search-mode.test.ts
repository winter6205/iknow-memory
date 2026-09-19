/**
 * search-mode unit tests (plans/search-mode-retrieve.md T1).
 *
 * Pins the three contracts the ticket owns:
 *   1. the closed set A|B|C|D — missing key resolves to B, anything else is
 *      an INVALID (never a silent fallback);
 *   2. `search_mode` is a routing control and must be stripped before the
 *      filters reach exact-match backends (the ES precision layer turns every
 *      filter key into a term clause, so an unstripped key would silently
 *      zero the lexical arm);
 *   3. the dispatch table exists for all four modes: B implemented, A/C/D
 *      still on the provisional graph-priority alias until plans T2/T3/T4
 *      open their rows.
 */
import { describe, it, expect } from "vitest";
import {
  INVALID_SEARCH_MODE_REASON,
  SEARCH_MODES,
  SEARCH_MODE_ARMS,
  parseSearchMode,
  stripSearchModeFilter,
  invalidSearchModeMessage,
} from "../../src/core/retrieval/search-mode.js";
import { assembleRetrievalResult } from "../../src/core/retrieval/index.js";

describe("parseSearchMode", () => {
  it("resolves to B when filters are absent", () => {
    expect(parseSearchMode(undefined)).toEqual({ kind: "resolved", mode: "B" });
  });

  it("resolves to B when the search_mode key is absent", () => {
    expect(
      parseSearchMode({ source_ref: "docs/a.md" })
    ).toEqual({ kind: "resolved", mode: "B" });
  });

  it("resolves each member of the closed set", () => {
    for (const mode of SEARCH_MODES) {
      expect(parseSearchMode({ search_mode: mode })).toEqual({
        kind: "resolved",
        mode,
      });
    }
  });

  it("reports invalid for a value outside the closed set", () => {
    for (const bad of ["E", "b", "", "  ", "A ", "graph"]) {
      expect(parseSearchMode({ search_mode: bad })).toEqual({
        kind: "invalid",
        value: bad,
      });
    }
  });

  it("keeps other filter keys untouched (a rejected mode must not look like a parse-side mutation)", () => {
    const filters = { source_ref: "docs/a.md", search_mode: "E" };
    expect(parseSearchMode(filters)).toEqual({ kind: "invalid", value: "E" });
    expect(filters.source_ref).toBe("docs/a.md");
  });
});

describe("stripSearchModeFilter", () => {
  it("passes undefined through unchanged", () => {
    expect(stripSearchModeFilter(undefined)).toBeUndefined();
  });

  it("returns the same object when no search_mode key exists", () => {
    const filters = { source_ref: "docs/a.md", "metadata.k": "v" };
    expect(stripSearchModeFilter(filters)).toBe(filters);
  });

  it("removes only the search_mode key", () => {
    expect(
      stripSearchModeFilter({ search_mode: "C", source_ref: "docs/a.md" })
    ).toEqual({ source_ref: "docs/a.md" });
  });

  it("yields undefined when search_mode was the only key", () => {
    expect(stripSearchModeFilter({ search_mode: "D" })).toBeUndefined();
  });

  it("does not mutate the caller's object", () => {
    const filters = { search_mode: "A", source_ref: "docs/a.md" };
    stripSearchModeFilter(filters);
    expect(filters).toEqual({ search_mode: "A", source_ref: "docs/a.md" });
  });
});

describe("invalidSearchModeMessage", () => {
  it("carries the stable reason token, the closed set and the offending value", () => {
    const message = invalidSearchModeMessage("E");
    expect(message).toContain(INVALID_SEARCH_MODE_REASON);
    expect(message).toContain(SEARCH_MODES.join(" | "));
    expect(message).toContain("E");
  });
});

describe("SEARCH_MODE_ARMS dispatch table", () => {
  it("routes all four modes through the assembler while A/C/D are provisional (T1)", () => {
    // T1 opens the table only: A/C/D alias the provisional graph-priority
    // arm, which IS the B assembler — byte-for-byte today's behavior.
    // T2 moves A's row, T3 moves C's row, T4 replaces D's row.
    for (const mode of SEARCH_MODES) {
      expect(SEARCH_MODE_ARMS[mode]).toBe(assembleRetrievalResult);
    }
  });

  it("keeps B on the graph-priority assembler", () => {
    expect(SEARCH_MODE_ARMS.B).toBe(assembleRetrievalResult);
  });
});
