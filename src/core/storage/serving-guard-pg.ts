/**
 * The PostgreSQL half of MP12's serving guard.
 *
 * Two shapes for the same rule, deliberately: a predicate the vector query
 * joins on, so a stale row is never materialised, and a read of the lifecycle
 * facts for a candidate set, so a caller holding already-fetched hits can apply
 * the identical rule in memory. Both are derived from the same two facts — an
 * un-collected version, and a source that has not been withdrawn — so the lanes
 * cannot answer different questions.
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
 * The predicate `buildVectorSearchQuery` appends. Two halves, both required:
 *
 * - **Payload**: a source is servable while any of its versions still has an
 *   un-collected payload, so one live version outweighs its collected siblings.
 *   A source with no version row at all fails this half, which is the
 *   fail-closed direction — see the `count(*) > 0` note below for why it is not
 *   written as `NOT EXISTS`.
 * - **Withdrawal**: `structured_publication_sources.active = false`, which is
 *   what `withdraw()` writes and the only place withdrawal is recorded — it
 *   never touches `source_versions`. Phrased as `NOT EXISTS` on the withdrawn
 *   set, NOT as `EXISTS (active)`: a source that was ingested but never
 *   published has no row here at all, and `EXISTS (active)` would fail-close
 *   every such source even though nothing has withdrawn it.
 *
 * It reads no timestamp and takes no parameter, so it cannot be evaluated
 * against a stale "now": the lifecycle stamps are the fact, not a window.
 *
 * The payload half is a correlated `count(*) > 0` rather than the more obvious
 * `EXISTS`, and the difference is purely for the planner: an `EXISTS` is pulled
 * up into a hash semi-join, which sits BELOW the `ORDER BY ... <=> $1`, forcing
 * a Sort and turning the chunk HNSW scan into a sequential scan
 * (tests/integration/vector-index-pg.test.ts pins that). An aggregate in a
 * `WHERE` subquery is not pulled up, so it stays a filter on the index scan.
 * `count(*) > 0` over the same predicate is the same boolean as `EXISTS`,
 * including for a source with no version row (count 0 → not served).
 */
export const SERVING_GUARD_CLAUSE = `
      AND (SELECT count(*)
             FROM source_versions sv
            WHERE sv.source_ref = chunks.source_ref
              AND sv.payload_collected_at IS NULL) > 0
      AND NOT EXISTS (
        SELECT 1
          FROM structured_publication_sources ps
         WHERE ps.source_ref = chunks.source_ref
           AND ps.active = false
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
      // LEFT JOIN, because the publication table is optional per source and
      // `COALESCE(.., true)` is what keeps an ingested-but-unpublished source
      // active. An INNER JOIN would silently drop those sources from the facts
      // map, and the guard would then refuse them as unknown — fail-closed, but
      // for the wrong reason and against every unpublished source.
      `SELECT sv.source_ref,
              max(sv.retired_at)           AS retired_at,
              bool_or(sv.payload_collected_at IS NULL) AS has_live_version,
              bool_and(COALESCE(ps.active, true))    AS is_active
         FROM source_versions sv
         LEFT JOIN structured_publication_sources ps
                ON ps.source_ref = sv.source_ref
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
      // `max`, the same aggregation the memory twin uses. This value is part of
      // the cross-lane contract, not decoration: a first-non-null read answers a
      // different question and the lanes would drift the moment the read order
      // changed. No rule below consumes it — retirement is deliberately not a
      // serving criterion — but it is asserted, because an unaggregated stamp
      // that no consumer reads is a field nobody notices drifting.
      retiredAt: row.retired_at === null || row.retired_at === undefined ? null : iso(row.retired_at),
      // bool_or, NOT bool_or's more obvious-looking sibling: a source is servable
      // while ANY of its versions still has an un-collected payload, so one live
      // version must outweigh its collected siblings. `bool_and` reads as the
      // same sentence and drops a source whose current version is perfectly
      // healthy because an older one was purged — the exact case the real
      // PostgreSQL lane exists to catch, since the memory twin spells it
      // `.some()` and a mock would agree with the bug.
      payloadCollectedAt: row.has_live_version === true ? null : "collected",
      // `bool_and` IS right here, unlike one line above, and the contrast is
      // the point: withdrawal is a per-SOURCE fact, so every joined row must be
      // active for the source to be, while payload liveness is satisfied by any
      // one row. The join can repeat a source's versions, but
      // `UNIQUE (source_ref)` bounds it to one publication row, and a repeat
      // would not change an AND anyway.
      //
      // `!== false` rather than `=== true` because the rule is negative — "not
      // withdrawn" — so a value that is somehow absent reads as not-withdrawn
      // instead of inventing a third state the rule has no case for.
      active: row.is_active !== false,
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
