/**
 * Real-Postgres coverage for the consolidate CLI's dry-run/apply contract.
 *
 * The schema is isolated per file because the P0 bootstrap uses unqualified
 * table names and other integration suites recreate their own schemas.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runCli, type ConsolidateDeps } from "../../src/cli/consolidate.js";
import { upSchemaP0 } from "../../src/core/storage/schema-p0.js";

const DIM = 8;
const BASE_DB_URL = "postgresql://postgres@localhost/postgres";
const SCHEMA = `consolidate_${randomUUID().slice(0, 8)}`;
const NOW = "2026-08-28T00:00:00.000Z";

function schemaDbUrl(): string {
  return `${BASE_DB_URL}?options=-c%20search_path%3D${SCHEMA}%2Cpublic`;
}

function silentLogger() {
  return {
    level: "error" as const,
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

let pgAvailable = false;
try {
  const probe = new pg.Client({ connectionString: BASE_DB_URL });
  await probe.connect();
  await probe.query("SELECT 1");
  await probe.end();
  pgAvailable = true;
} catch (err) {
  console.warn(
    `\n[consolidate-pg] Postgres unreachable at ${BASE_DB_URL}: ${(err as Error).message}\n`
  );
  console.warn(
    "Validation:\n" +
      "- Not run: tests/cli/consolidate-pg.test.ts\n" +
      "- Expected command: npx vitest run tests/cli/consolidate-pg.test.ts\n" +
      `- Blocking issue: cannot connect to Postgres at ${BASE_DB_URL}\n`
  );
}

const describePg = pgAvailable ? describe : describe.skip;

describePg("consolidate CLI against Postgres", () => {
  let admin: pg.Client | undefined;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: BASE_DB_URL });
    await admin.connect();
    await resetSchema(admin);
  });

  afterAll(async () => {
    if (!admin) return;
    await admin.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await admin.end();
  });

  async function resetSchema(client: pg.Client): Promise<void> {
    await client.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await client.query(`CREATE SCHEMA "${SCHEMA}"`);
    await client.query(`SET search_path TO "${SCHEMA}", public`);
    await client.query(`
      CREATE TABLE chunks (
        id uuid PRIMARY KEY,
        content text NOT NULL
      )
    `);
    await upSchemaP0(client, DIM, 2000);
  }

  async function seedConflictingFacts(client: pg.Client): Promise<void> {
    await client.query(
      `INSERT INTO entities (id, canonical_name, type)
       VALUES
         ('11111111-1111-4111-8111-111111111111', 'Alice', 'person'),
         ('22222222-2222-4222-8222-222222222222', 'Acme', 'system'),
         ('33333333-3333-4333-8333-333333333333', 'Globex', 'system')`
    );
    await client.query(
      `INSERT INTO triples
         (id, head_id, tail_id, relation_raw, relation_norm, confidence,
          valid_window, created_at)
       VALUES
         ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          '11111111-1111-4111-8111-111111111111',
          '22222222-2222-4222-8222-222222222222',
          'works at', 'works_for', 0.8,
          tstzrange('2026-01-01T00:00:00Z', NULL, '[)'),
          '2026-01-01T00:00:00Z'),
         ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          '11111111-1111-4111-8111-111111111111',
          '33333333-3333-4333-8333-333333333333',
          'works at', 'works_for', 0.9,
          tstzrange('2026-08-01T00:00:00Z', NULL, '[)'),
          '2026-08-02T00:00:00Z')`
    );
  }

  async function runConsolidate(args: string[]): Promise<number> {
    const pool = new pg.Pool({ connectionString: schemaDbUrl() });
    const deps: ConsolidateDeps = {
      pool,
      logger: silentLogger(),
      now: () => NOW,
    };
    try {
      return await runCli(args, deps);
    } finally {
      await pool.end();
    }
  }

  it("default dry-run does not mutate facts", async () => {
    const client = admin!;
    await resetSchema(client);
    await seedConflictingFacts(client);

    expect(await runConsolidate([])).toBe(0);
    const result = await client.query(
      `SELECT superseded_by, upper(valid_window) AS valid_until
         FROM triples
        WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'`
    );
    expect(result.rows).toEqual([{ superseded_by: null, valid_until: null }]);
  });

  it("--apply writes superseded_by, closes the window, and queues projection", async () => {
    const client = admin!;
    await resetSchema(client);
    await seedConflictingFacts(client);

    expect(await runConsolidate(["--apply"])).toBe(0);
    const result = await client.query(
      `SELECT superseded_by, lower(valid_window) AS valid_from,
              upper(valid_window) AS valid_until
         FROM triples
        WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'`
    );
    expect(result.rows[0]?.superseded_by).toBe(
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    );
    expect(result.rows[0]?.valid_from.toISOString()).toBe(
      "2026-01-01T00:00:00.000Z"
    );
    expect(result.rows[0]?.valid_until.toISOString()).toBe(NOW);

    const outbox = await client.query(
      `SELECT subject_kind, subject_id
         FROM projection_outbox
        WHERE subject_kind = 'triple'
          AND subject_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'`
    );
    expect(outbox.rows).toHaveLength(1);
  });
});
