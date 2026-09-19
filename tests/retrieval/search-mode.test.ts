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
 *   3. the dispatch table exists for all four modes: B implemented, A
 *      opened by T2 on its own lexical child→parent arm, C opened by T3 on
 *      its report-first arm, D opened by T4 as the typed unwired refusal
 *      (the closed 档 whose product fact is `real_db_not_wired`, never a
 *      provisional B answer).
 */
import { describe, it, expect } from "vitest";
import {
  INVALID_SEARCH_MODE_REASON,
  REAL_DB_NOT_WIRED_REASON,
  SEARCH_MODES,
  SEARCH_MODE_ARMS,
  SEARCH_MODE_FILTER_KEY,
  parseSearchMode,
  stripSearchModeFilter,
  invalidSearchModeMessage,
  realDbNotWiredMessage,
  C_DROP_WINDOWS_FILTER_KEY,
  cDropWindowsEnabled,
  stripCDropWindowsFilter,
} from "../../src/core/retrieval/search-mode.js";
import { assembleRetrievalResult } from "../../src/core/retrieval/index.js";
import { modeAParentWindowArm } from "../../src/core/retrieval/mode-a-arm.js";
import { modeCReportFirstArm } from "../../src/core/retrieval/mode-c-arm.js";

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
  it("routes A to the mode-A arm opened by plans T2 (child lexical → parent body)", () => {
    // The T2 swap: exactly this row moved off the provisional alias.
    expect(SEARCH_MODE_ARMS.A).toBe(modeAParentWindowArm);
    expect(SEARCH_MODE_ARMS.A).not.toBe(assembleRetrievalResult);
  });

  it("routes C to the report-first arm opened by plans T3 (ES ∥ summary vectors, ADR-0070)", () => {
    // The T3 swap: exactly this row moved off the provisional alias.
    expect(SEARCH_MODE_ARMS.C).toBe(modeCReportFirstArm);
    expect(SEARCH_MODE_ARMS.C).not.toBe(assembleRetrievalResult);
  });

  it("routes D to the typed unwired refusal opened by plans T4 (not a provisional B answer)", () => {
    // The T4 swap: exactly this row moved off the provisional alias. D is
    // a closed 档 whose product fact is 真库未接 — answering it through B
    // would pretend the SQL path exists.
    expect(SEARCH_MODE_ARMS.D).not.toBe(assembleRetrievalResult);
  });

  it("keeps B on the graph-priority assembler", () => {
    expect(SEARCH_MODE_ARMS.B).toBe(assembleRetrievalResult);
  });
});

describe("realDbNotWiredMessage", () => {
  it("carries the stable token, the routing key and the 档 letter", () => {
    const message = realDbNotWiredMessage();
    expect(message).toContain(REAL_DB_NOT_WIRED_REASON);
    expect(message).toContain(SEARCH_MODE_FILTER_KEY);
    expect(message).toContain("D");
  });
});

describe("c_drop_windows routing key (T3)", () => {
  it("defaults the drop ON when the key is absent", () => {
    expect(cDropWindowsEnabled(undefined)).toBe(true);
    expect(cDropWindowsEnabled({ source_ref: "docs/a.md" })).toBe(true);
  });

  it("switches the drop off only on the exact \"0\" value", () => {
    expect(cDropWindowsEnabled({ [C_DROP_WINDOWS_FILTER_KEY]: "0" })).toBe(
      false
    );
    // Anything else (including "false" or "") stays on the default side:
    // the wire pins exactly one off-value.
    for (const value of ["1", "false", "", "off"]) {
      expect(cDropWindowsEnabled({ [C_DROP_WINDOWS_FILTER_KEY]: value })).toBe(
        true
      );
    }
  });

  it("strips only c_drop_windows and yields undefined when it was the only key", () => {
    expect(
      stripCDropWindowsFilter({
        c_drop_windows: "0",
        source_ref: "docs/a.md",
      })
    ).toEqual({ source_ref: "docs/a.md" });
    expect(
      stripCDropWindowsFilter({ c_drop_windows: "1" })
    ).toBeUndefined();
  });

  it("passes filters without the key through unchanged and never mutates", () => {
    const untouched = { source_ref: "docs/a.md" };
    expect(stripCDropWindowsFilter(untouched)).toBe(untouched);
    expect(stripCDropWindowsFilter(undefined)).toBeUndefined();
    const withKey = { c_drop_windows: "0", source_ref: "docs/a.md" };
    stripCDropWindowsFilter(withKey);
    expect(withKey).toEqual({ c_drop_windows: "0", source_ref: "docs/a.md" });
  });
});
