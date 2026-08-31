/**
 * Real-Postgres reproduction for concurrent P0 schema bootstrap.
 *
 * Each invocation uses a separate connection with the same search_path.
 * Before the bootstrap lock exists, concurrent catalog DDL can deadlock.
 * Postgres is probed up front so an unavailable local service skips loudly.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { upSchemaP0 } from "../../src/core/storage/schema-p0.js";

const DIM = 8;
const BASE_DB_URL =
  process.env.GRAPHRAG_MEMORY_DB_URL ??
  "postgresql://postgres@localhost/postgres";
const SCHEMA = `schema_bootstrap_${randomUUID().replace(/-/g, "")}`;
const BOOTSTRAP_TABLES = [
  "entities",
  "entity_aliases",
  "triples",
  "extraction_records",
  "community_summaries",
  "projection_outbox",
] as const;

function schemaDbUrl(): string {
  const options = encodeURIComponent(`-c search_path=${SCHEMA},public`);
  return `${BASE_DB_URL}${BASE_DB_URL.includes("?") ? "&" : "?"}options=${options}`;
}

let PG_AVAILABLE = false;
try {
  const probe = new pg.Client({ connectionString: BASE_DB_URL });
  await probe.connect();
  await probe.query("SELECT 1");
  await probe.end();
  PG_AVAILABLE = true;
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.warn(
    `\n[schema-bootstrap-concurrency] Postgres unavailable at ${BASE_DB_URL}: ${message}\n`
  );
  console.warn(
    "Validation:\n" +
      "- Not run: tests/integration/schema-bootstrap-concurrency-pg.test.ts\n" +
      "- Expected command: npx vitest run tests/integration/schema-bootstrap-concurrency-pg.test.ts\n" +
      `- Blocking issue: cannot connect to Postgres at ${BASE_DB_URL}\n`
  );
}

const describePg = PG_AVAILABLE ? describe : describe.skip;

describePg("P0 schema bootstrap concurrency", () => {
  let admin: pg.Client | undefined;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: BASE_DB_URL });
    await admin.connect();
    await admin.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await admin.query(`CREATE SCHEMA "${SCHEMA}"`);
    await admin.query(`
      CREATE TABLE "${SCHEMA}".chunks (
        id uuid PRIMARY KEY,
        content text NOT NULL
      )
    `);
  });

  afterAll(async () => {
    if (!admin) return;
    await admin.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await admin.end();
  });

  it("completes eight concurrent bootstraps against one fresh schema", async () => {
    const pool = new pg.Pool({
      connectionString: schemaDbUrl(),
      max: 8,
    });

    try {
      const outcomes = await Promise.all(
        Array.from({ length: 8 }, async () => {
          const client = await pool.connect();
          try {
            await upSchemaP0(client, DIM);
            return undefined;
          } catch (err) {
            return err;
          } finally {
            client.release();
          }
        })
      );

      const errors = outcomes.filter((outcome) => outcome !== undefined);
      const errorMessages = errors.map((error) =>
        error instanceof Error ? error.message : String(error)
      );
      expect(errorMessages).toEqual([]);

      const tables = await admin!.query<{ tablename: string }>(
        `SELECT tablename
           FROM pg_tables
          WHERE schemaname = $1
            AND tablename = ANY($2::text[])`,
        [SCHEMA, BOOTSTRAP_TABLES]
      );
      expect(tables.rows.map((row) => row.tablename).sort()).toEqual(
        [...BOOTSTRAP_TABLES].sort()
      );
    } finally {
      await pool.end();
    }
  });
});
