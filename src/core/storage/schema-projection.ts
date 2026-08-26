/**
 * Projection schema bootstrap: the `projection_outbox` intent log that carries
 * ledger→Neo4j sync (specs/neo4j-graph-arm.md; ADR-0001).
 *
 * Sibling of schema-p0.ts rather than a fifth table inside it: the four P0
 * tables are the Postgres ledger (system of record), this one is the sync
 * mechanism for a downstream read-only projection. `upSchemaP0` still calls it
 * so a single bootstrap keeps the extract CLI's per-chunk transaction able to
 * INSERT an intent without a separate migration step.
 *
 * Same migration mechanism as P0: CREATE ... IF NOT EXISTS only, no version
 * tracking, no ALTER path. That is why the columns a later ticket needs
 * (`attempts` / `last_error` for T3's drain retries) ship now — a column added
 * later would never appear on an already-bootstrapped database.
 */
/**
 * Minimal DDL surface: every statement below is parameterless, so a
 * `pg.PoolClient`, a `pg.Pool` and the projection CLIs' leased client all
 * satisfy it without a cast.
 */
export interface SchemaClient {
  query(text: string): Promise<unknown>;
}

/**
 * projection_outbox: one row per "this ledger subject changed, re-sync it".
 *
 * The row records the SUBJECT, never a snapshot of its values: the projector
 * re-reads the current entity/triple from Postgres (the only SoR) at drain
 * time and MERGEs it into Neo4j, so a stale payload can never overwrite a
 * newer ledger state and no ordering rule between intents is needed.
 *
 * - `subject_kind` is CHECKed to ('entity','triple'), which makes ADR-0001's
 *   "chunks do not enter the graph" a database invariant instead of a
 *   convention every future writer has to remember.
 * - `status` is the pending → done | failed lifecycle T3's drain transitions;
 *   failed rows stay visible with their `last_error` for retry.
 * - No FK to entities/triples on purpose: a CASCADE would delete the very
 *   intent that tells the projector to remove a node from Neo4j.
 */
export async function upSchemaProjection(client: SchemaClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS projection_outbox (
      id           uuid PRIMARY KEY,
      subject_kind text NOT NULL CHECK (subject_kind IN ('entity','triple')),
      subject_id   uuid NOT NULL,
      status       text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','done','failed')),
      attempts     integer NOT NULL DEFAULT 0,
      last_error   text,
      created_at   timestamptz NOT NULL DEFAULT now(),
      processed_at timestamptz
    )`);
  // T3 drain scan: oldest pending intents first.
  await client.query(`
    CREATE INDEX IF NOT EXISTS projection_outbox_status_created_at_idx
      ON projection_outbox (status, created_at)`);
  // Per-subject history lookup (reconcile, failure triage).
  await client.query(`
    CREATE INDEX IF NOT EXISTS projection_outbox_subject_idx
      ON projection_outbox (subject_kind, subject_id)`);
  // Idempotency for emit + backfill: at most ONE undrained intent per
  // subject, so re-running a reconcile does not grow the queue. Partial on
  // `pending` so a subject that changes again after a drain re-enqueues.
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS projection_outbox_pending_subject_idx
      ON projection_outbox (subject_kind, subject_id)
      WHERE status = 'pending'`);
}
