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
});

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
