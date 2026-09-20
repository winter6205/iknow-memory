/**
 * Operator-console T4: `read_source` over the live PgvectorBackend.
 *
 * The unit suite (tests/tools/read-source.test.ts) covers the MemoryBackend
 * path; this one proves the same StorageReadPort seam works on the pg
 * backend — the read_source tool is only as good as both implementations.
 * Skips automatically when Postgres is unavailable (probe in the harness).
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PgvectorBackend } from "../../src/core/storage/pgvector-backend.js";
import { createReadSourceHandler } from "../../src/tools/read_source.js";
import type { ToolResult } from "../../src/tools/registry.js";
import { createPgIntegrationHarness } from "./pg-test-harness.js";

const DIM = 32;
const pgHarness = await createPgIntegrationHarness({
  label: "read-source-pg",
  testPath: "tests/integration/read-source-pg.test.ts",
  expectedCommand: "npx vitest run tests/integration/read-source-pg.test.ts",
  schemaPrefix: "read_source",
  defaultConnectionString: "postgresql://postgres@localhost/postgres",
  requiresVector: false,
});
const {
  schema: SCHEMA,
  schemaConnectionString: SCHEMA_URL,
  describePg,
} = pgHarness;

function parseBody(result: ToolResult): Record<string, unknown> {
  const text = result.content[0]?.text;
  if (typeof text !== "string") {
    throw new Error("expected text content in ToolResult");
  }
  return JSON.parse(text) as Record<string, unknown>;
}

describePg("T4 read_source: live PgvectorBackend", () => {
  let client: pg.Client | undefined;
  let backend: PgvectorBackend | undefined;

  beforeAll(async () => {
    client = pgHarness.createClient(SCHEMA_URL);
    await client.connect();
    await pgHarness.resetSchema(client);
    backend = new PgvectorBackend(SCHEMA_URL, DIM, { annMaxDimensions: 2000 });
  });

  afterAll(async () => {
    if (backend) await backend.close();
    if (client) {
      await pgHarness.dropSchema(client);
      await client.end();
    }
  });

  it("returns the full 资料 body by source_ref and a named miss otherwise", async () => {
    const doc = {
      id: "22222222-2222-4222-8222-222222222222",
      source_ref: "t4/read-source-pg",
      title: "PG 资料",
      content: "pg full body — byte identical readback",
      created_at: "2026-01-01T00:00:00.000Z",
    };
    await backend!.upsertSourceDoc(doc);

    const handler = createReadSourceHandler({ storage: backend! });

    const hit = parseBody(await handler({ source_ref: doc.source_ref }));
    expect(hit).toEqual({
      id: doc.id,
      source_ref: doc.source_ref,
      title: doc.title,
      content: doc.content,
    });

    const byId = parseBody(await handler({ id: doc.id }));
    expect(byId).toEqual(hit);

    const miss = await handler({ source_ref: "t4/missing" });
    expect(miss.isError).toBe(true);
    expect(parseBody(miss).error).toBe("read_source_not_found");
  });
});
