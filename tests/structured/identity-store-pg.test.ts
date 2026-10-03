/**
 * QP3 — persistent structured-result identity against real Postgres.
 *
 * The pure identity contract (exact-tuple derivation, strict whole-second UTC
 * windows) is covered Postgres-free in `tests/structured/identity.test.ts`.
 * This file covers what only a database can prove about the REGISTRATION:
 *
 *   1. `upSchemaBootstrap` creates both identity tables and their indexes, and
 *      every one of them is a second-run no-op.
 *   2. Re-registering one exact tuple resolves to the same id and does NOT add
 *      a second row — the row that makes repeated support collapse onto one
 *      assertion.
 *   3. A CHANGED tuple (including a differing-but-overlapping valid_window, the
 *      case the existing overlap dedup merges) lands as its own row rather than
 *      being merged into the original.
 *   4. The stored window columns are the canonical UTC strings the identity was
 *      derived from, byte-for-byte.
 *
 * Per docs/.claude/rules/test.md an unreachable Postgres must SKIP LOUDLY with
 * the documented Validation block — never silently pass. In CI (`CI=true`) the
 * same miss is a hard failure. Runs against a unique throwaway schema and never
 * touches `public.chunks`.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { upSchemaBootstrap } from "../../src/core/storage/schema-bootstrap.js";
import { PgStructuredIdentityStore } from "../../src/core/structured/identity-store.js";
import {
  createPgIntegrationHarness,
  redactPgConnectionString,
  warnPgUnavailable,
} from "../integration/pg-test-harness.js";

const IDENTITY_TABLES = [
  "structured_entity_identities",
  "structured_relation_assertion_identities",
] as const;

const IDENTITY_INDEXES = [
  "structured_relation_assertion_identities_tuple_idx",
  "structured_relation_assertion_identities_head_idx",
  "structured_relation_assertion_identities_tail_idx",
] as const;

const pgHarness = await createPgIntegrationHarness({
  label: "structured-identity-store",
  testPath: "tests/structured/identity-store-pg.test.ts",
  expectedCommand: "npx vitest run tests/structured/identity-store-pg.test.ts",
  schemaPrefix: "structured_identity",
  defaultConnectionString: "postgresql://postgres@localhost/postgres",
  // upSchemaBootstrap creates vector columns, so pgvector must be present.
  requiresVector: true,
});
const { connectionString: DB_URL, schema: SCHEMA, describePg } = pgHarness;

const HEAD = randomUUID();
const TAIL = randomUUID();

describePg("structured identity store: registration against real Postgres", () => {
  let client: pg.Client | undefined;

  beforeAll(async () => {
    try {
      client = pgHarness.createClient(DB_URL);
      await client.connect();
      await pgHarness.resetSchema(client);
      await client.query(`SET search_path TO "${SCHEMA}", public`);
    } catch (err) {
      warnPgUnavailable({
        label: "structured-identity-store",
        testPath: "tests/structured/identity-store-pg.test.ts (registration)",
        expectedCommand:
          "npx vitest run tests/structured/identity-store-pg.test.ts",
        connectionString: DB_URL,
        error: err,
        requiresVector: true,
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

  function requireClient(): pg.Client {
    if (!client) {
      throw new Error(
        `Postgres not reachable at ${redactPgConnectionString(DB_URL)} — see Validation block in beforeAll`
      );
    }
    return client;
  }

  /**
   * Boot the schema twice and return the two pg_tables counts. A second
   * invocation that changed the count would mean the identity DDL is not
   * replay-safe, which is the whole bootstrap contract.
   */
  async function bootstrapTwice(): Promise<{ first: number; second: number }> {
    const c = requireClient();
    await pgHarness.resetSchema(c);
    await c.query(`SET search_path TO "${SCHEMA}", public`);
    await c.query("CREATE EXTENSION IF NOT EXISTS vector");
    // Minimal stand-in: alterChunksBackPointers names `chunks`, and the real
    // ledger table is never dropped by this suite.
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
    await upSchemaBootstrap(c, 1536, 2000);
    const first = await countIdentityTables(c);
    await expect(upSchemaBootstrap(c, 1536, 2000)).resolves.toBeUndefined();
    const second = await countIdentityTables(c);
    return { first, second };
  }

  async function countIdentityTables(c: pg.Client): Promise<number> {
    const { rows } = await c.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM pg_tables
        WHERE schemaname = $1 AND tablename = ANY($2::text[])`,
      [SCHEMA, [...IDENTITY_TABLES]]
    );
    return Number(rows[0]?.count ?? "0");
  }

  it("creates both identity tables and their indexes", async () => {
    const c = requireClient();
    const { first } = await bootstrapTwice();
    expect(first).toBe(IDENTITY_TABLES.length);

    const tables = await c.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables
        WHERE schemaname = $1 AND tablename = ANY($2::text[])`,
      [SCHEMA, [...IDENTITY_TABLES]]
    );
    expect(tables.rows.map((r) => r.tablename).sort()).toEqual(
      [...IDENTITY_TABLES].sort()
    );

    const indexes = await c.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = $1
          AND indexname = ANY($2::text[])`,
      [SCHEMA, [...IDENTITY_INDEXES]]
    );
    const byName = new Map(indexes.rows.map((r) => [r.indexname, r.indexdef]));
    for (const name of IDENTITY_INDEXES) {
      expect(byName.has(name), `${name} missing`).toBe(true);
    }
    // The exact-tuple guard must actually be UNIQUE, and keyed on the version +
    // canonical serialization digest (a corrected identity version must not
    // collide with the identity it corrects).
    const tupleIndex = byName.get("structured_relation_assertion_identities_tuple_idx")!;
    expect(tupleIndex).toMatch(/^CREATE UNIQUE INDEX/i);
    expect(tupleIndex).toMatch(/\(identity_version, tuple_digest\)/);
  });

  it("running upSchemaBootstrap twice changes nothing", async () => {
    const { first, second } = await bootstrapTwice();
    expect(second).toBe(first);
  });

  it("re-registering the same tuple returns the same id and one row", async () => {
    const c = requireClient();
    await bootstrapTwice();
    const store = new PgStructuredIdentityStore(c);
    await seedEntity(c, HEAD, "person");
    await seedEntity(c, TAIL, "organization");

    const input = {
      headEntityId: HEAD,
      relationNorm: "works_for",
      tailEntityId: TAIL,
      validWindow: { from: "2024-01-01T00:00:00Z", until: null },
    };
    const first = await store.registerRelationAssertion(input);
    // A second source supporting the same exact tuple must resolve to the same
    // assertion, not create a row of its own.
    const second = await store.registerRelationAssertion({
      ...input,
      // Same exact tuple, spelled the way a second source would spell it.
      headEntityId: HEAD.toUpperCase(),
      relationNorm: "  WORKS_FOR ",
      validWindow: { from: "2024-01-01T02:00:00+02:00", until: null },
    });
    expect(second.assertionId).toBe(first.assertionId);
    expect(await countAssertions(c)).toBe(1);
    expect(await store.findRelationAssertion(first.assertionId)).toEqual(first);
  });

  it("stores the canonical UTC window the identity was derived from", async () => {
    const c = requireClient();
    await bootstrapTwice();
    const store = new PgStructuredIdentityStore(c);
    await seedEntity(c, HEAD, "person");
    await seedEntity(c, TAIL, "organization");

    const registered = await store.registerRelationAssertion({
      headEntityId: HEAD,
      relationNorm: "works_for",
      tailEntityId: TAIL,
      // A lossless offset, so the stored value can only be the converted one.
      validWindow: {
        from: "2024-01-01T10:00:00+02:00",
        until: "2030-01-01T09:59:59+02:00",
      },
    });
    const stored = await c.query<{ valid_from: string; valid_until: string }>(
      `SELECT valid_from, valid_until
         FROM structured_relation_assertion_identities
        WHERE assertion_id = $1`,
      [registered.assertionId]
    );
    expect(stored.rows[0]?.valid_from).toBe("2024-01-01T08:00:00Z");
    expect(stored.rows[0]?.valid_until).toBe("2030-01-01T07:59:59Z");
    expect(registered.validWindow).toEqual({
      from: "2024-01-01T08:00:00Z",
      until: "2030-01-01T07:59:59Z",
    });
  });

  it("keeps an overlapping valid_window as its own row, never merged", async () => {
    const c = requireClient();
    await bootstrapTwice();
    const store = new PgStructuredIdentityStore(c);
    await seedEntity(c, HEAD, "person");
    await seedEntity(c, TAIL, "organization");

    const base = {
      headEntityId: HEAD,
      relationNorm: "works_for",
      tailEntityId: TAIL,
    };
    // These windows overlap, so `core/extraction/dedup.ts` `findOverlap` would
    // merge them into one row. The exact-tuple rule must not.
    const earlier = await store.registerRelationAssertion({
      ...base,
      validWindow: { from: "2020-01-01T00:00:00Z", until: null },
    });
    const later = await store.registerRelationAssertion({
      ...base,
      validWindow: { from: "2024-01-01T00:00:00Z", until: null },
    });
    expect(later.assertionId).not.toBe(earlier.assertionId);
    expect(await countAssertions(c)).toBe(2);
    // Both identities stay readable: a correction records a new identity, it
    // does not erase the historical one.
    expect(await store.findRelationAssertion(earlier.assertionId)).not.toBeNull();
    expect(await store.findRelationAssertion(later.assertionId)).not.toBeNull();
  });

  it("registers an entity identity as its existing uuid and admits only the closed catalog", async () => {
    const c = requireClient();
    await bootstrapTwice();
    const store = new PgStructuredIdentityStore(c);
    await seedEntity(c, HEAD, "person");

    const registered = await store.registerEntity({
      entityId: HEAD,
      type: "person",
    });
    expect(registered.entityId).toBe(HEAD);
    // Re-registering resolves to the same identity, not a second one.
    const again = await store.registerEntity({ entityId: HEAD, type: "person" });
    expect(again.entityId).toBe(registered.entityId);
    const { rows } = await c.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM structured_entity_identities
        WHERE entity_id = $1`,
      [HEAD]
    );
    expect(Number(rows[0]?.count)).toBe(1);

    // The closed EntityType CHECK, rendered from the same constant the
    // `entities` CHECK uses, refuses a type outside the catalog.
    await expect(
      store.registerEntity({ entityId: HEAD, type: "concept" })
    ).rejects.toThrow();
    await expect(
      c.query(
        `INSERT INTO structured_entity_identities (entity_id, entity_type)
              VALUES ($1, 'concept')`,
        [randomUUID()]
      )
    ).rejects.toThrow();
  });

  it("refuses a non-canonical window and an empty interval at the storage boundary", async () => {
    const c = requireClient();
    await bootstrapTwice();
    const store = new PgStructuredIdentityStore(c);
    await seedEntity(c, HEAD, "person");
    await seedEntity(c, TAIL, "organization");

    const base = {
      headEntityId: HEAD,
      relationNorm: "works_for",
      tailEntityId: TAIL,
    };
    // Refused before any write: rounding, and an empty half-open interval.
    await expect(
      store.registerRelationAssertion({
        ...base,
        validWindow: { from: "2024-01-01T00:00:00.500Z", until: null },
      })
    ).rejects.toThrow();
    await expect(
      store.registerRelationAssertion({
        ...base,
        validWindow: {
          from: "2024-01-01T00:00:00Z",
          until: "2024-01-01T00:00:00Z",
        },
      })
    ).rejects.toThrow();
    expect(await countAssertions(c)).toBe(0);

    // The same rule enforced in the database, for a raw writer that bypassed the
    // normalizer: a non-whole-second endpoint and an empty interval both fail.
    await expect(
      c.query(
        `INSERT INTO structured_relation_assertion_identities
           (assertion_id, head_entity_id, relation_norm, tail_entity_id,
            valid_from, valid_until, tuple_digest, identity_version)
         VALUES ($1, $2, 'works_for', $3, '2024-01-01', NULL, 'd', 1)`,
        [randomUUID(), HEAD, TAIL]
      )
    ).rejects.toThrow();
    await expect(
      c.query(
        `INSERT INTO structured_relation_assertion_identities
           (assertion_id, head_entity_id, relation_norm, tail_entity_id,
            valid_from, valid_until, tuple_digest, identity_version)
         VALUES ($1, $2, 'works_for', $3,
                 '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z', 'e', 1)`,
        [randomUUID(), HEAD, TAIL]
      )
    ).rejects.toThrow();
  });
});

async function countAssertions(c: pg.Client): Promise<number> {
  const { rows } = await c.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM structured_relation_assertion_identities`
  );
  return Number(rows[0]?.count ?? "0");
}

async function seedEntity(
  c: pg.Client,
  id: string,
  type: string
): Promise<void> {
  await c.query(
    `INSERT INTO entities (id, canonical_name, type)
       VALUES ($1, $2, $3)
     ON CONFLICT (id) DO NOTHING`,
    [id, `identity-fixture-${id.slice(0, 8)}`, type]
  );
}
