/**
 * `BOOTSTRAP_TABLES` / `BOOTSTRAP_INDEXES` and the bootstrap's own
 * `CREATE TABLE` / `CREATE INDEX … IF NOT EXISTS` statements must stay in
 * lockstep.
 *
 * `upSchemaBootstrap` short-circuits the ENTIRE DDL block when
 * `schemaBootstrapIsReady` answers true (schema-lock.ts), and that probe
 * short-circuits the whole `COMMIT` too. So a table or index the probe does
 * not name is only ever created on a database that had some OTHER reason to
 * answer "not ready" — on an already-provisioned store `initialize()` reports
 * ready, the DDL never runs, and the object is missing forever. That is what
 * happened to the two `structured_*_identities` tables and their indexes: the
 * QP3 DDL block was added to schema-bootstrap.ts, and nothing named them here.
 *
 * The docblock above the lists asserted that invariant, but nothing enforced
 * it. The cases below DERIVE the expected table and index names from the
 * statements the bootstrap actually emits — `projection_outbox` included, since
 * `upSchemaProjection` runs inside the same `upSchemaBootstrap` call — rather
 * than restating the lists here, so the NEXT table or index trips them instead
 * of shipping.
 *
 * No Postgres: the derivation and the probe binds come from a recording fake
 * client, and the "does a database missing this one object get repaired" case
 * answers the probe from a simulated catalog, so the whole file runs anywhere.
 */
import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";

import { upSchemaBootstrap } from "../../src/core/storage/schema-bootstrap.js";

interface RecordedQuery {
  sql: string;
  values?: unknown[];
}

/**
 * The readiness probe's SQL also mentions `current_schema()` — it resolves the
 * namespace it verifies against (schema-lock.ts:141) — so the generic arm of
 * the fake below must NOT be consulted first: it would answer the probe
 * `{schema_name: "public"}` and the `ready` flag would never be read. Order is
 * load-bearing; the harness-pinning case below pins it.
 */
const READINESS_PROBE_RE = /AS ready/;

const TABLE_RE = /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(\w+)/gi;
const INDEX_RE = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\s+(\w+)/gi;
/**
 * The forward-compat columns. `CREATE TABLE IF NOT EXISTS` cannot add a column
 * to a table that already exists, so these are the only mechanism by which a
 * deployed store acquires one — and the probe short-circuits the block that
 * emits them.
 */
const COLUMN_RE =
  /ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+(\w+)/gi;
/**
 * A named `ADD CONSTRAINT`, paired with the table it lands on. The `.*?` is
 * bounded to the statement: the constraint name always follows its own
 * `ALTER TABLE <table>` inside one emitted statement, so the nearest match is
 * the right one. The template-interpolated constraints (the structured
 * identity shape CHECKs) arrive already substituted, which is what makes this
 * derivation see them at all.
 */
const CONSTRAINT_RE = /ALTER\s+TABLE\s+(\w+)[\s\S]*?ADD\s+CONSTRAINT\s+(\w+)/gi;

/**
 * A client shaped like `pg`'s that records every statement and bind value.
 * `answerProbe` gets first refusal on each statement, because the readiness
 * probe and the generic `current_schema()` arm both match that text.
 */
function recordingClient(
  answerProbe: (
    sql: string,
    values?: unknown[]
  ) => { rows: unknown[] } | undefined
): { client: PoolClient; queries: RecordedQuery[] } {
  const queries: RecordedQuery[] = [];
  const client = {
    query: vi.fn(async (sql: string, values?: unknown[]) => {
      queries.push({ sql, values });
      const probed = answerProbe(sql, values);
      if (probed) return probed;
      if (/current_schema\(\)/.test(sql)) {
        return { rows: [{ schema_name: "public" }] };
      }
      if (/pg_advisory_xact_lock/.test(sql)) return { rows: [{}] };
      return { rows: [] };
    }),
  } as unknown as PoolClient;
  return { client, queries };
}

async function drive(
  answerProbe: (
    sql: string,
    values?: unknown[]
  ) => { rows: unknown[] } | undefined
): Promise<RecordedQuery[]> {
  const { client, queries } = recordingClient(answerProbe);
  await upSchemaBootstrap(client, 1536, 2000);
  return queries;
}

/**
 * Run the real `upSchemaBootstrap` with the probe hard-wired. `ready: false`
 * drives the full DDL path, so the CREATE statements are observable; `ready:
 * true` short-circuits before them, so the probe's own bind values are the only
 * observable.
 */
function runBootstrap(ready: boolean): Promise<RecordedQuery[]> {
  return drive((sql) =>
    READINESS_PROBE_RE.test(sql) ? { rows: [{ ready }] } : undefined
  );
}

function collect(queries: RecordedQuery[], re: RegExp): string[] {
  const names: string[] = [];
  for (const { sql } of queries) {
    for (const match of sql.matchAll(re)) names.push(match[1]!.toLowerCase());
  }
  return names;
}

const emittedTables = (queries: RecordedQuery[]): string[] =>
  collect(queries, TABLE_RE);
const emittedIndexes = (queries: RecordedQuery[]): string[] =>
  collect(queries, INDEX_RE);

/**
 * Every `[table, column]` the forward-compat ALTERs add, and every
 * `[table, constraint]` the named ADD CONSTRAINTs land on. Both derived from
 * the emitted SQL so they track the DDL rather than a second list.
 */
function collectPairs(
  queries: RecordedQuery[],
  re: RegExp
): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (const { sql } of queries) {
    for (const match of sql.matchAll(re)) {
      pairs.push([match[1]!.toLowerCase(), match[2]!.toLowerCase()]);
    }
  }
  return pairs;
}

const emittedColumns = (queries: RecordedQuery[]): Array<[string, string]> =>
  collectPairs(queries, COLUMN_RE);
const emittedConstraints = (
  queries: RecordedQuery[]
): Array<[string, string]> => collectPairs(queries, CONSTRAINT_RE);

/** Every table and index the full DDL path created. */
async function emittedObjects(): Promise<{
  tables: string[];
  indexes: string[];
}> {
  const queries = await runBootstrap(false);
  return { tables: emittedTables(queries), indexes: emittedIndexes(queries) };
}

/** The single CREATE statement that would (re)create `name`, if any. */
function createStatementFor(name: string): RegExp {
  return new RegExp(
    String.raw`CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX)\s+IF\s+NOT\s+EXISTS\s+${name}\b`,
    "i"
  );
}

/**
 * The `required(name)` lists the probe actually asked about: `$1` is the table
 * list, `$2` the index list, and `$3`/`$4` the column tables/names — zipped
 * POSITIONALLY, because PostgreSQL evaluates `unnest($3::text[], $4::text[])`
 * as parallel arrays and pairs element i with element i. So the columns are
 * returned as `table.column` keys, never as two independent lists a swap could
 * hide inside.
 */
async function probeLists(): Promise<{
  tables: string[];
  indexes: string[];
  columns: string[];
  probeSql: string;
}> {
  const queries = await runBootstrap(true);
  const probe = queries.find(({ sql }) => READINESS_PROBE_RE.test(sql));
  expect(probe, "readiness probe statement not emitted").toBeDefined();
  const tables = probe!.values?.[0];
  const indexes = probe!.values?.[1];
  const columnTables = probe!.values?.[2];
  const columnNames = probe!.values?.[3];
  expect(
    Array.isArray(tables) && Array.isArray(indexes),
    "readiness probe did not bind the table/index arrays"
  ).toBe(true);
  expect(
    Array.isArray(columnTables) && Array.isArray(columnNames),
    "readiness probe did not bind the column table/name arrays"
  ).toBe(true);
  const columns = (columnTables as unknown[]).map(
    (table, i) => `${String(table)}.${String((columnNames as unknown[])[i])}`
  );
  return {
    tables: tables as string[],
    indexes: indexes as string[],
    columns,
    probeSql: probe!.sql,
  };
}

function assertListLockstep(
  label: string,
  emitted: string[],
  asked: string[],
  why: string
): void {
  const emittedSet = new Set(emitted);
  const askedSet = new Set(asked);
  expect(
    [...emittedSet].filter((name) => !askedSet.has(name)).sort(),
    `${why} absent from ${label}`
  ).toEqual([]);
  expect(
    [...askedSet].filter((name) => !emittedSet.has(name)).sort(),
    `${label} asks for a name no emitted statement creates — the entry is stale, ` +
      "or it names an object whose DDL was removed"
  ).toEqual([]);
  expect(
    askedSet.size,
    `${label} has a duplicate entry — a repeated name is a no-op that can mask a ` +
      "missing one"
  ).toBe(asked.length);
  // Stated as multiset equality too, so a duplicate on the emitted side (the
  // same CREATE reached twice) cannot hide behind the set checks above.
  expect([...asked].sort()).toEqual([...emitted].sort());
}

describe("BOOTSTRAP_TABLES / BOOTSTRAP_INDEXES lockstep with the bootstrap DDL", () => {
  it("the readiness probe asks for exactly the tables the bootstrap CREATEs", async () => {
    const { tables: emitted } = await emittedObjects();
    expect(emitted.length, "no CREATE TABLE was emitted").toBeGreaterThan(0);
    const { tables: asked } = await probeLists();
    assertListLockstep(
      "BOOTSTRAP_TABLES",
      emitted,
      asked,
      "a table the bootstrap creates"
    );
  });

  it("the readiness probe asks for exactly the indexes the bootstrap CREATEs", async () => {
    const { indexes: emitted } = await emittedObjects();
    expect(emitted.length, "no CREATE INDEX was emitted").toBeGreaterThan(0);
    const { indexes: asked } = await probeLists();
    assertListLockstep(
      "BOOTSTRAP_INDEXES",
      emitted,
      asked,
      "an index the bootstrap creates"
    );
  });

  it("the readiness probe asks for exactly the forward-compat columns the bootstrap ADDs", async () => {
    // `CREATE TABLE IF NOT EXISTS` cannot upgrade a table that already exists,
    // so a forward-compat ADD COLUMN is reachable ONLY through the probe: it
    // short-circuits the very block that emits the ALTER. The tables/indexes
    // guard could not see this class of object at all.
    const emitted = emittedColumns(await runBootstrap(false));
    expect(
      emitted.length,
      "no forward-compat ADD COLUMN was emitted"
    ).toBeGreaterThan(0);
    const emittedKeys = emitted.map(([table, column]) => `${table}.${column}`);

    const { columns } = await probeLists();
    assertListLockstep(
      "BOOTSTRAP_COLUMNS",
      emittedKeys,
      columns,
      "a forward-compat ADD COLUMN column"
    );
  });

  it("names every ADD CONSTRAINT either in the probe or on a table the run creates", async () => {
    // A constraint is the one object class the probe cannot enumerate as a
    // bind array — it is a name in the probe's SQL text — so it is checked as
    // "is it detectable at all" instead.
    //
    // The rule: a named constraint needs a probe entry of its own ONLY when
    // nothing else the probe already asks for reveals its absence. A table this
    // run creates is absent from a deployed store together with its
    // constraints, and the table's own probe entry already answers not-ready
    // for it; likewise a constraint added in the same block as a forward-compat
    // column is revealed by that column's entry. A constraint that rides
    // NEITHER — a rename or a widened CHECK on a long-lived table — has no
    // other signal at all, which is exactly why `entities_type_closed_check`
    // is the one the probe names by hand (schema-lock.ts).
    const queries = await runBootstrap(false);
    const created = new Set(emittedTables(queries));
    const constraints = emittedConstraints(queries);
    expect(
      constraints.length,
      "no named ADD CONSTRAINT was emitted"
    ).toBeGreaterThan(0);

    const { probeSql } = await probeLists();
    const named = probeSql.toLowerCase();
    const invisible = constraints
      .filter(([table, name]) => !named.includes(name) && !created.has(table))
      .map(([, name]) => name);
    expect(
      invisible,
      "a named ADD CONSTRAINT on a table this bootstrap never creates and the " +
        "probe never names — nothing can detect its absence on a deployed store"
    ).toEqual([]);

    // Pin the hand-named marker itself. Deliberate exception to this file's
    // derive-don't-restate doctrine: `entities_type_closed_check` is a RENAME,
    // so a store can carry the table, the column, and the LEGACY constraint all
    // at once, and the name is the only observable difference. Deleting it
    // would leave the destructive entities-type upgrade unable to re-run.
    expect(named).toContain("entities_type_closed_check");
  });

  it("names the invalidation outbox, its cursor, and the evidence_ref index", async () => {
    // P3 register §1.1, restated by hand for the same reason the marker above
    // is: these are brand-new tables on an already-provisioned store, so the
    // probe entry is the ONLY thing that can create them there. The derivation
    // above would notice a missing entry, but a future relaxation of it would
    // not name which contract regressed.
    const { tables, indexes } = await probeLists();
    expect(tables).toContain("evidence_invalidation_outbox");
    expect(tables).toContain("evidence_invalidation_cursors");
    expect(indexes).toContain("evidence_invalidation_outbox_evidence_ref_idx");
  });

  it("the mock itself is pinned: ready must short-circuit before the DDL", async () => {
    // Guards the mock, not the product: if a generic arm ever shadows the
    // readiness arm again, the probe never observes the `ready` flag and
    // `ready: true` replays the whole DDL — every assertion above would then be
    // answered by the same run that is supposed to have short-circuited.
    const readyQueries = await runBootstrap(true);
    const created = readyQueries.filter(({ sql }) =>
      createStatementFor("\\w+").test(sql)
    );
    expect(
      created.map(({ sql }) => sql.trim().slice(0, 80)),
      "ready: true emitted a CREATE — the mock answered the readiness probe " +
        "with the generic current_schema() arm instead of a ready row"
    ).toEqual([]);

    const notReady = await runBootstrap(false);
    expect(
      notReady.filter(({ sql }) => /CREATE\s+(?:UNIQUE\s+)?TABLE/i.test(sql))
        .length,
      "ready: false must drive the full DDL path for the derivation to see the " +
        "CREATE statements"
    ).toBeGreaterThan(0);
  });
});

describe("a database missing one object the bootstrap creates", () => {
  /**
   * The consequence half, and the one that needs no Postgres: the probe's lists
   * ARE the migration mechanism, so a database missing exactly `absent` is
   * answered "not ready" if and only if `absent` is named in a list. Names the
   * bootstrap emits but the probe never asks for leave the probe answering
   * "ready" on exactly the store that lacks them, and the DDL never replays.
   *
   * The probe answer models the object-existence arms only — the vector
   * extension and the `entities_type_closed_check` marker are held present,
   * which is the case that matters here.
   */
  function runWithAbsent(absent: readonly string[]): Promise<RecordedQuery[]> {
    const missing = new Set(absent);
    return drive((sql, values) => {
      if (!READINESS_PROBE_RE.test(sql)) return undefined;
      const asked = [
        ...((values?.[0] as string[] | undefined) ?? []),
        ...((values?.[1] as string[] | undefined) ?? []),
        // Columns ride the probe as two parallel arrays, so they are asked
        // about as `table.column` — reading only $1/$2 here is what let a
        // column go missing from the probe unnoticed by this file.
        ...((values?.[2] as string[] | undefined) ?? []).map(
          (table, i) => `${table}.${(values?.[3] as string[])[i]}`
        ),
      ];
      return { rows: [{ ready: asked.every((name) => !missing.has(name)) }] };
    });
  }

  it("reports not-ready and replays the DDL for every name the bootstrap creates", async () => {
    const queries = await runBootstrap(false);
    const { tables, indexes } = {
      tables: emittedTables(queries),
      indexes: emittedIndexes(queries),
    };
    const names = [...new Set([...tables, ...indexes])].sort();
    expect(names.length, "no objects were emitted").toBeGreaterThan(0);

    for (const name of names) {
      const queries = await runWithAbsent([name]);
      const replays = queries.filter(({ sql }) =>
        createStatementFor(name).test(sql)
      );
      expect(
        replays.length,
        `a database missing "${name}" was answered ready — the probe does not ` +
          `name it, so ${name} can never reach an already-provisioned store`
      ).toBeGreaterThan(0);
    }
  });

  it("reports not-ready and replays the DDL for every forward-compat column", async () => {
    // The column half of the same consequence, which the tables/indexes loop
    // above structurally could not reach: a column is not a name the probe can
    // be asked about on its own, it is a `table.column` pair.
    const columns = emittedColumns(await runBootstrap(false)).map(
      ([table, column]) => `${table}.${column}`
    );
    expect(
      columns.length,
      "no forward-compat columns were emitted"
    ).toBeGreaterThan(0);

    for (const key of columns) {
      const replays = (await runWithAbsent([key])).filter(({ sql }) =>
        new RegExp(
          String.raw`ALTER\s+TABLE\s+${key.split(".")[0]}\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+${key.split(".")[1]}\b`,
          "i"
        ).test(sql)
      );
      expect(
        replays.length,
        `a database missing "${key}" was answered ready — the probe does not ` +
          `name the pair, so the forward-compat ALTER never runs there`
      ).toBeGreaterThan(0);
    }
  });

  it("still reports ready when nothing is missing", async () => {
    // The complement: the derived per-object case above would also "pass" if
    // the fake answered "not ready" unconditionally, so pin the other arm.
    const { tables, indexes } = await emittedObjects();
    const queries = await runWithAbsent([]);
    const probe = queries.find(({ sql }) => READINESS_PROBE_RE.test(sql));
    expect(probe, "readiness probe statement not emitted").toBeDefined();
    expect(
      queries.filter(({ sql }) => /CREATE\s+(?:UNIQUE\s+)?TABLE/i.test(sql))
        .length,
      `a fully populated database was answered not-ready (${tables.length} tables, ` +
        `${indexes.length} indexes probed)`
    ).toBe(0);
  });
});
