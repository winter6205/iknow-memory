/**
 * Ledger retire hook (specs/retrieve-graph-quality.md SC4 slice 2; Q-T3).
 *
 * A row marked `retired = true` is filtered out of the live projection scans
 * in `ledger-source.ts`, so the next drain sees no live entity for the id and
 * removes the stale graph node (DETACH DELETE) by id. `retired` is the
 * soft-merge pointer that Q-T5 also writes into; this helper is the narrow
 * surface for the Q-T3 projection-GC slice, not the merge writer itself.
 *
 * The `retired` column already exists in `entities` (schema-bootstrap.ts); no schema
 * migration is needed here.
 *
 * The function returns `true` iff a row with that id exists in `entities`,
 * regardless of whether the value flipped from `false` → `true`. The
 * `RETURNING id` always names the touched row, so the caller does not have to
 * distinguish "freshly retired" from "already retired" — both leave the
 * ledger and the projection in the same state.
 */
import type { LedgerClient } from "../graph/ledger-source.js";

/**
 * Mark `entities.id = $1` as retired. Returns `true` if the row existed.
 *
 * Idempotent: a second call returns `true` again (the row is still there,
 * still retired), never throws. Caller-supplied `LedgerClient` is the same
 * minimal query surface the projection CLIs accept, so a `pg.PoolClient`,
 * a `pg.Pool`, or a test fake all satisfy it.
 */
export async function retireEntityById(
  client: LedgerClient,
  id: string
): Promise<boolean> {
  const { rows } = await client.query(
    `UPDATE entities SET retired = true
      WHERE id = $1::uuid
      RETURNING id`,
    [id]
  );
  return rows.length > 0;
}
