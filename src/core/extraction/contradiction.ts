/**
 * Pure contradiction semantics — shared between the offline consolidate CLI
 * and the live write path. One definition of "two facts contradict" so a
 * write-time supersede and an offline consolidation cannot drift.
 *
 * The contract is borrowed from the operator CLI's `supersession.ts` and
 * pinned here so neither call site owns the rule. Both surface a
 * `superseded` row and a `replacement` row; the offline CLI's candidate
 * picker and the write path's branch decision consume the same predicate.
 *
 * Deterministic winner: a fact is "newer" than another when its `created_at`
 * is strictly greater; on a tie, the one with the strictly greater
 * `confidence` wins; on a second tie, the one with the lexicographically
 * greater `id` wins. `compareNewest` below is the single implementation of
 * that rule: the offline picker (`supersession.ts`) sorts by it and the
 * write path (`upsertTriple`) folds with it, so no caller re-derives the
 * order.
 */

/**
 * A fact shape both call sites can build: the offline CLI loads it from a
 * SELECT, the write path has the in-memory `TripleInput`. Keeping the type
 * structural means callers do not need to import a class.
 */
export interface ContradictionFact {
  id: string;
  head_id: string;
  tail_id: string;
  relation_norm: string;
  confidence: number;
  /** ISO-8601 string or Date; both normalize to millis. */
  valid_from: string | Date;
  /** ISO-8601 string, Date, or null (null = forever). */
  valid_until: string | Date | null;
  /** ISO-8601 string or Date. */
  created_at: string | Date;
}

/**
 * Two facts contradict iff they share head + relation_norm, name DIFFERENT
 * tails, AND have overlapping validity windows. Same-tail pairs are not
 * contradictions; they are exact-key merges handled by `upsertTriple`.
 *
 * `superseded_by` is intentionally NOT consulted here. The predicate is
 * about content overlap, not ledger state — a row that has already been
 * superseded by a third fact is still a contradiction with a fourth fact
 * that overlaps its window, and the offline CLI runs against a snapshot
 * where the pointer is computed independently. The caller is responsible
 * for skipping already-superseded facts when iterating (the offline CLI
 * already does so in `findSupersessionCandidates`).
 */
export function isContradiction(
  a: ContradictionFact,
  b: ContradictionFact
): boolean {
  if (a.head_id !== b.head_id) return false;
  if (a.relation_norm !== b.relation_norm) return false;
  if (a.tail_id === b.tail_id) return false;
  return windowsOverlap(a, b);
}

/**
 * Newer-wins comparison — the shared source of truth both paths sort by.
 *
 * Returns negative if `a` is newer, positive if `b` is newer, zero on a
 * fully-tied pair (the caller then keeps `a` by stable-sort convention,
 * which both the picker and the write-path fold do the same way).
 */
export function compareNewest(
  a: ContradictionFact,
  b: ContradictionFact
): number {
  const created = toMillis(b.created_at) - toMillis(a.created_at);
  if (created !== 0) return created;
  const confidence = Number(b.confidence) - Number(a.confidence);
  if (confidence !== 0) return confidence;
  return b.id.localeCompare(a.id);
}

/**
 * Pick the winner of two contradicting facts under the deterministic rule.
 * Newest first; the `compareNewest` tie-break favours `b`, so a tie keeps
 * `a` in the caller's iteration order (consistent with the offline CLI).
 */
export function pickWinner(
  a: ContradictionFact,
  b: ContradictionFact
): ContradictionFact {
  return compareNewest(a, b) <= 0 ? a : b;
}

function windowsOverlap(a: ContradictionFact, b: ContradictionFact): boolean {
  const aStart = toMillis(a.valid_from);
  const bStart = toMillis(b.valid_from);
  const aEnd =
    a.valid_until === null ? Number.POSITIVE_INFINITY : toMillis(a.valid_until);
  const bEnd =
    b.valid_until === null ? Number.POSITIVE_INFINITY : toMillis(b.valid_until);
  // Half-open semantics: `[aStart, aEnd)` ∩ `[bStart, bEnd)`.
  // tstzrange uses the same rule on the SQL side.
  return Math.max(aStart, bStart) < Math.min(aEnd, bEnd);
}

function toMillis(value: string | Date): number {
  return value instanceof Date ? value.getTime() : Date.parse(value);
}
