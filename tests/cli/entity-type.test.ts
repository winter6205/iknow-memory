/**
 * Unit tests for `normalizeEntityType` (CR High #2).
 *
 * The DDL pins `entities.type` to a closed 4-value CHECK set
 * (person/concept/system/event). When the LLM emits an arbitrary type
 * ("Organization", "Location", capitalized variants, unknown), the CLI must
 * map it into the closed set at the boundary — otherwise the INSERT violates
 * the CHECK and the whole chunk transaction rolls back (exit 2).
 *
 * Coverage: each mapping family, case-insensitive folding, and the
 * unknown/empty → "concept" fallback (with an info log).
 */
import { describe, it, expect } from "vitest";

import { normalizeEntityType } from "../../src/core/extraction/entity-type.js";

/** Capture the info-level fallback log so we can assert it fires. */
function captureLogger() {
  const entries: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
  return {
    entries,
    logger: {
      level: "info" as const,
      debug: () => {},
      info: (msg: string, fields?: Record<string, unknown>) => {
        entries.push({ msg, fields });
      },
      warn: () => {},
      error: () => {},
    },
  };
}

describe("normalizeEntityType — person family", () => {
  it.each(["person", "human", "individual", "user", "agent"])(
    "maps %s → person",
    (raw) => {
      expect(normalizeEntityType(raw)).toBe("person");
    }
  );
});

describe("normalizeEntityType — system family", () => {
  it.each([
    "system",
    "tool",
    "platform",
    "service",
    "location",
    "place",
    "system_component",
  ])("maps %s → system", (raw) => {
    expect(normalizeEntityType(raw)).toBe("system");
  });
});

describe("normalizeEntityType — event family", () => {
  it.each(["event", "incident", "occurrence", "action"])(
    "maps %s → event",
    (raw) => {
      expect(normalizeEntityType(raw)).toBe("event");
    }
  );
});

describe("normalizeEntityType — concept family", () => {
  it.each(["organization", "company", "team", "group", "org", "concept"])(
    "maps %s → concept",
    (raw) => {
      expect(normalizeEntityType(raw)).toBe("concept");
    }
  );
});

describe("normalizeEntityType — case folding", () => {
  it("folds capitalized / mixed-case variants then maps", () => {
    expect(normalizeEntityType("Organization")).toBe("concept");
    expect(normalizeEntityType("PERSON")).toBe("person");
    expect(normalizeEntityType("Location")).toBe("system");
    expect(normalizeEntityType("  event  ")).toBe("event");
  });
});

describe("normalizeEntityType — unknown/empty fallback", () => {
  it.each(["", "  ", "widget", "place-of-worship", "11"])(
    "maps %j → concept and logs an info fallback",
    (raw) => {
      const { entries, logger } = captureLogger();
      expect(normalizeEntityType(raw, logger)).toBe("concept");
      expect(entries).toHaveLength(1);
      expect(entries[0]?.msg).toBe("normalize-entity-type-fallback");
      expect(entries[0]?.fields).toMatchObject({ mappedTo: "concept" });
    }
  );

  it("known types do NOT emit a fallback log", () => {
    const { entries, logger } = captureLogger();
    normalizeEntityType("person", logger);
    expect(entries).toHaveLength(0);
  });
});

describe("normalizeEntityType — realistic LLM output (CR High #2)", () => {
  it("maps a real-world 'Organization' headType to concept", () => {
    // The exact shape the prompting issue describes: the LLM returning a
    // non-listed, capitalized type that would previously hit the CHECK.
    const headType = "Organization";
    expect(normalizeEntityType(headType)).toBe("concept");
    // And the persisted value is CHECK-safe.
    expect(["person", "concept", "system", "event"]).toContain(
      normalizeEntityType(headType)
    );
  });
});
