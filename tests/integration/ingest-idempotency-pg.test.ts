import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { FakeEmbedder } from "../../src/core/embedder.js";
import { PgvectorBackend } from "../../src/core/storage/pgvector-backend.js";
import { createIngestHandler } from "../../src/tools/ingest.js";
import {
  createPgIntegrationHarness,
  redactPgDiagnostic,
  warnPgUnavailable,
} from "./pg-test-harness.js";

describe("Postgres diagnostic redaction", () => {
  it.each([
    {
      label: "URL-encoded password",
      connectionString:
        "postgresql://ci-user:p%40ss%3A%2Fencoded@db.example.test:5432/graph",
      secrets: ["p%40ss%3A%2Fencoded", "p@ss:/encoded"],
      diagnostic:
        "driver failure for postgresql://ci-user:p%40ss%3A%2Fencoded@db.example.test:5432/graph",
    },
    {
      label: "password containing @",
      connectionString:
        "postgres://ci-user:p@ssword@db.example.test:5432/graph",
      secrets: ["p@ssword"],
      diagnostic:
        "constructor exception for postgres://ci-user:p@ssword@db.example.test:5432/graph",
    },
    {
      label: "unix socket path",
      connectionString:
        "postgresql:///graph?host=%2Frun%2Fpostgresql%2Fprivate.sock&sslpassword=socket-password",
      secrets: ["socket-password", "%2Frun%2Fpostgresql%2Fprivate.sock"],
      diagnostic:
        "driver failure for postgresql:///graph?host=%2Frun%2Fpostgresql%2Fprivate.sock&sslpassword=socket-password",
    },
    {
      label: "no password",
      connectionString:
        "postgresql://ci-user@db.example.test:5432/graph?application_name=no-password-secret",
      secrets: ["no-password-secret"],
      diagnostic:
        "constructor exception for postgresql://ci-user@db.example.test:5432/graph?application_name=no-password-secret",
    },
    {
      label: "bare sslpassword diagnostic",
      connectionString:
        "postgresql://ci-user@db.example.test:5432/graph?sslpassword=query-password",
      secrets: ["query-password"],
      diagnostic: "driver diagnostic: sslpassword=query-password",
    },
  ])(
    "does not emit secrets from $label through warning or error output",
    ({ connectionString, secrets, diagnostic }) => {
      const output: string[] = [];
      const warn = vi
        .spyOn(console, "warn")
        .mockImplementation((...args: unknown[]) => {
          output.push(args.map((arg) => String(arg)).join(" "));
        });
      const error = vi
        .spyOn(console, "error")
        .mockImplementation((...args: unknown[]) => {
          output.push(args.map((arg) => String(arg)).join(" "));
        });
      const thrown = new Error(diagnostic);

      try {
        warnPgUnavailable({
          label: "redaction-test",
          testPath: "tests/integration/redaction.test.ts",
          expectedCommand: "npx vitest run tests/integration/redaction.test.ts",
          connectionString,
          requiresVector: false,
          error: thrown,
        });
        console.error(redactPgDiagnostic(thrown));
      } finally {
        warn.mockRestore();
        error.mockRestore();
      }

      const emitted = output.join("\n");
      for (const secret of secrets) {
        expect(emitted, `secret leaked for ${connectionString}`).not.toContain(
          secret
        );
      }
    }
  );

  it("does not emit the URL from a thrown constructor error stack", () => {
    const secret = "constructor-stack-password";
    const connectionString = `postgresql://ci-user:${secret}@db.example.test:5432/graph`;
    const output: string[] = [];
    const warn = vi
      .spyOn(console, "error")
      .mockImplementation((...args: unknown[]) => {
        output.push(args.map((arg) => String(arg)).join(" "));
      });
    const thrown = new TypeError("invalid PostgreSQL constructor options");
    Object.defineProperty(thrown, "stack", {
      configurable: true,
      value: `TypeError: invalid PostgreSQL constructor options for ${connectionString}`,
    });

    try {
      console.error(redactPgDiagnostic(thrown, connectionString));
    } finally {
      warn.mockRestore();
    }

    expect(output.join("\n")).not.toContain(secret);
  });

  it("does not emit credentials from a line-broken connection URL", () => {
    const secret = "wrapped-password";
    const diagnostic = new Error(
      `driver failure for postgresql://ci-user:\n${secret}@db.example.test:5432/graph`
    );

    expect(redactPgDiagnostic(diagnostic)).not.toContain(secret);
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
