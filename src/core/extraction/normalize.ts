/**
 * Relation normalization cascade (#4 D5).
 *
 * Order:
 * 1. Exact match against ALLOWED (case-insensitive, trimmed).
 * 2. Exact match of raw.toLowerCase() against ALIASES keys.
 * 3. Embedding cosine vs every ALLOWED term; return the best match iff >= threshold.
 * 4. Otherwise: UNMAPPED sentinel.
 *
 * Why a cascade (vs. one big classifier): each leg has a different cost/false-positive
 * profile. Exact + synonym are O(1) and deterministic; embedding is O(N * dim) and
 * fuzzy. The strict earlier legs guarantee stable keys for the common case; the
 * embedding leg is the fallback for LLM surface-form drift.
 */
import { cosineSimilarity } from "../cosine.js";
import type { EmbeddingClient } from "../embedder.js";
import { ALLOWED, ALIASES, UNMAPPED } from "./vocabulary.js";

export { UNMAPPED };

/** Default cosine floor for the embedding leg. Tested across .6 / .7 / .8. */
export const DEFAULT_THRESHOLD = 0.7;

export interface NormalizeContext {
  embedder?: EmbeddingClient;
  threshold?: number;
}

/**
 * Resolve a raw relation surface form to a vocabulary term.
 *
 * Returns a member of ALLOWED or the UNMAPPED sentinel. Never throws.
 */
export async function normalizeRelation(
  raw: string,
  ctx: NormalizeContext
): Promise<string> {
  // Leg 1: case-insensitive exact match against ALLOWED.
  const trimmed = raw.trim().toLowerCase();
  for (const term of ALLOWED) {
    if (term === trimmed) return term;
  }

  // Leg 2: synonym table.
  const aliased = ALIASES[trimmed];
  if (aliased !== undefined) return aliased;

  // Leg 3: embedding cosine, gated on both embedder and threshold.
  if (ctx.embedder !== undefined && ctx.threshold !== undefined) {
    const hit = await embedBestMatch(trimmed, ctx.embedder, ctx.threshold);
    if (hit !== null) return hit;
  }

  // Leg 4: sentinel.
  return UNMAPPED;
}

async function embedBestMatch(
  raw: string,
  embedder: EmbeddingClient,
  threshold: number
): Promise<string | null> {
  const [queryVec, allowedVecs] = await embedBatch(embedder, raw);
  let bestTerm: string | null = null;
  let bestScore = threshold;
  for (let i = 0; i < ALLOWED.length; i += 1) {
    const score = cosineSimilarity(queryVec, allowedVecs[i]!);
    if (score >= bestScore) {
      bestScore = score;
      bestTerm = ALLOWED[i]!;
    }
  }
  return bestTerm;
}

async function embedBatch(
  embedder: EmbeddingClient,
  raw: string
): Promise<[number[], number[][]]> {
  const inputs = [raw, ...ALLOWED];
  const vectors = await embedder.embed(inputs);
  const query = vectors[0]!;
  const allowedVecs = vectors.slice(1, ALLOWED.length + 1);
  return [query, allowedVecs];
}
