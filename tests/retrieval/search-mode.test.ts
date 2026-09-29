/**
 * search-mode unit tests (plans/search-mode-retrieve.md T1).
 *
 * Pins the three contracts the seam owns:
 *   1. the closed set lexical|graph|global|sql — word-form tokens matched
 *      verbatim, missing key resolves to `graph`, anything else (single
 *      letters included) is an INVALID (never a silent fallback);
 *   2. `search_mode` is a routing control and must be stripped before the
 *      filters reach exact-match backends (the ES precision layer turns every
 *      filter key into a term clause, so an unstripped key would silently
 *      zero the lexical arm);
 *   3. the dispatch table exists for all four modes: `graph` is the
 *      graph-priority assembler, `lexical` the child→parent arm, `global`
 *      the report-first arm, `sql` the business-SQL arm (T7: rows answer as
 *      the `database_rows` envelope sibling, and an unprovisioned ledger is
 *      the tokened `real_db_not_wired` refusal, never a provisional
 *      `graph` answer).
 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_SEARCH_MODE,
  INVALID_SEARCH_MODE_REASON,
  REAL_DB_NOT_WIRED_REASON,
  SEARCH_MODES,
  SEARCH_MODE_ARMS,
  SEARCH_MODE_FILTER_KEY,
  SEARCH_MODE_WIRE_COPY,
  parseSearchMode,
  stripSearchModeFilter,
  invalidSearchModeMessage,
  C_DROP_WINDOWS_FILTER_KEY,
  cDropWindowsEnabled,
  stripCDropWindowsFilter,
} from "../../src/core/retrieval/search-mode.js";
import {
  businessLedgerNotProvisionedMessage,
  modeDBusinessSqlArm,
} from "../../src/core/retrieval/mode-d-arm.js";
import { assembleRetrievalResult } from "../../src/core/retrieval/index.js";
import { modeAParentWindowArm } from "../../src/core/retrieval/mode-a-arm.js";
import { modeCReportFirstArm } from "../../src/core/retrieval/mode-c-arm.js";

describe("parseSearchMode", () => {
  it("names the closed set exactly, so the wire has one authoritative token list", () => {
    expect([...SEARCH_MODES]).toEqual(["lexical", "graph", "global", "sql"]);
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

  it("reports the default token, and the default is a member of the set", () => {
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

  it("types every single letter invalid, resolving nothing", () => {
    // The wire is word-form only: no letter, however spelled, may stand in
    // for a token or pick up a route of its own.
    for (const letter of ["A", "B", "C", "D"]) {
      expect(parseSearchMode({ search_mode: letter })).toEqual({
        kind: "invalid",
        value: letter,
      });
    }
  });

  it("matches the tokens verbatim: casing and stray whitespace are invalid", () => {
    for (const bad of [
      "E",
      "b",
      "",
      "  ",
      "local",
      "Graph",
      "Global",
      "Lexical",
      "SQL",
      "graph ",
      " lexical",
    ]) {
      expect(parseSearchMode({ search_mode: bad })).toEqual({
        kind: "invalid",
        value: bad,
      });
    }
  });

  it("reports invalid for an object-inherited key name, not a token hit", () => {
    // Membership is a fixed-list check, so inherited members like
    // `toString` can never be called a 档.
    for (const bad of ["toString", "constructor", "__proto__"]) {
      expect(parseSearchMode({ search_mode: bad })).toEqual({
        kind: "invalid",
        value: bad,
      });
    }
  });

  it("keeps other filter keys untouched (a rejected mode must not look like a parse-side mutation)", () => {
    const filters = { source_ref: "docs/a.md", search_mode: "B" };
    expect(parseSearchMode(filters)).toEqual({ kind: "invalid", value: "B" });
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
      stripSearchModeFilter({ search_mode: "sql", source_ref: "docs/a.md" })
    ).toEqual({ source_ref: "docs/a.md" });
    expect(
      stripSearchModeFilter({ search_mode: "global", source_ref: "docs/a.md" })
    ).toEqual({ source_ref: "docs/a.md" });
  });

  it("yields undefined when search_mode was the only key", () => {
    expect(stripSearchModeFilter({ search_mode: "lexical" })).toBeUndefined();
  });

  it("does not mutate the caller's object", () => {
    const filters = { search_mode: "lexical", source_ref: "docs/a.md" };
    stripSearchModeFilter(filters);
    expect(filters).toEqual({ search_mode: "lexical", source_ref: "docs/a.md" });
  });
});

describe("SEARCH_MODE_WIRE_COPY", () => {
  it("renders exactly the closed set of word-form tokens", () => {
    // One derived sentence feeds both the tool description and the refusal
    // (review M1), so IT has to carry the whole contract a host needs — and
    // nothing else: no letters, no second spelling of any token.
    expect(SEARCH_MODE_WIRE_COPY).toBe(SEARCH_MODES.join(" | "));
    expect(SEARCH_MODE_WIRE_COPY).not.toMatch(/\b[ABCD]\b/);
  });
});

describe("invalidSearchModeMessage", () => {
  it("carries the stable reason token, the closed set and the offending value", () => {
    const message = invalidSearchModeMessage("E");
    expect(message).toContain(INVALID_SEARCH_MODE_REASON);
    expect(message).toContain(SEARCH_MODES.join(" | "));
    expect(message).toContain("E");
  });

  it("names the closed set when a letter arrives, so the host learns the token", () => {
    const message = invalidSearchModeMessage("B");
    expect(message).toContain(INVALID_SEARCH_MODE_REASON);
    for (const mode of SEARCH_MODES) {
      expect(message).toContain(mode);
    }
    expect(message).toContain("B");
  });
});

describe("SEARCH_MODE_ARMS dispatch table", () => {
  it("has one row per wire token and no row for a letter", () => {
    expect(Object.keys(SEARCH_MODE_ARMS).sort()).toEqual(
      [...SEARCH_MODES].sort()
    );
    for (const letter of ["A", "B", "C", "D"]) {
      expect(SEARCH_MODE_ARMS).not.toHaveProperty(letter);
    }
  });

  it("routes lexical to the child→parent arm", () => {
    expect(SEARCH_MODE_ARMS.lexical).toBe(modeAParentWindowArm);
    expect(SEARCH_MODE_ARMS.lexical).not.toBe(assembleRetrievalResult);
  });

  it("routes global to the report-first arm (ES ∥ summary vectors, ADR-0070)", () => {
    expect(SEARCH_MODE_ARMS.global).toBe(modeCReportFirstArm);
    expect(SEARCH_MODE_ARMS.global).not.toBe(assembleRetrievalResult);
  });

  it("routes sql to the business-SQL arm (not a provisional graph answer)", () => {
    // T7 replaced the pre-A2 refusal stub with the real arm: a
    // provisional graph answer would pretend the SQL path runs over
    // document chunks, which the spec forbids.
    expect(SEARCH_MODE_ARMS.sql).toBe(modeDBusinessSqlArm);
    expect(SEARCH_MODE_ARMS.sql).not.toBe(assembleRetrievalResult);
  });

  it("routes graph to the graph-priority assembler", () => {
    expect(SEARCH_MODE_ARMS.graph).toBe(assembleRetrievalResult);
  });
});

describe("businessLedgerNotProvisionedMessage", () => {
  it("carries the stable token, the routing key and the 档 token", () => {
    const message = businessLedgerNotProvisionedMessage();
    expect(message).toContain(REAL_DB_NOT_WIRED_REASON);
    expect(message).toContain(SEARCH_MODE_FILTER_KEY);
    expect(message).toContain("sql");
  });

  it("names the token the document tables stay on", () => {
    expect(businessLedgerNotProvisionedMessage()).toContain("graph");
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
