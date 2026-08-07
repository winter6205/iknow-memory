/**
 * Schema-guided extraction prompt builder.
 *
 * Builds the prompt the LLM client sends to the model. The schema is the
 * single contract with the LLM; the parser (T4) and the JSON validator
 * (T2) must both honor it. description and evidenceSpan are MANDATORY
 * per #6 Q1(b) and spec §Code Style — the LLM is told this twice for
 * emphasis.
 *
 * Type alias ExtractionOutput is declared here in sync with the canonical
 * shape in src/core/extraction/types.ts (T2 ticket). When T2 lands, this
 * local declaration can be replaced with `import type { ExtractionOutput }
 * from "./types.js"`.
 */
import { PROMPT_HINT } from "./vocabulary.js";

/**
 * Local mirror of the canonical ExtractionOutput shape (T2 owns the
 * authoritative type). Keeping the shape in sync is a T3 contract; the
 * LLMClient.validate step on the parse side will enforce it.
 */
export interface ExtractionOutput {
  head: string;
  headType: string;
  relationRaw: string;
  relationNorm: string; // may equal "UNMAPPED"
  tail: string;
  tailType: string;
  description: string; // MANDATORY
  evidenceSpan: string; // MANDATORY
  confidence: number; // [0,1]
}

/**
 * Build a schema-guided prompt for triple extraction from one chunk.
 *
 * Sections:
 * 1. Role + task.
 * 2. Vocabulary (ALLOWED relation_norm terms).
 * 3. JSON output schema (ExtractionOutput[], MANDATORY fields called out).
 * 4. Chunk content.
 *
 * Returns a single string suitable for LLMClient.extract(chunkText) input.
 */
export function buildExtractionPrompt(chunkText: string): string {
  return [
    "You are an information-extraction assistant. Read the chunk and extract a",
    "set of typed relations between entities. Use ONLY the allowed relation",
    "terms listed below for the relation_norm field. Return raw JSON, no",
    "markdown wrapping.",
    "",
    "Allowed relation_norm terms:",
    PROMPT_HINT,
    "",
    "Output schema (return this exact JSON shape, nothing else):",
    "{",
    '  "outputs": ExtractionOutput[]',
    "}",
    "where each ExtractionOutput has these fields:",
    "  - head: string (entity mention)",
    "  - headType: string (entity type, one of: person, concept, system, event)",
    "  - relationRaw: string (the surface form you used in the text)",
    '  - relationNorm: string (one of the allowed terms, or "UNMAPPED")',
    "  - tail: string (entity mention)",
    "  - tailType: string (entity type, one of: person, concept, system, event)",
    "  - description: string  // MANDATORY, non-empty",
    "  - evidenceSpan: string  // MANDATORY, verbatim substring of the chunk",
    "  - confidence: number  // in [0, 1]",
    "",
    "MANDATORY: every output must include a non-empty description AND a",
    "verbatim evidenceSpan. Outputs missing either field are invalid.",
    "",
    "Return raw JSON only. Do not wrap in markdown fences.",
    "",
    "Chunk:",
    chunkText,
  ].join("\n");
}
