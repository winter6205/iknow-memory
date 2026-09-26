/**
 * `BOOTSTRAP_COLUMNS` and the forward-compat ALTERs must stay in lockstep.
 *
 * `upSchemaBootstrap` short-circuits the ENTIRE DDL block when
 * `schemaBootstrapIsReady` answers true (schema-lock.ts). A column that a
 * forward-compat `ALTER TABLE … ADD COLUMN IF NOT EXISTS` introduces is
 * therefore only ever added on a database where the probe already says "not
 * ready" — the probe is the ONLY mechanism that can add it to a deployed
 * database. A column missing from `BOOTSTRAP_COLUMNS` is silently skipped
 * forever: `initialize()` reports ready, the ALTER never runs, and the first
 * write that names the column fails with `column … does not exist`.
 *
 * That is what happened to `triples.evidence_span` (a forward-compat ALTER
 * in schema-bootstrap.ts, absent from the list): the production persist path
 * (`src/core/extraction/dedup.ts` INSERT) fails on a database that predates
 * the column.
 *
 * The docblock above the list asserted that invariant, but nothing enforced
 * it. The unit cases below DERIVE the expected `(table, column)` pairs from
 * the ALTER statements the bootstrap actually emits, rather than restating
 * the list here, so the NEXT forward-compat ALTER trips them instead of
 * shipping; one of them pins the harness itself (a ready probe must
 * short-circuit before any DDL). The final case is the empirical half,
 * against real Postgres: a database missing ONLY `evidence_span` must be
 * repaired by the next bootstrap. It skips loudly when Postgres is
 * unavailable (tests/integration/pg-test-harness.ts).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import pg from "pg";
import type { PoolClient } from "pg";

import { upSchemaBootstrap } from "../../src/core/storage/schema-bootstrap.js";
import { PgvectorBackend } from "../../src/core/storage/pgvector-backend.js";
import { createPgIntegrationHarness } from "../integration/pg-test-harness.js";

interface RecordedQuery {
  sql: string;
  values?: unknown[];
}

/**
 * The readiness probe's SQL also mentions `current_schema()` — it resolves the
 * namespace it verifies against (`schema-lock.ts:125`) — so the generic arm
 * below it must NOT be tested first: it would answer the probe
 * `{schema_name: "public"}` and the `ready` flag would never be consulted.
 * Order is load-bearing; the second case below pins it.
 */
const READINESS_PROBE_RE = /AS ready/;

/**
 * Run the real `upSchemaBootstrap` against a `pg`-shaped client that answers the
 * advisory-lock gate and the readiness probe, recording every statement and
 * bind value. `ready: false` drives the full DDL path; `ready: true`
 * short-circuits before the DDL, so the probe's own bind values are the only
 * observable.
 */
async function runBootstrap(ready: boolean): Promise<RecordedQuery[]> {
  const queries: RecordedQuery[] = [];
  const client = {
    query: vi.fn(async (sql: string, values?: unknown[]) => {
      queries.push({ sql, values });
      if (READINESS_PROBE_RE.test(sql)) return { rows: [{ ready }] };
      if (/current_schema\(\)/.test(sql)) {
        return { rows: [{ schema_name: "public" }] };
      }
      if (/pg_advisory_xact_lock/.test(sql)) return { rows: [{}] };
      return { rows: [] };
    }),
  } as unknown as PoolClient;
  await upSchemaBootstrap(client, 1536, 2000);
  return queries;
}

/**
 * Every `ALTER TABLE <table> ADD COLUMN IF NOT EXISTS <column> …` the
 * bootstrap emitted, as `[table, column]` pairs. Derived from the emitted
 * SQL so it tracks the DDL rather than a second hand-maintained list.
 */
function emittedForwardCompatColumns(
  queries: RecordedQuery[]
): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  const re =
    /ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+(\w+)/gis;
  for (const { sql } of queries) {
    for (const match of sql.matchAll(re)) {
      pairs.push([match[1]!.toLowerCase(), match[2]!.toLowerCase()]);
    }
  }
  return pairs;
}

interface ReadinessProbe {
  /**
   * The `(table, column)` pairs the probe actually asked about: `$3` and `$4`
   * zipped POSITIONALLY, because PostgreSQL evaluates
   * `unnest($3::text[], $4::text[])` as parallel arrays and pairs element i
   * with element i.
   */
  pairs: Array<[string, string]>;
  /** The same pairs expressed the way the probe asks them, `table.column`. */
  pairKeys: string[];
}

async function observeReadinessProbe(ready: boolean): Promise<ReadinessProbe> {
  const queries = await runBootstrap(ready);
  const probe = queries.find(({ sql }) => READINESS_PROBE_RE.test(sql));
  expect(probe, "readiness probe statement not emitted").toBeDefined();
  // Binds are [$1 tables, $2 indexes, $3 column tables, $4 column names].
  const tableNames = probe!.values?.[2];
  const columnNames = probe!.values?.[3];
  expect(
    Array.isArray(tableNames) && Array.isArray(columnNames),
    "readiness probe did not bind the column tables/names arrays"
  ).toBe(true);
  // `unnest($3, $4)` pairs by index, so equal lengths is what makes the
  // positional zip well defined at all.
  expect(columnNames as unknown[]).toHaveLength(
    (tableNames as unknown[]).length
  );
  const pairs = (tableNames as unknown[]).map((table, i) => [
    String(table),
    String((columnNames as unknown[])[i]),
  ]) as Array<[string, string]>;
  return {
    pairs,
    pairKeys: pairs.map(([table, column]) => `${table}.${column}`),
  };
}

describe("BOOTSTRAP_COLUMNS lockstep with the forward-compat ALTERs", () => {
  it("the readiness probe asks for exactly the columns the bootstrap ADDs", async () => {
    // `ready: false` drives the full DDL path, so the ALTERs are observable.
    const emitted = emittedForwardCompatColumns(await runBootstrap(false));
    expect(emitted.length).toBeGreaterThan(0);
    const emittedKeys = emitted.map(([t, c]) => `${t}.${c}`);

    const { pairs, pairKeys } = await observeReadinessProbe(true);

    // Zipped pairs, not two independent multisets: swapping two entries'
    // table names keeps both bind arrays' contents identical, yet drifts the
    // pairs the probe asks for — the probe would then cover a pair that no
    // table has and miss the real one. `pairs` is the `unnest($3, $4)` the
    // database sees, so it catches that.
    const missing = emittedKeys.filter((key) => !pairKeys.includes(key));
    expect(
      missing,
      "forward-compat ALTER columns absent from BOOTSTRAP_COLUMNS — the probe " +
        "will report ready and the ALTER will never run on a deployed database"
    ).toEqual([]);

    // The probe re-asks for pairs the DDL never writes: a dead entry (the
    // other half of a table-name swap), and the same drift seen from the
    // probe's side.
    const stale = pairKeys.filter((key) => !emittedKeys.includes(key));
    expect(
      stale,
      "readiness probe asks for (table, column) pairs no forward-compat ALTER " +
        "writes — the entry is mis-paired, or refers to a DDL no longer emitted"
    ).toEqual([]);

    // Same invariant stated as set equality, so a duplicate pair on either
    // side cannot hide behind the two inclusion checks above.
    expect([...pairKeys].sort()).toEqual([...emittedKeys].sort());
    // Deliberate exception to this file's derive-don't-restate doctrine: the
    // pair that regressed once, restated by hand so that a future relaxation
    // of the derivation (a narrowed ALTER regex, say) still names the concrete
    // column whose absence shipped `column "evidence_span" does not exist`.
    expect(pairs).toContainEqual(["triples", "evidence_span"]);
    // corpus-index-job T2: the content-identity column the durable submit
    // pair keys on — restated by hand so a future relaxation of the
    // derivation still names the concrete column a deployed database must get.
    expect(pairs).toContainEqual(["source_documents", "content_identity"]);
  });

  it("the mock itself is pinned: ready must short-circuit before the DDL", async () => {
    // Guards the mock, not the product: if a generic mock arm again shadows
    // the readiness arm, the probe never observes the `ready` flag and
    // `ready: true` replays the whole DDL. Both halves of the paired
    // assertions above would then be answered by the same DDL run.
    const readyQueries = await runBootstrap(true);
    const createTables = readyQueries.filter(({ sql }) =>
      /CREATE\s+TABLE/i.test(sql)
    );
    expect(
      createTables,
      "ready: true emitted CREATE TABLE — the mock answered the readiness " +
        "probe with the generic current_schema() arm instead of a ready row"
    ).toEqual([]);

    const probeQueries = await runBootstrap(false);
    expect(
      probeQueries.filter(({ sql }) => /CREATE\s+TABLE/i.test(sql)).length,
      "ready: false must drive the full DDL path for the derivation to see " +
        "the forward-compat ALTERs"
    ).toBeGreaterThan(0);
  });
});

const DIM = 8;
const pgHarness = await createPgIntegrationHarness({
  label: "bootstrap-columns",
  testPath: "tests/storage/bootstrap-columns.test.ts",
  expectedCommand: "npx vitest run tests/storage/bootstrap-columns.test.ts",
  schemaPrefix: "bootstrap_columns",
  defaultConnectionString: "postgresql://postgres@localhost/postgres",
  requiresVector: true,
});
const {
  schema: SCHEMA,
  schemaConnectionString: SCHEMA_URL,
  describePg,
} = pgHarness;

describePg(
  "bootstrap repairs a database missing only triples.evidence_span",
  () => {
    let client: pg.Client | undefined;

    beforeAll(async () => {
      client = pgHarness.createClient(SCHEMA_URL);
      await client.connect();
      await pgHarness.resetSchema(client);
    });

    afterAll(async () => {
      if (client) {
        await pgHarness.dropSchema(client);
        await client.end();
        client = undefined;
      }
    });

    it("re-adds the column and lets a triple INSERT naming it succeed", async () => {
      const c = client!;

      // First deployment: full DDL.
      const first = new PgvectorBackend(SCHEMA_URL, DIM, { annMaxDimensions: 2000 });
      try {
        await first.initialize();
      } finally {
        await first.close();
      }

      // Simulate a database that bootstrapped before the column existed.
      // Dropping only `evidence_span` leaves every OTHER probe entry intact,
      // which is exactly the reviewer's reproduction: the probe answered
      // "ready" and the ALTER never ran.
      await c.query(`ALTER TABLE triples DROP COLUMN IF EXISTS evidence_span`);
      const gone = await c.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = 'triples'
           AND column_name = 'evidence_span'`,
        [SCHEMA]
      );
      expect(gone.rowCount).toBe(0);

      // Redeploy: the same bootstrap a restarted server runs.
      const second = new PgvectorBackend(SCHEMA_URL, DIM, { annMaxDimensions: 2000 });
      try {
        await second.initialize();
      } finally {
        await second.close();
      }

      const back = await c.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = 'triples'
           AND column_name = 'evidence_span'`,
        [SCHEMA]
      );
      expect(
        back.rowCount,
        "triples.evidence_span was not re-added — the probe reported ready and " +
          "the forward-compat ALTER never ran"
      ).toBe(1);

      // And the production persist statement now works: this is the exact
      // column list src/core/extraction/dedup.ts inserts.
      const head = randomUUID();
      const tail = randomUUID();
      for (const id of [head, tail]) {
        await c.query(
          `INSERT INTO entities (id, canonical_name, type) VALUES ($1, $2, 'person')`,
          [id, `bootstrap-columns-${id}`]
        );
      }
      await expect(
        c.query(
          `INSERT INTO triples
           (id, head_id, tail_id, relation_raw, relation_norm, confidence,
            source_chunk_id, evidence_span, valid_window)
           VALUES ($1, $2, $3, 'raw', 'norm', 0.5, NULL, 'span', tstzrange($4, NULL, '[)'))`,
          [randomUUID(), head, tail, "2026-01-01T00:00:00Z"]
        )
      ).resolves.toBeDefined();
    });
  }
);
