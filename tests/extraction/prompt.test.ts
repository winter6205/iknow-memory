import { describe, it, expect } from "vitest";
import { buildExtractionPrompt } from "../../src/core/extraction/prompt.js";
import { ALLOWED } from "../../src/core/extraction/vocabulary.js";
import { ENTITY_TYPES } from "../../src/core/extraction/entity-type.js";

describe("buildExtractionPrompt", () => {
  it("includes every ALLOWED relation in the vocabulary list", () => {
    const prompt = buildExtractionPrompt("hello world");
    for (const term of ALLOWED) {
      expect(prompt).toContain(term);
    }
  });

  it("states that description and evidenceSpan are MANDATORY", () => {
    const prompt = buildExtractionPrompt("any chunk");
    expect(prompt.toLowerCase()).toContain("mandatory");
    expect(prompt).toContain("description");
    expect(prompt).toContain("evidenceSpan");
  });

  it("references the JSON output schema (ExtractionOutput[] wrapper)", () => {
    const prompt = buildExtractionPrompt("any chunk");
    expect(prompt).toContain("ExtractionOutput");
    expect(prompt).toContain("outputs");
    expect(prompt.toLowerCase()).toContain("json");
  });

  it("embeds the chunk text passed in", () => {
    const chunk = "the quick brown fox jumps over the lazy dog";
    const prompt = buildExtractionPrompt(chunk);
    expect(prompt).toContain(chunk);
  });

  it("instructs the LLM to return raw JSON (no markdown wrapping)", () => {
    const prompt = buildExtractionPrompt("any chunk");
    const lower = prompt.toLowerCase();
    // Both the "raw json" phrasing and an explicit "no markdown" / anti-fence note
    // are acceptable; either demonstrates the instruction is present.
    expect(lower).toMatch(/no markdown|raw json/);
  });

  it("offers exactly the four closed entity types and never teaches concept/system", () => {
    const prompt = buildExtractionPrompt("any chunk");
    const closedList = ENTITY_TYPES.join(", ");
    expect(ENTITY_TYPES).toEqual(["person", "organization", "place", "event"]);
    // Both headType and tailType advertise the same closed set.
    expect(prompt.match(new RegExp(`one of: ${closedList}`, "g"))).toHaveLength(2);
    // The legacy open-set types must not appear anywhere as storable values.
    expect(prompt).not.toMatch(/\bconcept\b/i);
    expect(prompt).not.toMatch(/\bsystem\b/i);
  });
});
