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
] as const;
const BOOTSTRAP_TABLES = [
  "entities",
  "entity_aliases",
  "triples",
  "extraction_records",
  "community_summaries",
  "projection_outbox",
  "source_documents",
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
  "extraction_records_chunk_id_idx",
  "extraction_records_batch_id_idx",
  "extraction_records_status_idx",
  "extraction_records_created_at_idx",
  "community_summaries_embedding_idx",
  "projection_outbox_status_created_at_idx",
  "projection_outbox_subject_idx",
  "projection_outbox_pending_subject_idx",
  "chunks_source_doc_id_ordinal_idx",
] as const;

/**
 * Derive the signed bigint accepted by PostgreSQL's advisory-lock API.
 *
 * FNV-1a over the schema's UTF-8 bytes keeps the key stable across processes
 * while preserving separate lock domains for ordinary schema names.
 */
export function schemaBootstrapLockKey(schemaName: string): bigint {
  let hash = FNV1A_OFFSET_BASIS;
  for (const byte of Buffer.from(schemaName, "utf8")) {
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

  const key = schemaBootstrapLockKey(schemaName);
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
