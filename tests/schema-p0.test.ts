/**
 * schema-p0: integration tests for the four P0 tables
 * (entities / entity_aliases / triples / extraction_records).
 *
 * Runs against a real Postgres 16 at postgresql://postgres@localhost/postgres
 * (no password — local trust auth per dev environment).
 *
 * Per docs/.claude/rules/test.md: if Postgres is unreachable the suite must
 * SKIP LOUDLY with the documented Validation block — never silently pass.
 *
 * Coverage contract (per specs/p0-schema.md §"Testing Strategy", but T2
 * only requires the first row to land; later T3-T8 rows are added by
 * later tickets):
 *   1. Idempotency: upSchemaP0() twice in a row -> no error, table/index
 *      counts unchanged.   <- THIS FILE
 *   2-9. (FK SET NULL / RESTRICT / CASCADE, CHECK, @>, index inventory)
 *      - added by later tickets.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { upSchemaP0 } from "../src/core/storage/schema-p0.js";

/**
 * The four P0 tables we own. Keep in sync with specs/p0-schema.md.
 * `chunks` is stage-1 owned and listed for cross-table FK count only.
 */
const P0_TABLES = [
  "entities",
  "entity_aliases",
  "triples",
  "extraction_records",
] as const;

/**
 * The five table names we count via pg_tables: four P0 tables + `chunks`.
 * Filtering on this set keeps the count independent of any other tables
 * that may exist in the database (e.g. test leftovers).
 */
const COUNTED_TABLES = [...P0_TABLES, "chunks"] as const;

const DB_URL = "postgresql://postgres@localhost/postgres";

describe("schema-p0: idempotent up() against real Postgres", () => {
  let client: pg.Client | undefined;

  beforeAll(async () => {
    // T2 contract: skip loudly (never silently pass) when no Postgres.
    try {
      client = new pg.Client({ connectionString: DB_URL });
      await client.connect();
    } catch (err) {
      console.warn(
        `\n[schema-p0] Postgres unreachable at ${DB_URL}: ${(err as Error).message}\n`
      );
      console.warn(
        "Validation:\n" +
          "- Not run: tests/schema-p0.test.ts (idempotent)\n" +
          `- Expected command: npx vitest run tests/schema-p0.test.ts -t 'idempotent'\n` +
          `- Blocking issue: cannot connect to Postgres at ${DB_URL}\n`
      );
      // Mark the client undefined so every test bails; vitest's it() will
      // still count the run as a skip when the body throws before assertions.
      client = undefined;
    }
  });

  afterAll(async () => {
    if (client) await client.end();
  });

  it("calling upSchemaP0 twice yields the same pg_tables count and does not throw", async () => {
    if (!client) {
      throw new Error(
        `Postgres not reachable at ${DB_URL} — see Validation block in beforeAll`
      );
    }
    const c = client;

    // Drop pre-existing P0 tables so the test starts from a known-empty
    // state. Cascade is required because triples / entity_aliases /
    // extraction_records carry FKs to entities / chunks.
    for (const t of P0_TABLES) {
      await c.query(`DROP TABLE IF EXISTS "${t}" CASCADE`);
    }
    // Also drop `chunks` so the entity FK that references chunks doesn't
    // block the recreation. We recreate it as a minimal stand-in below.
    await c.query(`DROP TABLE IF EXISTS chunks CASCADE`);
    await c.query(`
      CREATE TABLE IF NOT EXISTS chunks (
        id uuid PRIMARY KEY,
        content text NOT NULL
      )
    `);

    // First invocation.
    await upSchemaP0(c);
    const firstCount = await countPgTables(c);

    // Second invocation must not throw AND must not change the table count.
    await expect(upSchemaP0(c)).resolves.toBeUndefined();
    const secondCount = await countPgTables(c);

    expect(secondCount).toBe(firstCount);
    // Sanity: every P0 table we own is present after first invocation.
    const tableNames = await listTableNames(c);
    for (const t of P0_TABLES) {
      expect(tableNames).toContain(t);
    }
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
          `Postgres not reachable at ${DB_URL} — see Validation block in beforeAll`
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
           WHERE table_name = $1 AND table_schema = 'public'`,
        [tableName]
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
           WHERE schemaname = 'public'
             AND tablename IN ('entities','entity_aliases')`
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

    it("CHECK rejects an unknown entities.type value", async () => {
      const c = requireClient();
      // Minimal NOT-NULL columns only — embedding is nullable, metadata
      // has a server default, so omitting them isolates the CHECK.
      await expect(
        c.query(
          `INSERT INTO entities (id, canonical_name, type)
             VALUES ($1, $2, $3)`,
          [crypto.randomUUID(), "robot-x", "robot"]
        )
      ).rejects.toThrow();
    });

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
  // Runs after the idempotency test (which drops + recreates all P0 tables
  // and the minimal `chunks` stand-in), so `triples` and `chunks` exist with
  // the pinned DDL when these tests execute (vitest is sequential within a
  // describe). Each test pins one row of specs/p0-schema.md
  // §"Testing Strategy" against the triples table.
  // -------------------------------------------------------------------
  describe("triples DDL contract", () => {
    function requireClient(): pg.Client {
      if (!client) {
        throw new Error(
          `Postgres not reachable at ${DB_URL} — see Validation block in beforeAll`
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
           WHERE table_name = $1 AND table_schema = 'public'`,
        [tableName]
      );
      return new Set(res.rows.map((r) => r.column_name));
    }

    /**
     * Read the five triples indexes from pg_indexes + pg_class/pg_am so the
     * access-method type (btree vs gist) can be asserted without relying on
     * the Postgres-generated index definition text.
     */
    async function readTriplesIndexAm(
      c: pg.Client
    ): Promise<Map<string, string>> {
      const res = await c.query<{ indexname: string; amname: string }>(
        `SELECT i.indexname, am.amname
           FROM pg_indexes i
           JOIN pg_class r ON r.relname = i.indexname
           JOIN pg_am am ON am.oid = r.relam
          WHERE i.schemaname = 'public' AND i.tablename = 'triples'`
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
      await c.query(`INSERT INTO chunks (id, content) VALUES ($1, $2)`, [
        chunkId,
        "chunk-for-set-null",
      ]);
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
});

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
    [headId, `t4-head-${headId}`, "concept"]
  );
  await c.query(
    `INSERT INTO entities (id, canonical_name, type) VALUES ($1, $2, $3)`,
    [tailId, `t4-tail-${tailId}`, "concept"]
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
 * Count rows in pg_tables filtered to the four P0 tables + chunks. Used as
 * the idempotency invariant: a no-op second up() must leave the count
 * unchanged.
 */
async function countPgTables(c: pg.Client): Promise<number> {
  const res = await c.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM pg_tables
       WHERE tablename = ANY ($1::text[])`,
    [COUNTED_TABLES as unknown as string[]]
  );
  return Number(res.rows[0]?.count ?? "0");
}

/**
 * Return the set of table names we count on. Used to assert the four P0
 * tables actually exist after the first up() (idempotency alone wouldn't
 * distinguish "did nothing" from "created everything").
 */
async function listTableNames(c: pg.Client): Promise<string[]> {
  const res = await c.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE tablename = ANY ($1::text[])`,
    [COUNTED_TABLES as unknown as string[]]
  );
  return res.rows.map((r) => r.tablename);
}
