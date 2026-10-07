/**
 * The PostgreSQL half of MP12's serving guard.
 *
 * Two shapes for the same rule, deliberately: a NOT EXISTS predicate the vector
 * query joins on, so a stale row is never materialised, and a read of the
 * lifecycle facts for a candidate set, so a caller holding already-fetched hits
 * can apply the identical rule in memory.
 *
 * The `NOT EXISTS` form is also what will still be correct after MP16 lands a
 * tombstone: a purged source with no version row at all satisfies it, so a
 * deleted identity stops being served without this file changing.
 */
import { decideServingGuard } from "../structured/serving-guard.js";
import type {
  SourceLifecycleFact,
  SourceLifecycleFacts,
  ServingGuardVerdict,
} from "../structured/serving-guard.js";

/** The minimum a client must offer. Not the whole `EvidenceClient`. */
export interface ServingGuardClient {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

/**
 * The predicate `buildVectorSearchQuery` appends.
 *
 * `EXISTS ... payload_collected_at IS NULL` is the whole rule: a source is
 * servable while any of its versions still has an un-collected payload. A source
 * with no version row at all — withdrawn before it was ever registered, or purged
 * after MP16's tombstone — fails the EXISTS and is not served, which is the
 * fail-closed direction.
 *
 * It reads no timestamp and takes no parameter, so it cannot be evaluated
 * against a stale "now": the lifecycle stamps are the fact, not a window.
 */
export const SERVING_GUARD_CLAUSE = `
      AND EXISTS (
        SELECT 1
          FROM source_versions sv
         WHERE sv.source_ref = chunks.source_ref
           AND sv.payload_collected_at IS NULL
      )`;

/**
 * Read the lifecycle facts for a candidate set, in one round trip.
 *
 * Returns `null` — not an empty map — when the read itself fails, because an
 * empty map and an unreadable one mean different things to the guard: the first
 * says every source is dead, the second says nothing is known.
 */
export async function readSourceLifecycleFacts(
  client: ServingGuardClient,
  sourceRefs: readonly string[]
): Promise<SourceLifecycleFacts | null> {
  const distinct = [...new Set(sourceRefs)];
  if (distinct.length === 0) return new Map();

  let rows: Array<Record<string, any>>;
  try {
    const result = await client.query(
      `SELECT sv.source_ref,
              max(sv.retired_at)           AS retired_at,
              bool_or(sv.payload_collected_at IS NULL) AS has_live_version
         FROM source_versions sv
        WHERE sv.source_ref = ANY($1::text[])
        GROUP BY sv.source_ref`,
      [distinct]
    );
    rows = result.rows;
  } catch {
    // The reason is deliberately not propagated: the guard's own refusal names
    // the consequence, and a storage detail here would only invite a caller to
    // retry a read that has already been reported as unavailable.
    return null;
  }

  const facts = new Map<string, SourceLifecycleFact>();
  for (const row of rows) {
    const sourceRef = String(row.source_ref);
    facts.set(sourceRef, {
      sourceRef,
      retiredAt: row.retired_at === null || row.retired_at === undefined ? null : iso(row.retired_at),
      // bool_or, NOT bool_or's more obvious-looking sibling: a source is servable
      // while ANY of its versions still has an un-collected payload, so one live
      // version must outweigh its collected siblings. `bool_and` reads as the
      // same sentence and drops a source whose current version is perfectly
      // healthy because an older one was purged — the exact case the real
      // PostgreSQL lane exists to catch, since the memory twin spells it
      // `.some()` and a mock would agree with the bug.
      payloadCollectedAt: row.has_live_version === true ? null : "collected",
    });
  }
  return facts;
}

/** Apply the guard to an already-fetched candidate set. */
export async function guardCandidateSources(
  client: ServingGuardClient,
  sourceRefs: readonly string[]
): Promise<ServingGuardVerdict> {
  return decideServingGuard(sourceRefs, await readSourceLifecycleFacts(client, sourceRefs));
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
