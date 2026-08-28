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
import type { ChunkRecord, RetrievedChunk, SearchOptions } from "../types.js";
import type {
  GraphRagStorageBackend,
  LexicalStorageBackend,
} from "./backend.js";
import type {
  EntityChunkRow,
  GraphArmStorage,
  NeighborChunkRow,
  NeighborChunkStorage,
  Neo4jArmStorage,
} from "../retrieval/types.js";
import { GraphragError } from "../errors.js";
import type { PoolClient } from "pg";
import { upSchemaP0 } from "./schema-p0.js";

/**
 * Minimal structural subset of the `pg` package we use. Declared as an
 * interface (not `import type`) so the file compiles even when `pg` is not
 * installed — we `await import("pg")` at runtime and accept the result
 * only if it matches.
 */
interface PgModule {
  Pool: new (config: { connectionString: string }) => PgPool;
}
interface PgPool {
  query: (text: string, values: unknown[]) => Promise<{ rows: unknown[] }>;
  end: () => Promise<void>;
  // Acquired client carries a single in-flight transaction; upSchemaP0
  // takes ownership of the BEGIN/COMMIT/ROLLBACK and releases via finally
  // — see ensureTable().
  connect: () => Promise<PgClient>;
}
interface PgClient {
  query: (text: string, values: unknown[]) => Promise<{ rows: unknown[] }>;
  release: () => void;
}

/** Serialized pgvector literal: `[0.1,0.2,...]` with no spaces. */
function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

/**
 * Soft-merge survivor-only seed query (T3 contract):
 * `merged_into IS NULL AND retired = false`, ordered by cosine distance.
 */
const SEED_ENTITIES_SQL =
  "SELECT id, canonical_name FROM entities " +
  "WHERE embedding IS NOT NULL AND merged_into IS NULL AND retired = false " +
  "ORDER BY embedding <=> $1::vector LIMIT $2";

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
 */
const ENTITY_CHUNKS_SQL = `SELECT ranked.entity_id, c.id, c.content, c.source_ref,
          c.valid_from, c.valid_until
     FROM triples t
     JOIN chunks c ON t.source_chunk_id = c.id
     CROSS JOIN LATERAL (VALUES (t.head_id), (t.tail_id)) AS ranked(entity_id)
    WHERE ranked.entity_id = ANY($1::uuid[])
      AND t.valid_window @> $2::timestamptz
      AND c.valid_from <= $2::timestamptz
      AND (c.valid_until IS NULL OR c.valid_until > $2::timestamptz)
    ORDER BY array_position($1::uuid[], ranked.entity_id), c.id
    LIMIT $3`;

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
 * Text-search configuration for the lexical arm. `simple` deliberately,
 * not `english`: it lowercases and nothing else, so no stemmer or
 * stop-word list is baked into stored `content_tsv` values. Choosing a
 * language here would be a one-way door — the column is generated, so
 * changing the config later rewrites the whole table.
 */
const TEXT_SEARCH_CONFIG = "simple";

/**
 * Build the lexical query with OR semantics over the query's terms.
 *
 * `plainto_tsquery` does the lexing and escaping (so the raw user string
 * never becomes tsquery syntax), but joins terms with `&`. AND is wrong
 * for a recall arm: a natural-language question shares only a word or two
 * with the chunk that answers it, and requiring every term would return
 * nothing far more often than not. Swapping the operator on the already
 * sanitized output is the standard way to get OR without hand-parsing.
 *
 * A query with no lexemes yields an empty tsquery, which matches no rows
 * — the empty-input boundary needs no special case.
 */
const LEXICAL_TSQUERY = `replace(plainto_tsquery('${TEXT_SEARCH_CONFIG}', $1)::text, ' & ', ' | ')::tsquery`;

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

/**
 * Storage backend backed by PostgreSQL + the pgvector extension.
 *
 * Lazy init: the `pg` module is imported on the first call to `upsert`
 * or `search`, not in the constructor. This keeps `import { PgvectorBackend }`
 * from forcing every consumer to install `pg` — operators running with
 * GRAPHRAG_MEMORY_STORAGE=memory never touch the dependency.
 *
 * `ensureTable()` is called once per backend instance (idempotent
 * CREATE EXTENSION + CREATE TABLE IF NOT EXISTS), so a fresh database
 * works out of the box.
 */
export class PgvectorBackend
  implements GraphRagStorageBackend, LexicalStorageBackend, NeighborChunkStorage
{
  private pool: PgPool | undefined;
  private initPromise: Promise<void> | undefined;

  constructor(
    private readonly dbUrl: string,
    private readonly dimensions: number
  ) {}

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
      const pool = new mod.Pool({ connectionString: this.dbUrl });
      this.pool = pool;
      try {
        await this.ensureTable();
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
    const pool = this.pool!;
    // Acquire a dedicated client so upSchemaP0 can wrap its DDL in a
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
        // Lexical index for the BM25 arm. Kept as a separate ALTER rather
        // than a column in the CREATE above because the CREATE is
        // IF NOT EXISTS and no-ops on every existing deployment — an
        // operator upgrading into BM25 would never get the column.
        //
        // GENERATED ... STORED means Postgres maintains the vector on
        // every insert and update, so `upsert` needs no new SQL and no
        // trigger can drift from it. Adding the column rewrites the table
        // once, which backfills every pre-existing row: starting the
        // backend IS the migration (SC6).
        await client.query(
          `ALTER TABLE chunks ADD COLUMN IF NOT EXISTS content_tsv tsvector
             GENERATED ALWAYS AS (to_tsvector('${TEXT_SEARCH_CONFIG}', content)) STORED`,
          []
        );
        // Without this the lexical predicate would re-tokenize the table
        // on every retrieve.
        await client.query(
          `CREATE INDEX IF NOT EXISTS chunks_content_tsv_gin
             ON chunks USING GIN (content_tsv)`,
          []
        );
        // P0 schema: entities + entity_aliases + triples + extraction_records.
        // upSchemaP0 is idempotent (every statement is IF NOT EXISTS) and
        // owns its own BEGIN/COMMIT/ROLLBACK — we MUST NOT wrap it in an
        // outer transaction. Cast our minimal PgClient to PoolClient: only
        // .query is actually used by upSchemaP0, so the structural surface
        // is sufficient. Pass this.dimensions so entities.embedding width
        // matches chunks.embedding width (H1).
        await upSchemaP0(client as unknown as PoolClient, this.dimensions);
      } finally {
        client.release();
      }
    } catch (err) {
      throw new GraphragError(
        `PgvectorBackend: ensureTable failed (${(err as Error).message})`,
        "STORAGE_ERROR"
      );
    }
  }

  async upsert(chunks: ChunkRecord[]): Promise<string[]> {
    if (chunks.length === 0) return [];
    const pool = await this.ensureReady();

    // Validate embedding dimensions BEFORE any DB round-trip so a bad
    // batch fails fast and the whole upsert is atomic on the caller's
    // side. (Postgres would reject with a dimension error, but we'd rather
    // surface a typed GraphragError than a pg driver error.)
    for (const chunk of chunks) {
      if (chunk.embedding.length !== this.dimensions) {
        throw new GraphragError(
          `PgvectorBackend.upsert: chunk "${chunk.id}" embedding length ${chunk.embedding.length} !== ${this.dimensions}`,
          "EMBEDDING_DIM_MISMATCH"
        );
      }
    }

    // Each chunk is its own INSERT ... ON CONFLICT. A single multi-row
    // INSERT would be marginally faster, but per-row keeps the SQL
    // straightforward and lets pg report which id failed. We do NOT wrap
    // in a transaction here: ON CONFLICT (id) DO UPDATE is per-row atomic
    // already, and a partial failure mode (some chunks persist, others
    // don't) is acceptable — the caller can retry the missing ids.
    const ids: string[] = [];
    try {
      for (const chunk of chunks) {
        await pool.query(
          `INSERT INTO chunks
             (id, content, embedding, valid_from, valid_until,
              source_ref, metadata, created_at)
           VALUES ($1, $2, $3::vector, $4, $5, $6, $7::jsonb, $8)
           ON CONFLICT (id) DO UPDATE SET
             content = EXCLUDED.content,
             embedding = EXCLUDED.embedding,
             valid_from = EXCLUDED.valid_from,
             valid_until = EXCLUDED.valid_until,
             source_ref = EXCLUDED.source_ref,
             metadata = EXCLUDED.metadata,
             created_at = EXCLUDED.created_at`,
          [
            chunk.id,
            chunk.content,
            toVectorLiteral(chunk.embedding),
            chunk.valid_from,
            chunk.valid_until,
            chunk.source_ref,
            JSON.stringify(chunk.metadata),
            chunk.created_at,
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

  async search(
    queryEmbedding: number[],
    opts: SearchOptions
  ): Promise<RetrievedChunk[]> {
    if (queryEmbedding.length !== this.dimensions) {
      throw new GraphragError(
        `PgvectorBackend.search: query embedding length ${queryEmbedding.length} !== ${this.dimensions}`,
        "EMBEDDING_DIM_MISMATCH"
      );
    }
    const pool = await this.ensureReady();

    // Parameters are collected in order so the $N placeholders stay in
    // sync with the values array.
    const where = [...VALID_WINDOW_CLAUSES];
    const params: unknown[] = [toVectorLiteral(queryEmbedding), opts.validAt];
    appendFilterClauses(opts.filters ?? {}, where, params);
    params.push(opts.limit);

    const sql = `
      SELECT id, content, source_ref, valid_from, valid_until,
             embedding <=> $1::vector AS distance
      FROM chunks
      WHERE ${where.join(" AND ")}
      ORDER BY embedding <=> $1::vector ASC
      LIMIT $${params.length}
    `;

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
   * BM25-style lexical search over `content_tsv` (the BM25 arm, #65).
   *
   * Ranking is `ts_rank_cd`, not literal Okapi BM25 with k1=1.2 / b=0.75
   * — Postgres exposes no BM25 scorer and adding a dependency for one is
   * out of scope (SC11). The approximation is acceptable here precisely
   * because RRF fuses on RANK: only the ORDER of these hits reaches the
   * fused result, never the score's scale. `ts_rank_cd` is preferred over
   * `ts_rank` for its cover-density term, which rewards chunks where the
   * query's terms appear near each other.
   */
  async searchLexical(
    query: string,
    opts: SearchOptions
  ): Promise<RetrievedChunk[]> {
    const pool = await this.ensureReady();

    const where = [
      ...VALID_WINDOW_CLAUSES,
      `content_tsv @@ ${LEXICAL_TSQUERY}`,
    ];
    const params: unknown[] = [query, opts.validAt];
    appendFilterClauses(opts.filters ?? {}, where, params);
    params.push(opts.limit);

    const sql = `
      SELECT id, content, source_ref, valid_from, valid_until,
             ts_rank_cd(content_tsv, ${LEXICAL_TSQUERY}) AS rank
      FROM chunks
      WHERE ${where.join(" AND ")}
      ORDER BY rank DESC, id ASC
      LIMIT $${params.length}
    `;

    let rows: unknown[];
    try {
      const result = await pool.query(sql, params);
      rows = result.rows;
    } catch (err) {
      throw new GraphragError(
        `PgvectorBackend.searchLexical failed: ${(err as Error).message}`,
        "STORAGE_ERROR"
      );
    }

    return rows.map((r) => {
      const row = r as ChunkRow & { rank: number };
      return rowToRetrievedChunk(row, row.rank);
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

  async close(): Promise<void> {
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
     */
    seedEntitiesByEmbedding: async (embedding, topK) => {
      try {
        const pool = await this.ensureReady();
        const result = await pool.query(SEED_ENTITIES_SQL, [
          toVectorLiteral(embedding),
          topK,
        ]);
        return result.rows.map((r) => {
          const row = r as { id: string; canonical_name: string };
          return { id: row.id, canonical_name: row.canonical_name };
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
    seedEntitiesByEmbedding: (embedding, topK) =>
      this.graphArmSeed.seedEntitiesByEmbedding(embedding, topK),

    chunksByEntityIds: async (entityIds, validAt, limit) => {
      // Same empty-array short-circuit as the one-hop query: ANY over an
      // empty JS array leaves Postgres without a type to infer.
      if (entityIds.length === 0) return [];
      try {
        const pool = await this.ensureReady();
        const result = await pool.query(ENTITY_CHUNKS_SQL, [
          [...entityIds],
          validAt,
          limit,
        ]);
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
}
