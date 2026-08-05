/**
 * P0 schema bootstrap: the four entity/triple tables + their indexes.
 *
 * Decomposed by table (one small helper per table) so each function stays
 * well under 40 lines and the public `upSchemaP0` is a thin orchestrator
 * wrapping them in a single transaction. Every statement is idempotent
 * (CREATE ... IF NOT EXISTS) so a re-run is a safe no-op — this is the
 * P0 migration mechanism (spec: CREATE TABLE IF NOT EXISTS only, no
 * migration framework, no version tracking).
 *
 * snake_case columns and singular table names follow the glossary in
 * docs/CONTEXT.md; the DDL contract (columns, constraints, FK actions,
 * indexes) is pinned in specs/p0-schema.md §"DDL Contract".
 *
 * `client` is a pg PoolClient acquired by the caller (opened inside the
 * caller's transaction scope). This module owns no connection lifecycle.
 */
import type { PoolClient } from "pg";

/** entities: canonical entity rows (+ soft-merge columns, #6 Q1-Q2). */
async function createEntities(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS entities (
      id            uuid PRIMARY KEY,
      canonical_name text NOT NULL,
      type          text NOT NULL CHECK (type IN ('person','concept','system','event')),
      embedding     vector(1536),
      metadata      jsonb DEFAULT '{}',
      merged_into   uuid REFERENCES entities(id) ON DELETE SET NULL,
      retired       boolean NOT NULL DEFAULT false,
      created_at    timestamptz NOT NULL DEFAULT now()
    )`);
  // L0 merge lookup by canonical name (#6).
  await client.query(`
    CREATE INDEX IF NOT EXISTS entities_canonical_name_idx
      ON entities (canonical_name)`);
}

/** entity_aliases: surface forms pointing at a canonical entity (CASCADE). */
async function createEntityAliases(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS entity_aliases (
      id         uuid PRIMARY KEY,
      entity_id  uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      alias      text NOT NULL,
      alias_type text NOT NULL CHECK (alias_type IN ('name','variant','abbreviation')),
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS entity_aliases_entity_id_alias_idx
      ON entity_aliases (entity_id, alias)`);
  // Cross-entity L0 alias lookup (#6 L0).
  await client.query(`
    CREATE INDEX IF NOT EXISTS entity_aliases_alias_idx
      ON entity_aliases (alias)`);
}

/** triples: (head, relation, tail) edges with provenance + valid_window. */
async function createTriples(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS triples (
      id              uuid PRIMARY KEY,
      head_id         uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
      tail_id         uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
      relation_raw    text NOT NULL,
      relation_norm   text NOT NULL,
      confidence      real NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
      source_chunk_id uuid REFERENCES chunks(id) ON DELETE SET NULL,
      valid_window    tstzrange NOT NULL,
      created_at      timestamptz NOT NULL DEFAULT now()
    )`);
  await client.query(`
    CREATE INDEX IF NOT EXISTS triples_valid_window_idx
      ON triples USING gist (valid_window)`);
  // One-hop graph arm JOINs (#7 Q1).
  await client.query(`
    CREATE INDEX IF NOT EXISTS triples_head_id_idx ON triples (head_id)`);
  await client.query(`
    CREATE INDEX IF NOT EXISTS triples_tail_id_idx ON triples (tail_id)`);
  // Provenance back-map + idempotency scans (#4 D6).
  await client.query(`
    CREATE INDEX IF NOT EXISTS triples_source_chunk_id_idx
      ON triples (source_chunk_id)`);
  // UNMAPPED review CLI (#4 D7).
  await client.query(`
    CREATE INDEX IF NOT EXISTS triples_relation_norm_idx
      ON triples (relation_norm)`);
}

/** extraction_records: chunk-level extraction outcomes, batch_id aggregate. */
async function createExtractionRecords(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS extraction_records (
      id             uuid PRIMARY KEY,
      batch_id       uuid NOT NULL,
      chunk_id       uuid REFERENCES chunks(id) ON DELETE SET NULL,
      status         text NOT NULL CHECK (status IN ('pending','succeeded','failed')),
      error_code     text,
      error_msg      text,
      triples_count  integer NOT NULL DEFAULT 0,
      unmapped_count integer NOT NULL DEFAULT 0,
      started_at     timestamptz NOT NULL,
      finished_at    timestamptz,
      created_at     timestamptz NOT NULL DEFAULT now()
    )`);
  // listFailed / batch aggregate / cleanup (#7 Q3a, P0d verdicts 5-6).
  await client.query(`
    CREATE INDEX IF NOT EXISTS extraction_records_chunk_id_idx
      ON extraction_records (chunk_id)`);
  await client.query(`
    CREATE INDEX IF NOT EXISTS extraction_records_batch_id_idx
      ON extraction_records (batch_id)`);
  await client.query(`
    CREATE INDEX IF NOT EXISTS extraction_records_status_idx
      ON extraction_records (status)`);
  await client.query(`
    CREATE INDEX IF NOT EXISTS extraction_records_created_at_idx
      ON extraction_records (created_at)`);
}

/**
 * Create all four P0 tables + indexes, atomically. Idempotent: safe to call
 * repeatedly (each statement is IF NOT EXISTS). On any failure the whole
 * transaction rolls back so a partial schema can never be left behind.
 *
 * Why CREATE EXTENSION here (and not at the caller's bootstrap): mirrors
 * PgvectorBackend.ensureTable() — the module is self-contained and a fresh
 * database works out of the box without a separate migration step. Requires
 * superuser or extension-create privilege; that is fine for our local dev
 * Postgres (`postgres` superuser) and aligns with the existing backend.
 */
export async function upSchemaP0(client: PoolClient): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query("CREATE EXTENSION IF NOT EXISTS vector");
    await createEntities(client);
    await createEntityAliases(client);
    await createTriples(client);
    await createExtractionRecords(client);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}
