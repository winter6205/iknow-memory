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
import { writeStderr } from "../../logging.js";
import { GraphragError } from "../errors.js";
import { ENTITY_TYPES } from "../extraction/entity-type.js";
import {
  SOURCE_DOC_STATUS,
  EXTRACT_METHODS,
  COMMUNITY_INDEX_STATUS,
  EMBED_ROTATE_MODES,
  INDEX_JOB_STATUS,
  type SourceDocStatus,
} from "../types.js";
import { upSchemaInvalidation } from "./schema-invalidation.js";
import { upSchemaProjection } from "./schema-projection.js";
import { createEvidenceTables } from "./schema-evidence.js";
import { sqlTextList, sqlTextLiteral } from "./schema-sql.js";
import type { SchemaBootstrapClient } from "./schema-sql.js";
import { upSchemaMaintenanceWork } from "./schema-maintenance-work.js";
import { upSchemaPublication } from "./schema-publication.js";
import { acquireSchemaBootstrapLock } from "./schema-lock.js";
export type { SchemaBootstrapClient } from "./schema-sql.js";

/** The three-value 资料 status vocabulary, in declaration order. */
const SOURCE_DOC_STATUS_VALUES: readonly SourceDocStatus[] =
  Object.values(SOURCE_DOC_STATUS);

/** The four-value index-job vocabulary, in declaration order (corpus-index-job T2). */
const INDEX_JOB_STATUS_VALUES: readonly string[] =
  Object.values(INDEX_JOB_STATUS);

/**
 * entities: canonical entity rows (+ soft-merge columns, #6 Q1-Q2).
 *
 * `dimensions` is the configured embedding width (from GRAPHRAG_MEMORY_EMBED_DIMENSIONS,
 * defaults to 2048) — the SAME value as `chunks.embedding vector(N)`. The
 * entities.embedding column must match chunks.embedding width so vector
 * writes into either table share one dimension contract (specs/p0-schema.md
 * #6 Q1: N = chunks embedding dim).
 *
 * The type CHECK is a single source: its literal list is derived from
 * `ENTITY_TYPES` (extraction/entity-type.ts) — the same constant the
 * normalize-on-write mapper admits — so a taxonomy change can never leave
 * the DDL rejecting (or admitting) values the writers disagree with
 * (entity-type-and-filter review C1).
 */
async function createEntities(
  client: SchemaBootstrapClient,
  dimensions: number
): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS entities (
      id            uuid PRIMARY KEY,
      canonical_name text NOT NULL,
      type          text NOT NULL CONSTRAINT entities_type_closed_check
                      CHECK (type IN (${sqlTextList(ENTITY_TYPES)})),
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

/**
 * Closed-set CHECK upgrade for EXISTING databases (entity-type-and-filter
 * review C1). `CREATE TABLE IF NOT EXISTS` only protects fresh stores: a
 * deployed `entities` still carries the shipped legacy CHECK
 * (`'person','concept','system','event'`), which admits rows persist now
 * refuses and rejects the new types `organization`/`place`.
 *
 * why=operator-approved destructive upgrade: the review explicitly
 * authorized HARD-deleting existing rows whose type falls outside the closed
 * set — a re-extract rebuilds them with a legal type, and keeping rows the
 * CHECK cannot admit would fail validation on the ADD CONSTRAINT below.
 * FK posture per table, so the DELETE order is load-bearing:
 *   - `triples.head_id/tail_id` are ON DELETE RESTRICT — the referencing
 *     edges are deleted first (an edge dangling off a removed concept is
 *     meaningless under the closed set);
 *   - `entity_aliases.entity_id` and `claims.entity_id` are ON DELETE
 *     CASCADE — removed with their row, no manual step;
 *   - `entities.merged_into` is ON DELETE SET NULL — a surviving row that
 *     pointed at a deleted loser simply loses the audit pointer (no
 *     dangling reference);
 *   - `projection_outbox` carries no FK by design (Neo4j drain re-reads it),
 *     and `community_summaries.entity_ids` is an unenforced uuid[] — both
 *     self-heal on the next community generation / projection drain.
 *
 * The replacement is idempotent and named `entities_type_closed_check`: the
 * readiness probe (schema-lock.ts) treats its presence as the marker that
 * this upgrade already ran, so a legacy database is "not ready" until the
 * swap happened. The destructive DELETEs are additionally gated on the live
 * catalog — they run only when the legacy `entities_type_check` is actually
 * present — so a fresh or already-upgraded store (and the unit tests'
 * recording fake, whose catalog reads come back empty) emits no data-level
 * writes at all: bootstrap keeps its "dry-run writes nothing" contract.
 */
async function upgradeEntitiesTypeCheck(
  client: SchemaBootstrapClient
): Promise<{ deletedTriples: number; deletedEntities: number } | undefined> {
  const closed = sqlTextList(ENTITY_TYPES);
  const { rows } = await client.query(
    `SELECT k.conname
       FROM pg_constraint k
       JOIN pg_class t ON t.oid = k.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = current_schema()
        AND t.relname = 'entities'
        AND k.conname IN ('entities_type_check', 'entities_type_closed_check')`
  );
  const names = new Set(
    rows.map((row) => (row as { conname: string }).conname)
  );
  // Fresh CREATE already pinned the closed set; an upgraded store carries
  // the new name — either way there is nothing to migrate.
  if (names.has("entities_type_closed_check")) return undefined;
  let deletedTriples = 0;
  let deletedEntities = 0;
  if (names.has("entities_type_check")) {
    // RETURNING ids keep the destructive leg auditable: the caller logs the
    // row counts after COMMIT (audit-trail rule for data deletion).
    deletedTriples = (
      await client.query(`
      DELETE FROM triples
       WHERE head_id IN (SELECT id FROM entities WHERE type NOT IN (${closed}))
          OR tail_id IN (SELECT id FROM entities WHERE type NOT IN (${closed}))
      RETURNING id`)
    ).rows.length;
    deletedEntities = (
      await client.query(`
      DELETE FROM entities WHERE type NOT IN (${closed}) RETURNING id`)
    ).rows.length;
    // The legacy inline CHECK carries Postgres' auto-generated name.
    await client.query(`
      ALTER TABLE entities DROP CONSTRAINT IF EXISTS entities_type_check`);
  }
  await client.query(`
    DO $$
    BEGIN
      ALTER TABLE entities
        ADD CONSTRAINT entities_type_closed_check
        CHECK (type IN (${closed}));
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END $$`);
  return { deletedTriples, deletedEntities };
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
      created_at     timestamptz NOT NULL DEFAULT now(),
      proposed_payload jsonb NULL,
      discarded_at   timestamptz NULL
    )`);
  // extract-verify T1 forward-compat ALTER: deployments whose
  // extraction_records predates the judge gate get the reviewable proposal
  // column (proposed triples + per-triple verdicts on judge-failed legs).
  await client.query(`
    ALTER TABLE extraction_records
      ADD COLUMN IF NOT EXISTS proposed_payload jsonb NULL`);
  // extract-verify T2 forward-compat ALTER: a discarded review record keeps
  // its `failed` status (the status CHECK is a closed vocabulary) and leaves
  // the maintenance lane via this stamp instead.
  await client.query(`
    ALTER TABLE extraction_records
      ADD COLUMN IF NOT EXISTS discarded_at timestamptz NULL`);
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
): Promise<{ deletedLegacyRows: number }> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS community_summaries (
      id           uuid PRIMARY KEY,
      community_id text NOT NULL UNIQUE,
      summary      text NOT NULL,
      entity_ids   uuid[] NOT NULL,
      level        integer NOT NULL,
      embedding    vector(${dimensions}) NOT NULL,
      created_at   timestamptz NOT NULL DEFAULT now(),
      updated_at   timestamptz NOT NULL DEFAULT now()
    )`);
  // Forward-compat for deployed stores (specs/community-level.md): a
  // "larger = finer" product-scale level the retrieve cap filters on.
  // Legacy rows carry no level and are derived data the community-summary
  // CLI rebuilds wholesale, so the upgrade wipes them (spec assumption 2,
  // operator-approved) instead of guessing a grain. The destructive leg is
  // gated on a live probe so a fresh or already-upgraded store (and the
  // recording fakes, whose reads come back empty) emits no data-level
  // write at all — the same contract as upgradeEntitiesTypeCheck.
  await client.query(`
    ALTER TABLE community_summaries
      ADD COLUMN IF NOT EXISTS level integer`);
  let deletedLegacyRows = 0;
  const legacy = await client.query(
    `SELECT 1 FROM community_summaries WHERE level IS NULL LIMIT 1`
  );
  if (legacy.rows.length > 0) {
    // RETURNING keeps the wipe auditable: the caller logs the count after
    // COMMIT, so a rolled-back attempt cannot fake a deletion.
    const wiped = await client.query(`
      DELETE FROM community_summaries WHERE level IS NULL RETURNING id`);
    deletedLegacyRows = wiped.rows.length;
  }
  // No-op when the column already carries the constraint (fresh CREATE or
  // an upgraded store), so this stays idempotent like the ADD above.
  await client.query(`
    ALTER TABLE community_summaries ALTER COLUMN level SET NOT NULL`);
  await client.query(`
    CREATE INDEX IF NOT EXISTS community_summaries_embedding_idx
      ON community_summaries USING hnsw (embedding vector_cosine_ops)`);
  return { deletedLegacyRows };
}

/**
 * community_index_state: the corpus-level C-ready (就绪) singleton written
 * by the community-summary CLI (graph-index-standard-fast T5) and demoted
 * READY → STALE by the extract pipeline whenever a chunk transaction
 * actually persists graph rows (T5 review gap).
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
 * embedding_generation: the singleton pointer for the stored vector
 * generation (embedding generation rotate T1; specs/embedding-generation.md).
 *
 * One row (CHECK id = 1) records the ACTIVE physical vector column plus the
 * optional INCOMING slot of an open rotate, each with its own (model,
 * dimensions). All three vector classes — chunks, entities,
 * community_summaries — share this one pointer; cutover flips them together
 * and reads never mix slots. The columns live beside the singleton because
 * adding one is an operator rotate (openRotate), never a silent boot align.
 * `rotate_mode` derives its CHECK from EMBED_ROTATE_MODES (types.ts), same
 * constant-side doctrine as `community_index_state.status`.
 */
async function createEmbeddingGeneration(
  client: SchemaBootstrapClient
): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS embedding_generation (
      id                  integer PRIMARY KEY CHECK (id = 1),
      active_slot         text NOT NULL,
      active_model        text NULL,
      active_dimensions   integer NOT NULL,
      incoming_slot       text NULL,
      incoming_model      text NULL,
      incoming_dimensions integer NULL,
      rotate_mode         text NULL
                            CHECK (rotate_mode IN (${sqlTextList(EMBED_ROTATE_MODES)})),
      updated_at          timestamptz NOT NULL DEFAULT now()
    )`);
  // T4 rollback columns. A deployed store already has the table, so its
  // shape evolves HERE (the singleton's one DDL home) via guarded ADDs —
  // CREATE IF NOT EXISTS alone would never reach it.
  await client.query(
    "ALTER TABLE embedding_generation ADD COLUMN IF NOT EXISTS rollback_slot text NULL"
  );
  await client.query(
    "ALTER TABLE embedding_generation ADD COLUMN IF NOT EXISTS rollback_model text NULL"
  );
  await client.query(
    "ALTER TABLE embedding_generation ADD COLUMN IF NOT EXISTS rollback_dimensions integer NULL"
  );
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
  // corpus-index-job T2: the durable submit identity. `content_identity` is
  // the document-level version the (source_ref, content_identity) idempotency
  // pair keys on. Nullable because legacy rows predate the column — the next
  // push backfills it — so the ALTER cannot be NOT NULL.
  await client.query(`
    ALTER TABLE source_documents
      ADD COLUMN IF NOT EXISTS content_identity text NULL`);
  // The pair is the index-job submission key. `source_ref` is already UNIQUE
  // so this composite cannot admit a duplicate today, but naming the pair as
  // a constraint is the storage-boundary record of the idempotency contract.
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS source_documents_source_ref_content_identity_idx
      ON source_documents (source_ref, content_identity)`);
}

/**
 * index_jobs: the durable corpus index-job ledger (corpus-index-job T2).
 *
 * One row per (source_ref, content_identity) submission, keyed by the
 * derived `job_id` so a repeat submit resolves to the same job instead of
 * a second one. `status` reuses the four C-ready words (`INDEX_JOB_STATUS`):
 * queued-vs-running is `started_at IS NULL`, never a fifth state word, so
 * the CHECK derives its literal list from the constant the writers use —
 * the same doctrine as `source_documents_status_check`. `failure_code` sits
 * beside `status` exactly as in `community_index_state`.
 */
async function createIndexJobs(client: SchemaBootstrapClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS index_jobs (
      job_id           text PRIMARY KEY,
      source_ref       text NOT NULL,
      content_identity text NOT NULL,
      status           text NOT NULL,
      failure_code     text NULL,
      created_at       timestamptz NOT NULL DEFAULT now(),
      started_at       timestamptz NULL,
      finished_at      timestamptz NULL
    )`);
  await client.query(`
    DO $$
    BEGIN
      ALTER TABLE index_jobs
        ADD CONSTRAINT index_jobs_status_check
        CHECK (status IN (${sqlTextList(INDEX_JOB_STATUS_VALUES)}));
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END $$`);
  // The active-job lookup the submit seam makes on every request.
  await client.query(`
    CREATE INDEX IF NOT EXISTS index_jobs_source_ref_status_idx
      ON index_jobs (source_ref, status)`);
  // One live job per source, enforced at the source of truth: the submit
  // seam's read-then-write leaves a window where two conflicting submits both
  // see no active row, and only this index closes it. Terminal rows
  // (`ready`/`failed`/`stale`) are outside the predicate, so history is
  // unlimited while `in_progress` is singular (decision 3's per-source
  // binding). The literal rides the same constant the CHECK and the writers
  // use, so the predicate cannot drift from the vocabulary.
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS index_jobs_one_active_per_source_idx
      ON index_jobs (source_ref)
      WHERE status = ${sqlTextLiteral(INDEX_JOB_STATUS.IN_PROGRESS)}`);
}

/**
 * The two persistent structured-result identity tables (structured corpus
 * query, Q-ID).
 *
 * `structured_entity_identities` records the entity result identity — the
 * EXISTING `entities.id` UUID, which the entity table mints and which this
 * ticket deliberately does not re-derive. It is a registry row, not a second
 * identity scheme: the FK is what makes "an entity result has its persistent
 * UUID" checkable, and the type CHECK renders its literal list from
 * `ENTITY_TYPES` exactly as `createEntities` does, so the registry's vocabulary
 * cannot drift from the one the persist boundary already admits.
 *
 * `structured_relation_assertion_identities` holds one row per exact normalized
 * tuple `(head_entity_id, relation_norm, tail_entity_id, valid_window)`. The
 * `assertion_id` is DERIVED from that tuple (src/core/structured/identity.ts),
 * so the primary key is itself the exact-tuple key: re-registering the same
 * tuple resolves to the same id instead of a second row, and a CHANGED tuple
 * derives a new id — a versioned correction, never a merge by overlap,
 * similarity, or recency. `tuple_digest` is the sha256 of the canonical
 * length-prefixed serialization, and its UNIQUE index (scoped by
 * `identity_version`, so a corrected version cannot collide with the identity it
 * corrects) is the independent database-side guard on that rule.
 *
 * `valid_from` / `valid_until` are `text`, not `timestamptz`: the canonical
 * whole-second UTC string IS the identity input, and a timestamptz column would
 * re-render through the session TimeZone, so a stored row could no longer be
 * compared byte-for-byte against the serialization its id came from. The two
 * shape CHECKs keep that canonical form, and the ordering CHECK uses an explicit
 * `COLLATE "C"` comparison because both endpoints are fixed-width UTC — without
 * it the comparison would follow the database's collation instead of byte order.
 * `null` is the unbounded endpoint, so the ordering CHECK is satisfied whenever
 * either side is null.
 */
async function createStructuredIdentities(
  client: SchemaBootstrapClient
): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS structured_entity_identities (
      entity_id   uuid PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
      entity_type text NOT NULL
    )`);
  await client.query(`
    DO $$
    BEGIN
      ALTER TABLE structured_entity_identities
        ADD CONSTRAINT structured_entity_identities_type_check
        CHECK (entity_type IN (${sqlTextList(ENTITY_TYPES)}));
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END $$`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS structured_relation_assertion_identities (
      assertion_id     uuid PRIMARY KEY,
      head_entity_id   uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      relation_norm    text NOT NULL,
      tail_entity_id   uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      valid_from       text NULL,
      valid_until      text NULL,
      tuple_digest     text NOT NULL,
      identity_version integer NOT NULL,
      created_at       timestamptz NOT NULL DEFAULT now()
    )`);
  for (const [column, constraint] of [
    ["valid_from", "structured_relation_assertion_identities_from_shape_check"],
    [
      "valid_until",
      "structured_relation_assertion_identities_until_shape_check",
    ],
  ] as const) {
    await client.query(`
    DO $$
    BEGIN
      ALTER TABLE structured_relation_assertion_identities
        ADD CONSTRAINT ${constraint}
        CHECK (
          ${column} IS NULL
          OR ${column} ~ '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z$'
        );
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END $$`);
  }
  // Half-open and non-empty: with both endpoints present `from < until`, so an
  // empty or reversed interval cannot reach the table even from a raw writer
  // that skipped the normalizer.
  await client.query(`
    DO $$
    BEGIN
      ALTER TABLE structured_relation_assertion_identities
        ADD CONSTRAINT structured_relation_assertion_identities_window_check
        CHECK (
          valid_from IS NULL
          OR valid_until IS NULL
          OR (valid_from COLLATE "C") < (valid_until COLLATE "C")
        );
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END $$`);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS structured_relation_assertion_identities_tuple_idx
      ON structured_relation_assertion_identities (identity_version, tuple_digest)`);
  await client.query(`
    CREATE INDEX IF NOT EXISTS structured_relation_assertion_identities_head_idx
      ON structured_relation_assertion_identities (head_entity_id)`);
  await client.query(`
    CREATE INDEX IF NOT EXISTS structured_relation_assertion_identities_tail_idx
      ON structured_relation_assertion_identities (tail_entity_id)`);
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
 * Audit trail for the operator-approved destructive upgrade paths, written
 * only after COMMIT so a rolled-back attempt cannot fake a deletion.
 */
function logDestructiveUpgradeAudits(
  typeCheckAudit:
    { deletedTriples: number; deletedEntities: number } | undefined,
  deletedSummaryLegacyRows: number
): void {
  if (
    typeCheckAudit !== undefined &&
    (typeCheckAudit.deletedTriples > 0 || typeCheckAudit.deletedEntities > 0)
  ) {
    writeStderr(
      `WARN schema-bootstrap entities-type-closed-check upgrade deleted ` +
        `triples=${typeCheckAudit.deletedTriples} ` +
        `entities=${typeCheckAudit.deletedEntities}\n`
    );
  }
  if (deletedSummaryLegacyRows > 0) {
    writeStderr(
      `WARN schema-bootstrap community_summaries level upgrade wiped ` +
        `level-less legacy rows=${deletedSummaryLegacyRows} ` +
        `(rebuild with the community-summary CLI)\n`
    );
  }
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
    // After createTriples: the upgrade's edge cleanup names `triples`.
    const typeCheckAudit = await upgradeEntitiesTypeCheck(client);
    await createClaims(client);
    await createExtractionRecords(client);
    const summaryLevelAudit = await createCommunitySummaries(
      client,
      dimensions
    );
    await createCommunityIndexState(client);
    await createEmbeddingGeneration(client);
    await createSourceDocuments(client);
    await createIndexJobs(client);
    await createStructuredIdentities(client);
    await createEvidenceTables(client);
    // After createEvidenceTables: the outbox's `evidence_ref` is conceptually a
    // grant reference, and it carries no FK to that table (see the module's
    // docblock) — so this is ordering of meaning, not of dependency.
    await upSchemaInvalidation(client);
    await upSchemaProjection(client);
    await upSchemaMaintenanceWork(client);
    await upSchemaPublication(client);
    // ALTER chunks back-pointers must come after `source_documents` exists
    // (FK target) and after `chunks` itself exists (caller's responsibility —
    // `PgvectorBackend.ensureTable` creates it before invoking us).
    await alterChunksBackPointers(client);
    await client.query("COMMIT");
    logDestructiveUpgradeAudits(
      typeCheckAudit,
      summaryLevelAudit.deletedLegacyRows
    );
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
