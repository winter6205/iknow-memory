/**
 * Additive DDL for persisted structural screening evidence.
 *
 * Two tables, both append-only: the check record and the candidates it found.
 * The candidate table has no status, verdict, score or winner column on
 * purpose — the columns it does have are exactly the identity and the evidence
 * a reader needs to re-derive the screen, so the schema itself cannot express
 * "this alternative is the true one".
 */
import type { SchemaClient } from "./schema-projection.js";

export async function upSchemaScreening(client: SchemaClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS structured_screening_checks (
      check_id uuid PRIMARY KEY,
      scope_binding text NOT NULL
        REFERENCES structured_publication_scopes(scope_binding) ON DELETE CASCADE,
      job_key text NOT NULL,
      source_ref text NOT NULL,
      ruleset_revision text NOT NULL,
      coverage text NOT NULL,
      relation_catalog_version integer NOT NULL CHECK (relation_catalog_version >= 0),
      relation_buckets jsonb NOT NULL,
      input_revision text NOT NULL,
      assertion_count bigint NOT NULL CHECK (assertion_count >= 0),
      candidate_count bigint NOT NULL CHECK (candidate_count >= 0),
      published_at timestamptz NOT NULL
    )`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS structured_screening_candidates (
      candidate_id text PRIMARY KEY,
      check_id uuid NOT NULL
        REFERENCES structured_screening_checks(check_id) ON DELETE CASCADE,
      scope_binding text NOT NULL,
      head_entity_id uuid NOT NULL,
      relation_norm text NOT NULL,
      assertion_ids jsonb NOT NULL,
      tail_entity_ids jsonb NOT NULL,
      support_ids jsonb NOT NULL,
      support_revisions jsonb NOT NULL,
      extraction_revisions jsonb NOT NULL,
      assertion_input_revisions jsonb NOT NULL,
      input_revision text NOT NULL,
      relation_catalog_version integer NOT NULL,
      uncertainty_lower boolean NOT NULL,
      uncertainty_upper boolean NOT NULL,
      uncertainty_reason text NOT NULL,
      published_at timestamptz NOT NULL
    )`);
  await client.query(`
    CREATE INDEX IF NOT EXISTS structured_screening_candidates_scope_idx
      ON structured_screening_candidates (scope_binding, relation_norm)`);
  await client.query(`
    CREATE INDEX IF NOT EXISTS structured_screening_checks_scope_idx
      ON structured_screening_checks (scope_binding, source_ref)`);
}