/**
 * Unit tests for `normalizeEntityType` (entity-type-and-filter T1).
 *
 * The DDL pins `entities.type` to the closed 4-value CHECK set
 * (person/organization/place/event). When the LLM emits an arbitrary type
 * ("Organization", "Location", capitalized variants, unknown), the persist
 * boundary must either map it into the closed set or return null — never a
 * catch-all bucket. A null means "unknown": the caller typed-skips the
 * output so no entity row lands.
 *
 * Coverage: each mapping family (case-insensitive), the organization/place
 * spec mappings, and unknown/empty/legacy-concept/system → null.
 */
import { describe, it, expect } from "vitest";

import {
  ENTITY_TYPES,
  normalizeEntityType,
} from "../../src/core/extraction/entity-type.js";

describe("normalizeEntityType — person family", () => {
  it.each(["person", "human", "individual", "user", "agent"])(
    "maps %s → person",
    (raw) => {
      expect(normalizeEntityType(raw)).toBe("person");
    }
  );
});

describe("normalizeEntityType — organization family", () => {
  it.each(["organization", "company", "org", "team"])(
    "maps %s → organization",
    (raw) => {
      expect(normalizeEntityType(raw)).toBe("organization");
    }
  );
});

describe("normalizeEntityType — place family", () => {
  it.each(["place", "location", "geo"])("maps %s → place", (raw) => {
    expect(normalizeEntityType(raw)).toBe("place");
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

describe("normalizeEntityType — case folding", () => {
  it("folds capitalized / mixed-case variants then maps", () => {
    expect(normalizeEntityType("Organization")).toBe("organization");
    expect(normalizeEntityType("PERSON")).toBe("person");
    expect(normalizeEntityType("Location")).toBe("place");
    expect(normalizeEntityType("  event  ")).toBe("event");
  });
});

describe("normalizeEntityType — unknown returns null (no catch-all)", () => {
  it.each([
    "",
    "  ",
    "widget",
    "place-of-worship",
    "11",
    "concept",
    "system",
    "tool",
    "platform",
    "group",
  ])("maps %j → null", (raw) => {
    expect(normalizeEntityType(raw)).toBeNull();
  });
});

describe("normalizeEntityType — closed set is the four spec types", () => {
  it("ENTITY_TYPES lists exactly person/organization/place/event", () => {
    expect([...ENTITY_TYPES].sort()).toEqual([
      "event",
      "organization",
      "person",
      "place",
    ]);
  });
});

describe("normalizeEntityType — realistic LLM output (CR High #2)", () => {
  it("maps a real-world 'Organization' headType to organization", () => {
    // The exact shape the prompting issue describes: the LLM returning a
    // non-listed, capitalized type that would previously hit the CHECK.
    const headType = "Organization";
    expect(normalizeEntityType(headType)).toBe("organization");
    // And the persisted value is CHECK-safe.
    expect(ENTITY_TYPES).toContain(normalizeEntityType(headType));
  });
});
