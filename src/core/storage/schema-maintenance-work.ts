/**
 * Maintenance work schema bootstrap: the durable job ledger behind the
 * maintenance lifecycle (specs/maintenance-durable-work.md; fin
 * specs/structured-corpus-maintenance.md §Durable work and publication fences).
 *
 * Sibling of schema-projection.ts rather than more tables inside
 * schema-bootstrap.ts: these tables belong to the maintenance capability, and
 * keeping their DDL next to that capability's contract keeps the opt-in slice
 * separable from the legacy index-job ledger, which this capability never
 * touches. `upSchemaBootstrap` still calls it so one bootstrap covers both.
 *
 * Same migration mechanism as the rest of the package — CREATE IF NOT EXISTS
 * only, no version tracking — which is why every column MP4 needs ships now: a
 * column added later would never appear on an already-bootstrapped database.
 *
 * Statement surface is parameterless, so a Pool, a PoolClient, and the test
 * fakes all satisfy `SchemaClient` without a cast.
 */
import {
  MAINTENANCE_WORK_KINDS,
  MAINTENANCE_WORK_STATUS,
  MAX_AUTO_ATTEMPTS,
} from "../maintenance/types.js";
import type { SchemaClient } from "./schema-projection.js";

export { type SchemaClient };

/**
 * The CHECK lists are rendered from the exported vocabularies rather than
 * retyped, so the schema and the TypeScript union cannot disagree — a fifth work
 * kind or status added to the vocabulary must not silently be rejected by the
 * database.
 */
const sqlList = (values: readonly string[]): string =>
  values.map((value) => `'${value}'`).join(",");

/**
 * `maintenance_jobs`: one row per bound job key.
 *
 * The primary key IS the contract — it is derived from work kind, source
 * version/generation, dependency-vector digest, and config/ruleset revision, so
 * a second schedule of the same key joins this row and a schedule that differs
 * in any bound field addresses a different job. There is therefore no separate
 * idempotency column and no ON CONFLICT branch that could silently join two
 * different dependency sets.
 *
 * The live lease columns (`fencing_token`, `lease_expires_at`,
 * `attempt_started_at`) describe the CURRENT attempt only; attempt history lives
 * in `maintenance_job_attempts`. Keeping the live lease on the job row is what
 * makes claim and fence a single-row atomic update.
 */
export async function upSchemaMaintenanceWork(client: SchemaClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS maintenance_jobs (
      job_key            text PRIMARY KEY,
      work_kind          text NOT NULL
                          CHECK (work_kind IN (${sqlList(MAINTENANCE_WORK_KINDS)})),
      source_ref         text NOT NULL CHECK (length(source_ref) > 0),
      source_version     text NOT NULL CHECK (length(source_version) > 0),
      source_generation  bigint NOT NULL CHECK (source_generation >= 0),
      input_revision     text NOT NULL CHECK (length(input_revision) > 0),
      config_revision    text NOT NULL CHECK (length(config_revision) > 0),
      status             text NOT NULL DEFAULT 'pending'
                          CHECK (status IN (${sqlList(MAINTENANCE_WORK_STATUS)})),
      attempt_count      integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      auto_attempt_count integer NOT NULL DEFAULT 0 CHECK (auto_attempt_count >= 0),
      max_attempts       integer NOT NULL DEFAULT ${MAX_AUTO_ATTEMPTS}
                          CHECK (max_attempts > 0),
      next_attempt_at    timestamptz,
      fencing_token      text,
      lease_expires_at   timestamptz,
      attempt_started_at timestamptz,
      last_failure_code  text,
      created_at         timestamptz NOT NULL,
      updated_at         timestamptz NOT NULL
    )`);
  /**
   * Claim scan: oldest pending work whose retry deadline has passed. Partial on
   * `pending` so a running job — which reclaim owns, not claim — can never
   * appear here, and so two workers stepping through this index with SKIP
   * LOCKED never meet on the same row.
   */
  await client.query(`
    CREATE INDEX IF NOT EXISTS maintenance_jobs_claim_idx
      ON maintenance_jobs (next_attempt_at, created_at)
      WHERE status = 'pending'`);
  /**
   * Reclaim scan: running attempts whose lease ran out.
   */
  await client.query(`
    CREATE INDEX IF NOT EXISTS maintenance_jobs_expired_lease_idx
      ON maintenance_jobs (lease_expires_at)
      WHERE status = 'running'`);
  await client.query(`
    CREATE INDEX IF NOT EXISTS maintenance_jobs_source_idx
      ON maintenance_jobs (source_ref, status)`);

  /**
   * `maintenance_job_attempts`: the retry history.
   *
   * Rows are appended, never edited away: an explicit retry after exhaustion
   * adds attempt N+1 and leaves attempts 1..N intact, so "three transient
   * attempts then failed" stays auditable. `fencing_token` is UNIQUE across the
   * table so a token can never identify two attempts, and `reclaimed` records
   * that a lease expiry took this attempt away rather than the attempt
   * finishing on its own.
   */
  await client.query(`
    CREATE TABLE IF NOT EXISTS maintenance_job_attempts (
      job_key        text NOT NULL
                       REFERENCES maintenance_jobs (job_key) ON DELETE CASCADE,
      attempt_number integer NOT NULL CHECK (attempt_number > 0),
      fencing_token  text NOT NULL UNIQUE,
      failure_code   text,
      started_at     timestamptz NOT NULL,
      finished_at    timestamptz,
      reclaimed      boolean NOT NULL DEFAULT false,
      PRIMARY KEY (job_key, attempt_number)
    )`);
  /**
   * History read, oldest attempt first.
   */
  await client.query(`
    CREATE INDEX IF NOT EXISTS maintenance_job_attempts_history_idx
      ON maintenance_job_attempts (job_key, attempt_number)`);
}
