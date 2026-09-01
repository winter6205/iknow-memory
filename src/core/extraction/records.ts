/**
 * extraction_records status transitions.
 *
 * Per-chunk status rows carry the mark-and-continue policy's visible record:
 * `pending → succeeded | failed` (#4 D4). `batch_id` is the aggregation key
 * (no separate batch rows, P0d verdict 7). `listFailed()` surfaces failed
 * chunks without retrying the whole batch.
 *
 * SC5: `SELF_LOOP_REJECTED` is a permanent reject — there is no re-extract
 * path for a self-loop triple, so both `listFailed()` and the `--only-failed`
 * scan exclude it by `error_code`. Without this filter, an operator would see
 * "must re-extract" rows that re-extraction will only reproduce identically.
 *
 * The client is the `Queryable` shape from resolve.ts — a minimal
 * `{ query(text, values) => Promise<{rows}> }` that accepts both `pg.Pool`
 * and `pg.PoolClient`, so unit tests can drive it with a fake and the T7
 * Postgres integration can pass a real pool.
 *
 * Transactionality note: these are single statements. Writing extraction_records
 * in the same transaction as the triples/entities they describe (#4 D6) is the
 * orchestrator's concern (T6 CLI) — that scope owns the transaction boundary.
 */
import { randomUUID } from "node:crypto";

/** SC5: error_code for an all-self-loop chunk; hidden from listFailed(). */
export const SELF_LOOP_REJECTED_CODE = "SELF_LOOP_REJECTED";

/** Graph-query contract accepted by both `pg.Pool` and `pg.PoolClient`. */
export interface Queryable {
  query: (text: string, values: unknown[]) => Promise<{ rows: any[] }>;
}

export interface RecordInput {
  id: string;
  batchId: string;
  chunkId: string | null;
  startedAt: string;
}

export interface SuccessCounts {
  triplesCount: number;
  unmappedCount: number;
}

export interface FailureInfo {
  code: string;
  msg: string;
}

export interface ListFailedOptions {
  batchId?: string;
}

/** Insert a chunk-status row in `pending`. */
export async function insertRecord(
  client: Queryable,
  rec: RecordInput
): Promise<void> {
  await client.query(
    `INSERT INTO extraction_records
       (id, batch_id, chunk_id, status, started_at)
     VALUES ($1, $2, $3, 'pending', $4)`,
    [rec.id, rec.batchId, rec.chunkId, rec.startedAt]
  );
}

/** Transition a row to `succeeded` with finishing counts. */
export async function markSucceeded(
  client: Queryable,
  id: string,
  counts: SuccessCounts
): Promise<void> {
  await client.query(
    `UPDATE extraction_records
     SET status = 'succeeded', finished_at = now(),
         triples_count = $2, unmapped_count = $3
     WHERE id = $1`,
    [id, counts.triplesCount, counts.unmappedCount]
  );
}

/** Transition a row to `failed` with the error code/msg. */
export async function markFailed(
  client: Queryable,
  id: string,
  error: FailureInfo
): Promise<void> {
  await client.query(
    `UPDATE extraction_records
     SET status = 'failed', finished_at = now(),
         error_code = $2, error_msg = $3
     WHERE id = $1`,
    [id, error.code, error.msg]
  );
}

/**
 * List failed rows, newest-first filterable by batch_id, ordered by created_at.
 *
 * SC5: SELF_LOOP_REJECTED rows are filtered out — they are permanent rejects
 * (no re-extract path), so listing them as "must re-extract" would mislead
 * operators. The exclusion rides the SQL WHERE clause so the DB applies the
 * filter, not the caller.
 */
export async function listFailed(
  client: Queryable,
  opts: ListFailedOptions = {}
): Promise<Record<string, unknown>[]> {
  const { batchId } = opts;
  // AND keeps both filters independent: status = failed AND error_code !=
  // SELF_LOOP_REJECTED. The batch_id clause joins with AND when present.
  const where = batchId
    ? `WHERE status = 'failed' AND error_code != '${SELF_LOOP_REJECTED_CODE}' AND batch_id = $1`
    : `WHERE status = 'failed' AND error_code != '${SELF_LOOP_REJECTED_CODE}'`;
  const values = batchId ? [batchId] : [];
  const { rows } = await client.query(
    `SELECT * FROM extraction_records ${where} ORDER BY created_at`,
    values
  );
  return rows;
}

/** Generate a UUID v4 (spec-1 Open Question 1 resolution: Node built-in). */
export function newRecordId(): string {
  return randomUUID();
}
