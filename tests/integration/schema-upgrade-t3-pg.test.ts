/**
 * In-place upgrade of an EXISTING database to the T3 资料 status columns.
 *
 * Every other schema test starts from `DROP SCHEMA … CASCADE`, so a fresh
 * database is the only path they exercise. A deployed database is the other
 * path: `source_documents` already exists, so `CREATE TABLE IF NOT EXISTS`
 * is a no-op and the forward-compat ALTERs are the only thing that can add
 * the new columns. `upSchemaBootstrap` skips the whole DDL block when
 * `schemaBootstrapIsReady` says the schema is already bootstrapped — so if
 * that probe does not name a new column, the column never lands and the
 * first `source_documents` SELECT after the upgrade fails with
 * `column sd.status does not exist`.
 *
 * This test therefore bootstraps, re-creates the pre-T3 column set by
 * dropping `status` / `failure_code` (WITHOUT dropping the schema), and
 * runs the real bootstrap again — the same second call a redeployed
 * server makes. Postgres is probed up front; an unavailable local service
 * skips loudly, never silently.
 */
import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { upSchemaBootstrap } from "../../src/core/storage/schema-bootstrap.js";
import { PgvectorBackend } from "../../src/core/storage/pgvector-backend.js";
import { createPgIntegrationHarness } from "./pg-test-harness.js";

const DIM = 8;
const pgHarness = await createPgIntegrationHarness({
  label: "schema-upgrade-t3",
  testPath: "tests/integration/schema-upgrade-t3-pg.test.ts",
  expectedCommand:
    "npx vitest run tests/integration/schema-upgrade-t3-pg.test.ts",
  schemaPrefix: "schema_upgrade_t3",
  defaultConnectionString: "postgresql://postgres@localhost/postgres",
  requiresVector: true,
});
const {
  schema: SCHEMA,
  schemaConnectionString: SCHEMA_URL,
  describePg,
} = pgHarness;

async function columnsOf(
  client: pg.Client,
  table: string
): Promise<Set<string>> {
  const result = await client.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2`,
    [SCHEMA, table]
  );
  return new Set(result.rows.map((row) => row.column_name));
}

describePg("P0 schema upgrade lands the T3 资料 status columns", () => {
  let admin: pg.Client | undefined;

  beforeAll(async () => {
    // Schema-scoped connection: the unqualified ALTER/SELECT below must hit
    // THIS test's schema, never the dev database's `public` copy (which is
    // itself a pre-T3 deployment and would silently absorb the ALTER).
    admin = pgHarness.createClient(SCHEMA_URL);
    await admin.connect();
    await pgHarness.resetSchema(admin);
    // First boot = a deployment that bootstrapped before T3 shipped. It uses
    // the production entry point (`PgvectorBackend.initialize`), because the
    // stage-1 `chunks` table is owned by that path and `upSchemaBootstrap` needs it.
    const first = new PgvectorBackend(SCHEMA_URL, DIM, { annMaxDimensions: 2000 });
    try {
      await first.initialize();
    } finally {
      await first.close();
    }

    // Simulate that pre-T3 deployment: the 资料 table exists with its
    // original columns only. Dropping a column also drops the CHECK that
    // referenced it, so the constraint is named explicitly for clarity.
    await admin.query(`
      ALTER TABLE source_documents
        DROP CONSTRAINT IF EXISTS source_documents_status_check,
        DROP COLUMN IF EXISTS status,
        DROP COLUMN IF EXISTS failure_code
    `);
    const preT3 = await columnsOf(admin, "source_documents");
    expect(preT3.has("status")).toBe(false);
    expect(preT3.has("failure_code")).toBe(false);
  });

  afterAll(async () => {
    if (admin) {
      await pgHarness.dropSchema(admin);
      await admin.end();
    }
  });

  it("adds status + failure_code when the same bootstrap runs again in place", async () => {
    // NO schema reset between the two calls: this is the redeploy path.
    await upSchemaBootstrap(admin!, DIM, 2000);

    const columns = await columnsOf(admin!, "source_documents");
    expect(columns.has("status"), "source_documents.status missing").toBe(true);
    expect(
      columns.has("failure_code"),
      "source_documents.failure_code missing"
    ).toBe(true);

    // The CHECK must land with the column, otherwise a future writer could
    // store a status the read port cannot map.
    const constraint = await admin!.query(
      `SELECT 1
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = $1
          AND t.relname = 'source_documents'
          AND c.conname = 'source_documents_status_check'`,
      [SCHEMA]
    );
    expect(constraint.rowCount).toBe(1);
  });

  it("lets a push and a 资料 list work after the in-place upgrade", async () => {
    // The upgraded schema is what a 资料 read/write actually runs against:
    // the INSERT names `status`, the list SELECT reads `sd.status` +
    // `sd.failure_code`. Both failed before the probe learned these columns.
    const backend = new PgvectorBackend(SCHEMA_URL, DIM, { annMaxDimensions: 2000 });
    try {
      await backend.initialize();
      const ref = "docs/upgraded.md";
      const id = "11111111-2222-4333-8444-555555555555";
      await backend.upsertSourceDoc({
        id,
        source_ref: ref,
        title: "升级后的资料",
        content: "upgraded body",
        created_at: "2026-01-01T00:00:00.000Z",
        status: "in_progress",
        failure_code: null,
      });
      await backend.markSourceDocReady(id);

      const page = await backend.listSourceDocs({ limit: 100, offset: 0 });
      const hit = page.items.find((item) => item.source_ref === ref);
      expect(hit).toMatchObject({
        status: "ready",
        failure_code: null,
        chunk_count: 0,
      });
    } finally {
      await backend.close();
    }
  });
});
