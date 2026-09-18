/**
 * Schema bootstrap: the entity/triple/claim ledger tables + their indexes.
 *
 * Decomposed by table (one small helper per table) so each function stays
 * well under 40 lines and the public `upSchemaBootstrap` is a thin orchestrator
 * wrapping them in a single transaction. Every statement is idempotent
 * (CREATE ... IF NOT EXISTS) so a re-run is a safe no-op — this is the
 * standing migration mechanism (spec: CREATE TABLE IF NOT EXISTS only, no
 * migration framework, no version tracking).
 *
 * snake_case columns and singular table names follow the glossary in
 * docs/CONTEXT.md; the DDL contract (columns, constraints, FK actions,
 * indexes) is pinned in specs/p0-schema.md §"DDL Contract".
 *
 * `client` is any query-capable handle the caller leases (a pg PoolClient,
 * a pg Pool, a CLI's leased client — see `SchemaBootstrapClient`). This module owns
 * no connection lifecycle.
 */
import { ConfigError, readPgvectorAnnMaxDimensions } from "../../config.js";
import { GraphragError } from "../errors.js";
import {
  SOURCE_DOC_STATUS,
  EXTRACT_METHODS,
  COMMUNITY_INDEX_STATUS,
  type SourceDocStatus,
} from "../types.js";
import { upSchemaProjection } from "./schema-projection.js";
import { acquireSchemaBootstrapLock } from "./schema-lock.js";

/**
 * Render a status vocabulary as a SQL literal list for a CHECK constraint.
 *
 * The values are compile-time constants from SOURCE_DOC_STATUS, so there is
 * no injection surface; quoting is defensive so a future value containing a
 * quote cannot silently break the DDL.
 */
function sqlTextList(values: readonly string[]): string {
  return values.map((value) => `'${value.replace(/'/g, "''")}'`).join(", ");
}

/** A single value as a SQL literal — same escaping as the CHECK's list. */
function sqlTextLiteral(value: string): string {
  return sqlTextList([value]);
}

/** The three-value 资料 status vocabulary, in declaration order. */
const SOURCE_DOC_STATUS_VALUES: readonly SourceDocStatus[] =
  Object.values(SOURCE_DOC_STATUS);

/**
 * Minimal client surface the bootstrap consumes: only `query`, with
 * optional bind values (the only parameterized statements live in
 * `schema-lock.ts`). A `pg.PoolClient`, a `pg.Pool`, the CLIs' leased
 * clients and the extract tool's leased client all satisfy it structurally,
 * so no call site needs a cast.
 */
export interface SchemaBootstrapClient {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

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
  client: SchemaBootstrapClient,
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
async function createEntityAliases(
  client: SchemaBootstrapClient
): Promise<void> {
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
async function createTriples(client: SchemaBootstrapClient): Promise<void> {
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
      extractor       text NOT NULL DEFAULT 'llm',
      created_at      timestamptz NOT NULL DEFAULT now()
    )`);
  // Keep existing bootstrap installations forward-compatible with the supersession
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
  // Forward-compat for the extraction-provenance column. The default exists
  // because rows written before this column shipped were all LLM-produced
  // (the schema has no other write path); a non-LLM producer must set it
  // explicitly on its INSERT.
  await client.query(`
    ALTER TABLE triples
      ADD COLUMN IF NOT EXISTS extractor text NOT NULL DEFAULT 'llm'`);
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

/**
 * claims: time-bounded assertions the STANDARD extract job writes after
 * canonical merge (graph-index-standard-fast T3; ADR 0071).
 *
 * Postgres SoR like the rest of the ledger — claims are NOT graph subjects,
 * so no projection intent is ever emitted for this table (ADR-0001 keeps
 * the Neo4j side an entity/triple projection). One row = one claim hanging
 * on one survivor entity (`entity_id` CASCADE: retiring the entity retires
 * its claims) with the producing chunk as provenance (`SET NULL`: knowledge
 * outlives its source, same posture as `triples.source_chunk_id`). The
 * extract pipeline RESTATES a chunk's rows (DELETE by `source_chunk_id` →
 * INSERT) inside the chunk transaction, which is what makes repeat
 * extraction idempotent; `claims_source_chunk_id_idx` serves that replace.
 * Column vocabulary mirrors `triples` (valid_window '[)' semantics,
 * confidence CHECK, extractor provenance tag).
 */
async function createClaims(client: SchemaBootstrapClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS claims (
      id              uuid PRIMARY KEY,
      entity_id       uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      source_chunk_id uuid REFERENCES chunks(id) ON DELETE SET NULL,
      claim_text      text NOT NULL,
      valid_window    tstzrange NOT NULL,
      confidence      real NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
      evidence_span   text,
      extractor       text NOT NULL DEFAULT 'llm',
      created_at      timestamptz NOT NULL DEFAULT now()
    )`);
  // Community-report / claim-read joins hang claims on their entity.
  await client.query(`
    CREATE INDEX IF NOT EXISTS claims_entity_id_idx
      ON claims (entity_id)`);
  // Per-chunk restatement (DELETE WHERE source_chunk_id = $1).
  await client.query(`
    CREATE INDEX IF NOT EXISTS claims_source_chunk_id_idx
      ON claims (source_chunk_id)`);
}

/** extraction_records: chunk-level extraction outcomes, batch_id aggregate. */
async function createExtractionRecords(
  client: SchemaBootstrapClient
): Promise<void> {
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
  client: SchemaBootstrapClient,
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
 * community_index_state: the corpus-level C-ready (就绪) singleton written
 * by the community-summary CLI (graph-index-standard-fast T5).
 *
 * One row (CHECK id = 1) describes the WHOLE report generation, because the
 * CLI swaps `community_summaries` atomically — a partial generation is by
 * definition not ready, so a per-community flag would only restate the row
 * set. `failure_code` mirrors the `source_documents` status pattern and
 * carries the fin-pinned `community_summary_index_failure` token so the
 * search-mode retrieve ticket can forward it verbatim. The CHECK's literal
 * list derives from COMMUNITY_INDEX_STATUS (types.ts), same constant-side
 * doctrine as `source_documents_status_check`.
 */
async function createCommunityIndexState(
  client: SchemaBootstrapClient
): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS community_index_state (
      id           integer PRIMARY KEY CHECK (id = 1),
      status       text NOT NULL
                     CHECK (status IN (${sqlTextList(Object.values(COMMUNITY_INDEX_STATUS))})),
      failure_code text NULL,
      updated_at   timestamptz NOT NULL DEFAULT now()
    )`);
}

/**
 * source_documents: the 资料 prose SoR (operator-console T1; ADR-0010).
 *
 * One row holds the full body text the injector pushed; the dashboard and
 * `read_source` MCP tool return this body. Chunks back-point to this row
 * via `chunks.source_doc_id` + `chunks.ordinal` so a derived slice stays
 * traceable to its source.
 *
 * `source_ref` is UNIQUE so re-pushing the same locator collapses to a
 * single 资料 row (no duplicate SoR rows). Forward-compatible with an
 * index lookup for the header typeahead.
 */
async function createSourceDocuments(
  client: SchemaBootstrapClient
): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS source_documents (
      id          uuid PRIMARY KEY,
      source_ref  text NOT NULL UNIQUE,
      title       text,
      content     text NOT NULL,
      created_at  timestamptz NOT NULL DEFAULT now(),
      valid_until timestamptz NULL
    )`);
  // T5 forward-compat ALTER: deployments whose source_documents predates
  // the 资料 validity window keep working — every existing row reads as
  // "still valid" through the NULL default. Same pattern as the chunks
  // back-pointer ALTERs below.
  await client.query(`
    ALTER TABLE source_documents
      ADD COLUMN IF NOT EXISTS valid_until timestamptz NULL`);
  // T3 (corpus-ready retrieve) forward-compat ALTERs: status is PERSISTED so
  // a failed push is visible on the 资料页 even though it produced no chunk
  // row to derive anything from. The default is 就绪's precondition state,
  // not a claim about the row: a pre-T3 资料 gets its real status the next
  // time a push touches it, because the push write always declares one.
  //
  // The CHECK pins the vocabulary at the storage boundary. Both the values
  // and the literal come from SOURCE_DOC_STATUS (types.ts) so a rename
  // cannot leave the constraint rejecting the constant the writers use.
  await client.query(`
    ALTER TABLE source_documents
      ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT ${sqlTextLiteral(SOURCE_DOC_STATUS.IN_PROGRESS)}`);
  await client.query(`
    ALTER TABLE source_documents
      ADD COLUMN IF NOT EXISTS failure_code text NULL`);
  await client.query(`
    DO $$
    BEGIN
      ALTER TABLE source_documents
        ADD CONSTRAINT source_documents_status_check
        CHECK (status IN (${sqlTextList(SOURCE_DOC_STATUS_VALUES)}));
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END $$`);
  // T1 (graph-index-standard-fast) version spine: which extract method
  // produced this 资料 version. NULL = never extracted; once set, the method
  // is frozen for the version — the pipeline refuses a conflicting re-
  // extract (EXTRACT_METHOD_CONFLICT) and its record UPDATE is overwrite-
  // guarded, so the column can never silently change hands. Same
  // constant-derived CHECK as status above.
  await client.query(`
    ALTER TABLE source_documents
      ADD COLUMN IF NOT EXISTS extract_method text NULL`);
  await client.query(`
    DO $$
    BEGIN
      ALTER TABLE source_documents
        ADD CONSTRAINT source_documents_extract_method_check
        CHECK (extract_method IN (${sqlTextList(EXTRACT_METHODS)}));
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END $$`);
}

/**
 * Forward-compat ALTERs for the operator-console ledger.
 *
 * `chunks` is stage-1 owned; adding `source_doc_id` + `ordinal` keeps the
 * SoR/derived pointer explicit on new writes while leaving existing rows
 * readable (the columns are nullable). Follows the same shape as the
 * `triples.superseded_by` / `triples.evidence_span` forward-compat
 * pattern already in this file.
 */
async function alterChunksBackPointers(
  client: SchemaBootstrapClient
): Promise<void> {
  await client.query(`
    ALTER TABLE chunks
      ADD COLUMN IF NOT EXISTS source_doc_id uuid
      REFERENCES source_documents(id) ON DELETE SET NULL`);
  await client.query(`
    ALTER TABLE chunks
      ADD COLUMN IF NOT EXISTS ordinal integer`);
  // (source_doc_id, ordinal) UNIQUE keeps a re-push from leaving two
  // chunks on the same slice slot. Partial-filtered is not needed —
  // `ordinal` is per-source and the column is nullable for legacy rows.
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS chunks_source_doc_id_ordinal_idx
      ON chunks (source_doc_id, ordinal)`);
}

/**
 * Create all four ledger tables + indexes (plus the projection outbox that rides
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
export async function upSchemaBootstrap(
  client: SchemaBootstrapClient,
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
    await createClaims(client);
    await createExtractionRecords(client);
    await createCommunitySummaries(client, dimensions);
    await createCommunityIndexState(client);
    await createSourceDocuments(client);
    await upSchemaProjection(client);
    // ALTER chunks back-pointers must come after `source_documents` exists
    // (FK target) and after `chunks` itself exists (caller's responsibility —
    // `PgvectorBackend.ensureTable` creates it before invoking us).
    await alterChunksBackPointers(client);
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
