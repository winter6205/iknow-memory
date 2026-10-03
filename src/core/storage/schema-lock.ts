/**
 * PostgreSQL advisory-lock ownership for schema bootstrap — plus the key
 * derivation every advisory lock in the repo shares.
 *
 * `advisoryLockKey` is repo-wide, not schema-migration machinery: the schema
 * bootstrap lock and the index-job serialization lock both take their bigint
 * from it, and one derivation is the point (two hashes would let two names for
 * the same domain silently stop contending). It is exported from this module
 * because the bootstrap lock was its first user; a job-serialization caller
 * importing it imports the derivation only, never a bootstrap behaviour.
 */
import { Buffer } from "node:buffer";

import type { SchemaBootstrapClient } from "./schema-bootstrap.js";
import { GraphragError } from "../errors.js";

const UINT64_MASK = (1n << 64n) - 1n;
const INT64_SIGN_BIT = 1n << 63n;
const UINT64_MODULUS = 1n << 64n;
const FNV1A_OFFSET_BASIS = 14695981039346656037n;
const FNV1A_PRIME = 1099511628211n;
/**
 * Forward-compat columns whose presence defines a bootstrapped schema. A
 * deployment that predates an entry has the table but not the column, so
 * `schemaBootstrapIsReady` must name every one of them: `upSchemaBootstrap`
 * short-circuits on its answer, and the same `CREATE TABLE IF NOT EXISTS`
 * that created the table can never add the column afterwards.
 *
 * Keep this in lockstep with the forward-compat ALTERs in schema-bootstrap.ts —
 * a column added there without an entry here is silently skipped on every
 * existing database (the ALTER only runs when the probe says "not ready").
 * `tests/storage/bootstrap-columns.test.ts` enforces the lockstep by
 * deriving the expected set from the ALTER statements the bootstrap emits,
 * so the next forward-compat column fails a test instead of shipping.
 */
const BOOTSTRAP_COLUMNS = [
  ["triples", "superseded_by"],
  ["triples", "evidence_span"],
  ["triples", "extractor"],
  ["chunks", "source_doc_id"],
  ["chunks", "ordinal"],
  ["source_documents", "valid_until"],
  ["source_documents", "status"],
  ["source_documents", "failure_code"],
  ["source_documents", "extract_method"],
  // corpus-index-job T2: forward-compat ALTER in createSourceDocuments, so it
  // MUST be probed or deployed databases never get the column.
  ["source_documents", "content_identity"],
  // the judge-failure proposal payload. Deployed
  // extraction_records tables predate the column, so it rides the probe too.
  ["extraction_records", "proposed_payload"],
  // the discard stamp of the review lane.
  ["extraction_records", "discarded_at"],
  // T4 rollback columns: added by forward-compat ALTERs in
  // createEmbeddingGeneration, so they MUST be probed (bootstrap-columns
  // lockstep) or deployed databases never get them.
  ["embedding_generation", "rollback_slot"],
  ["embedding_generation", "rollback_model"],
  ["embedding_generation", "rollback_dimensions"],
  // community-level T1: added by the forward-compat ALTER in
  // createCommunitySummaries, so it MUST be probed or deployed databases
  // never get the column (bootstrap-columns lockstep).
  ["community_summaries", "level"],
] as const;
const BOOTSTRAP_TABLES = [
  "entities",
  "entity_aliases",
  "triples",
  "claims",
  "extraction_records",
  "community_summaries",
  "community_index_state",
  "embedding_generation",
  "projection_outbox",
  "source_documents",
  // corpus-index-job T2: a brand-new table — CREATE IF NOT EXISTS alone never
  // reaches a deployed store once the probe says ready, so the probe names it.
  "index_jobs",
  // The immutable source/support records and the finite grants: nine brand-new
  // tables, same reason as index_jobs.
  "source_versions",
  "source_version_locators",
  "assertion_supports",
  "support_extractions",
  "evidence_scope_revisions",
  "evidence_authorization_receipts",
  "evidence_grants",
  "evidence_grant_supports",
  "evidence_grant_extractions",
] as const;
const BOOTSTRAP_INDEXES = [
  "entities_canonical_name_idx",
  "entity_aliases_entity_id_alias_idx",
  "entity_aliases_alias_idx",
  "triples_valid_window_idx",
  "triples_head_id_idx",
  "triples_tail_id_idx",
  "triples_source_chunk_id_idx",
  "triples_relation_norm_idx",
  "claims_entity_id_idx",
  "claims_source_chunk_id_idx",
  "extraction_records_chunk_id_idx",
  "extraction_records_batch_id_idx",
  "extraction_records_status_idx",
  "extraction_records_created_at_idx",
  "community_summaries_embedding_idx",
  "projection_outbox_status_created_at_idx",
  "projection_outbox_subject_idx",
  "projection_outbox_pending_subject_idx",
  "chunks_source_doc_id_ordinal_idx",
  // corpus-index-job T2: forward-compat CREATE ... IF NOT EXISTS indexes —
  // absent from a deployed store until the probe reports not-ready.
  "source_documents_source_ref_content_identity_idx",
  "index_jobs_source_ref_status_idx",
  "index_jobs_one_active_per_source_idx",
  // structured corpus evidence: the occurrence key is the one index that makes
  // a repeated extraction a second link instead of a second support, so a
  // deployed store that never received it would let the duplicate through.
  "source_versions_source_ref_source_version_idx",
  "assertion_supports_source_version_idx",
  "assertion_supports_result_idx",
  "support_extractions_extraction_ref_idx",
  "evidence_authorization_receipts_scope_revisions_idx",
  "evidence_grants_expires_at_idx",
  "evidence_grants_scope_binding_idx",
  "evidence_grant_supports_support_id_idx",
] as const;

/**
 * Derive the signed bigint accepted by PostgreSQL's advisory-lock API from
 * a lock name.
 *
 * Repo-wide, not bootstrap-only: every advisory lock here takes its key from
 * this function — the schema bootstrap's transaction-scoped lock and the index
 * job's session-scoped serialization lock alike.
 *
 * FNV-1a over the name's UTF-8 bytes keeps the key stable across processes
 * AND PostgreSQL majors (a server-side hash like `hashtext` is neither
 * 64-bit nor version-stable) while preserving separate lock domains for
 * ordinary names.
 */
export function advisoryLockKey(name: string): bigint {
  let hash = FNV1A_OFFSET_BASIS;
  for (const byte of Buffer.from(name, "utf8")) {
    hash = (hash ^ BigInt(byte)) * FNV1A_PRIME;
    hash &= UINT64_MASK;
  }
  return hash >= INT64_SIGN_BIT ? hash - UINT64_MODULUS : hash;
}

/**
 * Serialize bootstrap DDL for the connection's current schema.
 *
 * The caller must already have started a transaction. PostgreSQL releases
 * this advisory lock automatically when that transaction commits or rolls
 * back, including when schema bootstrap fails. The return value is true when
 * another committed bootstrap already left every owned object in place; the
 * caller can then commit without replaying DDL against active writers.
 */
export async function acquireSchemaBootstrapLock(
  client: SchemaBootstrapClient
): Promise<boolean> {
  const result = await client.query("SELECT current_schema() AS schema_name");
  const schemaName = (result.rows as { schema_name: string | null }[])[0]
    ?.schema_name;
  if (result.rows.length === 0) {
    return false;
  }
  if (schemaName === null || schemaName === undefined) {
    throw new GraphragError(
      "P0 schema bootstrap requires a current schema",
      "STORAGE_ERROR"
    );
  }

  const key = advisoryLockKey(schemaName);
  await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [
    key.toString(),
  ]);
  return schemaBootstrapIsReady(client);
}

async function schemaBootstrapIsReady(
  client: SchemaBootstrapClient
): Promise<boolean> {
  const result = await client.query(
    `SELECT
       EXISTS (
         SELECT 1 FROM pg_extension WHERE extname = 'vector'
       )
       AND NOT EXISTS (
         SELECT 1
           FROM unnest($1::text[]) AS required(name)
          WHERE NOT EXISTS (
            SELECT 1
              FROM pg_class c
              JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = current_schema()
               AND c.relname = required.name
               AND c.relkind IN ('r', 'p')
          )
       )
       AND NOT EXISTS (
         SELECT 1
           FROM unnest($2::text[]) AS required(name)
          WHERE NOT EXISTS (
            SELECT 1
              FROM pg_class c
              JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = current_schema()
               AND c.relname = required.name
               AND c.relkind = 'i'
          )
       )
       AND NOT EXISTS (
         SELECT 1
           FROM unnest($3::text[], $4::text[]) AS required(table_name, column_name)
          WHERE NOT EXISTS (
            SELECT 1
              FROM pg_attribute a
              JOIN pg_class c ON c.oid = a.attrelid
              JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = current_schema()
               AND c.relname = required.table_name
               AND a.attname = required.column_name
               AND a.attnum > 0
               AND NOT a.attisdropped
          )
       )
       AND EXISTS (
         -- entity-type-and-filter review C1: presence of the renamed closed-set
         -- CHECK is the marker that the destructive entities-type upgrade has
         -- already run in this schema. A store still carrying the legacy
         -- auto-named entities_type_check misses this name, so the probe
         -- answers "not ready" and upSchemaBootstrap replays the (idempotent)
         -- DDL including upgradeEntitiesTypeCheck.
         SELECT 1
           FROM pg_constraint k
           JOIN pg_class t ON t.oid = k.conrelid
           JOIN pg_namespace n ON n.oid = t.relnamespace
          WHERE n.nspname = current_schema()
            AND t.relname = 'entities'
            AND k.conname = 'entities_type_closed_check'
       ) AS ready`,
    [
      BOOTSTRAP_TABLES,
      BOOTSTRAP_INDEXES,
      BOOTSTRAP_COLUMNS.map(([table]) => table),
      BOOTSTRAP_COLUMNS.map(([, column]) => column),
    ]
  );
  const rows = result.rows as { ready: boolean }[];
  return rows[0]?.ready === true;
}
