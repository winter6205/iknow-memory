/**
 * The evidence-store contract against a live PostgreSQL schema.
 *
 * The same body the memory suite runs (evidence-store-contract.ts), so a
 * disagreement between the two stores about occurrence identity, a lifetime
 * or a denial reason fails here rather than surfacing as a wrong citation in
 * production. The suite skips LOUDLY when no local Postgres answers, exactly
 * like the rest of tests/storage; that skip is not a pass.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { supportsEvidenceStore } from "../../src/core/storage/backend.js";
import { PgvectorBackend } from "../../src/core/storage/pgvector-backend.js";
import type { EvidenceStore } from "../../src/core/types.js";
import { createPgIntegrationHarness } from "../integration/pg-test-harness.js";
import { runEvidenceStoreContract } from "./evidence-store-contract.js";

const DIM = 8;

const pgHarness = await createPgIntegrationHarness({
  label: "evidence-store-pg",
  testPath: "tests/storage/evidence-store-pg.test.ts",
  expectedCommand: "npx vitest run tests/storage/evidence-store-pg.test.ts",
  schemaPrefix: "evidence_store",
  defaultConnectionString: "postgresql://postgres@localhost/postgres",
  requiresVector: true,
});
const {
  schemaConnectionString: SCHEMA_URL,
  createClient,
  resetSchema,
  dropSchema,
  describePg,
} = pgHarness;

let admin: pg.Client | undefined;
let backend: PgvectorBackend | undefined;

beforeAll(async () => {
  admin = createClient(SCHEMA_URL);
  await admin.connect();
  await resetSchema(admin);
  backend = new PgvectorBackend(SCHEMA_URL, DIM, { annMaxDimensions: 2000 });
  await backend.initialize();
});

afterAll(async () => {
  if (backend) {
    await backend.close();
    backend = undefined;
  }
  if (admin) {
    await dropSchema(admin);
    await admin.end();
    admin = undefined;
  }
});

describePg("PgvectorBackend evidence store", () => {
  it("bootstraps every evidence table the contract reads", async () => {
    const result = await admin!.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = current_schema()`
    );
    const tables = new Set(result.rows.map((row) => row.table_name));
    for (const table of [
      "source_versions",
      "source_version_locators",
      "assertion_supports",
      "support_extractions",
      "evidence_scope_revisions",
      "evidence_authorization_receipts",
      "evidence_grants",
      "evidence_grant_supports",
      "evidence_grant_extractions",
    ]) {
      expect(tables, `${table} missing from the bootstrapped schema`).toContain(
        table
      );
    }
  });

  it("preserves both dimensions under concurrent partial scope revision writes", async () => {
    if (backend === undefined || !supportsEvidenceStore(backend)) {
      throw new Error("the pg evidence store was not initialized");
    }
    const scopeBinding = `concurrent-revision-${randomUUID()}`;
    await backend.setScopeRevisions(scopeBinding, {
      authorizationRevision: "auth-1",
      purgeRevision: "purge-1",
    });

    await Promise.all([
      backend.setScopeRevisions(scopeBinding, {
        authorizationRevision: "auth-2",
      }),
      backend.setScopeRevisions(scopeBinding, {
        purgeRevision: "purge-2",
      }),
    ]);

    const { rows } = await admin!.query<{
      authorization_revision: string;
      purge_revision: string;
    }>(
      `SELECT authorization_revision, purge_revision
         FROM evidence_scope_revisions WHERE scope_binding = $1`,
      [scopeBinding]
    );
    expect(rows).toEqual([
      { authorization_revision: "auth-2", purge_revision: "purge-2" },
    ]);
  });
});

runEvidenceStoreContract(
  "PgvectorBackend",
  async (): Promise<EvidenceStore> => {
    if (backend === undefined) {
      throw new Error("the pg evidence store was not initialized");
    }
    if (!supportsEvidenceStore(backend)) {
      throw new Error("PgvectorBackend does not expose the evidence capability");
    }
    return backend;
  },
  describePg
);
