/**
 * The evidence tables and indexes must be reachable on a DEPLOYED database.
 *
 * `upSchemaBootstrap` short-circuits the entire DDL block once the readiness
 * probe answers true (schema-lock.ts), so a brand-new `CREATE TABLE IF NOT
 * EXISTS` only ever runs on a database the probe already called "not ready".
 * Naming the tables and indexes in `BOOTSTRAP_TABLES` / `BOOTSTRAP_INDEXES`
 * is therefore the only mechanism that can add them to an existing
 * installation — a missing entry means the first evidence write fails with
 * `relation … does not exist`, not at review time.
 *
 * The sibling case in bootstrap-columns.test.ts derives the same invariant for
 * forward-compat COLUMNS; this one covers the tables and indexes the evidence
 * slice added.
 */
import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";

import { upSchemaBootstrap } from "../../src/core/storage/schema-bootstrap.js";

/** The readiness probe's own SQL also matches a generic `current_schema()`. */
const READINESS_PROBE_RE = /AS ready/;

/** Every table and index the evidence slice added. */
const EVIDENCE_TABLES = [
  "source_versions",
  "source_version_locators",
  "assertion_supports",
  "support_extractions",
  "evidence_scope_revisions",
  "evidence_authorization_receipts",
  "evidence_grants",
  "evidence_grant_supports",
  "evidence_grant_extractions",
];

const EVIDENCE_INDEXES = [
  "source_versions_source_ref_source_version_idx",
  "assertion_supports_source_version_idx",
  "assertion_supports_result_idx",
  "support_extractions_extraction_ref_idx",
  "evidence_authorization_receipts_scope_revisions_idx",
  "evidence_grants_expires_at_idx",
  "evidence_grants_scope_binding_idx",
  "evidence_grant_supports_support_id_idx",
];

interface RecordedQuery {
  sql: string;
  values?: unknown[];
}

/** Run the real bootstrap against a recording client; `ready` drives the path. */
async function runBootstrap(ready: boolean): Promise<RecordedQuery[]> {
  const statements: RecordedQuery[] = [];
  const client = {
    query: vi.fn(async (sql: string, values?: unknown[]) => {
      statements.push({ sql, values });
      if (READINESS_PROBE_RE.test(sql)) return { rows: [{ ready }] };
      if (/current_schema\(\)/.test(sql)) {
        return { rows: [{ schema_name: "public" }] };
      }
      return { rows: [] };
    }),
  } as unknown as PoolClient;
  await upSchemaBootstrap(client, 1536, 2000);
  return statements;
}

/** The `(table, column)` / object names the probe actually asked about. */
function probeBindings(
  statements: RecordedQuery[]
): { tables: string[]; indexes: string[] } {
  const probe = statements.find(({ sql }) => READINESS_PROBE_RE.test(sql));
  expect(probe, "readiness probe statement not emitted").toBeDefined();
  const values = probe!.values ?? [];
  return { tables: values[0] as string[], indexes: values[1] as string[] };
}

describe("evidence tables are registered with the readiness probe", () => {
  it("creates every evidence table and index", async () => {
    const statements = await runBootstrap(false);
    const created = statements.map(({ sql }) => sql).join("\n");
    for (const table of EVIDENCE_TABLES) {
      expect(created, `no CREATE TABLE for ${table}`).toContain(
        `CREATE TABLE IF NOT EXISTS ${table}`
      );
    }
    for (const index of EVIDENCE_INDEXES) {
      expect(created, `no CREATE INDEX for ${index}`).toContain(index);
    }
  });

  it("asks the probe for every one of them", async () => {
    const { tables, indexes } = probeBindings(await runBootstrap(false));
    for (const table of EVIDENCE_TABLES) {
      expect(
        tables,
        `${table} is absent from BOOTSTRAP_TABLES — the probe will report ready ` +
          "and the table will never reach a deployed database"
      ).toContain(table);
    }
    for (const index of EVIDENCE_INDEXES) {
      expect(
        indexes,
        `${index} is absent from BOOTSTRAP_INDEXES — the occurrence-key and ` +
          "receipt indexes are what make a repeated extraction a second link " +
          "instead of a second support"
      ).toContain(index);
    }
  });

  it("derives the occurrence key from a unique constraint, not an expression index", async () => {
    // NULLs never collide in a unique constraint, so the absent span uses the
    // -1 spelling: with NULL columns one absent-span occurrence could become
    // many supports.
    const created = (await runBootstrap(false))
      .map(({ sql }) => sql)
      .join("\n");
    expect(created).toContain(
      "assertion_supports_occurrence_key"
    );
    expect(created).toContain("span_start        integer NOT NULL DEFAULT -1");
  });
});
