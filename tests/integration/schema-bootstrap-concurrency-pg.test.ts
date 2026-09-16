/**
 * Real-Postgres reproduction for concurrent schema bootstrap.
 *
 * Each invocation uses a separate connection with the same search_path.
 * Before the bootstrap lock exists, concurrent catalog DDL can deadlock.
 * Postgres is probed up front so an unavailable local service skips loudly.
 */
import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { upSchemaBootstrap } from "../../src/core/storage/schema-bootstrap.js";
import { createPgIntegrationHarness } from "./pg-test-harness.js";

const DIM = 8;
const pgHarness = await createPgIntegrationHarness({
  label: "schema-bootstrap-concurrency",
  testPath: "tests/integration/schema-bootstrap-concurrency-pg.test.ts",
  expectedCommand:
    "npx vitest run tests/integration/schema-bootstrap-concurrency-pg.test.ts",
  schemaPrefix: "schema_bootstrap",
  defaultConnectionString: "postgresql://postgres@localhost/postgres",
  requiresVector: false,
});
const {
  connectionString: BASE_DB_URL,
  schema: SCHEMA,
  schemaConnectionString: SCHEMA_URL,
  describePg,
} = pgHarness;
const BOOTSTRAP_TABLES = [
  "entities",
  "entity_aliases",
  "triples",
  "extraction_records",
  "community_summaries",
  "projection_outbox",
  "source_documents",
] as const;

describePg("schema bootstrap concurrency", () => {
  let admin: pg.Client | undefined;

  beforeAll(async () => {
    admin = pgHarness.createClient(BASE_DB_URL);
    await admin.connect();
    await pgHarness.resetSchema(admin);
    await admin.query(`
      CREATE TABLE "${SCHEMA}".chunks (
        id uuid PRIMARY KEY,
        content text NOT NULL
      )
    `);
  });

  afterAll(async () => {
    if (!admin) return;
    await pgHarness.dropSchema(admin);
    await admin.end();
  });

  it("completes eight concurrent bootstraps against one fresh schema", async () => {
    const pool = new pg.Pool({
      connectionString: SCHEMA_URL,
      max: 8,
    });

    try {
      const outcomes = await Promise.all(
        Array.from({ length: 8 }, async () => {
          const client = await pool.connect();
          try {
            await upSchemaBootstrap(client, DIM, 2000);
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
