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

/**
 * The decision table and the visibility effect it applies.
 *
 * The decision row is append-only evidence: who decided, what they decided,
 * why, and the exact supports and assertions they named. It is never updated
 * or deleted by a later decision, so "preserve evidence" is a property of the
 * schema rather than of a code path that remembers to keep history.
 *
 * The conflict table is separate because a decision resolves a conflict by
 * changing which rows are current, and that is state rather than evidence. It
 * carries one row per (candidate, support) with the visibility the decision
 * gave it, so a later decision against the same conflict is a compare against a
 * value the store holds rather than a re-derivation from a request.
 */
export async function upSchemaScreeningDecisions(
  client: SchemaClient
): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS structured_screening_decisions (
      decision_id text PRIMARY KEY CHECK (length(btrim(decision_id)) > 0),
      scope_binding text NOT NULL,
      candidate_id text NOT NULL
        REFERENCES structured_screening_candidates(candidate_id) ON DELETE CASCADE,
      check_id uuid NOT NULL,
      outcome text NOT NULL
        CHECK (outcome IN ('keep_both', 'retire_support', 'supersede_assertion')),
      reason text NOT NULL CHECK (length(btrim(reason)) > 0),
      actor_id text NOT NULL CHECK (length(btrim(actor_id)) > 0),
      retire_support_ids jsonb NOT NULL CHECK (jsonb_typeof(retire_support_ids) = 'array'),
      retain_support_ids jsonb NOT NULL CHECK (jsonb_typeof(retain_support_ids) = 'array'),
      assertion_ids jsonb NOT NULL CHECK (jsonb_typeof(assertion_ids) = 'array'),
      expected_input_revision text NOT NULL,
      expected_relation_catalog_version integer NOT NULL,
      content_digest text NOT NULL CHECK (content_digest ~ '^[0-9a-f]{64}$'),
      decided_at timestamptz NOT NULL
    )`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS structured_screening_conflict_visibility (
      scope_binding text NOT NULL,
      candidate_id text NOT NULL
        REFERENCES structured_screening_candidates(candidate_id) ON DELETE CASCADE,
      support_id uuid NOT NULL,
      assertion_id uuid NOT NULL,
      current boolean NOT NULL,
      resolved_by text NOT NULL,
      outcome text NOT NULL
        CHECK (outcome IN ('keep_both', 'retire_support', 'supersede_assertion')),
      decided_at timestamptz NOT NULL,
      PRIMARY KEY (scope_binding, candidate_id, support_id)
    )`);
  await client.query(`
    CREATE INDEX IF NOT EXISTS structured_screening_decisions_scope_idx
      ON structured_screening_decisions (scope_binding, candidate_id)`);
}