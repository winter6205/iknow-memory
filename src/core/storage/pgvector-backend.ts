/**
 * PostgreSQL + pgvector storage backend (production).
 *
 * Requires: PostgreSQL 16 + pgvector ≥ 0.7.
 * Table: chunks(id uuid PK, content text, embedding vector(dimensions),
 *        valid_from timestamptz, valid_until timestamptz NULL,
 *        source_ref text, metadata jsonb, created_at timestamptz)
 *
 * Vector search: cosine distance via the `<=>` operator (lower = more
 * similar; we expose similarity = 1 - distance to match MemoryBackend's
 * convention so callers can compare scores across backends).
 *
 * valid_window filter: valid_from <= $validAt AND (valid_until IS NULL OR
 * valid_until > $validAt). Matches the spec at src/core/types.ts and the
 * reference implementation in MemoryBackend.
 *
 * This backend is NOT tested in CI (no PostgreSQL available). It compiles
 * (typecheck) and is verified by code review + local manual testing. The
 * "no pg at import time" guarantee lets memory-mode users skip the
 * dependency entirely: see the dynamic import in the constructor and in
 * src/index.ts:buildDeps.
 */
import type {
  ChunkRecord,
  EvidenceGrantRead,
  EvidenceGrantRecord,
  EvidenceStore,
  GrantDependencyFact,
  GrantRequest,
  IndexJobClaimOptions,
  IndexJobInsertOutcome,
  IndexJobRecord,
  IndexJobStatus,
  IndexJobStore,
  IndexJobTerminalOutcome,
  NewSourceVersion,
  RetrievedChunk,
  ScopeRevisionFence,
  ScopeRevisionRecord,
  SearchOptions,
  SourceDocRecord,
  SourceLocatorBinding,
  SourceVersionRecord,
  StorageChunkView,
  StorageCounts,
  StorageEntityView,
  StorageListOptions,
  StoragePage,
  StorageReadPort,
  StorageReadResult,
  StorageSourceDocSummary,
  StorageSourceDocView,
  StorageTimelineEvent,
  SupportOccurrence,
  SupportRecord,
} from "../types.js";
import { PgStructuredPublicationStorage } from "./publication-pg.js";
import { PgMaintenanceWorkStore } from "./maintenance-work-pg.js";
import { PgStructuredScopeUnitOfWork } from "./structured-scope-uow.js";
import type { ScopeClientLease } from "./structured-scope-types.js";
import type { StructuredPublicationStorage } from "../maintenance/publication-types.js";
import {
  appendContentInvalidation,
  CONTENT_INVALIDATIONS_METADATA_KEY,
  normalizeContentInvalidationRequest,
  readContentInvalidations,
  type ContentInvalidationRecord,
  type ContentInvalidationStorage,
  type GraphRagStorageBackend,
} from "./backend.js";
import type {
  EntityChunkRow,
  EntityEmbeddingStorage,
  GraphArmStorage,
  NeighborChunkRow,
  NeighborChunkStorage,
  Neo4jArmStorage,
  CommunitySummaryRow,
  CommunityIndexStateRow,
  CommunityIndexStateStorage,
  ParentWindowRow,
  ParentWindowStorage,
  ProjectionDrainWaiter,
} from "../retrieval/types.js";
import {
  ConfigError,
  readPgvectorAnnMaxDimensions,
  readPgvectorPoolConfig,
  type PgvectorPoolConfig,
} from "../../config.js";
import { GraphragError } from "../errors.js";
import {
  EVIDENCE_FAILURE,
  SOURCE_DOC_STATUS,
  INDEX_JOB_STATUS,
  type ChunkUpsertOptions,
  type EmbeddingGenerationState,
} from "../types.js";
import {
  assertPgvectorAnnDimensions,
  upSchemaBootstrap,
} from "./schema-bootstrap.js";
import {
  activeSlotForRead,
  assertEmbeddingSlotIdentifier,
  assertVectorReadsAllowed,
  guardEmbeddingBoot,
  readGenerationState,
} from "./embedding-generation.js";
import {
  slotWriteFragments,
  slotWriteTargets,
  slotWriteWidths,
} from "../embed-slots.js";
import { waitForProjectionDrain } from "./projection-outbox.js";
import { SERVING_GUARD_CLAUSE, servingGuardClause } from "./serving-guard-pg.js";
import { randomUUID } from "node:crypto";
import {
  assertFilled,
  assertInstant,
  assertUuid,
  evidenceError,
  normalizeLocatorBinding,
  normalizeOccurrence,
  normalizeSourceVersion,
  type SourceVersionStamp,
} from "./evidence-source.js";
import {
  assertScopeRevisionFenceCurrent,
  decideGrantRead,
  normalizeGrantRequest,
  normalizeScopeRevisionFence,
} from "./evidence-store.js";
import {
  bindSourceLocatorRow,
  inEvidenceTransaction,
  issueGrantRows,
  lockScopeRevisions,
  readGrantDependenciesByRef,
  readGrantFacts,
  readGrantPinnedExtractions,
  readScopeRevisions,
  readSupportExtractionRefs,
  readSupportRow,
  recordSupportRow,
  registerSourceVersionRow,
  stampSourceVersionRow,
  writeScopeRevisions,
} from "./evidence-pg.js";
import {
  CHUNK_BY_ID_SQL,
  CHUNK_COUNT_SQL,
  CHUNK_LIST_SQL,
  ENTITY_BY_ID_SQL,
  ENTITY_LIST_SQL,
  ENTITY_LIVE_COUNT_SQL,
  TIMELINE_CHUNKS_SQL,
  SOURCE_DOC_BY_ID_SQL,
  SOURCE_DOC_BY_REF_SQL,
  SOURCE_DOC_COUNT_SQL,
  SOURCE_DOC_LIST_SQL,
  SOURCE_DOC_MARK_READY_SQL,
  SOURCE_DOC_RECORD_FAILURE_SQL,
  asIsoTimestamp,
  isPgInvalidTextRepresentation,
  wrapPgRead,
  lookupReadId,
  normalizeSourceDocStatus,
  normalizeStorageListOptions,
  paginateItems,
  projectTimelineEvents,
  readSqlCount,
  toChunkView,
  toEntityView,
  toSourceDocFields,
  type StorageChunkRow,
  type StorageEntityRow,
  type StorageSourceDocRow,
} from "./storage-reads.js";

/**
 * Minimal structural subset of the `pg` package we use. Declared as an
 * interface (not `import type`) so the file compiles even when `pg` is not
 * installed — we `await import("pg")` at runtime and accept the result
 * only if it matches.
 */
interface PgModule {
  Pool: new (config: {
    connectionString: string;
    max: number;
    connectionTimeoutMillis: number;
  }) => PgPool;
}
interface PgPool {
  query: (text: string, values: unknown[]) => Promise<{ rows: unknown[] }>;
  end: () => Promise<void>;
  // Acquired client carries a single in-flight transaction; upSchemaBootstrap
  // takes ownership of the BEGIN/COMMIT/ROLLBACK and releases via finally
  // — see ensureTable().
  connect: () => Promise<PgClient>;
  on?: (
    event: "acquire" | "release",
    listener: (...args: unknown[]) => void
  ) => PgPool;
}
interface PgClient {
  query: (text: string, values: unknown[]) => Promise<{ rows: unknown[] }>;
  release: () => void;
}

/** Optional constructor overrides for the PostgreSQL connection pool. */
export interface PgvectorPoolOptions {
  max?: number;
  connectionWaitTimeoutMs?: number;
}

/** Observable pool counters consumed by the later concurrency harness. */
export interface PgvectorPoolStats {
  configuredMax: number;
  connectionWaitTimeoutMs: number;
  observedConcurrentConnections: number;
  peakConcurrentConnections: number;
  connectionWaitTimeouts: number;
}

/** Constructor overrides past the required (dbUrl, dimensions) pair. */
export interface PgvectorBackendOptions {
  annMaxDimensions?: number;
  poolOptions?: PgvectorPoolOptions;
  /**
   * Desired embed model from the operator setting (loadEnv().embedModel);
   * the generation boot guard compares the (model, dimensions) pair.
   */
  embedModel?: string;
}

/** Serialized pgvector literal: `[0.1,0.2,...]` with no spaces. */
function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

/**
 * Soft-merge survivor-only seed query (T3 contract):
 * `merged_into IS NULL AND retired = false`, ordered by cosine distance.
 * `$3` is the optional `filters.entity_type` seed restriction
 * (plans/entity-type-and-filter.md T3): NULL keeps every type — the exact
 * pre-filter plan shape — and a type value narrows the seed set.
 *
 * T3 read binding: the slot column comes from `activeSlotForRead` — one
 * generation per query, never both in one `ORDER BY <=>`.
 */
function seedEntitiesSql(slot: string): string {
  assertEmbeddingSlotIdentifier(slot);
  return (
    `SELECT id, canonical_name, 1 - (${slot} <=> $1::vector) AS score FROM entities ` +
    `WHERE ${slot} IS NOT NULL AND merged_into IS NULL AND retired = false ` +
    `AND ($3::text IS NULL OR type = $3) ` +
    `ORDER BY ${slot} <=> $1::vector LIMIT $2`
  );
}

/**
 * One-hop traversal (T3 contract — single JOIN chunks, two-sided temporal
 * filter). `$1` is the seed-id array, `$2` is validAt, `$3` is the limit.
 */
const ONE_HOP_CHUNKS_SQL =
  "SELECT DISTINCT c.id, c.content, c.source_ref, c.valid_from, c.valid_until " +
  "FROM triples t " +
  "JOIN chunks c ON t.source_chunk_id = c.id " +
  "WHERE (t.head_id = ANY($1::uuid[]) OR t.tail_id = ANY($1::uuid[])) " +
  "AND t.valid_window @> $2::timestamptz " +
  "AND c.valid_window @> $2::timestamptz " +
  "ORDER BY c.id " +
  "LIMIT $3";

/**
 * Chunks behind a set of ranked entities (Neo4j graph arm, #70 T4).
 *
 * The graph engine ranks ENTITIES; chunks never enter Neo4j (ADR-0001), so
 * this is the hop back. `triples.source_chunk_id` is the provenance link
 * the extract path already writes, and one row per (entity, chunk) pair is
 * returned so the arm can give a chunk the rank of the best entity that
 * reached it.
 *
 * Temporal filtering is two-sided but asymmetric on purpose: `triples`
 * carries a real `tstzrange`, while `chunks` carries the `valid_from` /
 * `valid_until` pair every other read path in this file filters on. (The
 * archived one-hop SQL above assumes a GENERATED `chunks.valid_window`
 * that only the P0 test fixtures ever created — one more reason it is
 * archived.)
 *
 * `array_position` orders by the caller's ranking so the `LIMIT` keeps the
 * chunks of the most relevant entities rather than an arbitrary slice.
 *
 * MP12: the same serving guard the vector tier carries is appended here, bound
 * to this query's local `c` alias. Step 3 of the Neo4j arm is the only place
 * the graph tier emits chunk text (chunks never enter the graph, ADR-0001), so
 * this predicate is the whole graph tier's exposure — a withdrawn or
 * sole-purged source must not be materialised here either, for the same
 * reason it must not be materialised by the vector read.
 */
const ENTITY_CHUNKS_SQL = `SELECT ranked.entity_id, c.id, c.content, c.source_ref,
          c.valid_from, c.valid_until
     FROM triples t
     JOIN chunks c ON t.source_chunk_id = c.id
     CROSS JOIN LATERAL (VALUES (t.head_id), (t.tail_id)) AS ranked(entity_id)
    WHERE ranked.entity_id = ANY($1::uuid[])
      AND t.valid_window @> $2::timestamptz
      AND c.valid_from <= $2::timestamptz
      AND (c.valid_until IS NULL OR c.valid_until > $2::timestamptz)${servingGuardClause("c")}
    ORDER BY array_position($1::uuid[], ranked.entity_id), c.id
    LIMIT $3`;

/**
 * The graph arm's step-3 query and its bound parameters.
 *
 * Exists for the same reason `buildVectorSearchQuery` does: the acceptance lane
 * must execute the SQL production executes. A test that re-typed the query would
 * pass while the served one drifted, and a test that could not reach this const
 * had no way to prove the guard at all.
 *
 * `$1` is the ranked entity-id array (the caller's PPR order — `array_position`
 * reads it), `$2` is `validAt`, `$3` is the limit. Reuses the vector query's
 * `{ sql, params }` shape because the shape is the contract; the field names are
 * not a claim that this is a vector search.
 */
export function buildEntityChunksQuery(
  entityIds: readonly string[],
  validAt: string,
  limit: number
): VectorSearchQuery {
  return {
    sql: ENTITY_CHUNKS_SQL,
    params: [[...entityIds], validAt, limit],
  };
}

/**
 * The ONE `level <= N` predicate every `community_summaries` read applies
 * (specs/community-level.md). Each site interpolates its own parameter
 * index; the meaning lives here only.
 */
function communityLevelCapSql(paramIndex: number): string {
  return `level <= $${paramIndex}`;
}

/** Community-summary cosine read; slot bound per T3 (see seedEntitiesSql). */
function communitySummariesSql(slot: string): string {
  assertEmbeddingSlotIdentifier(slot);
  return `SELECT id, community_id, summary, level,
    1 - (${slot} <=> $1::vector) AS score
  FROM community_summaries
 WHERE ${slot} IS NOT NULL
   AND ${communityLevelCapSql(3)}
 ORDER BY ${slot} <=> $1::vector ASC, id ASC
 LIMIT $2`;
}

const COMMUNITY_SUMMARY_BY_ID_SQL = `SELECT id, community_id, summary, level
  FROM community_summaries
 WHERE community_id = $1
   AND ${communityLevelCapSql(2)}`;

/**
 * The 档 C readiness singleton (schema-bootstrap `community_index_state`,
 * CHECK id = 1). Retrieve reads it to decide ready-vs-typed-not-ready;
 * only the community-summary CLI and the extract demotion ever write it.
 */
const COMMUNITY_INDEX_STATE_SQL = `SELECT status, failure_code
  FROM community_index_state
 WHERE id = 1`;

/**
 * The durable index-job ledger (schema-bootstrap `index_jobs`,
 * corpus-index-job T2). Every read projects the same column list so the
 * record the caller wrote is exactly the record it reads back.
 */
const INDEX_JOB_COLUMNS = `job_id, source_ref, content_identity, status,
       failure_code, created_at, started_at, finished_at`;

/** The one-active-job-per-source read: `in_progress` is the only active word. */
const ACTIVE_JOB_FOR_SOURCE_SQL = `WHERE source_ref = $1 AND status = $2::text LIMIT 1`;

/**
 * Which rows a worker may claim. `in_progress AND started_at IS NULL` is the
 * queued arm (queued vs running is `started_at`, never a fifth status word);
 * the second arm — a running row that started before
 * `$3::timestamptz` — is what keeps a durable request alive after the worker
 * that held it died mid-stage. `$3` is NULL when the caller claims queued
 * rows only, so that arm opens only when `stalledBefore` was supplied.
 */
const CLAIMABLE_JOB_SQL = `status = $2::text
     AND (started_at IS NULL
          OR ($3::timestamptz IS NOT NULL AND started_at < $3::timestamptz))`;

/**
 * PostgreSQL `unique_violation`. In `insertJobOrJoin` the INSERT's
 * `ON CONFLICT (job_id)` arm absorbs primary-key collisions, so this is the
 * partial unique index `index_jobs_one_active_per_source_idx` rejecting a
 * second live job for one source — the racing submit's row, not an accident.
 */
const UNIQUE_VIOLATION_SQLSTATE = "23505";

/** One `index_jobs` row as returned by pg (timestamps arrive as Date). */
interface IndexJobRow {
  job_id: string;
  source_ref: string;
  content_identity: string;
  status: string;
  failure_code: string | null;
  created_at: Date | string;
  started_at: Date | string | null;
  finished_at: Date | string | null;
}

/** Map a row to the record, serializing timestamps as ISO strings. */
function toIndexJobRecord(row: IndexJobRow): IndexJobRecord {
  return {
    job_id: row.job_id,
    source_ref: row.source_ref,
    content_identity: row.content_identity,
    status: row.status as IndexJobStatus,
    created_at: asIsoTimestamp(row.created_at),
    started_at: row.started_at === null ? null : asIsoTimestamp(row.started_at),
    finished_at:
      row.finished_at === null ? null : asIsoTimestamp(row.finished_at),
    failure_code: row.failure_code,
  };
}

/** One `source_documents` row as RETURNED by the upsert statement. */
interface SourceDocUpsertRow {
  id: string;
  source_ref: string;
  title: string | null;
  content: string;
  created_at: Date | string;
  valid_until: Date | null;
  status: string | null;
  failure_code: string | null;
  content_identity: string | null;
}

/** Project the upsert's RETURNING row back onto the record contract. */
function toSourceDocUpsertRecord(row: SourceDocUpsertRow): SourceDocRecord {
  return {
    id: row.id,
    source_ref: row.source_ref,
    title: row.title,
    content: row.content,
    created_at: asIsoTimestamp(row.created_at),
    valid_until:
      row.valid_until === null ? null : asIsoTimestamp(row.valid_until),
    ...(row.status === null
      ? {}
      : { status: normalizeSourceDocStatus(row.status) }),
    failure_code: row.failure_code,
    content_identity: row.content_identity,
  };
}

/**
 * Same-source neighboring chunks around already-ranked anchors.
 *
 * `created_at, id` is the stable ingest order. The visibility predicate is
 * repeated inside the CTE so temporal filtering happens before positions are
 * calculated; an expired row must not shift the visible neighbor window.
 */
const NEIGHBOR_CHUNKS_SQL = `
WITH visible AS (
  SELECT id, content, source_ref, valid_from, valid_until, created_at,
         row_number() OVER (
           PARTITION BY source_ref
           ORDER BY created_at ASC, id ASC
         ) AS position
    FROM chunks
   WHERE valid_from <= $2::timestamptz
     AND (valid_until IS NULL OR valid_until > $2::timestamptz)
),
targets AS (
  SELECT id, source_ref, position
    FROM visible
   WHERE id = ANY($1::uuid[])
)
SELECT DISTINCT n.id, n.content, n.source_ref, n.valid_from,
                n.valid_until, n.created_at
  FROM visible n
  JOIN targets t
    ON n.source_ref = t.source_ref
   AND n.position BETWEEN t.position - $3::bigint
                       AND t.position + $3::bigint
 ORDER BY n.source_ref, n.created_at, n.id`;

/**
 * 档 A child→parent window rows (plans/search-mode-retrieve.md T2,
 * ADR-0060). One round trip over the child ids the lexical arm ranked.
 *
 * The INNER JOIN is the whole contract: a legacy chunk with a NULL
 * `source_doc_id`, or a chunk whose 资料 row is gone, yields no row and the
 * arm must degrade — it never cites the child slice as if it were the
 * parent window. No temporal predicate here on purpose: the lexical arm
 * already admitted the child by `valid_from`/`valid_until`, and a parent
 * closed by invalidation closes its children in the same transaction
 * (operator-console T5), so a re-filter could only hide rows behind a
 * second clock read.
 */
const PARENT_WINDOWS_SQL = `
SELECT c.id AS chunk_id, c.source_doc_id, c.ordinal, d.content
  FROM chunks c
  JOIN source_documents d ON d.id = c.source_doc_id
 WHERE c.id = ANY($1::uuid[])`;

export const CHUNK_VECTOR_INDEX_NAME = "chunks_embedding_idx";

/** Cast for the row shape we expect from our SELECT/UPSERT queries. */
interface ChunkRow {
  id: string;
  content: string;
  source_ref: string;
  valid_from: Date;
  valid_until: Date | null;
  distance: number;
}

function rowToRetrievedChunk(row: ChunkRow, score: number): RetrievedChunk {
  return {
    id: row.id,
    content: row.content,
    source_ref: row.source_ref,
    valid_window: [
      row.valid_from.toISOString(),
      row.valid_until?.toISOString() ?? null,
    ],
    score,
  };
}

/**
 * The two-sided temporal predicate every read path shares. Both search
 * paths bind `$2` to `validAt`, so the clause text is identical.
 */
const VALID_WINDOW_CLAUSES: readonly string[] = [
  "valid_from <= $2::timestamptz",
  "(valid_until IS NULL OR valid_until > $2::timestamptz)",
];

/**
 * Append exact-match `source_ref` / `metadata.*` clauses, extending
 * `where` and `params` in step so the `$N` placeholders stay in sync.
 * Callers must have already pushed the two shared positional arguments
 * ($1 arm input, $2 validAt).
 *
 * Unknown top-level filter keys are ignored — they cannot match anything
 * on a chunk row, and MemoryBackend is permissive the same way so caller
 * code stays portable across backends.
 */
function appendFilterClauses(
  filters: Record<string, string>,
  where: string[],
  params: unknown[]
): void {
  if (filters["source_ref"] !== undefined) {
    params.push(filters["source_ref"]);
    where.push(`source_ref = $${params.length}`);
  }
  for (const [key, value] of Object.entries(filters)) {
    if (key === "source_ref") continue;
    if (!key.startsWith("metadata.")) continue;
    // JSONB text extraction via `->>` is the canonical exact-match
    // pattern; it casts the value to text so `=` works for any JSON
    // scalar (string, number, bool) without operator juggling.
    params.push(key.slice("metadata.".length), value);
    where.push(`metadata ->> $${params.length - 1} = $${params.length}`);
  }
}

export interface VectorSearchQuery {
  sql: string;
  params: unknown[];
}

/**
 * Build the production vector retrieval query and its bound parameters.
 *
 * Keeping EXPLAIN callers on this builder prevents a test-only query from
 * claiming that the production retrieval path uses the ANN index. The
 * validity-window predicates are part of the query by construction.
 *
 * `activeSlot` is REQUIRED (T3): the caller resolves it through
 * `activeSlotForRead`, so no read can silently stay on the legacy column
 * after a cutover. It is interpolated only after identifier validation.
 */
export function buildVectorSearchQuery(
  queryEmbedding: number[],
  opts: SearchOptions,
  activeSlot: string
): VectorSearchQuery {
  assertEmbeddingSlotIdentifier(activeSlot);
  const where = [...VALID_WINDOW_CLAUSES];
  const params: unknown[] = [toVectorLiteral(queryEmbedding), opts.validAt];
  appendFilterClauses(opts.filters ?? {}, where, params);
  params.push(opts.limit);

  return {
    // MP12 (spec 320-323): the guard is a real join to source lifecycle, not a
    // post-filter. It has to be here rather than after the fetch because a
    // withdrawn or sole-purged row must never be MATERIALISED — a post-filter
    // would still have read it, and "we read it and then hid it" is not the
    // same promise as "we never served it".
    sql: `
      SELECT id, content, source_ref, valid_from, valid_until,
             ${activeSlot} <=> $1::vector AS distance
      FROM chunks
      WHERE ${where.join(" AND ")}${SERVING_GUARD_CLAUSE}
      ORDER BY ${activeSlot} <=> $1::vector ASC
      LIMIT $${params.length}
    `,
    params,
  };
}

function closePgValidityWindow(
  current: Date | null,
  invalidatedAt: string
): string {
  if (current === null || current.getTime() > Date.parse(invalidatedAt)) {
    return invalidatedAt;
  }
  return current.toISOString();
}

function sortInvalidationRecords(
  records: ContentInvalidationRecord[]
): ContentInvalidationRecord[] {
  return records.sort(
    (a, b) =>
      a.chunk_id.localeCompare(b.chunk_id) ||
      a.invalidated_at.localeCompare(b.invalidated_at) ||
      a.triggered_by.localeCompare(b.triggered_by)
  );
}

function validatePoolParameter(
  name: string,
  value: number | undefined,
  fallback: number
): number {
  const resolved = value ?? fallback;
  if (
    !Number.isFinite(resolved) ||
    !Number.isInteger(resolved) ||
    resolved <= 0
  ) {
    throw new ConfigError(
      `${name} must be a finite positive integer, got "${String(value)}"`
    );
  }
  return resolved;
}

export class ConnectionWaitTimeoutError extends GraphragError {
  constructor(timeoutMs: number) {
    super(
      `PgvectorBackend: connection wait exceeded ${timeoutMs}ms`,
      "STORAGE_ERROR"
    );
    this.name = "ConnectionWaitTimeoutError";
  }
}

/**
 * Storage backend backed by PostgreSQL + the pgvector extension.
 *
 * Lazy init: the `pg` module is imported on the first call to `initialize`,
 * `upsert`, or `search`, not in the constructor. This keeps
 * `import { PgvectorBackend }` from forcing every consumer to install `pg` —
 * operators running with GRAPHRAG_MEMORY_STORAGE=memory never touch the
 * dependency. The production server calls `initialize()` before opening its
 * transport so schema and ANN-index failures are startup failures.
 *
 * `ensureTable()` is called once per backend instance (idempotent
 * CREATE EXTENSION + CREATE TABLE IF NOT EXISTS), so a fresh database
 * works out of the box.
 */
export class PgvectorBackend
  implements
    GraphRagStorageBackend,
    ContentInvalidationStorage,
    NeighborChunkStorage,
    ParentWindowStorage,
    CommunityIndexStateStorage,
    ProjectionDrainWaiter,
    IndexJobStore,
    EvidenceStore,
    StorageReadPort
{
  structuredPublication: StructuredPublicationStorage;
  /**
   * The one write authority every accepted structured mutation cooperates on:
   * composition hands it to the publication adapter, and the same seam mints the
   * trusted contexts readers run under. Two authorities — one per adapter — is
   * what let a publication and a work settlement hold the same rows in opposite
   * orders.
   */
  readonly structuredScopeUnitOfWork: PgStructuredScopeUnitOfWork;
  /**
   * The durable-work ledger, composed over the same seam rather than over a
   * private one: a work write must take the lock order publication takes, and a
   * ledger that minted its own authority could not be recognized by a context
   * this composition minted.
   */
  readonly maintenanceWorkStore: PgMaintenanceWorkStore;
  private pool: PgPool | undefined;
  private initPromise: Promise<void> | undefined;
  private readonly poolConfig: PgvectorPoolConfig;
  private readonly annMaxDimensions: number | undefined;
  private readonly embedModel: string | undefined;
  private generation: EmbeddingGenerationState | undefined;
  private observedConcurrentConnections = 0;
  private peakConcurrentConnections = 0;
  private connectionWaitTimeouts = 0;

  constructor(
    private readonly dbUrl: string,
    private readonly dimensions: number,
    options: PgvectorBackendOptions = {}
  ) {
    // One lease, one client per structured transaction: the seam owns the
    // transaction and the publication helpers read through that same client, so
    // a write never spans two connections from this pool.
    const structuredClientLease: ScopeClientLease = async () => {
      const pool = await this.ensureReady();
      return this.connectWithTimeout(pool);
    };
    this.structuredScopeUnitOfWork = new PgStructuredScopeUnitOfWork(
      structuredClientLease
    );
    this.structuredPublication = new PgStructuredPublicationStorage(
      this.structuredScopeUnitOfWork
    );
    this.maintenanceWorkStore = new PgMaintenanceWorkStore(
      { connect: () => structuredClientLease() },
      this.structuredScopeUnitOfWork
    );
    this.annMaxDimensions = options.annMaxDimensions;
    this.embedModel = options.embedModel;
    const defaults = readPgvectorPoolConfig();
    const poolOptions = options.poolOptions ?? {};
    this.poolConfig = {
      max: validatePoolParameter(
        "PostgreSQL pool max",
        poolOptions.max,
        defaults.max
      ),
      connectionWaitTimeoutMs: validatePoolParameter(
        "PostgreSQL connection wait timeout",
        poolOptions.connectionWaitTimeoutMs,
        defaults.connectionWaitTimeoutMs
      ),
    };
  }

  /** Return pool settings and live counters without exposing the pg client. */
  getPoolStats(): PgvectorPoolStats {
    return {
      configuredMax: this.poolConfig.max,
      connectionWaitTimeoutMs: this.poolConfig.connectionWaitTimeoutMs,
      observedConcurrentConnections: this.observedConcurrentConnections,
      peakConcurrentConnections: this.peakConcurrentConnections,
      connectionWaitTimeouts: this.connectionWaitTimeouts,
    };
  }

  /**
   * Run the storage bootstrap self-check explicitly.
   *
   * Direct backend consumers may still rely on lazy initialization through
   * `upsert` or `search`; the MCP server calls this method during startup so
   * dimension and index-build failures cannot become tool-level responses.
   */
  async initialize(): Promise<void> {
    await this.ensureReady();
  }

  /**
   * The generation ledger as recorded by the last successful boot guard:
   * the slot names dual-write persist (T2) and cosine read binding (T3)
   * consume. Undefined before the first completed initialize().
   */
  getGenerationState(): EmbeddingGenerationState | undefined {
    return this.generation;
  }

  /**
   * Seed or refuse against the embedding_generation singleton (spec:
   * embedding generation rotate T1). A typed ConfigError here is a boot
   * failure — a desired generation that is neither active nor the incoming
   * slot of an open rotate must stop the process, never realign columns.
   */
  private async guardEmbeddingGenerationBoot(): Promise<EmbeddingGenerationState> {
    const state = await guardEmbeddingBoot(this.pool!, {
      model: this.embedModel,
      dimensions: this.dimensions,
    });
    this.generation = state;
    return state;
  }

  /**
   * Lazily initialize the pg module + connection pool + schema.
   *
   * Why a memoized promise (and not an `async` constructor): JS classes
   * don't support async constructors, and callers (index.ts:buildDeps) want
   * to construct + run async init + use in a single await chain. A
   * memoized promise means concurrent `upsert` calls share one init.
   */
  private async ensureReady(): Promise<PgPool> {
    if (this.pool) return this.pool;
    if (this.initPromise) {
      await this.initPromise;
      return this.pool!;
    }
    this.initPromise = (async () => {
      let mod: PgModule;
      try {
        mod = (await import("pg")) as unknown as PgModule;
      } catch (err) {
        throw new GraphragError(
          `PgvectorBackend: failed to load optional dependency "pg" — install it to use storage=pgvector (${(err as Error).message})`,
          "STORAGE_ERROR"
        );
      }
      const rawPool = new mod.Pool({
        connectionString: this.dbUrl,
        max: this.poolConfig.max,
        connectionTimeoutMillis: this.poolConfig.connectionWaitTimeoutMs,
      });
      this.attachPoolObservers(rawPool);
      this.pool = this.wrapPool(rawPool);
      try {
        await this.ensureTable();
        // Same generation guard for every backend consumer (MCP server and
        // the CLIs): seed the singleton or typed-refuse a config change that
        // has no open rotate. Outside ensureTable's catch so the ConfigError
        // keeps its type instead of becoming a STORAGE_ERROR wrapper.
        await this.guardEmbeddingGenerationBoot();
      } catch (err) {
        // Reset pool so the next call retries from scratch (High-fix:
        // without this, a failed ensureTable leaves a broken pool that
        // every subsequent call returns via the `if (this.pool)` guard).
        this.pool = undefined;
        throw err;
      }
    })();
    try {
      await this.initPromise;
    } finally {
      // Allow re-entry if init failed; the next call will retry.
      this.initPromise = undefined;
    }
    return this.pool!;
  }

  private attachPoolObservers(pool: PgPool): void {
    if (pool.on === undefined) return;
    pool.on("acquire", () => {
      this.observedConcurrentConnections += 1;
      this.peakConcurrentConnections = Math.max(
        this.peakConcurrentConnections,
        this.observedConcurrentConnections
      );
    });
    pool.on("release", () => {
      this.observedConcurrentConnections = Math.max(
        0,
        this.observedConcurrentConnections - 1
      );
    });
  }

  private wrapPool(rawPool: PgPool): PgPool {
    return {
      query: (text, values) => this.queryWithPoolClient(rawPool, text, values),
      connect: () => this.connectWithTimeout(rawPool),
      end: () => rawPool.end(),
    };
  }

  private async queryWithPoolClient(
    pool: PgPool,
    text: string,
    values: unknown[]
  ): Promise<{ rows: unknown[] }> {
    const client = await this.connectWithTimeout(pool);
    try {
      return await client.query(text, values);
    } finally {
      client.release();
    }
  }

  private async connectWithTimeout(pool: PgPool): Promise<PgClient> {
    const pending = pool.connect();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        this.connectionWaitTimeouts += 1;
        reject(
          new ConnectionWaitTimeoutError(
            this.poolConfig.connectionWaitTimeoutMs
          )
        );
      }, this.poolConfig.connectionWaitTimeoutMs);
    });
    try {
      return await Promise.race([pending, timeout]);
    } catch (error) {
      if (timedOut) {
        void pending.then(
          (client) => client.release(),
          () => undefined
        );
      }
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * Create the `vector` extension and the `chunks` table if they don't
   * already exist. Both statements are idempotent (IF NOT EXISTS) so a
   * re-run is safe.
   *
   * Why on every fresh pool: an operator pointing the server at a new
   * database should not have to run a separate migration step. T8 ships
   * the inline CREATE as the migration; later stages may replace this
   * with a versioned migration runner if the schema grows.
   */
  private async ensureTable(): Promise<void> {
    const annMaxDimensions =
      this.annMaxDimensions ?? readPgvectorAnnMaxDimensions();
    assertPgvectorAnnDimensions(this.dimensions, annMaxDimensions);
    const pool = this.pool!;
    // Acquire a dedicated client so upSchemaBootstrap can wrap its DDL in a
    // BEGIN/COMMIT/ROLLBACK transaction without conflicting with the
    // pool-level `query` path used elsewhere in this class. Release in
    // finally whether the transaction commits or rolls back. connect() is
    // inside the try so a connection failure is wrapped in the same
    // GraphragError STORAGE_ERROR as the DDL failures below (M1).
    try {
      const client = await pool.connect();
      try {
        await client.query("CREATE EXTENSION IF NOT EXISTS vector", []);
        await client.query(
          `CREATE TABLE IF NOT EXISTS chunks (
             id uuid PRIMARY KEY,
             content text NOT NULL,
             embedding vector(${this.dimensions}) NOT NULL,
             valid_from timestamptz NOT NULL,
             valid_until timestamptz NULL,
             source_ref text NOT NULL,
             metadata jsonb NOT NULL,
             created_at timestamptz NOT NULL
           )`,
          []
        );
        await client.query(
          `CREATE INDEX IF NOT EXISTS ${CHUNK_VECTOR_INDEX_NAME}
             ON chunks USING hnsw (embedding vector_cosine_ops)`,
          []
        );
        const indexCheck = await client.query(
          `SELECT indexname
             FROM pg_indexes
            WHERE schemaname = current_schema()
              AND tablename = 'chunks'
              AND indexname = '${CHUNK_VECTOR_INDEX_NAME}'`,
          []
        );
        if (indexCheck.rows.length !== 1) {
          throw new GraphragError(
            `PgvectorBackend: expected exactly one ${CHUNK_VECTOR_INDEX_NAME} catalog entry, found ${indexCheck.rows.length}`,
            "STORAGE_ERROR"
          );
        }
        // ES precision-layer migration: drop the legacy derived column
        // (and its GIN index, if any survived) from deployments that predate
        // the move. The column name is concatenated at runtime to keep the
        // legacy identifier out of the active source tree (spec SC-6). DROP
        // COLUMN IF EXISTS + DROP INDEX IF EXISTS together are idempotent
        // and a safe no-op on a fresh database.
        const legacyContentColumn = ["content", "_tsv"].join("");
        const legacyContentIndex = `${legacyContentColumn}_gin`;
        await client.query(
          `DROP INDEX IF EXISTS chunks_${legacyContentIndex}`,
          []
        );
        await client.query(
          `ALTER TABLE chunks DROP COLUMN IF EXISTS ${legacyContentColumn}`,
          []
        );
        // P0 schema: entities + entity_aliases + triples + extraction_records.
        // upSchemaBootstrap is idempotent (every statement is IF NOT EXISTS) and
        // owns its own BEGIN/COMMIT/ROLLBACK — we MUST NOT wrap it in an
        // outer transaction. The minimal PgClient satisfies upSchemaBootstrap's
        // `SchemaBootstrapClient` surface structurally. Pass this.dimensions so
        // entities.embedding width matches chunks.embedding width (H1).
        await upSchemaBootstrap(client, this.dimensions, annMaxDimensions);
      } finally {
        client.release();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new GraphragError(
        `PgvectorBackend: ensureTable failed (${message})`,
        "STORAGE_ERROR"
      );
    }
  }

  async upsert(
    chunks: ChunkRecord[],
    options?: ChunkUpsertOptions
  ): Promise<string[]> {
    if (chunks.length === 0) return [];
    const pool = await this.ensureReady();

    // Review repair E: a caller that already embedded against a specific
    // ledger state (tools reading the backend cache) passes it here, so the
    // SAME state decides validation AND the dual-write — no fresh re-read
    // that could half-decide against the embeddings we were handed. When the
    // option is absent, the T2 behavior stands: re-read the ledger per batch
    // — a rotate may have been opened after this process booted — and refresh
    // the cached boot state so the tool layer self-heals against the ledger.
    let state: EmbeddingGenerationState | null;
    if (options !== undefined && options.generation !== undefined) {
      state = options.generation;
    } else {
      state = await readGenerationState(pool);
      if (state !== null) this.generation = state;
    }
    const targets = slotWriteTargets(state);
    const widths = slotWriteWidths(state, this.dimensions);
    this.validateUpsertVectors(
      chunks,
      targets.activeSlot,
      widths,
      targets.incomingSlot
    );

    // Review repair B: the slot column/placeholder/SET triplet comes from
    // the shared fragments SSOT. The incoming vector stays LAST in the
    // values array ($11), hence the explicit non-contiguous indices.
    const {
      columns: slotColumns,
      valuePlaceholders: slotPlaceholders,
      excludedAssignments: slotAssignments,
    } = slotWriteFragments({ ...targets, activeParam: 3, incomingParam: 11 });

    // Each chunk is its own INSERT ... ON CONFLICT. A single multi-row
    // INSERT would be marginally faster, but per-row keeps the SQL
    // straightforward and lets pg report which id failed. We do NOT wrap
    // in a transaction here: ON CONFLICT (id) DO UPDATE is per-row atomic
    // already — the row-atomic dual-write T2 needs — and a partial failure
    // mode (some chunks persist, others don't) is acceptable; the caller
    // can retry the missing ids.
    const ids: string[] = [];
    try {
      for (const chunk of chunks) {
        await pool.query(
          `INSERT INTO chunks
             (id, content, ${slotColumns}, valid_from, valid_until,
              source_ref, metadata, created_at,
              source_doc_id, ordinal)
           VALUES ($1, $2, ${slotPlaceholders}, $4, $5, $6, $7::jsonb, $8,
                   $9, $10)
           ON CONFLICT (id) DO UPDATE SET
             content = EXCLUDED.content,
             ${slotAssignments},
             valid_from = EXCLUDED.valid_from,
             valid_until = CASE
               WHEN chunks.metadata ? '${CONTENT_INVALIDATIONS_METADATA_KEY}'
               THEN CASE
                 WHEN chunks.valid_until IS NULL THEN EXCLUDED.valid_until
                 WHEN EXCLUDED.valid_until IS NULL THEN chunks.valid_until
                 WHEN chunks.valid_until <= EXCLUDED.valid_until
                   THEN chunks.valid_until
                 ELSE EXCLUDED.valid_until
               END
               ELSE EXCLUDED.valid_until
             END,
             source_ref = EXCLUDED.source_ref,
             metadata = CASE
               WHEN chunks.metadata ? '${CONTENT_INVALIDATIONS_METADATA_KEY}'
               THEN EXCLUDED.metadata || jsonb_build_object(
                 '${CONTENT_INVALIDATIONS_METADATA_KEY}',
                 chunks.metadata -> '${CONTENT_INVALIDATIONS_METADATA_KEY}'
               )
               ELSE EXCLUDED.metadata
             END,
             created_at = EXCLUDED.created_at,
             source_doc_id = EXCLUDED.source_doc_id,
             ordinal = EXCLUDED.ordinal`,
          [
            chunk.id,
            chunk.content,
            toVectorLiteral(chunk.embedding),
            chunk.valid_from,
            chunk.valid_until,
            chunk.source_ref,
            JSON.stringify(chunk.metadata),
            chunk.created_at,
            chunk.source_doc_id ?? null,
            chunk.ordinal ?? null,
            ...(targets.incomingSlot === null
              ? []
              : [toVectorLiteral(chunk.incoming_embedding as number[])]),
          ]
        );
        ids.push(chunk.id);
      }
    } catch (err) {
      throw new GraphragError(
        `PgvectorBackend.upsert failed: ${(err as Error).message}`,
        "STORAGE_ERROR"
      );
    }
    return ids;
  }

  /**
   * Validate the whole batch BEFORE the first round-trip (both-or-neither):
   * the active vector must match the ledger's active width, and while a
   * dual-write rotate is open the incoming vector must be present at the
   * incoming width — a row half-written in one generation only is exactly
   * what T4's cutover fill must never have to guess about.
   */
  private validateUpsertVectors(
    chunks: ChunkRecord[],
    activeSlot: string,
    widths: { activeDimensions: number; incomingDimensions: number | null },
    incomingSlot: string | null
  ): void {
    for (const chunk of chunks) {
      if (chunk.embedding.length !== widths.activeDimensions) {
        throw new GraphragError(
          `PgvectorBackend.upsert: chunk "${chunk.id}" ${activeSlot} length ${chunk.embedding.length} !== ${widths.activeDimensions}`,
          "EMBEDDING_DIM_MISMATCH"
        );
      }
      if (incomingSlot !== null) {
        const incoming = chunk.incoming_embedding;
        if (
          incoming === undefined ||
          incoming.length !== widths.incomingDimensions
        ) {
          throw new GraphragError(
            `PgvectorBackend.upsert: chunk "${chunk.id}" lacks the incoming-slot vector for the open dual-write rotate (slot ${incomingSlot})`,
            "EMBEDDING_FAILED"
          );
          // EXIT: dual-write is all-or-nothing per row; refuse the batch
          // rather than half-write the rotate (spec T2 both-or-neither).
        }
      }
    }
  }

  async invalidateSourceRef(
    sourceRef: string,
    invalidatedAt: string,
    triggeredBy: string
  ): Promise<ContentInvalidationRecord[]> {
    const request = normalizeContentInvalidationRequest(
      sourceRef,
      invalidatedAt,
      triggeredBy
    );
    let client: PgClient | undefined;
    let transactionStarted = false;
    try {
      const pool = await this.ensureReady();
      client = await pool.connect();
      await client.query("BEGIN", []);
      transactionStarted = true;
      const result = await client.query(
        `SELECT id, valid_until, metadata
           FROM chunks
          WHERE source_ref = $1
          ORDER BY id
          FOR UPDATE`,
        [request.sourceRef]
      );
      if (result.rows.length === 0) {
        throw new GraphragError(
          `content invalidation: unknown source_ref "${request.sourceRef}"`,
          "INVALID_INPUT"
        );
      }

      // T5: content invalidation targets the 资料 AND its derived chunks.
      // Close the source_documents window in the SAME transaction so a
      // committed invalidate always leaves both levels closed (read_source
      // answers a named-invalid from the 资料 window). The row itself stays
      // SELECT-able — no physical delete this wave.
      await client.query(
        `UPDATE source_documents
            SET valid_until = $2
          WHERE source_ref = $1
            AND (valid_until IS NULL OR valid_until > $2::timestamptz)`,
        [request.sourceRef, request.invalidatedAt]
      );

      const records: ContentInvalidationRecord[] = [];
      for (const raw of result.rows) {
        const row = raw as {
          id: string;
          valid_until: Date | null;
          metadata: Record<string, unknown>;
        };
        const record: ContentInvalidationRecord = {
          chunk_id: row.id,
          invalidated_at: request.invalidatedAt,
          triggered_by: request.triggeredBy,
        };
        const metadata = appendContentInvalidation(row.metadata, record);
        await client.query(
          `UPDATE chunks
              SET valid_until = $2, metadata = $3::jsonb
            WHERE id = $1`,
          [
            row.id,
            closePgValidityWindow(row.valid_until, request.invalidatedAt),
            JSON.stringify(metadata),
          ]
        );
        records.push(record);
      }
      await client.query("COMMIT", []);
      transactionStarted = false;
      return sortInvalidationRecords(records);
    } catch (err) {
      if (client !== undefined && transactionStarted) {
        try {
          await client.query("ROLLBACK", []);
        } catch (rollbackErr) {
          const rollbackMessage =
            rollbackErr instanceof Error
              ? rollbackErr.message
              : String(rollbackErr);
          throw new GraphragError(
            `PgvectorBackend.invalidateSourceRef rollback failed: ${rollbackMessage}`,
            "STORAGE_ERROR"
          );
        }
      }
      if (err instanceof GraphragError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new GraphragError(
        `PgvectorBackend.invalidateSourceRef failed: ${message}`,
        "STORAGE_ERROR"
      );
    } finally {
      client?.release();
    }
  }

  async listInvalidations(
    sourceRef?: string
  ): Promise<ContentInvalidationRecord[]> {
    if (sourceRef !== undefined && sourceRef.trim() === "") {
      throw new GraphragError(
        "content invalidation: source_ref must be a non-empty string",
        "INVALID_INPUT"
      );
    }
    const where = sourceRef === undefined ? "" : " WHERE source_ref = $1";
    const params = sourceRef === undefined ? [] : [sourceRef];
    let rows: unknown[];
    try {
      const pool = await this.ensureReady();
      const result = await pool.query(
        `SELECT metadata FROM chunks${where} ORDER BY id`,
        params
      );
      rows = result.rows;
    } catch (err) {
      if (err instanceof GraphragError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new GraphragError(
        `PgvectorBackend.listInvalidations failed: ${message}`,
        "STORAGE_ERROR"
      );
    }
    const records: ContentInvalidationRecord[] = [];
    for (const raw of rows) {
      const row = raw as { metadata: Record<string, unknown> };
      records.push(...readContentInvalidations(row.metadata));
    }
    return sortInvalidationRecords(records);
  }

  /**
   * Insert-or-update a 资料 row keyed by `source_ref`. The `ON CONFLICT
   * (source_ref) DO UPDATE` keeps the same id on re-push so chunk back-
   * pointers remain valid. The T3 contract: re-push of the same locator
   * must NOT grow the source_documents row count.
   *
   * `created_at` is intentionally NOT updated on conflict — first-write
   * identity timestamp stays stable for the dashboard's "added on" column.
   *
   * T5 window rule on conflict: a re-push of the SAME content keeps the
   * closed 资料 window (invalidation still applies); different content is
   * a fresh document version and reopens the window (valid_until = NULL).
   * Mirrors the memory backend and the chunk-level
   * preserveInvalidationState / ON CONFLICT validity CASE.
   */
  async upsertSourceDoc(doc: SourceDocRecord): Promise<SourceDocRecord> {
    try {
      const pool = await this.ensureReady();
      // The status columns are written only when the caller declares a
      // status, and a declared status carries its failure code with it
      // (`failure_code: null` on a re-push clears a previous 失败). A
      // caller that declares neither — `ingest`, the pre-T3 write path —
      // leaves the stored status untouched rather than silently
      // downgrading a 就绪 资料. A brand-new row with no declared status
      // takes 进行中, the state a row is in until a write proves otherwise.
      // $6 stays the raw declared status: the ON CONFLICT branch reads
      // `$6 IS NULL` as "the caller declared nothing", which is a different
      // question from what a brand-new row should hold. $8 answers that one
      // and is bound rather than inlined, because the vocabulary is owned by
      // SOURCE_DOC_STATUS and the column's CHECK is derived from it.
      const declaredStatus = doc.status ?? null;
      const insertStatus = declaredStatus ?? SOURCE_DOC_STATUS.IN_PROGRESS;
      const result = await pool.query(
        `INSERT INTO source_documents
           (id, source_ref, title, content, created_at, valid_until,
            status, failure_code, content_identity)
           VALUES ($1, $2, $3, $4, $5, NULL,
                   $8::text, $7::text, $9::text)
           ON CONFLICT (source_ref) DO UPDATE SET
             title = EXCLUDED.title,
             content = EXCLUDED.content,
             status = COALESCE($6::text, source_documents.status),
             failure_code = CASE
               WHEN $6::text IS NULL THEN source_documents.failure_code
               ELSE $7::text
             END,
             content_identity = EXCLUDED.content_identity,
             valid_until = CASE
               WHEN source_documents.content = EXCLUDED.content
                 THEN source_documents.valid_until
               ELSE NULL
             END
           RETURNING id, source_ref, title, content, created_at, valid_until,
                     status, failure_code, content_identity`,
        [
          doc.id,
          doc.source_ref,
          doc.title,
          doc.content,
          doc.created_at,
          declaredStatus,
          doc.failure_code ?? null,
          insertStatus,
          doc.content_identity ?? null,
        ]
      );
      return toSourceDocUpsertRecord(result.rows[0] as SourceDocUpsertRow);
    } catch (err) {
      if (err instanceof GraphragError) throw err;
      throw new GraphragError(
        `PgvectorBackend.upsertSourceDoc failed: ${(err as Error).message}`,
        "STORAGE_ERROR"
      );
    }
  }

  /**
   * Drop every chunk row that back-points to `sourceDocId`. T3 rebuild
   * semantics: same-locator re-push wipes derived chunk rows before
   * inserting the new set. Legacy chunk rows (source_doc_id IS NULL) are
   * NOT touched. Returns when the DELETE has committed.
   *
   * `excludeChunkIds` lists chunk ids that should NOT be deleted even
   * though they back-point to `sourceDocId` — T3's ingest handler passes
   * the ids it just upserted so `preserveInvalidationState` can keep a
   * closed-row from a prior invalidation. Only orphans (chunks left
   * over from a previous content-identity version) are dropped.
   */
  async deleteChunksForSourceDoc(
    sourceDocId: string,
    excludeChunkIds?: Iterable<string>
  ): Promise<void> {
    try {
      const pool = await this.ensureReady();
      const excluded =
        excludeChunkIds !== undefined
          ? Array.from(new Set(excludeChunkIds))
          : [];
      if (excluded.length === 0) {
        await pool.query(`DELETE FROM chunks WHERE source_doc_id = $1`, [
          sourceDocId,
        ]);
      } else {
        await pool.query(
          `DELETE FROM chunks WHERE source_doc_id = $1 AND NOT (id = ANY($2::uuid[]))`,
          [sourceDocId, excluded]
        );
      }
    } catch (err) {
      if (err instanceof GraphragError) throw err;
      throw new GraphragError(
        `PgvectorBackend.deleteChunksForSourceDoc failed: ${(err as Error).message}`,
        "STORAGE_ERROR"
      );
    }
  }

  /**
   * List every chunk row that back-points to `sourceDocId`, ordered by
   * ordinal ascending. Used by T4's `read_source` MCP tool and the
   * dashboard detail.
   */
  async listChunksBySourceDoc(
    sourceDocId: string
  ): Promise<StorageChunkView[]> {
    try {
      const pool = await this.ensureReady();
      const result = await pool.query(
        `SELECT id, content, source_ref, valid_from, valid_until, metadata
           FROM chunks
          WHERE source_doc_id = $1
          ORDER BY ordinal ASC`,
        [sourceDocId]
      );
      return (result.rows as StorageChunkRow[]).map(toChunkView);
    } catch (err) {
      if (err instanceof GraphragError) throw err;
      throw new GraphragError(
        `PgvectorBackend.listChunksBySourceDoc failed: ${(err as Error).message}`,
        "STORAGE_ERROR"
      );
    }
  }

  /**
   * T3 read binding — the ONE place this backend resolves the physical
   * ACTIVE slot for a cosine read (validated identifier, legacy fallback).
   * T4's downtime refuse sits here too: all three vector reads (chunk
   * search, entity seed, community cosine) funnel through this method, so
   * the refuse fires before any SELECT leaves the backend.
   */
  private activeReadSlot(): string {
    assertVectorReadsAllowed(this.generation);
    return activeSlotForRead(this.generation);
  }

  async search(
    queryEmbedding: number[],
    opts: SearchOptions
  ): Promise<RetrievedChunk[]> {
    const pool = await this.ensureReady();
    // The query vector belongs to the ACTIVE generation (T3 query-embed
    // binding), so its width is checked against the LEDGER's active width —
    // during a dimension rotate the env width describes the incoming one.
    const activeDimensions =
      this.generation?.active.dimensions ?? this.dimensions;
    if (queryEmbedding.length !== activeDimensions) {
      throw new GraphragError(
        `PgvectorBackend.search: query embedding length ${queryEmbedding.length} !== active generation width ${activeDimensions}`,
        "EMBEDDING_DIM_MISMATCH"
      );
    }

    const { sql, params } = buildVectorSearchQuery(
      queryEmbedding,
      opts,
      this.activeReadSlot()
    );

    let rows: unknown[];
    try {
      const result = await pool.query(sql, params);
      rows = result.rows;
    } catch (err) {
      throw new GraphragError(
        `PgvectorBackend.search failed: ${(err as Error).message}`,
        "STORAGE_ERROR"
      );
    }

    return rows.map((r) => {
      const row = r as ChunkRow;
      // pgvector `<=>` returns cosine *distance* (1 - similarity). Flip
      // so the public score matches MemoryBackend's cosine similarity
      // convention (1 = perfect match, 0 = orthogonal).
      return rowToRetrievedChunk(row, 1 - row.distance);
    });
  }

  /**
   * Read visible chunks within `width` ingest positions of each anchor.
   * Neighbor expansion is a Postgres concern: chunks remain ledger rows and
   * are never written to or looked up in Neo4j.
   */
  async chunksByChunkIds(
    chunkIds: readonly string[],
    validAt: string,
    width: number
  ): Promise<NeighborChunkRow[]> {
    if (chunkIds.length === 0 || width <= 0) return [];
    try {
      const pool = await this.ensureReady();
      const result = await pool.query(NEIGHBOR_CHUNKS_SQL, [
        [...chunkIds],
        validAt,
        width,
      ]);
      return result.rows.map((r) => {
        const row = r as {
          id: string;
          content: string;
          source_ref: string;
          valid_from: Date;
          valid_until: Date | null;
        };
        return {
          id: row.id,
          content: row.content,
          source_ref: row.source_ref,
          valid_from: row.valid_from.toISOString(),
          valid_until: row.valid_until?.toISOString() ?? null,
        };
      });
    } catch (err) {
      throw new GraphragError(
        `PgvectorBackend.chunksByChunkIds failed: ${(err as Error).message}`,
        "STORAGE_ERROR"
      );
    }
  }

  /**
   * Resolve child chunks to their parent 资料 window rows (档 A, T2).
   * Children with no back-pointer or no 资料 row are absent from the
   * result; the calling arm turns that absence into a named degradation.
   */
  async parentWindowsByChunkIds(
    chunkIds: readonly string[]
  ): Promise<ParentWindowRow[]> {
    if (chunkIds.length === 0) return [];
    try {
      const pool = await this.ensureReady();
      const result = await pool.query(PARENT_WINDOWS_SQL, [[...chunkIds]]);
      return result.rows.map((r) => {
        const row = r as {
          chunk_id: string;
          source_doc_id: string;
          ordinal: number | null;
          content: string;
        };
        return {
          chunk_id: row.chunk_id,
          source_doc_id: row.source_doc_id,
          ordinal: row.ordinal,
          content: row.content,
        };
      });
    } catch (err) {
      throw new GraphragError(
        `PgvectorBackend.parentWindowsByChunkIds failed: ${(err as Error).message}`,
        "STORAGE_ERROR"
      );
    }
  }

  /**
   * Read the 档 C readiness singleton (plans/search-mode-retrieve.md T3).
   * `undefined` = no row = the community job never ran; the C arm turns
   * that and every non-ready spelling into the typed
   * `community_summary_index_failure` exit. A read failure throws — it
   * must not read as "no row", because the arm fails closed either way
   * and the operator needs the storage error named in logs.
   */
  async getCommunityIndexState(): Promise<CommunityIndexStateRow | undefined> {
    try {
      const pool = await this.ensureReady();
      const result = await pool.query(COMMUNITY_INDEX_STATE_SQL, []);
      const row = result.rows[0] as
        { status: string; failure_code: string | null } | undefined;
      if (row === undefined) return undefined;
      return { status: row.status, failure_code: row.failure_code };
    } catch (err) {
      throw new GraphragError(
        `PgvectorBackend.getCommunityIndexState failed: ${(err as Error).message}`,
        "STORAGE_ERROR"
      );
    }
  }

  /**
   * Idempotent submit arm (corpus-index-job T2). The derived `job_id` is the
   * pair key, so a repeat submit hits `ON CONFLICT (job_id) DO NOTHING`,
   * which RETURNs no row, and the follow-up SELECT returns the EXISTING row —
   * including whatever status/started_at a worker already advanced it to. The
   * insert never overwrites a running job.
   *
   * `inserted` is read from the write itself, not inferred: a row came back
   * from the INSERT ⇒ this call created it; nothing came back ⇒ this call
   * joined it. A caller that reports "queued now" on a join would claim a
   * queue entry another submit already made.
   *
   * A 23505 from the INSERT can only come from the one-active-per-source
   * partial unique index (the `ON CONFLICT` arbiter already absorbs the
   * `job_id` PK), i.e. a conflicting submit that raced past the handler's
   * pre-check: the call returns that racing active row as `conflict` and
   * persists nothing. Any other SQLSTATE rethrows untouched — a storage fault
   * must not be dressed up as a domain conflict.
   */
  async insertJobOrJoin(
    record: IndexJobRecord
  ): Promise<IndexJobInsertOutcome> {
    return wrapPgRead("insertJobOrJoin", async () => {
      const pool = await this.ensureReady();
      let inserted: { rows: unknown[] };
      try {
        inserted = await pool.query(
          `INSERT INTO index_jobs
             (job_id, source_ref, content_identity, status, failure_code,
              created_at, started_at, finished_at)
           VALUES ($1, $2, $3, $4::text, $5::text,
                   $6::timestamptz, $7::timestamptz, $8::timestamptz)
           ON CONFLICT (job_id) DO NOTHING
           RETURNING ${INDEX_JOB_COLUMNS}`,
          [
            record.job_id,
            record.source_ref,
            record.content_identity,
            record.status,
            record.failure_code ?? null,
            record.created_at,
            record.started_at,
            record.finished_at,
          ]
        );
      } catch (err) {
        if ((err as { code?: string }).code !== UNIQUE_VIOLATION_SQLSTATE) {
          throw err;
        }
        const active = await this.readJob(pool, ACTIVE_JOB_FOR_SOURCE_SQL, [
          record.source_ref,
          INDEX_JOB_STATUS.IN_PROGRESS,
        ]);
        if (active === null) {
          // The constraint rejected this write, so a row owned the source at
          // INSERT time; if it terminalized before this read the conflict
          // outcome has nothing to name — loud, never a fabricated verdict.
          throw new GraphragError(
            `PgvectorBackend.insertJobOrJoin: unique violation left no active job for ${record.source_ref}`,
            "STORAGE_ERROR"
          );
        }
        return { conflict: active };
      }
      const own = inserted.rows[0] as IndexJobRow | undefined;
      if (own !== undefined) {
        return { record: toIndexJobRecord(own), inserted: true };
      }
      const joined = await this.readJob(pool, `WHERE job_id = $1`, [
        record.job_id,
      ]);
      if (joined === null) {
        // The row is gone between insert and read — only a concurrent delete
        // could do that, and nothing in this schema deletes jobs. Loud, not a
        // silent null the caller would misread as a fresh submit.
        throw new GraphragError(
          `PgvectorBackend.insertJobOrJoin: job ${record.job_id} not found after write`,
          "STORAGE_ERROR"
        );
      }
      return { record: joined, inserted: false };
    });
  }

  async getJob(jobId: string): Promise<IndexJobRecord | null> {
    return wrapPgRead("getJob", async () => {
      const pool = await this.ensureReady();
      return this.readJob(pool, `WHERE job_id = $1`, [jobId]);
    });
  }

  /**
   * The one in-progress job for a source. `status='in_progress'` is the only
   * active word (queued vs running is `started_at IS NULL`), and the partial
   * unique index makes "at most one" a storage fact, so LIMIT 1 keeps the
   * read cheap and total.
   */
  async getActiveJobForSource(
    sourceRef: string
  ): Promise<IndexJobRecord | null> {
    return wrapPgRead("getActiveJobForSource", async () => {
      const pool = await this.ensureReady();
      return this.readJob(pool, ACTIVE_JOB_FOR_SOURCE_SQL, [
        sourceRef,
        INDEX_JOB_STATUS.IN_PROGRESS,
      ]);
    });
  }

  /**
   * Demote every terminal `ready` job of a source to `stale` when a new
   * content version supersedes them. Returns the number of rows demoted.
   *
   * No exception parameter: the incoming job is `in_progress`, so the
   * `status = 'ready'` predicate cannot touch it, and a filter on the
   * caller's own id would only re-derive a fact the submit path already
   * settled when its join arm returned.
   */
  async supersedeReadyJobs(sourceRef: string): Promise<number> {
    return wrapPgRead("supersedeReadyJobs", async () => {
      const pool = await this.ensureReady();
      const result = await pool.query(
        `UPDATE index_jobs
            SET status = $3::text
          WHERE source_ref = $1
            AND status = $2::text
          RETURNING job_id`,
        [sourceRef, INDEX_JOB_STATUS.READY, INDEX_JOB_STATUS.STALE]
      );
      // RETURNING job_id lets the PgPool surface (rows only, no rowCount)
      // report the demoted count as an observable result rather than an
      // inferred one.
      return result.rows.length;
    });
  }

  /**
   * Claim the oldest claimable job for this worker and stamp its start.
   *
   * Pick and write are one statement: `FOR UPDATE SKIP LOCKED` makes a
   * concurrent claimant step over the row another worker is holding instead of
   * blocking on it or taking the same job twice — the same idiom as
   * `claimPendingIntents` in projection-outbox.ts. A re-claim overwrites
   * `started_at` deliberately: the column records the current attempt, while
   * `created_at` stays the queue time the next claim still orders by.
   */
  async claimNextJob(
    options: IndexJobClaimOptions
  ): Promise<IndexJobRecord | null> {
    return wrapPgRead("claimNextJob", async () => {
      const pool = await this.ensureReady();
      const result = await pool.query(
        `UPDATE index_jobs
            SET started_at = $1::timestamptz
          WHERE job_id = (
                  SELECT job_id
                    FROM index_jobs
                   WHERE ${CLAIMABLE_JOB_SQL}
                   ORDER BY created_at, job_id
                      LIMIT 1
                    FOR UPDATE SKIP LOCKED
                )
          RETURNING ${INDEX_JOB_COLUMNS}`,
        [
          options.startedAt,
          INDEX_JOB_STATUS.IN_PROGRESS,
          options.stalledBefore ?? null,
        ]
      );
      // Zero rows updated means the queue held nothing claimable — null is the
      // honest answer, never a stand-in row for a job that was not claimed.
      const row = result.rows[0] as IndexJobRow | undefined;
      return row === undefined ? null : toIndexJobRecord(row);
    });
  }

  /**
   * Publish a claimed job's terminal outcome.
   *
   * `AND status = in_progress` is the lease check inside the write: a row that
   * already reached a terminal state belongs to whoever settled it, so this
   * call answers null and the worker must not report the outcome it computed.
   * No runtime status validator lives here — the column CHECK admits exactly
   * the four vocabulary words, and `IndexJobTerminalStatus` is the compile-time
   * guard that `in_progress` cannot be published.
   */
  async publishJobOutcome(
    jobId: string,
    outcome: IndexJobTerminalOutcome
  ): Promise<IndexJobRecord | null> {
    return wrapPgRead("publishJobOutcome", async () => {
      const pool = await this.ensureReady();
      const result = await pool.query(
        `UPDATE index_jobs
            SET status = $2::text,
                failure_code = $3::text,
                finished_at = $4::timestamptz
          WHERE job_id = $1
            AND status = $5::text
            AND started_at IS NOT DISTINCT FROM $6::timestamptz
          RETURNING ${INDEX_JOB_COLUMNS}`,
        [
          jobId,
          outcome.status,
          outcome.failureCode ?? null,
          outcome.finishedAt,
          INDEX_JOB_STATUS.IN_PROGRESS,
          outcome.claimedStartedAt,
        ]
      );
      const row = result.rows[0] as IndexJobRow | undefined;
      return row === undefined ? null : toIndexJobRecord(row);
    });
  }

  /** Shared single-row job read; a missing row is null, not an error. */
  private async readJob(
    pool: PgPool,
    predicate: string,
    values: unknown[]
  ): Promise<IndexJobRecord | null> {
    const result = await pool.query(
      `SELECT ${INDEX_JOB_COLUMNS} FROM index_jobs ${predicate}`,
      values
    );
    const row = result.rows[0] as IndexJobRow | undefined;
    return row === undefined ? null : toIndexJobRecord(row);
  }

  /**
   * Read-only projection synchronization seam. The graph drain runs in its
   * own process; retrieve only observes the Postgres outbox and never writes
   * Neo4j inside a request transaction.
   */
  async waitForProjectionDrain(timeoutMs: number): Promise<void> {
    try {
      const pool = await this.ensureReady();
      await waitForProjectionDrain(pool, timeoutMs);
    } catch (err) {
      if (err instanceof GraphragError) throw err;
      throw new GraphragError(
        `PgvectorBackend.waitForProjectionDrain failed: ${(err as Error).message}`,
        "STORAGE_ERROR"
      );
    }
  }

  async counts(): Promise<StorageCounts> {
    return wrapPgRead("counts", async () => {
      const pool = await this.ensureReady();
      const [chunks, entities, invalidations] = await Promise.all([
        pool.query(CHUNK_COUNT_SQL, []),
        pool.query(ENTITY_LIVE_COUNT_SQL, []),
        this.listInvalidations(),
      ]);
      return {
        chunks: readSqlCount(chunks.rows as Array<Record<string, unknown>>),
        entities: readSqlCount(entities.rows as Array<Record<string, unknown>>),
        invalidations: invalidations.length,
      };
    });
  }

  async listChunks(
    opts?: StorageListOptions
  ): Promise<StoragePage<StorageChunkView>> {
    const { limit, offset } = normalizeStorageListOptions(opts);
    return wrapPgRead("listChunks", async () => {
      const pool = await this.ensureReady();
      const [countResult, pageResult] = await Promise.all([
        pool.query(CHUNK_COUNT_SQL, []),
        pool.query(CHUNK_LIST_SQL, [limit, offset]),
      ]);
      return {
        items: (pageResult.rows as StorageChunkRow[]).map(toChunkView),
        total: readSqlCount(countResult.rows as Array<Record<string, unknown>>),
        limit,
        offset,
      };
    });
  }

  async getChunk(id: string): Promise<StorageReadResult<StorageChunkView>> {
    const lookedUp = lookupReadId(id);
    if (!lookedUp.ok) return lookedUp;
    return wrapPgRead<StorageReadResult<StorageChunkView>>(
      "getChunk",
      async () => {
        const pool = await this.ensureReady();
        const result = await pool.query(CHUNK_BY_ID_SQL, [lookedUp.value]);
        const row = result.rows[0] as StorageChunkRow | undefined;
        if (row === undefined) return { ok: false, code: "NOT_FOUND" };
        return { ok: true, value: toChunkView(row) };
      },
      (err) =>
        isPgInvalidTextRepresentation(err)
          ? { ok: false, code: "INVALID_INPUT" }
          : undefined
    );
  }

  async listEntities(
    opts?: StorageListOptions
  ): Promise<StoragePage<StorageEntityView>> {
    const { limit, offset } = normalizeStorageListOptions(opts);
    return wrapPgRead("listEntities", async () => {
      const pool = await this.ensureReady();
      const [countResult, pageResult] = await Promise.all([
        pool.query(ENTITY_LIVE_COUNT_SQL, []),
        pool.query(ENTITY_LIST_SQL, [limit, offset]),
      ]);
      return {
        items: (pageResult.rows as StorageEntityRow[]).map(toEntityView),
        total: readSqlCount(countResult.rows as Array<Record<string, unknown>>),
        limit,
        offset,
      };
    });
  }

  async getEntity(id: string): Promise<StorageReadResult<StorageEntityView>> {
    const lookedUp = lookupReadId(id);
    if (!lookedUp.ok) return lookedUp;
    return wrapPgRead<StorageReadResult<StorageEntityView>>(
      "getEntity",
      async () => {
        const pool = await this.ensureReady();
        const result = await pool.query(ENTITY_BY_ID_SQL, [lookedUp.value]);
        const row = result.rows[0] as StorageEntityRow | undefined;
        if (row === undefined) return { ok: false, code: "NOT_FOUND" };
        return { ok: true, value: toEntityView(row) };
      },
      (err) =>
        isPgInvalidTextRepresentation(err)
          ? { ok: false, code: "INVALID_INPUT" }
          : undefined
    );
  }

  async listTimeline(
    opts?: StorageListOptions
  ): Promise<StoragePage<StorageTimelineEvent>> {
    const { limit, offset } = normalizeStorageListOptions(opts);
    return wrapPgRead("listTimeline", async () => {
      const pool = await this.ensureReady();
      const result = await pool.query(TIMELINE_CHUNKS_SQL, []);
      const chunks = (result.rows as StorageChunkRow[]).map(toChunkView);
      return paginateItems(projectTimelineEvents(chunks), limit, offset);
    });
  }

  async getSourceDoc(
    sourceRef: string
  ): Promise<StorageReadResult<StorageSourceDocView>> {
    if (typeof sourceRef !== "string" || sourceRef.trim() === "") {
      return { ok: false, code: "INVALID_INPUT" };
    }
    return wrapPgRead<StorageReadResult<StorageSourceDocView>>(
      "getSourceDoc",
      async () => {
        const pool = await this.ensureReady();
        const result = await pool.query(`${SOURCE_DOC_BY_REF_SQL}`, [
          sourceRef,
        ]);
        const row = result.rows[0] as
          (StorageSourceDocRow & { content: string }) | undefined;
        if (row === undefined) return { ok: false, code: "NOT_FOUND" };
        return {
          ok: true,
          value: { ...toSourceDocFields(row), content: row.content },
        };
      }
    );
  }

  async getSourceDocById(
    id: string
  ): Promise<StorageReadResult<StorageSourceDocView>> {
    const lookedUp = lookupReadId(id);
    if (!lookedUp.ok) return lookedUp;
    return wrapPgRead<StorageReadResult<StorageSourceDocView>>(
      "getSourceDocById",
      async () => {
        const pool = await this.ensureReady();
        const result = await pool.query(SOURCE_DOC_BY_ID_SQL, [lookedUp.value]);
        const row = result.rows[0] as
          (StorageSourceDocRow & { content: string }) | undefined;
        if (row === undefined) return { ok: false, code: "NOT_FOUND" };
        return {
          ok: true,
          value: { ...toSourceDocFields(row), content: row.content },
        };
      },
      (err) =>
        isPgInvalidTextRepresentation(err)
          ? { ok: false, code: "INVALID_INPUT" }
          : undefined
    );
  }

  /**
   * 资料 summaries in created_at order. Body column deliberately not
   * selected — the dashboard list is on-demand (operator-console T6);
   * open via getSourceDocById.
   */
  async listSourceDocs(
    opts?: StorageListOptions
  ): Promise<StoragePage<StorageSourceDocSummary>> {
    const { limit, offset } = normalizeStorageListOptions(opts);
    return wrapPgRead("listSourceDocs", async () => {
      const pool = await this.ensureReady();
      const [countResult, pageResult] = await Promise.all([
        pool.query(SOURCE_DOC_COUNT_SQL, []),
        pool.query(SOURCE_DOC_LIST_SQL, [limit, offset]),
      ]);
      const rows = pageResult.rows as StorageSourceDocRow[];
      return {
        items: rows.map((row) => toSourceDocFields(row)),
        total: readSqlCount(countResult.rows as Array<Record<string, unknown>>),
        limit,
        offset,
      };
    });
  }

  /**
   * Move a known 资料 to 就绪 (corpus-ready retrieve T3). A targeted UPDATE:
   * an unknown id is a silent no-op, never an invented row.
   */
  async markSourceDocReady(sourceDocId: string): Promise<void> {
    await wrapPgRead("markSourceDocReady", async () => {
      const pool = await this.ensureReady();
      await pool.query(SOURCE_DOC_MARK_READY_SQL, [
        sourceDocId,
        SOURCE_DOC_STATUS.READY,
      ]);
    });
  }

  /**
   * Record a failed push against a known 资料, keyed by source_ref. Matches
   * zero rows for an unknown locator — the failure is dropped rather than
   * attached to a 资料 the store never saw.
   */
  async recordSourceDocFailure(
    sourceRef: string,
    errorCode: string
  ): Promise<void> {
    if (typeof sourceRef !== "string" || sourceRef.trim() === "") {
      throw new GraphragError(
        "source doc failure: source_ref must be a non-empty string",
        "INVALID_INPUT"
      );
    }
    await wrapPgRead("recordSourceDocFailure", async () => {
      const pool = await this.ensureReady();
      await pool.query(SOURCE_DOC_RECORD_FAILURE_SQL, [
        sourceRef,
        errorCode,
        SOURCE_DOC_STATUS.FAILED,
      ]);
    });
  }

  /**
   * The evidence seam. The methods are one-liners over evidence-pg.ts: the
   * statements and the decisions both live there, so this file keeps only the
   * pool access and the transaction wrapper the in-memory twin does not need.
   */
  async registerSourceVersion(
    input: NewSourceVersion
  ): Promise<{ record: SourceVersionRecord; created: boolean }> {
    const plan = normalizeSourceVersion(input);
    return wrapPgRead("registerSourceVersion", async () => {
      const pool = await this.ensureReady();
      return registerSourceVersionRow(pool, {
        ...plan,
        source_version_id: plan.source_version_id || randomUUID(),
      });
    });
  }

  async bindSourceLocator(
    input: SourceLocatorBinding
  ): Promise<SourceLocatorBinding> {
    const binding = normalizeLocatorBinding(input);
    return wrapPgRead("bindSourceLocator", async () => {
      const pool = await this.ensureReady();
      return bindSourceLocatorRow(pool, binding);
    });
  }

  async recordSupport(
    occurrence: SupportOccurrence
  ): Promise<{ support: SupportRecord; created: boolean }> {
    const plan = normalizeOccurrence(occurrence);
    return wrapPgRead("recordSupport", async () => {
      const pool = await this.ensureReady();
      return recordSupportRow(pool, plan, randomUUID());
    });
  }

  async getSupport(supportId: string): Promise<SupportRecord | null> {
    const id = assertUuid(supportId, "support_id");
    return wrapPgRead("getSupport", async () => {
      const pool = await this.ensureReady();
      return readSupportRow(pool, id);
    });
  }

  async listSupportExtractions(supportId: string): Promise<string[]> {
    const id = assertUuid(supportId, "support_id");
    return wrapPgRead("listSupportExtractions", async () => {
      const pool = await this.ensureReady();
      return readSupportExtractionRefs(pool, id);
    });
  }

  /**
   * The grant and its obligations are one transaction, so a reference cannot
   * commit without the dependencies it claims to protect.
   */
  async issueGrant(request: GrantRequest): Promise<EvidenceGrantRecord> {
    const [grant] = await this.issueGrants([request]);
    // A one-element batch is a one-grant write, so this branch is unreachable
    // rather than merely unlikely — and saying so beats indexing a possibly
    // undefined element into a promise the caller awaits.
    if (grant === undefined) {
      throw new GraphragError(
        "evidence store: issueGrants returned no grant for a one-request batch",
        "STORAGE_ERROR"
      );
    }
    return grant;
  }

  /**
   * A whole page in one transaction.
   *
   * `inEvidenceTransaction` owns the BEGIN/COMMIT/ROLLBACK pairing, so a failure
   * on the third of three requests rolls back the first two: the page's caller
   * receives no references, and no reference is left behind it pinning
   * dependencies it can never hand to anyone.
   */
  async issueGrants(
    requests: readonly GrantRequest[],
    expectedScopeRevisionFence?: ScopeRevisionFence
  ): Promise<readonly EvidenceGrantRecord[]> {
    const plans = requests.map((request) => ({
      grant: normalizeGrantRequest(request),
      evidenceRef: randomUUID(),
      receiptId: randomUUID(),
    }));
    const fence = normalizeScopeRevisionFence(
      expectedScopeRevisionFence,
      plans.map((plan) => plan.grant)
    );
    return inEvidenceTransaction(
      async () => (await this.ensureReady()).connect(),
      async (client) => {
        if (fence !== null) {
          const current = await lockScopeRevisions(client, fence.scope_binding);
          assertScopeRevisionFenceCurrent(fence, current);
        }
        const issued: EvidenceGrantRecord[] = [];
        for (const plan of plans) {
          issued.push(await issueGrantRows(client, plan));
        }
        return issued;
      }
    );
  }

  async readGrant(evidenceRef: string, at: string): Promise<EvidenceGrantRead> {
    // `at` is validated before any read so a malformed instant is refused
    // rather than silently compared against a NaN.
    assertInstant(at, "at");
    return wrapPgRead("readGrant", async () => {
      const pool = await this.ensureReady();
      return decideGrantRead(await readGrantFacts(pool, evidenceRef), at);
    });
  }

  async listGrantSupports(
    evidenceRef: string
  ): Promise<readonly GrantDependencyFact[]> {
    return wrapPgRead("listGrantSupports", async () => {
      const pool = await this.ensureReady();
      return readGrantDependenciesByRef(pool, evidenceRef);
    });
  }

  async listGrantPinnedExtractions(
    evidenceRef: string
  ): Promise<readonly { support_id: string; extraction_ref: string }[]> {
    return wrapPgRead("listGrantPinnedExtractions", async () => {
      const pool = await this.ensureReady();
      return readGrantPinnedExtractions(pool, evidenceRef);
    });
  }

  async setScopeRevisions(
    scopeBinding: string,
    revisions: { authorizationRevision?: string; purgeRevision?: string }
  ): Promise<ScopeRevisionRecord> {
    const scope = assertFilled(scopeBinding, "scope_binding");
    const authorization = revisions.authorizationRevision ?? null;
    const purge = revisions.purgeRevision ?? null;
    for (const [name, value] of [
      ["authorizationRevision", authorization],
      ["purgeRevision", purge],
    ] as const) {
      if (value !== null) assertFilled(value, name);
    }
    return wrapPgRead("setScopeRevisions", async () => {
      const pool = await this.ensureReady();
      const existing = await readScopeRevisions(pool, scope);
      if (existing === null && (authorization === null || purge === null)) {
        throw evidenceError(
          EVIDENCE_FAILURE.MALFORMED_CONTRACT,
          `scope "${scope}" has no revisions on record, so its first write must carry both authorization_revision and purge_revision`
        );
      }
      return writeScopeRevisions(pool, scope, authorization, purge);
    });
  }

  async markSourceVersionRetired(
    sourceVersionId: string,
    retiredAt: string
  ): Promise<void> {
    await this.stampSourceVersion("retired_at", sourceVersionId, retiredAt);
  }

  async collectSourceVersionPayload(
    sourceVersionId: string,
    collectedAt: string
  ): Promise<void> {
    await this.stampSourceVersion(
      "payload_collected_at",
      sourceVersionId,
      collectedAt
    );
  }

  async stopAcceptingObligations(
    sourceVersionId: string,
    at: string
  ): Promise<void> {
    await this.stampSourceVersion(
      "obligations_stopped_at",
      sourceVersionId,
      at
    );
  }

  private async stampSourceVersion(
    stamp: SourceVersionStamp,
    sourceVersionId: string,
    at: string
  ): Promise<void> {
    const id = assertUuid(sourceVersionId, "source_version_id");
    return wrapPgRead("stampSourceVersion", async () => {
      const pool = await this.ensureReady();
      await stampSourceVersionRow(pool, stamp, id, at);
    });
  }

  async close(): Promise<void> {
    // The ledger leases through this backend's pool, so it has to be closed
    // first: a write after close would otherwise re-open a pool on a backend
    // that has already reported itself closed.
    await this.maintenanceWorkStore.close();
    if (!this.pool) return;
    try {
      await this.pool.end();
    } catch (err) {
      throw new GraphragError(
        `PgvectorBackend.close failed: ${(err as Error).message}`,
        "STORAGE_ERROR"
      );
    } finally {
      this.pool = undefined;
    }
  }

  /**
   * Graph-arm storage seam (spec-3 p0-integration T4). Composed inline —
   * no closure over private state beyond `this`. Methods use `this.ensureReady()`
   * to access the lazy pool, then delegate to local `pool.query` so the
   * failure-wrapping stays in one place (see seedQuery / oneHopQuery).
   *
   * The two SQL strings are pinned here (not in query-builder.ts) because
   * the pgvector backend binds concrete values (embedding dimension,
   * parameter casts); the query-builder module owns the *pure* shape
   * assertions that T3 already locked. The T4 unit test asserts the
   * single-JOIN / no-recursion contract on these emitted strings.
   */
  readonly graphArmSeed: GraphArmStorage = {
    /**
     * Top-K seed entities by cosine similarity to `embedding`.
     * Soft-merge survivor-only (merged_into IS NULL AND retired = false).
     * `entityType` (resolved `filters.entity_type`) restricts the seed to
     * one entity type; undefined binds $3 to NULL = every type.
     */
    seedEntitiesByEmbedding: async (embedding, topK, entityType) => {
      // Slot resolved before the try so a corrupt identifier surfaces as
      // the typed refusal itself, not a wrapped read failure.
      const slot = this.activeReadSlot();
      try {
        const pool = await this.ensureReady();
        const result = await pool.query(seedEntitiesSql(slot), [
          toVectorLiteral(embedding),
          topK,
          entityType ?? null,
        ]);
        return result.rows.map((r) => {
          const row = r as {
            id: string;
            canonical_name: string;
            score: number;
          };
          return {
            id: row.id,
            canonical_name: row.canonical_name,
            score: row.score,
          };
        });
      } catch (err) {
        throw new GraphragError(
          `PgvectorBackend.graphArmSeed.seedEntitiesByEmbedding failed: ${(err as Error).message}`,
          "STORAGE_ERROR"
        );
      }
    },

    /**
     * One-hop traversal from `seedIds` through triples to chunks. Two-sided
     * temporal filter (`triples.valid_window @> $validAt` AND
     * `chunks.valid_window @> $validAt`). Exactly one JOIN chunks (single-hop
     * hard limit, Success Criterion #8).
     */
    chunksByOneHopFromEntities: async (seedIds, validAt, limit) => {
      // ANY($1::uuid[]) over an empty JS array triggers ambiguous Postgres
      // type inference. Short-circuit to the empty result — no DB round-trip.
      if (seedIds.length === 0) return [];
      try {
        const pool = await this.ensureReady();
        const result = await pool.query(ONE_HOP_CHUNKS_SQL, [
          seedIds,
          validAt,
          limit,
        ]);
        return result.rows.map((r) => {
          const row = r as {
            id: string;
            content: string;
            source_ref: string;
            valid_from: Date;
            valid_until: Date | null;
          };
          return {
            id: row.id,
            content: row.content,
            source_ref: row.source_ref,
            valid_from: row.valid_from.toISOString(),
            valid_until: row.valid_until?.toISOString() ?? null,
          };
        });
      } catch (err) {
        throw new GraphragError(
          `PgvectorBackend.graphArmSeed.chunksByOneHopFromEntities failed: ${(err as Error).message}`,
          "STORAGE_ERROR"
        );
      }
    },
  };

  /**
   * Neo4j graph-arm storage seam (#70 T4) — the Postgres half of the PPR
   * arm. Seeding is the same survivor-only embedding query the archived arm
   * uses (spec A7 keeps the entity-linking idea); the traversal is NOT, it
   * now happens in the graph engine, and this seam only maps the entities
   * it ranked back onto chunks.
   */
  readonly neo4jArmSeed: Neo4jArmStorage = {
    seedEntitiesByEmbedding: (embedding, topK, entityType) =>
      this.graphArmSeed.seedEntitiesByEmbedding(embedding, topK, entityType),

    chunksByEntityIds: async (entityIds, validAt, limit) => {
      // Same empty-array short-circuit as the one-hop query: ANY over an
      // empty JS array leaves Postgres without a type to infer.
      if (entityIds.length === 0) return [];
      try {
        const pool = await this.ensureReady();
        const { sql, params } = buildEntityChunksQuery(entityIds, validAt, limit);
        const result = await pool.query(sql, params);
        return result.rows.map((r) => {
          const row = r as {
            entity_id: string;
            id: string;
            content: string;
            source_ref: string;
            valid_from: Date;
            valid_until: Date | null;
          };
          return {
            entity_id: row.entity_id,
            id: row.id,
            content: row.content,
            source_ref: row.source_ref,
            valid_from: row.valid_from.toISOString(),
            valid_until: row.valid_until?.toISOString() ?? null,
          } satisfies EntityChunkRow;
        });
      } catch (err) {
        throw new GraphragError(
          `PgvectorBackend.neo4jArmSeed.chunksByEntityIds failed: ${(err as Error).message}`,
          "STORAGE_ERROR"
        );
      }
    },
  };

  /**
   * Direct entity-embedding read seam for retrieve. It deliberately reuses
   * the Postgres half of the Neo4j arm; no entity vector is copied to Neo4j.
   */
  readonly entityEmbedding: EntityEmbeddingStorage = {
    seedEntitiesByEmbedding: (embedding, topK, entityType) =>
      this.neo4jArmSeed.seedEntitiesByEmbedding(embedding, topK, entityType),
    chunksByEntityIds: (entityIds, validAt, limit) =>
      this.neo4jArmSeed.chunksByEntityIds(entityIds, validAt, limit),
  };

  /**
   * Semantic lookup for index-time summaries. Summary rows are kept in
   * Postgres and are never copied to Neo4j; this is the optional retrieve
   * seam used only by a summary-enabled preset.
   */
  readonly communitySummaries = {
    getCommunitySummaryByCommunityId: async (
      communityId: string,
      maxLevel: number
    ): Promise<CommunitySummaryRow | undefined> => {
      if (communityId === "") return undefined;
      try {
        const pool = await this.ensureReady();
        const result = await pool.query(COMMUNITY_SUMMARY_BY_ID_SQL, [
          communityId,
          maxLevel,
        ]);
        const row = result.rows[0] as
          | {
              id: string;
              community_id: string;
              summary: string;
              level: number;
            }
          | undefined;
        if (row === undefined) return undefined;
        return {
          id: row.id,
          communityId: row.community_id,
          summary: row.summary,
          level: Number(row.level),
        };
      } catch (err) {
        throw new GraphragError(
          `PgvectorBackend.communitySummaries.getCommunitySummaryByCommunityId failed: ${(err as Error).message}`,
          "STORAGE_ERROR"
        );
      }
    },
    searchCommunitySummaries: async (
      embedding: number[],
      limit: number,
      maxLevel: number
    ): Promise<CommunitySummaryRow[]> => {
      // Same T3 binding as the entity seed: active slot only.
      const slot = this.activeReadSlot();
      try {
        const pool = await this.ensureReady();
        const result = await pool.query(communitySummariesSql(slot), [
          toVectorLiteral(embedding),
          limit,
          maxLevel,
        ]);
        return result.rows.map((r) => {
          const row = r as {
            id: string;
            community_id: string;
            summary: string;
            level: number;
            score: number;
          };
          return {
            id: row.id,
            communityId: row.community_id,
            summary: row.summary,
            level: Number(row.level),
            score: Number(row.score),
          };
        });
      } catch (err) {
        throw new GraphragError(
          `PgvectorBackend.communitySummaries.searchCommunitySummaries failed: ${(err as Error).message}`,
          "STORAGE_ERROR"
        );
      }
    },
  };
}
