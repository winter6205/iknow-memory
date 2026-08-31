import { randomUUID } from "node:crypto";
import pg from "pg";
import { describe } from "vitest";

import {
  redactPgConnectionString,
  redactPgDiagnostic,
} from "../../src/core/storage/pg-diagnostics.js";

export { redactPgConnectionString, redactPgDiagnostic };

const DEFAULT_CONNECTION_STRING = "postgresql://postgres@localhost/postgres";

export interface PgIntegrationHarnessOptions {
  label: string;
  testPath: string;
  expectedCommand: string;
  schemaPrefix: string;
  defaultConnectionString?: string;
  requiresVector?: boolean;
}

export interface PgIntegrationHarness {
  readonly connectionString: string;
  readonly schema: string;
  readonly schemaConnectionString: string;
  readonly describePg: typeof describe;
  createClient(connectionString?: string): pg.Client;
  resetSchema(client: pg.Client): Promise<void>;
  dropSchema(client: pg.Client): Promise<void>;
}

export interface PgUnavailableWarningOptions {
  label: string;
  testPath: string;
  expectedCommand: string;
  connectionString: string;
  error: unknown;
  requiresVector: boolean;
}

export function warnPgUnavailable(options: PgUnavailableWarningOptions): void {
  const {
    label,
    testPath,
    expectedCommand,
    connectionString,
    error,
    requiresVector,
  } = options;
  const safeConnectionString = redactPgConnectionString(connectionString);
  const safeError = redactPgDiagnostic(
    error instanceof Error ? error.message : error,
    connectionString
  );
  const dependency = requiresVector ? "Postgres/pgvector" : "Postgres";
  const blockingIssue = requiresVector
    ? "cannot use Postgres with pgvector"
    : "cannot connect to Postgres";

  console.warn(
    `\n[${label}] ${dependency} unavailable at ${safeConnectionString}: ${safeError}\n`
  );
  console.warn(
    "Validation:\n" +
      `- Not run: ${testPath}\n` +
      `- Expected command: ${expectedCommand}\n` +
      `- Blocking issue: ${blockingIssue} at ${safeConnectionString}\n`
  );
}

interface ProbeResult {
  available: boolean;
  error?: unknown;
}

async function probePostgres(
  connectionString: string,
  requiresVector: boolean
): Promise<ProbeResult> {
  let probe: pg.Client | undefined;
  let connected = false;
  let available = false;
  let error: unknown;

  try {
    probe = new pg.Client({ connectionString });
    await probe.connect();
    connected = true;
    await probe.query("SELECT 1");

    if (requiresVector) {
      const extension = await probe.query<{
        installed_version: string | null;
      }>(
        "SELECT installed_version FROM pg_available_extensions WHERE name = 'vector'"
      );
      if (extension.rows[0]?.installed_version === undefined) {
        error = new Error("pgvector extension is unavailable");
      } else {
        available = true;
      }
    } else {
      available = true;
    }
  } catch (caught: unknown) {
    error = caught;
  } finally {
    if (connected && probe !== undefined) {
      try {
        await probe.end();
      } catch (endError: unknown) {
        error ??= endError;
        available = false;
      }
    }
  }

  return { available, error };
}

function withSchemaSearchPath(
  connectionString: string,
  schema: string
): string {
  const separator = connectionString.includes("?") ? "&" : "?";
  const options = encodeURIComponent(`-c search_path=${schema},public`);
  return `${connectionString}${separator}options=${options}`;
}

export async function createPgIntegrationHarness(
  options: PgIntegrationHarnessOptions
): Promise<PgIntegrationHarness> {
  const connectionString =
    process.env.GRAPHRAG_MEMORY_DB_URL ??
    options.defaultConnectionString ??
    DEFAULT_CONNECTION_STRING;
  const schema = `${options.schemaPrefix}_${randomUUID().replace(/-/g, "")}`;
  const schemaConnectionString = withSchemaSearchPath(connectionString, schema);
  const probe = await probePostgres(
    connectionString,
    options.requiresVector ?? false
  );

  if (!probe.available) {
    warnPgUnavailable({
      ...options,
      connectionString,
      error: probe.error ?? new Error("Postgres probe failed"),
      requiresVector: options.requiresVector ?? false,
    });
  }

  return {
    connectionString,
    schema,
    schemaConnectionString,
    describePg: probe.available ? describe : describe.skip,
    createClient(targetConnectionString = connectionString): pg.Client {
      return new pg.Client({ connectionString: targetConnectionString });
    },
    async resetSchema(client: pg.Client): Promise<void> {
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await client.query(`CREATE SCHEMA "${schema}"`);
    },
    async dropSchema(client: pg.Client): Promise<void> {
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    },
  };
}
