/**
 * Fact supersession candidates for the operator consolidate CLI.
 *
 * A contradiction is represented by two live ledger facts with the same
 * `(head_id, relation_norm)` and different tails whose validity windows
 * overlap. The newest fact wins; the older fact receives a forward
 * `superseded_by` pointer when the operator chooses `--apply`.
 */

export interface FactRow {
  id: string;
  head_id: string;
  tail_id: string;
  relation_norm: string;
  confidence: number;
  valid_from: string | Date;
  valid_until: string | Date | null;
  created_at: string | Date;
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
    const ordered = [...group].sort(compareNewest);
    const winner = ordered[0];
    if (!winner) continue;
    for (const older of ordered.slice(1)) {
      if (older.tail_id === winner.tail_id) continue;
      if (!windowsOverlap(older, winner)) continue;
      candidates.push({ superseded: older, replacement: winner });
    }
  }
  return candidates;
}

function compareNewest(a: FactRow, b: FactRow): number {
  const created = toMillis(b.created_at) - toMillis(a.created_at);
  if (created !== 0) return created;
  const confidence = Number(b.confidence) - Number(a.confidence);
  if (confidence !== 0) return confidence;
  return b.id.localeCompare(a.id);
}

function windowsOverlap(a: FactRow, b: FactRow): boolean {
  const aStart = toMillis(a.valid_from);
  const bStart = toMillis(b.valid_from);
  const aEnd =
    a.valid_until === null ? Number.POSITIVE_INFINITY : toMillis(a.valid_until);
  const bEnd =
    b.valid_until === null ? Number.POSITIVE_INFINITY : toMillis(b.valid_until);
  return Math.max(aStart, bStart) < Math.min(aEnd, bEnd);
}

function toMillis(value: string | Date): number {
  return value instanceof Date ? value.getTime() : Date.parse(value);
}
