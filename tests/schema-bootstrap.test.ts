/**
 * schema-bootstrap: integration tests for the four ledger tables
 * (entities / entity_aliases / triples / extraction_records).
 *
 * Runs against a unique schema on whatever Postgres `resolvePgConnectionString`
 * selects (`.env.local` / `GRAPHRAG_MEMORY_DB_URL` / legacy localhost).
 * It must never DROP `public.chunks` — that table is the product ledger.
 *
 * Per docs/.claude/rules/test.md: if Postgres is unreachable the suite must
 * SKIP LOUDLY with the documented Validation block — never silently pass.
 * In CI (`CI=true`) the same miss is a hard failure.
 *
 * Coverage contract (per specs/p0-schema.md §"Testing Strategy", but T2
 * only requires the first row to land; later T3-T8 rows are added by
 * later tickets):
 *   1. Idempotency: upSchemaBootstrap() twice in a row -> no error, table/index
 *      counts unchanged.   <- THIS FILE
 *   2-9. (FK SET NULL / RESTRICT / CASCADE, CHECK, @>, index inventory)
 *      - added by later tickets.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { upSchemaBootstrap } from "../src/core/storage/schema-bootstrap.js";
import { ENTITY_TYPES } from "../src/core/extraction/entity-type.js";
import {
  SOURCE_DOC_STATUS,
  COMMUNITY_INDEX_STATUS,
  INDEX_JOB_STATUS,
} from "../src/core/types.js";
import {
  createPgIntegrationHarness,
  redactPgConnectionString,
  warnPgUnavailable,
} from "./integration/pg-test-harness.js";

/**
 * The four ledger tables we own. Keep in sync with specs/p0-schema.md.
 * `chunks` is stage-1 owned and listed for cross-table FK count only.
 */
const LEDGER_TABLES = [
  "entities",
  "entity_aliases",
  "triples",
  "extraction_records",
] as const;

/**
 * The projection tables `upSchemaBootstrap` also bootstraps (specs/neo4j-graph-arm.md
 * T2). Not a ledger table — it carries the ledger→Neo4j sync intent log — but it
 * rides the same idempotent bootstrap, so the drop/count/presence invariants
 * below cover it too.
 */
const PROJECTION_TABLES = ["projection_outbox"] as const;

/**
 * operator-console T1: the 资料 prose SoR that the dashboard main list
 * opens. Rides the same idempotent bootstrap so an empty `iknow_memory`
 * database boots cleanly.
 */
const SOURCE_DOCUMENT_TABLES = ["source_documents"] as const;

/**
 * graph-index-standard-fast T3: the claims ledger table the standard
 * extract job writes after canonical merge (ADR 0071). Rides the same
 * idempotent bootstrap.
 */
const CLAIMS_TABLES = ["claims"] as const;

/** Every table the bootstrap owns; dropped and re-created by the first test. */
const BOOTSTRAP_TABLES = [
  ...LEDGER_TABLES,
  ...PROJECTION_TABLES,
  ...SOURCE_DOCUMENT_TABLES,
  ...CLAIMS_TABLES,
] as const;

/**
 * The table names we count via pg_tables: everything the bootstrap owns +
 * `chunks`. Filtering on this set keeps the count independent of any other
 * tables that may exist in the database (e.g. test leftovers).
 */
const COUNTED_TABLES = [...BOOTSTRAP_TABLES, "chunks"] as const;

const pgHarness = await createPgIntegrationHarness({
  label: "schema-bootstrap",
  testPath: "tests/schema-bootstrap.test.ts",
  expectedCommand: "npx vitest run tests/schema-bootstrap.test.ts",
  schemaPrefix: "schema_bootstrap",
  defaultConnectionString: "postgresql://postgres@localhost/postgres",
});
const { connectionString: DB_URL, schema: SCHEMA, describePg } = pgHarness;

describePg("schema-bootstrap: idempotent up() against real Postgres", () => {
  let client: pg.Client | undefined;

  beforeAll(async () => {
    try {
      client = pgHarness.createClient(DB_URL);
      await client.connect();
      await pgHarness.resetSchema(client);
      await client.query(`SET search_path TO "${SCHEMA}", public`);
    } catch (err) {
      warnPgUnavailable({
        label: "schema-bootstrap",
        testPath: "tests/schema-bootstrap.test.ts (idempotent)",
        expectedCommand:
          "npx vitest run tests/schema-bootstrap.test.ts -t 'idempotent'",
        connectionString: DB_URL,
        error: err,
        requiresVector: false,
      });
      client = undefined;
    }
  });

  afterAll(async () => {
    if (!client) return;
    try {
      await pgHarness.dropSchema(client);
    } finally {
      await client.end();
    }
  });

  it("calling upSchemaBootstrap twice yields the same pg_tables count and does not throw", async () => {
    if (!client) {
      throw new Error(
        `Postgres not reachable at ${redactPgConnectionString(DB_URL)} — see Validation block in beforeAll`
      );
    }
    const c = client;

    // Isolated schema only — never DROP public.chunks (product ledger).
    await pgHarness.resetSchema(c);
    await c.query(`SET search_path TO "${SCHEMA}", public`);
    await c.query("CREATE EXTENSION IF NOT EXISTS vector");
    await c.query(`
      CREATE TABLE chunks (
        id uuid PRIMARY KEY,
        content text NOT NULL,
        embedding vector(1536) NOT NULL,
        valid_from timestamptz NOT NULL,
        valid_until timestamptz NULL,
        source_ref text NOT NULL,
        metadata jsonb NOT NULL,
        created_at timestamptz NOT NULL
      )
    `);

    // First invocation.
    await upSchemaBootstrap(c, 1536, 2000);
    const firstCount = await countPgTables(c);

    // Second invocation must not throw AND must not change the table count.
    await expect(upSchemaBootstrap(c, 1536, 2000)).resolves.toBeUndefined();
    const secondCount = await countPgTables(c);

    expect(secondCount).toBe(firstCount);
    const tableNames = await listTableNames(c);
    for (const t of BOOTSTRAP_TABLES) {
      expect(tableNames).toContain(t);
    }
    const chunkCols = await c.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = 'chunks'`,
      [SCHEMA]
    );
    expect(chunkCols.rows.map((r) => r.column_name)).toContain("embedding");
  });

  // -------------------------------------------------------------------
  // T3: DDL contract lock for entities + entity_aliases.
  //
  // The idempotency test above drops + recreates the schema, so by the
  // time these tests run (vitest is sequential within a describe) the
  // tables exist with the pinned DDL. Each test below pins one row of
  // specs/p0-schema.md §"Testing Strategy" against these two tables:
  //   - column enumeration (info_schema.columns)
  //   - index inventory for the three indexes serving these two tables
  //   - CHECK rejections on type / alias_type
  //   - FK CASCADE entity -> aliases (ordering caveat noted inline)
  //
  // Triples / extraction_records coverage is intentionally left to
  // later tickets (T4+) — this describe only locks the two tables it
  // owns per the T3 split.
  // -------------------------------------------------------------------
  describe("entities + entity_aliases DDL contract", () => {
    function requireClient(): pg.Client {
      if (!client) {
        throw new Error(
          `Postgres not reachable at ${redactPgConnectionString(DB_URL)} — see Validation block in beforeAll`
        );
      }
      return client;
    }

    /**
     * Read column names for a given table from information_schema.columns.
     * Single source of truth for the column-enumeration probes; the
     * caller asserts presence via toContain on the returned set.
     */
    async function readColumns(
      c: pg.Client,
      tableName: string
    ): Promise<Set<string>> {
      const res = await c.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
           WHERE table_name = $1 AND table_schema = $2`,
        [tableName, SCHEMA]
      );
      return new Set(res.rows.map((r) => r.column_name));
    }

    /**
     * Read the per-table indexes that this ticket owns (the three indexes
     * pinned in specs/p0-schema.md §"Indexes" for entities +
     * entity_aliases). Returns a map keyed by index name with
     * { isUnique, definition } so callers can assert uniqueness on the
     * (entity_id, alias) index without hard-coding the Postgres-generated
     * index name.
     */
    async function readOwnedIndexes(
      c: pg.Client
    ): Promise<Map<string, { isUnique: boolean; definition: string }>> {
      const res = await c.query<{
        indexname: string;
        indexdef: string;
      }>(
        `SELECT indexname, indexdef FROM pg_indexes
           WHERE schemaname = $1
             AND tablename IN ('entities','entity_aliases')`,
        [SCHEMA]
      );
      const map = new Map<string, { isUnique: boolean; definition: string }>();
      for (const row of res.rows) {
        // pg_indexes.indexdef starts with "CREATE [UNIQUE] INDEX ..."
        const isUnique = /^CREATE UNIQUE INDEX/i.test(row.indexdef);
        map.set(row.indexname, { isUnique, definition: row.indexdef });
      }
      return map;
    }

    it("entities exposes every column pinned in the DDL contract", async () => {
      const c = requireClient();
      const cols = await readColumns(c, "entities");
      const expected = [
        "id",
        "canonical_name",
        "type",
        "embedding",
        "metadata",
        "merged_into",
        "retired",
        "created_at",
      ];
      for (const col of expected) {
        expect(cols, `entities.${col} missing`).toContain(col);
      }
    });

    it("entities.embedding is a vector column with the pinned dimension", async () => {
      // M3: pin the embedding column's TYPE, not just its presence. The
      // idempotency test above creates the schema with dimension 1536, so
      // format_type must resolve to `vector(1536)`. This catches a
      // dimension drift like the H1 hardcode (vector(N) vs vector(1536))
      // that mere column-enumeration would miss.
      const c = requireClient();
      // Qualify by public schema: without the JOIN pg_namespace + nspname
      // filter, parallel integration suites that create their own
      // `entities` table in an isolated search_path (e.g. extraction-pg,
      // retrieval-pg) make the bare `relname='entities'` match across all
      // schemas and rowCount>1. The flake was an environmental artefact,
      // not a real DDL defect.
      const res = await c.query<{ column_type: string }>(
        `SELECT format_type(atttypid, atttypmod) AS column_type
           FROM pg_attribute
           JOIN pg_class ON pg_class.oid = pg_attribute.attrelid
           JOIN pg_namespace ON pg_namespace.oid = pg_class.relnamespace
          WHERE pg_class.relname = 'entities'
            AND pg_attribute.attname = 'embedding'
            AND pg_namespace.nspname = $1`,
        [SCHEMA]
      );
      expect(res.rowCount).toBe(1);
      expect(res.rows[0].column_type).toBe("vector(1536)");
    });

    it("entity_aliases exposes every column pinned in the DDL contract", async () => {
      const c = requireClient();
      const cols = await readColumns(c, "entity_aliases");
      const expected = ["id", "entity_id", "alias", "alias_type", "created_at"];
      for (const col of expected) {
        expect(cols, `entity_aliases.${col} missing`).toContain(col);
      }
    });

    it("entities has the canonical_name btree index", async () => {
      const c = requireClient();
      const idx = await readOwnedIndexes(c);
      const entry = idx.get("entities_canonical_name_idx");
      expect(entry, "entities_canonical_name_idx missing").toBeDefined();
      // Sanity: must be a plain (non-unique) btree on canonical_name.
      expect(entry!.isUnique).toBe(false);
      expect(entry!.definition).toMatch(/USING btree/i);
      expect(entry!.definition).toMatch(/\(canonical_name\)/);
    });

    it("entity_aliases has a UNIQUE (entity_id, alias) index and a non-unique (alias) btree index", async () => {
      const c = requireClient();
      const idx = await readOwnedIndexes(c);

      // UNIQUE (entity_id, alias) — pg names this index from the CREATE
      // statement we ship; pin the name explicitly so a future rename is
      // caught.
      const uniq = idx.get("entity_aliases_entity_id_alias_idx");
      expect(uniq, "entity_aliases_entity_id_alias_idx missing").toBeDefined();
      expect(uniq!.isUnique, "UNIQUE index lost its uniqueness").toBe(true);
      expect(uniq!.definition).toMatch(/\(entity_id, alias\)/);

      // Cross-entity L0 alias lookup.
      const aliasIdx = idx.get("entity_aliases_alias_idx");
      expect(aliasIdx, "entity_aliases_alias_idx missing").toBeDefined();
      expect(aliasIdx!.isUnique).toBe(false);
      expect(aliasIdx!.definition).toMatch(/USING btree/i);
      expect(aliasIdx!.definition).toMatch(/\(alias\)/);
    });

    it.each(["robot", "concept", "system"])(
      // entity-type-and-filter T1: the closed set is
      // person/organization/place/event — the legacy 'concept'/'system'
      // values must be rejected by the CHECK exactly like any unknown type.
      "CHECK rejects an unknown entities.type value (%s)",
      async (badType) => {
        const c = requireClient();
        // Minimal NOT-NULL columns only — embedding is nullable, metadata
        // has a server default, so omitting them isolates the CHECK.
        await expect(
          c.query(
            `INSERT INTO entities (id, canonical_name, type)
             VALUES ($1, $2, $3)`,
            [crypto.randomUUID(), `bad-type-${badType}`, badType]
          )
        ).rejects.toThrow();
      }
    );

    it.each(["person", "organization", "place", "event"])(
      "CHECK accepts the closed-set value %s",
      async (okType) => {
        const c = requireClient();
        await c.query(
          `INSERT INTO entities (id, canonical_name, type)
           VALUES ($1, $2, $3)`,
          [crypto.randomUUID(), `ok-type-${okType}`, okType]
        );
        const { rows } = await c.query<{ type: string }>(
          `SELECT type FROM entities WHERE canonical_name = $1`,
          [`ok-type-${okType}`]
        );
        expect(rows[0]?.type).toBe(okType);
      }
    );

    it("CHECK rejects an unknown entity_aliases.alias_type value", async () => {
      const c = requireClient();
      // First create a valid parent entity — alias_type CHECK runs before
      // the FK check, so this still isolates the CHECK behaviour.
      const entityId = crypto.randomUUID();
      await c.query(
        `INSERT INTO entities (id, canonical_name, type)
           VALUES ($1, $2, $3)`,
        [entityId, "alice-t3-alias-check", "person"]
      );
      await expect(
        c.query(
          `INSERT INTO entity_aliases (id, entity_id, alias, alias_type)
             VALUES ($1, $2, $3, $4)`,
          [crypto.randomUUID(), entityId, "ali", "nickname"]
        )
      ).rejects.toThrow();
    });

    it("FK CASCADE: deleting an entity removes its aliases", async () => {
      const c = requireClient();
      // Spec coverage-contract row 6: only testable when no triple
      // references the entity, because triples.{head_id,tail_id} are
      // ON DELETE RESTRICT — which is the whole point of RESTRICT, and
      // why the CASCADE test must stand on its own entity with zero
      // triples. The order below is intentional and the comment above
      // matches the spec note.
      const entityId = crypto.randomUUID();
      const aliasId = crypto.randomUUID();
      await c.query(
        `INSERT INTO entities (id, canonical_name, type)
           VALUES ($1, $2, $3)`,
        [entityId, "eve-t3-cascade", "person"]
      );
      await c.query(
        `INSERT INTO entity_aliases (id, entity_id, alias, alias_type)
           VALUES ($1, $2, $3, $4)`,
        [aliasId, entityId, "eve-alias", "name"]
      );

      const before = await c.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM entity_aliases WHERE entity_id = $1`,
        [entityId]
      );
      expect(Number(before.rows[0].count)).toBe(1);

      // Direct SQL — RESTRICT would block this DELETE if any triple
      // referenced the entity, but our entity has zero triples, so the
      // CASCADE on entity_aliases.entity_id fires as designed.
      await c.query(`DELETE FROM entities WHERE id = $1`, [entityId]);

      const after = await c.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM entity_aliases WHERE id = $1`,
        [aliasId]
      );
      expect(Number(after.rows[0].count)).toBe(0);
    });
  });

  // -------------------------------------------------------------------
  // T4: DDL contract lock for triples.
  //
  // Runs after the idempotency test (which drops + recreates all ledger tables
  // and the minimal `chunks` stand-in), so `triples` and `chunks` exist with
  // the pinned DDL when these tests execute (vitest is sequential within a
  // describe). Each test pins one row of specs/p0-schema.md
  // §"Testing Strategy" against the triples table.
  // -------------------------------------------------------------------
  describe("triples DDL contract", () => {
    function requireClient(): pg.Client {
      if (!client) {
        throw new Error(
          `Postgres not reachable at ${redactPgConnectionString(DB_URL)} — see Validation block in beforeAll`
        );
      }
      return client;
    }

    /**
     * Read column names for a given table from information_schema.columns.
     * Local copy of the T3 helper so this describe is self-contained.
     */
    async function readColumns(
      c: pg.Client,
      tableName: string
    ): Promise<Set<string>> {
      const res = await c.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
           WHERE table_name = $1 AND table_schema = $2`,
        [tableName, SCHEMA]
      );
      return new Set(res.rows.map((r) => r.column_name));
    }

    /**
     * Read the five triples indexes from pg_indexes + pg_class/pg_am so the
     * access-method type (btree vs gist) can be asserted without relying on
     * the Postgres-generated index definition text.
     *
     * The pg_class join is qualified to the CURRENT schema: an unqualified
     * `relname = i.indexname` also matches a same-named index that a
     * parallel integration suite created in its own throwaway schema, which
     * makes this map collapse two rows into one (false PASS on the access
     * method) or pick the wrong one (false FAIL). Same reason the
     * embedding-column probe above pins `nspname`.
     */
    async function readTriplesIndexAm(
      c: pg.Client
    ): Promise<Map<string, string>> {
      const res = await c.query<{ indexname: string; amname: string }>(
        `SELECT i.indexname, am.amname
           FROM pg_indexes i
           JOIN pg_class r ON r.relname = i.indexname
           JOIN pg_namespace rn ON rn.oid = r.relnamespace
           JOIN pg_am am ON am.oid = r.relam
          WHERE i.schemaname = $1 AND i.tablename = 'triples'
            AND rn.nspname = $1`,
        [SCHEMA]
      );
      return new Map(res.rows.map((r) => [r.indexname, r.amname]));
    }

    it("triples exposes every column pinned in the DDL contract", async () => {
      const c = requireClient();
      const cols = await readColumns(c, "triples");
      const expected = [
        "id",
        "head_id",
        "tail_id",
        "relation_raw",
        "relation_norm",
        "confidence",
        "source_chunk_id",
        "valid_window",
        "superseded_by",
        "evidence_span",
        "extractor",
        "created_at",
      ];
      for (const col of expected) {
        expect(cols, `triples.${col} missing`).toContain(col);
      }
    });

    it("triples has the five pinned indexes with the right access methods", async () => {
      const c = requireClient();
      const ams = await readTriplesIndexAm(c);

      // GiST on valid_window — must be gist, not a btree fallback.
      expect(ams.get("triples_valid_window_idx")).toBe("gist");
      // The four btree indexes.
      expect(ams.get("triples_head_id_idx")).toBe("btree");
      expect(ams.get("triples_tail_id_idx")).toBe("btree");
      expect(ams.get("triples_source_chunk_id_idx")).toBe("btree");
      expect(ams.get("triples_relation_norm_idx")).toBe("btree");
    });

    it("CHECK rejects confidence out of [0,1] (negative)", async () => {
      const c = requireClient();
      const { headId, tailId } = await mintTripleEntities(c);
      await expect(
        c.query(
          `INSERT INTO triples
             (id, head_id, tail_id, relation_raw, relation_norm, confidence, valid_window)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            crypto.randomUUID(),
            headId,
            tailId,
            "raw",
            "norm",
            -0.5,
            tstzrangeAll(c),
          ]
        )
      ).rejects.toThrow();
    });

    it("CHECK rejects confidence out of [0,1] (above 1)", async () => {
      const c = requireClient();
      const { headId, tailId } = await mintTripleEntities(c);
      await expect(
        c.query(
          `INSERT INTO triples
             (id, head_id, tail_id, relation_raw, relation_norm, confidence, valid_window)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            crypto.randomUUID(),
            headId,
            tailId,
            "raw",
            "norm",
            1.5,
            tstzrangeAll(c),
          ]
        )
      ).rejects.toThrow();
    });

    it("NOT NULL rejects a NULL relation_raw", async () => {
      const c = requireClient();
      const { headId, tailId } = await mintTripleEntities(c);
      await expect(
        c.query(
          `INSERT INTO triples
             (id, head_id, tail_id, relation_raw, relation_norm, confidence, valid_window)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            crypto.randomUUID(),
            headId,
            tailId,
            null,
            "norm",
            0.5,
            tstzrangeAll(c),
          ]
        )
      ).rejects.toThrow();
    });

    it("NOT NULL rejects a NULL relation_norm", async () => {
      const c = requireClient();
      const { headId, tailId } = await mintTripleEntities(c);
      await expect(
        c.query(
          `INSERT INTO triples
             (id, head_id, tail_id, relation_raw, relation_norm, confidence, valid_window)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            crypto.randomUUID(),
            headId,
            tailId,
            "raw",
            null,
            0.5,
            tstzrangeAll(c),
          ]
        )
      ).rejects.toThrow();
    });

    it("FK ON DELETE SET NULL: deleting the source chunk NULLs source_chunk_id and keeps the triple", async () => {
      const c = requireClient();
      const { headId, tailId } = await mintTripleEntities(c);
      const chunkId = crypto.randomUUID();
      await insertFkProbeChunk(c, chunkId, "chunk-for-set-null");
      const tripleId = crypto.randomUUID();
      await c.query(
        `INSERT INTO triples
           (id, head_id, tail_id, relation_raw, relation_norm, confidence,
            source_chunk_id, valid_window)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [tripleId, headId, tailId, "raw", "norm", 0.5, chunkId, tstzrangeAll(c)]
      );

      // Delete the chunk; the triple must survive with a nulled source_chunk_id
      // (spec coverage-contract row 2).
      await c.query(`DELETE FROM chunks WHERE id = $1`, [chunkId]);

      const after = await c.query<{ source_chunk_id: string | null }>(
        `SELECT source_chunk_id FROM triples WHERE id = $1`,
        [tripleId]
      );
      expect(after.rowCount).toBe(1);
      expect(after.rows[0].source_chunk_id).toBeNull();
    });

    it("FK ON DELETE RESTRICT: deleting an entity referenced as head_id fails", async () => {
      const c = requireClient();
      const { headId, tailId } = await mintTripleEntities(c);
      await c.query(
        `INSERT INTO triples
           (id, head_id, tail_id, relation_raw, relation_norm, confidence, valid_window)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          crypto.randomUUID(),
          headId,
          tailId,
          "raw",
          "norm",
          0.5,
          tstzrangeAll(c),
        ]
      );
      // RESTRICT must block the delete of the head entity (spec row 5).
      await expect(
        c.query(`DELETE FROM entities WHERE id = $1`, [headId])
      ).rejects.toThrow();
    });

    it("FK ON DELETE RESTRICT: deleting an entity referenced as tail_id fails", async () => {
      const c = requireClient();
      const { headId, tailId } = await mintTripleEntities(c);
      await c.query(
        `INSERT INTO triples
           (id, head_id, tail_id, relation_raw, relation_norm, confidence, valid_window)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          crypto.randomUUID(),
          headId,
          tailId,
          "raw",
          "norm",
          0.5,
          tstzrangeAll(c),
        ]
      );
      // RESTRICT must block the delete of the tail entity.
      await expect(
        c.query(`DELETE FROM entities WHERE id = $1`, [tailId])
      ).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------
  // T5: DDL contract lock for extraction_records + valid_window @>
  // boundary probes + complete index inventory (the 13 indexes pinned
  // by specs/p0-schema.md §"Indexes").
  //
  // Runs after the idempotency test which drops + recreates the schema,
  // so all four ledger tables + the minimal `chunks` stand-in are present.
  // Each test pins one row of §"Testing Strategy" coverage contract 8
  // (@> probes) and §"Success Criteria" row 6 (13-index inventory).
  // -------------------------------------------------------------------
  describe("extraction_records DDL contract + valid_window @>", () => {
    function requireClient(): pg.Client {
      if (!client) {
        throw new Error(
          `Postgres not reachable at ${redactPgConnectionString(DB_URL)} — see Validation block in beforeAll`
        );
      }
      return client;
    }

    async function readColumns(
      c: pg.Client,
      tableName: string
    ): Promise<Set<string>> {
      const res = await c.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
           WHERE table_name = $1 AND table_schema = $2`,
        [tableName, SCHEMA]
      );
      return new Set(res.rows.map((r) => r.column_name));
    }

    /**
     * Read pg_indexes rows for the named ledger tables (entities,
     * entity_aliases, triples, extraction_records). Returns a map keyed
     * by index name with the raw `indexdef` string so callers can assert
     * uniqueness / access method without re-querying pg_class.
     */
    async function readLedgerIndexes(
      c: pg.Client
    ): Promise<Map<string, { tablename: string; indexdef: string }>> {
      const res = await c.query<{
        indexname: string;
        tablename: string;
        indexdef: string;
      }>(
        `SELECT indexname, tablename, indexdef FROM pg_indexes
           WHERE schemaname = $1
             AND tablename IN ('entities','entity_aliases','triples','extraction_records')`,
        [SCHEMA]
      );
      const map = new Map<string, { tablename: string; indexdef: string }>();
      for (const row of res.rows) {
        map.set(row.indexname, {
          tablename: row.tablename,
          indexdef: row.indexdef,
        });
      }
      return map;
    }

    it("extraction_records exposes every column pinned in the DDL contract", async () => {
      const c = requireClient();
      const cols = await readColumns(c, "extraction_records");
      const expected = [
        "id",
        "batch_id",
        "chunk_id",
        "status",
        "error_code",
        "error_msg",
        "triples_count",
        "unmapped_count",
        "started_at",
        "finished_at",
        "created_at",
        "proposed_payload",
        "discarded_at",
      ];
      for (const col of expected) {
        expect(cols, `extraction_records.${col} missing`).toContain(col);
      }
    });

    it("CHECK rejects an unknown extraction_records.status value", async () => {
      const c = requireClient();
      await expect(
        c.query(
          `INSERT INTO extraction_records
             (id, batch_id, status, started_at)
             VALUES ($1, $2, $3, now())`,
          [crypto.randomUUID(), crypto.randomUUID(), "running"]
        )
      ).rejects.toThrow();
    });

    it("extraction_records has the four pinned btree indexes", async () => {
      const c = requireClient();
      const idx = await readLedgerIndexes(c);
      for (const name of [
        "extraction_records_chunk_id_idx",
        "extraction_records_batch_id_idx",
        "extraction_records_status_idx",
        "extraction_records_created_at_idx",
      ]) {
        const entry = idx.get(name);
        expect(entry, `${name} missing`).toBeDefined();
        expect(entry!.tablename).toBe("extraction_records");
        expect(entry!.indexdef).toMatch(/USING btree/i);
      }
      // Per-index column matches.
      expect(idx.get("extraction_records_chunk_id_idx")!.indexdef).toMatch(
        /\(chunk_id\)/
      );
      expect(idx.get("extraction_records_batch_id_idx")!.indexdef).toMatch(
        /\(batch_id\)/
      );
      expect(idx.get("extraction_records_status_idx")!.indexdef).toMatch(
        /\(status\)/
      );
      expect(idx.get("extraction_records_created_at_idx")!.indexdef).toMatch(
        /\(created_at\)/
      );
    });

    it("the full ledger index inventory contains exactly the 12 pinned indexes", async () => {
      // Spec §"Success Criteria" row 6 + §"Testing Strategy" row 9:
      // introspect every index in the §"Indexes" table; the count must
      // match exactly and the names must be the ones we pinned in
      // schema-bootstrap.ts. We assert by explicit name-list rather than a raw
      // count so the test fails loudly if a stray index appears or a
      // pinned one is renamed.
      //
      // Spec prose says "13 tabled indexes" but the §Indexes table
      // itself lists 12 (1 entities + 2 entity_aliases + 5 triples +
      // 4 extraction_records). The DDL is ground truth — this test
      // pins what the schema ships, not the prose summary.
      const c = requireClient();
      const idx = await readLedgerIndexes(c);
      const pinned = [
        // entities (1)
        "entities_canonical_name_idx",
        // entity_aliases (2)
        "entity_aliases_entity_id_alias_idx",
        "entity_aliases_alias_idx",
        // triples (5)
        "triples_valid_window_idx",
        "triples_head_id_idx",
        "triples_tail_id_idx",
        "triples_source_chunk_id_idx",
        "triples_relation_norm_idx",
        // extraction_records (4)
        "extraction_records_chunk_id_idx",
        "extraction_records_batch_id_idx",
        "extraction_records_status_idx",
        "extraction_records_created_at_idx",
      ];
      expect(pinned.length).toBe(12);
      for (const name of pinned) {
        expect(idx.has(name), `${name} missing from pg_indexes`).toBe(true);
      }
      // No foreign ledger-name indexes (defends against accidental duplicates).
      // Implicit `_pkey` indexes from the PK constraints are owned by
      // Postgres itself, not by our DDL — exclude them so the comparison
      // matches the 12 modeled indexes we ship.
      const p0IndexNames = [...idx.keys()].filter(
        (n) =>
          !n.endsWith("_pkey") &&
          (n.startsWith("entities_") ||
            n.startsWith("entity_aliases_") ||
            n.startsWith("triples_") ||
            n.startsWith("extraction_records_"))
      );
      // All pinned indexes must be exactly the set we own; if pg decided
      // to create a sibling index with a different name (e.g. on a
      // different access method) we'd want to know.
      expect(p0IndexNames.sort()).toEqual([...pinned].sort());
    });

    it("valid_window @> is left-closed, right-open, with NULL upper = forever", async () => {
      // Spec coverage-contract row 8: three boundary probes plus the
      // unbounded-forever case. Asserted via direct SQL so we pin the
      // Postgres-level semantics (the @> operator on tstzrange).
      const c = requireClient();

      type Probe = { range: string; instant: string; expectContained: boolean };
      const probes: Probe[] = [
        // [t, t+1h) contains t (left-closed)
        {
          range: "[2026-01-01 00:00:00+00,2026-01-01 01:00:00+00)",
          instant: "2026-01-01 00:00:00+00",
          expectContained: true,
        },
        // [t, t+1h) contains t+30min (interior point)
        {
          range: "[2026-01-01 00:00:00+00,2026-01-01 01:00:00+00)",
          instant: "2026-01-01 00:30:00+00",
          expectContained: true,
        },
        // [t, t+1h) does NOT contain t+1h (right-open)
        {
          range: "[2026-01-01 00:00:00+00,2026-01-01 01:00:00+00)",
          instant: "2026-01-01 01:00:00+00",
          expectContained: false,
        },
        // [t, NULL) — null upper bound = forever, so a far-future instant
        // is contained.
        {
          range: "[2026-01-01 00:00:00+00,)",
          instant: "2099-12-31 23:59:59+00",
          expectContained: true,
        },
      ];

      for (const p of probes) {
        const res = await c.query<{ contains: boolean }>(
          `SELECT $1::tstzrange @> $2::timestamptz AS contains`,
          [p.range, p.instant]
        );
        expect(res.rows[0].contains, `${p.range} @> ${p.instant}`).toBe(
          p.expectContained
        );
      }
    });

    it("FK ON DELETE SET NULL: deleting the chunk NULLs extraction_records.chunk_id and keeps the row", async () => {
      // Spec coverage-contract row 4: chunks -> extraction_records.chunk_id.
      const c = requireClient();
      const chunkId = crypto.randomUUID();
      await insertFkProbeChunk(
        c,
        chunkId,
        "chunk-for-extraction-record-set-null"
      );

      const recordId = crypto.randomUUID();
      const batchId = crypto.randomUUID();
      await c.query(
        `INSERT INTO extraction_records
           (id, batch_id, chunk_id, status, started_at)
           VALUES ($1, $2, $3, $4, now())`,
        [recordId, batchId, chunkId, "pending"]
      );

      // Delete the chunk; the record must survive with a nulled chunk_id.
      await c.query(`DELETE FROM chunks WHERE id = $1`, [chunkId]);

      const after = await c.query<{ chunk_id: string | null }>(
        `SELECT chunk_id FROM extraction_records WHERE id = $1`,
        [recordId]
      );
      expect(after.rowCount).toBe(1);
      expect(after.rows[0].chunk_id).toBeNull();
    });
  });

  // -------------------------------------------------------------------
  // Neo4j graph arm T2: DDL contract lock for projection_outbox
  // (specs/neo4j-graph-arm.md SC3/SC4, ADR-0001).
  //
  // Runs after the idempotency test which drops + recreates everything the
  // bootstrap owns. The pins below are the ones later tickets depend on:
  // the `status` lifecycle T3's drain transitions, the subject CHECK that
  // makes "chunks never enter Neo4j" a database invariant rather than a
  // convention, and the partial UNIQUE index that keeps a re-run backfill
  // from piling up duplicate pending intents.
  // -------------------------------------------------------------------
  describe("projection_outbox DDL contract", () => {
    function requireClient(): pg.Client {
      if (!client) {
        throw new Error(
          `Postgres not reachable at ${redactPgConnectionString(DB_URL)} — see Validation block in beforeAll`
        );
      }
      return client;
    }

    async function readColumns(
      c: pg.Client,
      tableName: string
    ): Promise<Set<string>> {
      const res = await c.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
           WHERE table_name = $1 AND table_schema = $2`,
        [tableName, SCHEMA]
      );
      return new Set(res.rows.map((r) => r.column_name));
    }

    /** Index name → indexdef for the table's own indexes. */
    async function readOutboxIndexes(
      c: pg.Client
    ): Promise<Map<string, string>> {
      const res = await c.query<{ indexname: string; indexdef: string }>(
        `SELECT indexname, indexdef FROM pg_indexes
           WHERE schemaname = $1 AND tablename = 'projection_outbox'`,
        [SCHEMA]
      );
      return new Map(res.rows.map((r) => [r.indexname, r.indexdef]));
    }

    /** Insert one intent row; returns the minted id. */
    async function insertIntent(
      c: pg.Client,
      over: {
        subjectKind?: string;
        subjectId?: string;
        status?: string;
      } = {}
    ): Promise<string> {
      const id = crypto.randomUUID();
      const columns = ["id", "subject_kind", "subject_id"];
      const values: unknown[] = [
        id,
        over.subjectKind ?? "entity",
        over.subjectId ?? crypto.randomUUID(),
      ];
      if (over.status !== undefined) {
        columns.push("status");
        values.push(over.status);
      }
      const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");
      await c.query(
        `INSERT INTO projection_outbox (${columns.join(", ")})
           VALUES (${placeholders})`,
        values
      );
      return id;
    }

    it("projection_outbox exposes every column pinned in the DDL contract", async () => {
      const c = requireClient();
      const cols = await readColumns(c, "projection_outbox");
      const expected = [
        "id",
        "subject_kind",
        "subject_id",
        "status",
        "attempts",
        "last_error",
        "created_at",
        "processed_at",
      ];
      for (const col of expected) {
        expect(cols, `projection_outbox.${col} missing`).toContain(col);
      }
    });

    it("a freshly emitted intent defaults to status 'pending' with zero attempts", async () => {
      const c = requireClient();
      const id = await insertIntent(c);
      const res = await c.query<{
        status: string;
        attempts: number;
        processed_at: string | null;
      }>(
        `SELECT status, attempts, processed_at FROM projection_outbox
           WHERE id = $1`,
        [id]
      );
      expect(res.rows[0]).toMatchObject({
        status: "pending",
        attempts: 0,
        processed_at: null,
      });
    });

    it("status accepts exactly pending / done / failed (T3 drain lifecycle)", async () => {
      const c = requireClient();
      for (const status of ["pending", "done", "failed"]) {
        await expect(insertIntent(c, { status })).resolves.toBeTypeOf("string");
      }
      await expect(insertIntent(c, { status: "draining" })).rejects.toThrow();
    });

    it("CHECK rejects a chunk subject — chunks never enter the projection", async () => {
      const c = requireClient();
      await expect(insertIntent(c, { subjectKind: "chunk" })).rejects.toThrow();
      for (const subjectKind of ["entity", "triple"]) {
        await expect(insertIntent(c, { subjectKind })).resolves.toBeTypeOf(
          "string"
        );
      }
    });

    it("has the drain-scan and subject-lookup indexes", async () => {
      const c = requireClient();
      const idx = await readOutboxIndexes(c);
      const scan = idx.get("projection_outbox_status_created_at_idx");
      expect(
        scan,
        "projection_outbox_status_created_at_idx missing"
      ).toBeDefined();
      expect(scan!).toMatch(/\(status, created_at\)/);
      const subject = idx.get("projection_outbox_subject_idx");
      expect(subject, "projection_outbox_subject_idx missing").toBeDefined();
      expect(subject!).toMatch(/\(subject_kind, subject_id\)/);
    });

    it("a partial UNIQUE index collapses duplicate pending intents for one subject", async () => {
      const c = requireClient();
      const idx = await readOutboxIndexes(c);
      const uniq = idx.get("projection_outbox_pending_subject_idx");
      expect(
        uniq,
        "projection_outbox_pending_subject_idx missing"
      ).toBeDefined();
      expect(uniq!).toMatch(/^CREATE UNIQUE INDEX/i);
      expect(uniq!).toMatch(/WHERE \(status = 'pending'/);

      // Same subject twice while pending → rejected; once the first intent
      // is drained the subject can be re-enqueued, which is what keeps a
      // re-run backfill idempotent without blocking later changes.
      const subjectId = crypto.randomUUID();
      const first = await insertIntent(c, { subjectId });
      await expect(insertIntent(c, { subjectId })).rejects.toThrow();
      await c.query(
        `UPDATE projection_outbox SET status = 'done', processed_at = now()
           WHERE id = $1`,
        [first]
      );
      await expect(insertIntent(c, { subjectId })).resolves.toBeTypeOf(
        "string"
      );
    });

    it("carries no FK to entities or triples so an intent outlives its ledger row", async () => {
      // A CASCADE from the ledger would silently delete the very intent that
      // tells the projector to remove the node from Neo4j.
      const c = requireClient();
      const res = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM information_schema.table_constraints
           WHERE table_schema = $1
             AND table_name = 'projection_outbox'
             AND constraint_type = 'FOREIGN KEY'`,
        [SCHEMA]
      );
      expect(Number(res.rows[0]!.n)).toBe(0);
    });
  });

  // -------------------------------------------------------------------
  // operator-console T1: ledger schema adds 资料 (source_documents) and
  // the chunks back-pointer columns (source_doc_id, ordinal).
  //
  // Idempotency has already dropped + recreated the schema above, so
  // `source_documents` and the back-pointer columns exist when this
  // describe runs.
  // -------------------------------------------------------------------
  describe("source_documents DDL contract", () => {
    function requireClient(): pg.Client {
      if (!client) {
        throw new Error(
          `Postgres not reachable at ${redactPgConnectionString(DB_URL)} — see Validation block in beforeAll`
        );
      }
      return client;
    }

    async function readColumns(
      c: pg.Client,
      tableName: string
    ): Promise<Set<string>> {
      const res = await c.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
           WHERE table_name = $1 AND table_schema = $2`,
        [tableName, SCHEMA]
      );
      return new Set(res.rows.map((r) => r.column_name));
    }

    it("source_documents exposes every column pinned in the operator-console ledger contract", async () => {
      const c = requireClient();
      const cols = await readColumns(c, "source_documents");
      for (const col of [
        "id",
        "source_ref",
        "title",
        "content",
        "created_at",
      ]) {
        expect(cols, `source_documents.${col} missing`).toContain(col);
      }
    });

    it("source_documents.source_ref is unique so a re-push can locate the row", async () => {
      const c = requireClient();
      const res = await c.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes
           WHERE schemaname = $1 AND tablename = 'source_documents'`,
        [SCHEMA]
      );
      const uniqueOnSourceRef = res.rows.some(
        (row) =>
          /^CREATE UNIQUE INDEX/i.test(row.indexdef) &&
          /\(source_ref\)/.test(row.indexdef)
      );
      expect(
        uniqueOnSourceRef,
        "source_documents must have a UNIQUE (source_ref) index"
      ).toBe(true);
    });

    it("chunks has source_doc_id and ordinal back-pointer columns", async () => {
      const c = requireClient();
      const cols = await readColumns(c, "chunks");
      expect(cols, "chunks.source_doc_id missing").toContain("source_doc_id");
      expect(cols, "chunks.ordinal missing").toContain("ordinal");
    });

    it("the status CHECK accepts exactly SOURCE_DOC_STATUS (T3)", async () => {
      // The CHECK polices the column; SOURCE_DOC_STATUS supplies the values
      // the writers use. If the two spell the vocabulary independently, a
      // rename produces rows the CHECK rejects. Asserted against the live
      // constraint rather than the DDL text so a hand-edited schema fails
      // here too.
      const c = requireClient();
      const accepted: string[] = [];
      for (const status of Object.values(SOURCE_DOC_STATUS)) {
        const res = await c.query(
          `INSERT INTO source_documents (id, source_ref, content, status)
             VALUES ($1, $2, $3, $4)
           ON CONFLICT (source_ref) DO UPDATE SET status = EXCLUDED.status
           RETURNING status`,
          [crypto.randomUUID(), `status-${status}`, "body", status]
        );
        accepted.push((res.rows[0] as { status: string }).status);
      }
      expect(accepted).toEqual(Object.values(SOURCE_DOC_STATUS));
      await expect(
        c.query(
          `INSERT INTO source_documents (id, source_ref, content, status)
             VALUES ($1, $2, $3, $4)`,
          [crypto.randomUUID(), "status-bogus", "body", "not-a-status"]
        )
      ).rejects.toThrow(/source_documents_status_check/);
    });

    it("source_documents carries content_identity (corpus-index-job T2)", async () => {
      const c = requireClient();
      const cols = await readColumns(c, "source_documents");
      expect(cols, "source_documents.content_identity missing").toContain(
        "content_identity"
      );
    });

    it("source_documents has the UNIQUE (source_ref, content_identity) pair index", async () => {
      const c = requireClient();
      const res = await c.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes
           WHERE schemaname = $1 AND tablename = 'source_documents'`,
        [SCHEMA]
      );
      const pairUnique = res.rows.some(
        (row) =>
          /^CREATE UNIQUE INDEX/i.test(row.indexdef) &&
          /\(source_ref, content_identity\)/.test(row.indexdef)
      );
      expect(
        pairUnique,
        "source_documents must have a UNIQUE (source_ref, content_identity) index"
      ).toBe(true);
    });
  });

  // -------------------------------------------------------------------
  // corpus-index-job T2: the durable index-job ledger. Status reuses the
  // four C-ready words (INDEX_JOB_STATUS); a fifth word is the storage
  // boundary the CHECK must reject, and the derived job_id is the submit
  // identity, so it is the PRIMARY KEY.
  // -------------------------------------------------------------------
  describe("index_jobs DDL contract", () => {
    function requireClient(): pg.Client {
      if (!client) {
        throw new Error(
          `Postgres not reachable at ${redactPgConnectionString(DB_URL)} — see Validation block in beforeAll`
        );
      }
      return client;
    }

    async function readColumns(
      c: pg.Client,
      tableName: string
    ): Promise<Set<string>> {
      const res = await c.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
           WHERE table_name = $1 AND table_schema = $2`,
        [tableName, SCHEMA]
      );
      return new Set(res.rows.map((r) => r.column_name));
    }

    it("index_jobs exposes every column pinned in the corpus-index-job T2 contract", async () => {
      const c = requireClient();
      const cols = await readColumns(c, "index_jobs");
      for (const col of [
        "job_id",
        "source_ref",
        "content_identity",
        "status",
        "failure_code",
        "created_at",
        "started_at",
        "finished_at",
      ]) {
        expect(cols, `index_jobs.${col} missing`).toContain(col);
      }
    });

    it("the status CHECK accepts exactly INDEX_JOB_STATUS", async () => {
      const c = requireClient();
      let i = 0;
      for (const status of Object.values(INDEX_JOB_STATUS)) {
        await c.query(
          `INSERT INTO index_jobs (job_id, source_ref, content_identity, status)
             VALUES ($1, $2, $3, $4)`,
          [`check-${status}`, `idx-ref-${i}`, `identity-${i}`, status]
        );
        i += 1;
      }
      await expect(
        c.query(
          `INSERT INTO index_jobs (job_id, source_ref, content_identity, status)
             VALUES ('bogus-job', 'bogus-ref', 'bogus-identity', 'queued')`
        )
      ).rejects.toThrow(/index_jobs_status_check/);
    });

    it("job_id is the primary key so a repeat submit collapses onto one row", async () => {
      const c = requireClient();
      await c.query(
        `INSERT INTO index_jobs (job_id, source_ref, content_identity, status)
           VALUES ('pk-1', 'pk-ref', 'pk-identity', 'in_progress')
         ON CONFLICT (job_id) DO NOTHING`
      );
      await expect(
        c.query(
          `INSERT INTO index_jobs (job_id, source_ref, content_identity, status)
             VALUES ('pk-1', 'other-ref', 'other-identity', 'ready')`
        )
      ).rejects.toThrow(/index_jobs_pkey|duplicate key/);
    });

    it("has the (source_ref, status) index for the active-job lookup", async () => {
      const c = requireClient();
      const res = await c.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes
           WHERE schemaname = $1 AND tablename = 'index_jobs'
             AND indexname = 'index_jobs_source_ref_status_idx'`,
        [SCHEMA]
      );
      expect(
        res.rows.some((row) => /\(source_ref, status\)/.test(row.indexdef)),
        "index_jobs must carry a (source_ref, status) index"
      ).toBe(true);
    });

    it("the one-active-per-source UNIQUE index is partial to in_progress", async () => {
      const c = requireClient();
      const res = await c.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes
           WHERE schemaname = $1 AND tablename = 'index_jobs'
             AND indexname = 'index_jobs_one_active_per_source_idx'`,
        [SCHEMA]
      );
      expect(
        res.rows.some((row) => /^CREATE UNIQUE INDEX/.test(row.indexdef)),
        "index_jobs must carry a UNIQUE one-active-per-source index"
      ).toBe(true);
      expect(
        res.rows.some(
          (row) =>
            /\(source_ref\)/.test(row.indexdef) &&
            /WHERE \(status = 'in_progress'::text\)/.test(row.indexdef)
        ),
        "the unique index must be partial to in_progress rows"
      ).toBe(true);

      // The live constraint, not just its definition: a second concurrent
      // active row for one source is rejected at the storage boundary.
      await c.query(
        `INSERT INTO index_jobs (job_id, source_ref, content_identity, status)
           VALUES ('one-active-1', 'one-active-ref', 'one-active-id-1', 'in_progress')`
      );
      await expect(
        c.query(
          `INSERT INTO index_jobs (job_id, source_ref, content_identity, status)
             VALUES ('one-active-2', 'one-active-ref', 'one-active-id-2', 'in_progress')`
        )
      ).rejects.toThrow(/index_jobs_one_active_per_source_idx|duplicate key/);
      // Terminal history is unlimited, and once the active row leaves the
      // predicate a new active row for the SAME source is legal again.
      await c.query(
        `INSERT INTO index_jobs (job_id, source_ref, content_identity, status)
           VALUES ('one-active-3', 'one-active-ref', 'one-active-id-3', 'ready')`
      );
      await c.query(
        `UPDATE index_jobs SET status = 'ready' WHERE job_id = 'one-active-1'`
      );
      await c.query(
        `INSERT INTO index_jobs (job_id, source_ref, content_identity, status)
           VALUES ('one-active-4', 'one-active-ref', 'one-active-id-4', 'in_progress')`
      );
      expect(
        (
          await c.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM index_jobs
          WHERE source_ref = 'one-active-ref' AND status = 'in_progress'`
          )
        ).rows[0]!.n
      ).toBe("1");
    });
  });

  // -------------------------------------------------------------------
  // graph-index-standard-fast T3: DDL contract lock for `claims`
  // (ADR 0069 / 0071 — standard extract writes time-bounded claims after
  // canonical merge; Postgres SoR, never projected to Neo4j).
  // -------------------------------------------------------------------
  describe("claims DDL contract", () => {
    function requireClient(): pg.Client {
      if (!client) {
        throw new Error(
          `Postgres not reachable at ${redactPgConnectionString(DB_URL)} — see Validation block in beforeAll`
        );
      }
      return client;
    }

    async function readColumns(
      c: pg.Client,
      tableName: string
    ): Promise<Set<string>> {
      const res = await c.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
           WHERE table_name = $1 AND table_schema = $2`,
        [tableName, SCHEMA]
      );
      return new Set(res.rows.map((r) => r.column_name));
    }

    /** Insert one claim row against a fresh entity; returns the row id. */
    async function insertClaim(
      c: pg.Client,
      over: { chunkId?: string; confidence?: number } = {}
    ): Promise<string> {
      const entityId = crypto.randomUUID();
      await c.query(
        `INSERT INTO entities (id, canonical_name, type) VALUES ($1, $2, 'person')`,
        [entityId, `claims-${entityId}`]
      );
      const id = crypto.randomUUID();
      await c.query(
        `INSERT INTO claims
           (id, entity_id, source_chunk_id, claim_text, valid_window, confidence)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          id,
          entityId,
          over.chunkId ?? null,
          "Alice joined Acme in 2024.",
          "[2026-01-01,)",
          over.confidence ?? 0.8,
        ]
      );
      return id;
    }

    it("claims exposes every column pinned in the ledger contract", async () => {
      const c = requireClient();
      const cols = await readColumns(c, "claims");
      for (const col of [
        "id",
        "entity_id",
        "source_chunk_id",
        "claim_text",
        "valid_window",
        "confidence",
        "evidence_span",
        "extractor",
        "created_at",
      ]) {
        expect(cols, `claims.${col} missing`).toContain(col);
      }
    });

    it("claims has the entity-lookup and per-chunk-replace btree indexes", async () => {
      const c = requireClient();
      const res = await c.query<{ indexname: string; indexdef: string }>(
        `SELECT indexname, indexdef FROM pg_indexes
           WHERE schemaname = $1 AND tablename = 'claims'`,
        [SCHEMA]
      );
      const byName = new Map(res.rows.map((r) => [r.indexname, r.indexdef]));
      const entityIdx = byName.get("claims_entity_id_idx");
      expect(entityIdx, "claims_entity_id_idx missing").toBeDefined();
      expect(entityIdx).toMatch(/USING btree/i);
      expect(entityIdx).toMatch(/\(entity_id\)/);
      const chunkIdx = byName.get("claims_source_chunk_id_idx");
      expect(chunkIdx, "claims_source_chunk_id_idx missing").toBeDefined();
      expect(chunkIdx).toMatch(/\(source_chunk_id\)/);
    });

    it("CHECK rejects confidence outside [0,1]", async () => {
      const c = requireClient();
      await expect(insertClaim(c, { confidence: -0.5 })).rejects.toThrow();
      await expect(insertClaim(c, { confidence: 1.5 })).rejects.toThrow();
    });

    it("extractor defaults to 'llm' (the standard extract writer)", async () => {
      const c = requireClient();
      const id = await insertClaim(c);
      const res = await c.query<{ extractor: string }>(
        `SELECT extractor FROM claims WHERE id = $1`,
        [id]
      );
      expect(res.rows[0]!.extractor).toBe("llm");
    });

    it("FK ON DELETE CASCADE: deleting the entity removes its claims", async () => {
      const c = requireClient();
      const id = await insertClaim(c);
      const row = await c.query<{ entity_id: string }>(
        `SELECT entity_id FROM claims WHERE id = $1`,
        [id]
      );
      await c.query(`DELETE FROM entities WHERE id = $1`, [
        row.rows[0]!.entity_id,
      ]);
      const after = await c.query(`SELECT 1 FROM claims WHERE id = $1`, [id]);
      expect(after.rowCount).toBe(0);
    });

    it("FK ON DELETE SET NULL: deleting the chunk keeps the claim, nulls the provenance", async () => {
      const c = requireClient();
      const chunkId = crypto.randomUUID();
      await insertFkProbeChunk(c, chunkId, "claim-provenance-chunk");
      const id = await insertClaim(c, { chunkId });

      await c.query(`DELETE FROM chunks WHERE id = $1`, [chunkId]);

      const after = await c.query<{ source_chunk_id: string | null }>(
        `SELECT source_chunk_id FROM claims WHERE id = $1`,
        [id]
      );
      expect(after.rowCount).toBe(1);
      expect(after.rows[0]!.source_chunk_id).toBeNull();
    });
  });

  // -------------------------------------------------------------------
  // graph-index-standard-fast T5: DDL contract lock for
  // `community_index_state` — the singleton C-ready (就绪) row the
  // community-summary CLI swaps atomically with the report generation.
  // -------------------------------------------------------------------
  describe("community_index_state DDL contract", () => {
    function requireClient(): pg.Client {
      if (!client) {
        throw new Error(
          `Postgres not reachable at ${redactPgConnectionString(DB_URL)} — see Validation block in beforeAll`
        );
      }
      return client;
    }

    it("accepts exactly the COMMUNITY_INDEX_STATUS vocabulary", async () => {
      const c = requireClient();
      for (const status of Object.values(COMMUNITY_INDEX_STATUS)) {
        await c.query(
          `INSERT INTO community_index_state (id, status, failure_code)
             VALUES (1, $1, NULL)
             ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status`,
          [status]
        );
      }
      await expect(
        c.query(
          `UPDATE community_index_state SET status = 'bogus' WHERE id = 1`
        )
      ).rejects.toThrow(/community_index_state_status_check/);
    });

    it("holds at most one row: the state is corpus-level, not per-community", async () => {
      const c = requireClient();
      await c.query(
        `INSERT INTO community_index_state (id, status) VALUES (1, 'ready')
           ON CONFLICT (id) DO NOTHING`
      );
      await expect(
        c.query(
          `INSERT INTO community_index_state (id, status) VALUES (2, 'ready')`
        )
      ).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------
  // Review C1 (entity-type-and-filter): the closed-set CHECK must also
  // reach EXISTING databases. `CREATE TABLE IF NOT EXISTS` alone leaves a
  // legacy store on its old CHECK; up() must idempotently upgrade the
  // constraint, hard-deleting non-closed-set rows (operator-approved
  // destructive upgrade) and the RESTRICT-guarded triples that reference
  // them. The upgrade must leave the readiness probe satisfied so a second
  // up() is a no-op.
  // -------------------------------------------------------------------
  describe("entities type CHECK upgrade over a legacy store", () => {
    function requireClient(): pg.Client {
      if (!client) {
        throw new Error(
          `Postgres not reachable at ${redactPgConnectionString(DB_URL)} — see Validation block in beforeAll`
        );
      }
      return client;
    }

    it("replaces the legacy CHECK, deletes stale rows/edges, stays idempotent", async () => {
      const c = requireClient();
      // Rebuild the pre-T1 world from scratch: minimal chunks stand-in,
      // legacy `entities` with the shipped old CHECK, legacy `triples` whose
      // FKs are ON DELETE RESTRICT (exactly what a deployed store looks like).
      await pgHarness.resetSchema(c);
      await c.query(`SET search_path TO "${SCHEMA}", public`);
      await c.query("CREATE EXTENSION IF NOT EXISTS vector");
      await c.query(`
        CREATE TABLE chunks (
          id uuid PRIMARY KEY,
          content text NOT NULL,
          embedding vector(1536) NOT NULL,
          valid_from timestamptz NOT NULL,
          valid_until timestamptz NULL,
          source_ref text NOT NULL,
          metadata jsonb NOT NULL,
          created_at timestamptz NOT NULL
        )
      `);
      await c.query(`
        CREATE TABLE entities (
          id            uuid PRIMARY KEY,
          canonical_name text NOT NULL,
          type          text NOT NULL CHECK (type IN ('person','concept','system','event')),
          embedding     vector(1536),
          metadata      jsonb DEFAULT '{}',
          merged_into   uuid REFERENCES entities(id) ON DELETE SET NULL,
          retired       boolean NOT NULL DEFAULT false,
          created_at    timestamptz NOT NULL DEFAULT now()
        )`);
      await c.query(`
        CREATE TABLE triples (
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

      const personId = crypto.randomUUID();
      const conceptId = crypto.randomUUID();
      const systemId = crypto.randomUUID();
      await c.query(
        `INSERT INTO entities (id, canonical_name, type) VALUES
           ($1, 'legacy-person', 'person'),
           ($2, 'legacy-concept', 'concept'),
           ($3, 'legacy-system', 'system')`,
        [personId, conceptId, systemId]
      );
      await c.query(
        `INSERT INTO triples (id, head_id, tail_id, relation_raw,
                              relation_norm, confidence, valid_window)
         VALUES ($1, $2, $3, 'mentions', 'RELATED_TO', 0.9, tstzrange(now(), NULL, '[)'))`,
        [crypto.randomUUID(), personId, conceptId]
      );

      await expect(upSchemaBootstrap(c, 1536, 2000)).resolves.toBeUndefined();

      // Non-closed-set rows are hard-deleted; closed-set rows survive.
      const survivors = await c.query<{ canonical_name: string }>(
        `SELECT canonical_name FROM entities ORDER BY canonical_name`
      );
      expect(survivors.rows.map((r) => r.canonical_name)).toEqual([
        "legacy-person",
      ]);
      // The RESTRICT-guarded edge off the deleted concept is gone too.
      const edges = await c.query(
        `SELECT 1 FROM triples WHERE head_id = $1 OR tail_id = $2`,
        [personId, conceptId]
      );
      expect(edges.rowCount).toBe(0);

      // The legacy constraint name is replaced; the new one carries exactly
      // ENTITY_TYPES (kills the double-source drift the review flagged).
      const cons = await c.query<{ conname: string; condef: string }>(
        `SELECT k.conname, pg_get_constraintdef(k.oid) AS condef
           FROM pg_constraint k
           JOIN pg_class t ON t.oid = k.conrelid
           JOIN pg_namespace n ON n.oid = t.relnamespace
          WHERE n.nspname = $1 AND t.relname = 'entities'
            AND k.contype = 'c'`,
        [SCHEMA]
      );
      const typeChecks = cons.rows.filter((r) =>
        /type/.test(r.condef.replace(/\s+/g, " "))
      );
      expect(
        typeChecks.some((r) =>
          ENTITY_TYPES.every((t) => r.condef.includes(`'${t}'`))
        ),
        `no CHECK admits exactly ENTITY_TYPES: ${JSON.stringify(cons.rows)}`
      ).toBe(true);
      expect(cons.rows.map((r) => r.conname)).not.toContain(
        "entities_type_check"
      );

      // Writing a legacy value is now rejected by the re-pinned CHECK.
      await expect(
        c.query(
          `INSERT INTO entities (id, canonical_name, type)
             VALUES ($1, 'post-upgrade-concept', 'concept')`,
          [crypto.randomUUID()]
        )
      ).rejects.toThrow();

      // Idempotent: a second up() (probe may or may not short-circuit) is a
      // no-op and does not touch the survivor.
      await expect(upSchemaBootstrap(c, 1536, 2000)).resolves.toBeUndefined();
      const after = await c.query(`SELECT 1 FROM entities WHERE id = $1`, [
        personId,
      ]);
      expect(after.rowCount).toBe(1);
    });
  });
});

async function insertFkProbeChunk(
  c: pg.Client,
  id: string,
  content: string
): Promise<void> {
  const embedding = `[${Array.from({ length: 1536 }, () => 0).join(",")}]`;
  await c.query(
    `INSERT INTO chunks
       (id, content, embedding, valid_from, valid_until, source_ref, metadata, created_at)
     VALUES
       ($1, $2, $3::vector, '2026-01-01T00:00:00Z', NULL, 'fk-probe', '{}'::jsonb, '2026-01-01T00:00:00Z')`,
    [id, content, embedding]
  );
}

/**
 * Mint two fresh entities to be used as a triple's head_id / tail_id. type
 * must be one of the CHECK'd values ('person' etc); canonical_name is unique
 * per call so the test never collides with earlier rows.
 */
async function mintTripleEntities(
  c: pg.Client
): Promise<{ headId: string; tailId: string }> {
  const headId = crypto.randomUUID();
  const tailId = crypto.randomUUID();
  await c.query(
    `INSERT INTO entities (id, canonical_name, type) VALUES ($1, $2, $3)`,
    [headId, `t4-head-${headId}`, "person"]
  );
  await c.query(
    `INSERT INTO entities (id, canonical_name, type) VALUES ($1, $2, $3)`,
    [tailId, `t4-tail-${tailId}`, "person"]
  );
  return { headId, tailId };
}

/**
 * A tstzrange literal covering `[2026-01-01, +inf)` — left-closed, no upper
 * bound (spec: null upper bound = forever). Used so valid_window satisfies
 * its NOT NULL while standing outside the boundary-probe semantics T5 owns.
 */
function tstzrangeAll(c: pg.Client): unknown {
  void c;
  return `[2026-01-01,)` as unknown;
}

/**
 * Count rows in pg_tables filtered to the bootstrap tables + chunks. Used as
 * the idempotency invariant: a no-op second up() must leave the count
 * unchanged.
 *
 * Qualified to this suite's isolated schema so parallel workers that create
 * the same table names elsewhere cannot move the count.
 */
async function countPgTables(c: pg.Client): Promise<number> {
  const res = await c.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM pg_tables
       WHERE schemaname = $1 AND tablename = ANY ($2::text[])`,
    [SCHEMA, COUNTED_TABLES as unknown as string[]]
  );
  return Number(res.rows[0]?.count ?? "0");
}

/**
 * Return the set of table names we count on. Used to assert the bootstrap
 * tables actually exist after the first up() (idempotency alone wouldn't
 * distinguish "did nothing" from "created everything").
 */
async function listTableNames(c: pg.Client): Promise<string[]> {
  const res = await c.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables
       WHERE schemaname = $1 AND tablename = ANY ($2::text[])`,
    [SCHEMA, COUNTED_TABLES as unknown as string[]]
  );
  return res.rows.map((r) => r.tablename);
}
