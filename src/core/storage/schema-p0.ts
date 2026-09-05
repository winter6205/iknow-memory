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

import { ConfigError, readPgvectorAnnMaxDimensions } from "../../config.js";
import { GraphragError } from "../errors.js";
import { upSchemaProjection } from "./schema-projection.js";
import { acquireSchemaBootstrapLock } from "./schema-lock.js";

/**
 * entities: canonical entity rows (+ soft-merge columns, #6 Q1-Q2).
 *
 * `dimensions` is the configured embedding width (from GRAPHRAG_MEMORY_EMBED_DIMENSIONS,
 * defaults to 2048) — the SAME value as `chunks.embedding vector(N)`. The
 * entities.embedding column must match chunks.embedding width so vector
 * writes into either table share one dimension contract (specs/p0-schema.md
 * #6 Q1: N = chunks embedding dim).
 */
async function createEntities(
  client: PoolClient,
  dimensions: number
): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS entities (
      id            uuid PRIMARY KEY,
      canonical_name text NOT NULL,
      type          text NOT NULL CHECK (type IN ('person','concept','system','event')),
      embedding     vector(${dimensions}),
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
      superseded_by   uuid REFERENCES triples(id) ON DELETE SET NULL,
      evidence_span   text,
      created_at      timestamptz NOT NULL DEFAULT now()
    )`);
  // Keep existing P0 installations forward-compatible with the supersession
  // ledger column; CREATE TABLE IF NOT EXISTS does not alter an old table.
  await client.query(`
    ALTER TABLE triples
      ADD COLUMN IF NOT EXISTS superseded_by uuid
      REFERENCES triples(id) ON DELETE SET NULL`);
  // Same forward-compat for the grounding column: nullable because
  // pre-existing rows have no span; new inserts are gated non-empty by the
  // production persist path (specs/graph-rerank-boot-and-evidence.md SC8).
  await client.query(`
    ALTER TABLE triples
      ADD COLUMN IF NOT EXISTS evidence_span text`);
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
 * Validate the single vector width used by every ANN index in this schema.
 * A dimension change is a full re-embed operation; accepting a width that
 * pgvector cannot index would otherwise leave a mixed or partially indexed
 * store.
 */
export function assertPgvectorAnnDimensions(
  dimensions: number,
  annMaxDimensions: number
): void {
  if (
    !Number.isFinite(annMaxDimensions) ||
    !Number.isInteger(annMaxDimensions) ||
    annMaxDimensions <= 0
  ) {
    throw new ConfigError(
      `GRAPHRAG_MEMORY_PGVECTOR_ANN_MAX_DIMENSIONS must be a finite positive integer, got "${annMaxDimensions}"`
    );
  }
  if (
    !Number.isFinite(dimensions) ||
    !Number.isInteger(dimensions) ||
    dimensions <= 0
  ) {
    throw new ConfigError(
      `GRAPHRAG_MEMORY_EMBED_DIMENSIONS must be a finite positive integer, got "${dimensions}"`
    );
  }
  if (dimensions > annMaxDimensions) {
    throw new ConfigError(
      `GRAPHRAG_MEMORY_EMBED_DIMENSIONS (${dimensions}) exceeds configured pgvector ANN limit (${annMaxDimensions})`
    );
  }
}

async function createCommunitySummaries(
  client: PoolClient,
  dimensions: number
): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS community_summaries (
      id           uuid PRIMARY KEY,
      community_id text NOT NULL UNIQUE,
      summary      text NOT NULL,
      entity_ids   uuid[] NOT NULL,
      embedding    vector(${dimensions}) NOT NULL,
      created_at   timestamptz NOT NULL DEFAULT now(),
      updated_at   timestamptz NOT NULL DEFAULT now()
    )`);
  await client.query(`
    CREATE INDEX IF NOT EXISTS community_summaries_embedding_idx
      ON community_summaries USING hnsw (embedding vector_cosine_ops)`);
}

/**
 * Create all four P0 tables + indexes (plus the projection outbox that rides
 * the same bootstrap — see schema-projection.ts), atomically. Idempotent: safe
 * to call repeatedly (each statement is IF NOT EXISTS). On any failure the
 * whole transaction rolls back so a partial schema can never be left behind.
 *
 * Why CREATE EXTENSION here (and not at the caller's bootstrap): mirrors
 * PgvectorBackend.ensureTable() — the module is self-contained and a fresh
 * database works out of the box without a separate migration step. Requires
 * superuser or extension-create privilege; that is fine for our local dev
 * Postgres (`postgres` superuser) and aligns with the existing backend.
 */
export async function upSchemaP0(
  client: PoolClient,
  dimensions: number,
  annMaxDimensions = readPgvectorAnnMaxDimensions()
): Promise<void> {
  assertPgvectorAnnDimensions(dimensions, annMaxDimensions);
  await client.query("BEGIN");
  try {
    if (await acquireSchemaBootstrapLock(client)) {
      await client.query("COMMIT");
      return;
    }
    await client.query("CREATE EXTENSION IF NOT EXISTS vector");
    await createEntities(client, dimensions);
    await createEntityAliases(client);
    await createTriples(client);
    await createExtractionRecords(client);
    await createCommunitySummaries(client, dimensions);
    await upSchemaProjection(client);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    if (err instanceof ConfigError || err instanceof GraphragError) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new GraphragError(
      `P0 schema bootstrap failed: ${message}`,
      "STORAGE_ERROR"
    );
  }
}
