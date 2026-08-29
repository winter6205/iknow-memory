/**
 * Relation vocabulary for triple extraction.
 *
 * git-managed module holding the closed set of grammatical relation_norm terms,
 * a synonym map, and the prompt hint used to build extraction prompts.
 *
 * Governance (#4 D7): growth is human-reviewed, not automated. `--list-unmapped`
 * is the review signal that a raw surface form may deserve a new ALLOWED entry.
 *
 * frozen-on: 2026-08-07
 * frozen-by: T3 [impl]
 */

/** Closed set of relation_norm terms. Traversal key for triples. */
export const ALLOWED: readonly string[] = [
  "related_to",
  "part_of",
  "has_part",
  "located_in",
  "located_at",
  "occurred_at",
  "occurred_in",
  // Typed causal edges (SC11).
  "caused",
  "enabled",
  "prevented",
  "caused_by",
  "causes",
  "depends_on",
  "enables",
  "precedes",
  "follows",
  "creates",
  "created_by",
  "uses",
  "used_by",
  "has_role",
  "instance_of",
  "subclass_of",
  "member_of",
  "belongs_to",
  "owns",
  "owned_by",
  "works_for",
  "employed_by",
  "knows",
  "communicates_with",
  "mentions",
  "references",
  "derived_from",
  "supersedes",
  "contradicts",
  "supports",
  "opposes",
  "equivalent_to",
];

/** Surface-form synonyms mapping to ALLOWED entries (cascade leg 2). */
export const ALIASES: Readonly<Record<string, string>> = {
  "is part of": "part_of",
  "works at": "works_for",
  "based in": "located_in",
  "based at": "located_at",
  "happened in": "occurred_in",
  "happened at": "occurred_at",
  "was caused by": "caused_by",
  "responsible for": "causes",
  "leads to": "enables",
  "comes before": "precedes",
  "comes after": "follows",
  "similar to": "related_to",
  "is a": "instance_of",
  "belongs to": "member_of",
  "same as": "equivalent_to",
};

/**
 * Human-readable, comma-separated list of ALLOWED terms for embedding in LLM
 * prompts. Kept in sync with ALLOWED by construction (derived, single source).
 */
export const PROMPT_HINT: string = ALLOWED.join(", ");

/** Legal sentinel for relation_norm when no cascade leg matched. */
export const UNMAPPED = "UNMAPPED";
