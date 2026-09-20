import { describe, expect, it } from "vitest";
import { inkForType, INK_ACTOR, INK_ARTIFACT } from "./graphInk";

describe("graphInk — Variant D two-ink rule over the closed type set", () => {
  it("maps the actor types person/organization to actor ink", () => {
    expect(inkForType("person")).toBe(INK_ACTOR);
    expect(inkForType("organization")).toBe(INK_ACTOR);
  });

  it("maps the artifact types place/event to artifact ink", () => {
    expect(inkForType("place")).toBe(INK_ARTIFACT);
    expect(inkForType("event")).toBe(INK_ARTIFACT);
  });

  // entity-type-and-filter review C2: the schema bootstrap hard-deleted every
  // non-closed-set row and the CHECK rejects new ones, so a pre-migration
  // value can no longer reach the display layer. There is deliberately NO
  // third "historical" ink/legend — an unknown value only reuses an existing
  // default as a defensive fallback, without introducing a display concept.
  it("folds unknown/missing values into the existing artifact default (no third ink)", () => {
    expect(inkForType("concept")).toBe(INK_ARTIFACT);
    expect(inkForType("system")).toBe(INK_ARTIFACT);
    expect(inkForType("wiki")).toBe(INK_ARTIFACT);
    expect(inkForType(undefined)).toBe(INK_ARTIFACT);
  });

  it("gives the four closed types exactly the two legend inks", () => {
    const inks = ["person", "organization", "place", "event"].map(inkForType);
    expect(inks[0]).toBe(inks[1]); // person/organization → actor
    expect(inks[2]).toBe(inks[3]); // place/event → artifact
    expect(inks).toEqual([INK_ACTOR, INK_ACTOR, INK_ARTIFACT, INK_ARTIFACT]);
  });
});
