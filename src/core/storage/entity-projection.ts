/**
 * Entity projection — read the authoritative Postgres entity ledger
 * (specs/es-precision-layer.md T5, plans/es-precision-layer.md T5).
 *
 * Postgres remains the only system of record; this module owns the read
 * shape that the precision layer mirrors. The SQL joins `entities` to
 * `entity_aliases` and filters `retired = false`, mirroring the live
 * filter the graph arm seed query already applies (PG `entities` rows
 * whose `merged_into` is set stay visible here as long as they are not
 * retired; the canonical survivor is what the projection carries forward
 * via the merge path in `src/cli/extract.ts`).
 *
 * The output shape (`EntityIndexRecord`) is the precision layer's wire
 * format. `aliases` always contains the full set of surface forms stored
 * against the entity — never a single alias from one merge, never a
 * "current" subset — because the precision layer's entity index is the
 * only lexical recall path an entity can come from, and missing an alias
 * means that surface form can never seed a graph query.
 *
 * This module is read-only; it never writes to `entities` or
 * `entity_aliases`. The caller owns the transaction lifecycle, so the
 * same projection is safe inside an extract pipeline transaction and
 * outside one.
 */

import type { EntityIndexRecord } from "./elasticsearch-precision.js";

/**
 * Minimal query surface satisfied by `pg.Pool`, `pg.PoolClient`, and the
 * CLI/test fakes. Declared structurally so the storage module does not
 * depend on a sibling capability slice for a 1-line shape.
 */
export interface EntityProjectionClient {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

/**
 * One authoritative entity projection: id, final canonical name, type, and
 * the FULL alias list. The retirement flag is carried so the precision
 * layer's bulk path can mark a row inactive in the same write (the ES
 * `retired` field exists to keep the filter on the query side simple).
 *
 * `merged_into` is intentionally absent: rows in this view are by
 * construction the survivors of the soft-merge walk — losers stay in
 * Postgres but never reach the precision layer because the projection
 * is taken from `retired = false` rows that are NOT pointed-at losers.
 */
export interface EntityProjectionPageRow {
  id: string;
  canonical_name: string;
  type: string;
  retired: boolean;
  aliases: string[];
}

/**
 * Pull one keyset page of live entity projections from PG. `after` is the
 * exclusive lower bound on `entities.id` — pass `"00000000-0000-0000-0000-000000000000"`
 * for the first page; subsequent calls reuse the last returned id as the
 * next cursor. The page is returned ordered by `id` ASC so the keyset
 * walk terminates even when the ledger grows mid-scan.
 *
 * Two live predicates, one for each tombstone kind the ledger keeps:
 * `retired = false` and `merged_into IS NULL`. A soft-merge loser is a
 * row the ledger retains only as the rollbackable `merged_into` edge —
 * the extract CLI deletes its index document at merge time, so the
 * rebuild path must agree or a reindex would resurrect what the merge
 * path removed.
 */
export const ENTITY_PROJECTION_PAGE_SQL = `SELECT e.id, e.canonical_name, e.type, e.retired,
          coalesce(
            array_agg(a.alias) FILTER (WHERE a.alias IS NOT NULL),
            ARRAY[]::text[]
          ) AS aliases
     FROM entities e
     LEFT JOIN entity_aliases a ON a.entity_id = e.id
    WHERE e.id > $1 AND e.retired = false AND e.merged_into IS NULL
    GROUP BY e.id, e.canonical_name, e.type, e.retired
    ORDER BY e.id
    LIMIT $2`;

/**
 * Project a single page of live entities onto the precision-layer shape.
 * Caller iterates the keyset cursor; this function only translates rows
 * into `EntityIndexRecord[]`. Aliases are de-duplicated and ordered
 * deterministically so two projections of the same ledger produce the
 * same index documents.
 */
export function projectEntityIndexRecords(
  rows: readonly EntityProjectionPageRow[]
): EntityIndexRecord[] {
  return rows.map((row) => ({
    id: row.id,
    canonical_name: row.canonical_name,
    aliases: [...new Set(row.aliases ?? [])],
    type: row.type,
    retired: row.retired,
  }));
}

/**
 * Fetch one page of entity projections from PG. The caller passes a
 * `Queryable`-like client and the cursor + page size; the function owns
 * the SQL constant so the column set and the row shape stay locked
 * together. Errors from the underlying query propagate so the caller can
 * decide between transactional retry and degraded logging.
 */
export async function fetchEntityProjectionPage(
  client: EntityProjectionClient,
  after: string,
  limit: number
): Promise<EntityProjectionPageRow[]> {
  const { rows } = await client.query(ENTITY_PROJECTION_PAGE_SQL, [
    after,
    limit,
  ]);
  return (rows as RawProjectionRow[]).map(toEntityProjectionPageRow);
}

/**
 * Convenience: collect every live entity projection into one array.
 * Used by callers that already know the ledger fits in memory (the
 * extract pipeline projects only the entities a single chunk just
 * persisted, not the whole ledger).
 */
export async function fetchEntityProjection(
  client: EntityProjectionClient,
  ids: readonly string[]
): Promise<EntityIndexRecord[]> {
  if (ids.length === 0) return [];
  const { rows } = await client.query(
    `SELECT e.id, e.canonical_name, e.type, e.retired,
            coalesce(
              array_agg(a.alias) FILTER (WHERE a.alias IS NOT NULL),
              ARRAY[]::text[]
            ) AS aliases
       FROM entities e
       LEFT JOIN entity_aliases a ON a.entity_id = e.id
      WHERE e.id = ANY($1::uuid[]) AND e.retired = false
        AND e.merged_into IS NULL
      GROUP BY e.id, e.canonical_name, e.type, e.retired
      ORDER BY e.id`,
    [[...ids]]
  );
  return projectEntityIndexRecords(
    (rows as RawProjectionRow[]).map(toEntityProjectionPageRow)
  );
}

interface RawProjectionRow {
  id: unknown;
  canonical_name: unknown;
  type: unknown;
  retired: unknown;
  aliases: unknown;
}

function toEntityProjectionPageRow(
  row: RawProjectionRow
): EntityProjectionPageRow {
  return {
    id: String(row.id),
    canonical_name: String(row.canonical_name),
    type: String(row.type),
    retired: Boolean(row.retired),
    aliases: Array.isArray(row.aliases)
      ? (row.aliases as unknown[]).map((alias) => String(alias))
      : [],
  };
}
