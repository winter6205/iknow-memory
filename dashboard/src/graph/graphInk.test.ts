import { describe, expect, it } from "vitest";
import { inkForType, INK_ACTOR, INK_ARTIFACT } from "./graphInk";

describe("graphInk — Variant D two-ink rule", () => {
  it("maps person and company to actor ink", () => {
    expect(inkForType("person")).toBe(INK_ACTOR);
    expect(inkForType("company")).toBe(INK_ACTOR);
  });

  it("maps project/doc/note/meeting and unknown to artifact ink", () => {
    expect(inkForType("project")).toBe(INK_ARTIFACT);
    expect(inkForType("doc")).toBe(INK_ARTIFACT);
    expect(inkForType("note")).toBe(INK_ARTIFACT);
    expect(inkForType("meeting")).toBe(INK_ARTIFACT);
    expect(inkForType(undefined)).toBe(INK_ARTIFACT);
    expect(inkForType("wiki")).toBe(INK_ARTIFACT);
  });
});
