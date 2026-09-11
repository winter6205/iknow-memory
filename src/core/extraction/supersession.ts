/**
 * Fact supersession candidates for the operator consolidate CLI.
 *
 * A contradiction is represented by two live ledger facts with the same
 * `(head_id, relation_norm)` and different tails whose validity windows
 * overlap. The newest fact wins; the older fact receives a forward
 * `superseded_by` pointer when the operator chooses `--apply`.
 *
 * The contradiction predicate and the newest-wins tie-break live in
 * `contradiction.ts` so the offline CLI and the live write path agree on
 * a single definition. This file owns only the candidate-picker shape
 * (group by (head, relation_norm), drop superseded, propose every older-vs-
 * winner pair).
 */

import {
  compareNewest,
  isContradiction,
  type ContradictionFact,
} from "./contradiction.js";

export interface FactRow extends ContradictionFact {
  superseded_by?: string | null;
}

export interface SupersessionCandidate {
  superseded: FactRow;
  replacement: FactRow;
}

/** Pick deterministic old → new pairs from a ledger snapshot. */
export function findSupersessionCandidates(
  facts: readonly FactRow[]
): SupersessionCandidate[] {
  const groups = new Map<string, FactRow[]>();
  for (const fact of facts) {
    if (fact.superseded_by !== null && fact.superseded_by !== undefined) {
      continue;
    }
    const key = `${fact.head_id}\u0000${fact.relation_norm}`;
    const group = groups.get(key) ?? [];
    group.push(fact);
    groups.set(key, group);
  }

  const candidates: SupersessionCandidate[] = [];
  for (const group of groups.values()) {
    // Newest-first, using the shared comparator — the same rule the write
    // path applies in `upsertTriple`, so both paths pick the same winner on
    // a created_at tie (confidence, then id).
    const ordered = [...group].sort((a, b) => compareNewest(a, b));
    const winner = ordered[0];
    if (!winner) continue;
    for (const older of ordered.slice(1)) {
      // The shared predicate answers "same head + relation + overlapping
      // window + different tail" exactly once across both code paths.
      if (!isContradiction(older, winner)) continue;
      candidates.push({ superseded: older, replacement: winner });
    }
  }
  return candidates;
}
