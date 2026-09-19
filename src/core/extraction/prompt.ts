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

// ─── T3 (graph-index-standard-fast): standard post-merge enrichment ──────

/**
 * Build the describe prompt for ONE batched call covering every merge
 * survivor of a chunk (ADR 0069). Each entity arrives with its merged
 * description list; the model returns one consolidated description per
 * entity. Entities the model cannot summarize are omitted from the response
 * — a miss skips that description, it never fails the run.
 */
export function buildDescribePrompt(
  entities: readonly { canonicalName: string; descriptions: readonly string[] }[]
): string {
  const blocks = entities.map(
    (e) =>
      `Entity: ${e.canonicalName}\n` +
      e.descriptions.map((d) => `  - ${d}`).join("\n")
  );
  return [
    "You consolidate extracted knowledge descriptions into one entity description.",
    "For each entity below, merge its description list into ONE concise",
    "description (1-2 sentences) that preserves every distinct fact. Use the",
    "same language as the descriptions.",
    "",
    "Entities:",
    ...(blocks.length > 0 ? blocks : ["(none)"]),
    "",
    "Output schema (return this exact JSON shape, nothing else):",
    "{",
    '  "descriptions": [ { "entity": string, "description": string } ]',
    "}",
    'The "entity" value must repeat the entity name exactly as listed.',
    "Omit an entity you cannot summarize — never invent facts the",
    "descriptions do not carry.",
    "",
    "Return raw JSON only. Do not wrap in markdown fences.",
  ].join("\n");
}

/**
 * Build the claims prompt for one chunk (ADR 0071): time-bounded factual
 * assertions about the given survivor entities, grounded in the chunk text.
 * `validFrom` / `validTo` carry ISO-8601 dates when the text states a
 * bound, otherwise null (open-ended window).
 */
export function buildClaimsPrompt(
  chunkText: string,
  entityNames: readonly string[]
): string {
  return [
    "You extract time-bounded claims about the listed entities from the chunk.",
    "A claim is one atomic assertion that could later be contradicted or",
    "retired; not a triple relation, not an opinion.",
    "",
    "Entities (a claim must be about exactly one of them, by this name):",
    ...(entityNames.length > 0
      ? entityNames.map((n) => `- ${n}`)
      : ["(none — return an empty list)"]),
    "",
    "Output schema (return this exact JSON shape, nothing else):",
    "{",
    '  "claims": [ { "entity": string, "claim": string,',
    '    "validFrom": string|null, "validTo": string|null,',
    '    "confidence": number, "evidenceSpan": string } ]',
    "}",
    "validFrom / validTo: ISO-8601 dates when the chunk states a bound,",
    "otherwise null. confidence in [0, 1]. evidenceSpan: a short verbatim",
    "substring of the chunk backing the claim (empty string when none).",
    "",
    "Return raw JSON only. Do not wrap in markdown fences.",
    "",
    "Chunk:",
    chunkText,
  ].join("\n");
}
