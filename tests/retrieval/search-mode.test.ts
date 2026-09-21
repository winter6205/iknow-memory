/**
 * search-mode unit tests (plans/search-mode-retrieve.md T1).
 *
 * Pins the three contracts the seam owns:
 *   1. the closed set A|graph|global|D — missing key resolves to `graph`,
 *      anything else is an INVALID (never a silent fallback);
 *   2. `search_mode` is a routing control and must be stripped before the
 *      filters reach exact-match backends (the ES precision layer turns every
 *      filter key into a term clause, so an unstripped key would silently
 *      zero the lexical arm);
 *   3. the dispatch table exists for all four modes: `graph` is the
 *      graph-priority assembler, A the lexical child→parent arm, `global`
 *      the report-first arm, D the typed unwired refusal (the closed 档 whose
 *      product fact is `real_db_not_wired`, never a provisional `graph`
 *      answer);
 *   4. the retired letters `B`/`C` resolve to their lasting token instead of
 *      becoming extra dispatch rows, so a host mid-migration keeps answering
 *      (specs/search-mode-graph-global.md confirmed assumption 2).
 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_SEARCH_MODE,
  INVALID_SEARCH_MODE_REASON,
  REAL_DB_NOT_WIRED_REASON,
  SEARCH_MODES,
  SEARCH_MODE_ALIASES,
  SEARCH_MODE_ARMS,
  SEARCH_MODE_FILTER_KEY,
  SEARCH_MODE_WIRE_COPY,
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
  it("names the closed set exactly, so the wire has one authoritative token list", () => {
    expect([...SEARCH_MODES]).toEqual(["A", "graph", "global", "D"]);
  });

  it("defaults to graph when filters are absent", () => {
    expect(parseSearchMode(undefined)).toEqual({
      kind: "resolved",
      mode: "graph",
    });
  });

  it("defaults to graph when the search_mode key is absent", () => {
    expect(parseSearchMode({ source_ref: "docs/a.md" })).toEqual({
      kind: "resolved",
      mode: "graph",
    });
  });

  it("reports the lasting default token, not the retired letter it replaced", () => {
    expect(DEFAULT_SEARCH_MODE).toBe("graph");
    expect(SEARCH_MODES).toContain(DEFAULT_SEARCH_MODE);
  });

  it("resolves each member of the closed set", () => {
    for (const mode of SEARCH_MODES) {
      expect(parseSearchMode({ search_mode: mode })).toEqual({
        kind: "resolved",
        mode,
      });
    }
  });

  it("accepts B and C as aliases and reports the lasting token", () => {
    // The retired letters stay routable only while hosts migrate; what
    // downstream sees is always the lasting token, never the letter.
    expect(parseSearchMode({ search_mode: "B" })).toEqual({
      kind: "resolved",
      mode: "graph",
    });
    expect(parseSearchMode({ search_mode: "C" })).toEqual({
      kind: "resolved",
      mode: "global",
    });
  });

  it("derives the alias targets from the lasting closed set", () => {
    for (const [letter, mode] of Object.entries(SEARCH_MODE_ALIASES)) {
      expect(SEARCH_MODES).toContain(mode);
      expect(letter).not.toBe(mode);
    }
  });

  it("reports invalid for a value outside the closed set and outside the aliases", () => {
    for (const bad of [
      "E",
      "b",
      "",
      "  ",
      "A ",
      "local",
      "Graph",
      "Global",
      "graph ",
      "B ",
    ]) {
      expect(parseSearchMode({ search_mode: bad })).toEqual({
        kind: "invalid",
        value: bad,
      });
    }
  });

  it("reports invalid for an object-inherited key name, not an alias hit", () => {
    // Alias lookup on a plain object literal would otherwise resolve
    // inherited members like `toString` to a non-token value.
    for (const bad of ["toString", "constructor", "__proto__"]) {
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
    expect(
      stripSearchModeFilter({ search_mode: "global", source_ref: "docs/a.md" })
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

describe("SEARCH_MODE_WIRE_COPY", () => {
  it("reads as the closed set first, then every alias pair", () => {
    // One derived sentence feeds both the tool description and the refusal
    // (review M1), so IT has to carry the whole contract a host needs: the
    // lasting tokens and each retired letter mapped to its target.
    expect(SEARCH_MODE_WIRE_COPY).toContain(SEARCH_MODES.join(" | "));
    const setAt = SEARCH_MODE_WIRE_COPY.indexOf(SEARCH_MODES.join(" | "));
    for (const [letter, mode] of Object.entries(SEARCH_MODE_ALIASES)) {
      const pair = `${letter}=${mode}`;
      expect(SEARCH_MODE_WIRE_COPY).toContain(pair);
      // Set first, aliases after — the copy must not bury the lasting tokens.
      expect(SEARCH_MODE_WIRE_COPY.indexOf(pair)).toBeGreaterThan(setAt);
    }
    expect(SEARCH_MODE_WIRE_COPY).toMatch(/alias/i);
  });
});

describe("invalidSearchModeMessage", () => {
  it("carries the stable reason token, the closed set and the offending value", () => {
    const message = invalidSearchModeMessage("E");
    expect(message).toContain(INVALID_SEARCH_MODE_REASON);
    expect(message).toContain(SEARCH_MODES.join(" | "));
    expect(message).toContain("E");
  });

  it("points at the alias targets so a migrating host learns the new token", () => {
    const message = invalidSearchModeMessage("local");
    for (const [letter, mode] of Object.entries(SEARCH_MODE_ALIASES)) {
      expect(message).toContain(`${letter}=${mode}`);
    }
  });
});

describe("SEARCH_MODE_ARMS dispatch table", () => {
  it("has one row per closed-set token and no row for an alias", () => {
    // `B`/`C` normalize in parseSearchMode; a second row per letter would
    // let the aliases drift away from the arm they are supposed to share.
    expect(Object.keys(SEARCH_MODE_ARMS).sort()).toEqual(
      [...SEARCH_MODES].sort()
    );
    expect(SEARCH_MODE_ARMS).not.toHaveProperty("B");
    expect(SEARCH_MODE_ARMS).not.toHaveProperty("C");
  });

  it("routes A to the mode-A arm (child lexical → parent body)", () => {
    expect(SEARCH_MODE_ARMS.A).toBe(modeAParentWindowArm);
    expect(SEARCH_MODE_ARMS.A).not.toBe(assembleRetrievalResult);
  });

  it("routes global to the report-first arm (ES ∥ summary vectors, ADR-0070)", () => {
    expect(SEARCH_MODE_ARMS.global).toBe(modeCReportFirstArm);
    expect(SEARCH_MODE_ARMS.global).not.toBe(assembleRetrievalResult);
  });

  it("routes D to the typed unwired refusal (not a provisional graph answer)", () => {
    // D is a closed 档 whose product fact is 真库未接 — answering it through
    // the graph assembler would pretend the SQL path exists.
    expect(SEARCH_MODE_ARMS.D).not.toBe(assembleRetrievalResult);
  });

  it("routes graph to the graph-priority assembler", () => {
    expect(SEARCH_MODE_ARMS.graph).toBe(assembleRetrievalResult);
  });
});

describe("realDbNotWiredMessage", () => {
  it("carries the stable token, the routing key and the 档 letter", () => {
    const message = realDbNotWiredMessage();
    expect(message).toContain(REAL_DB_NOT_WIRED_REASON);
    expect(message).toContain(SEARCH_MODE_FILTER_KEY);
    expect(message).toContain("D");
  });

  it("names the lasting token for the document tables, not a retired letter", () => {
    const message = realDbNotWiredMessage();
    expect(message).toContain("graph");
    expect(message).not.toMatch(/档 B\b/);
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
