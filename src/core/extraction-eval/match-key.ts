/**
 * Micro-F1 match key (specs/p0-eval.md A8).
 *
 * A8 pins the key narrow on purpose: `relation_norm` exactly as the
 * extract cascade produced it (`normalizeRelation`, which the gold
 * loader validates against the shared vocabulary), plus Unicode
 * case-fold and trim on head and tail — and nothing else. No canonical
 * entity merge, no inner-whitespace collapse, no alias table. Every
 * extra leniency here would raise extraction F1 without the extractor
 * getting better.
 */

/** The three fields A8 admits into the key. */
export interface TripleMatchFields {
  head: string;
  relation_norm: string;
  tail: string;
}

/**
 * Control character as the field separator: it cannot occur in a
 * legitimate entity name, so no head or tail can forge another triple's
 * key by containing the delimiter.
 */
const FIELD_SEPARATOR = "\u0001";

/** Case-fold + trim an entity surface form. No other rewriting (A8). */
export function foldEntity(value: string): string {
  return value.trim().toLowerCase();
}

/** Stable equality key for exact-match micro-F1 (A8). */
export function tripleMatchKey(triple: TripleMatchFields): string {
  return [
    foldEntity(triple.head),
    triple.relation_norm,
    foldEntity(triple.tail),
  ].join(FIELD_SEPARATOR);
}
