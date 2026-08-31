import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { FakeEmbedder } from "../../src/core/embedder.js";
import { PgvectorBackend } from "../../src/core/storage/pgvector-backend.js";
import { createIngestHandler } from "../../src/tools/ingest.js";
import {
  createPgIntegrationHarness,
  warnPgUnavailable,
} from "./pg-test-harness.js";

describe("Postgres diagnostic redaction", () => {
  it("does not emit a connection password in an unavailable warning", () => {
    const secret = "redaction-password-123";
    const connectionString = `postgresql://ci-user:${secret}@db.example.test:5432/graph?sslmode=require`;
    const warnings: string[] = [];
    const warn = vi
      .spyOn(console, "warn")
      .mockImplementation((...args: unknown[]) => {
        warnings.push(args.map((arg) => String(arg)).join(" "));
      });

    try {
      warnPgUnavailable({
        label: "redaction-test",
        testPath: "tests/integration/redaction.test.ts",
        expectedCommand: "npx vitest run tests/integration/redaction.test.ts",
        connectionString,
        requiresVector: false,
        error: new Error(`connect failed using ${connectionString}`),
      });
    } finally {
      warn.mockRestore();
    }

    const diagnostic = warnings.join("\n");
    expect(diagnostic).not.toContain(secret);
    expect(diagnostic).toContain("db.example.test");
    expect(diagnostic).toContain("graph");
    expect(diagnostic).not.toContain("sslmode=require");
  });
});

const DIM = 32;
const pgHarness = await createPgIntegrationHarness({
  label: "ingest-idempotency-pg",
  testPath: "tests/integration/ingest-idempotency-pg.test.ts",
  expectedCommand:
    "npx vitest run tests/integration/ingest-idempotency-pg.test.ts",
  schemaPrefix: "ingest_idempotency",
  defaultConnectionString: "postgresql://postgres@localhost/postgres",
  requiresVector: false,
});
const {
  schema: SCHEMA,
  schemaConnectionString: SCHEMA_URL,
  describePg,
} = pgHarness;

describePg("T5 ingest idempotency: live PostgreSQL", () => {
  let client: pg.Client | undefined;
  let backend: PgvectorBackend | undefined;

  beforeAll(async () => {
    client = pgHarness.createClient(SCHEMA_URL);
    await client.connect();
    await pgHarness.resetSchema(client);
    backend = new PgvectorBackend(SCHEMA_URL, DIM, 2000);
  });

  afterAll(async () => {
    if (backend) await backend.close();
    if (client) {
      await pgHarness.dropSchema(client);
      await client.end();
    }
  });

  it("returns one stable id for concurrent duplicate pushes and stores one row", async () => {
    const ingest = createIngestHandler({
      embedder: new FakeEmbedder(DIM),
      storage: backend!,
    });
    const sourceRef = "t5/live-concurrent";
    const content = "concurrent idempotent content";

    const results = await Promise.all(
      Array.from({ length: 16 }, () =>
        ingest({ content, source_ref: sourceRef })
      )
    );
    const idSets = results.map((result) => {
      const text = (result.content as Array<{ type: string; text?: string }>)
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join("");
      return (JSON.parse(text) as { chunk_ids: string[] }).chunk_ids;
    });

    expect(idSets[0]).toHaveLength(1);
    for (const idSet of idSets) expect(idSet).toEqual(idSets[0]);

    const count = await client!.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM chunks WHERE source_ref = $1`,
      [sourceRef]
    );
    expect(count.rows[0]?.count).toBe("1");
  });
});
