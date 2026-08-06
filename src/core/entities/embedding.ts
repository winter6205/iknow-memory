/**
 * Builds the text input that feeds entity embedding (per #6 Q1).
 *
 * canonical_name + " | " + description is the SSOT input shape for the
 * `entities.embedding` column. This module only assembles the string — the
 * actual vector is computed by the injected `Embedder` at merge time so the
 * caller controls batching and dimension.
 */

export function computeEntityEmbeddingText(
  canonicalName: string,
  description: string
): string {
  return `${canonicalName} | ${description}`;
}
