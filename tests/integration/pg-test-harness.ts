import { randomUUID } from "node:crypto";
import pg from "pg";
import { describe } from "vitest";

const DEFAULT_CONNECTION_STRING = "postgresql://postgres@localhost/postgres";
const POSTGRES_URL_PATTERN = /\bpostgres(?:ql)?:\/\/[^\s"'`<>]+/gi;
const KEY_VALUE_SECRET_PATTERN =
  /(\b(?:user|username|password|passwd|pwd)\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s]+)/gi;

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

function parseConnectionUrl(connectionString: string): URL | undefined {
  if (!URL.canParse(connectionString)) return undefined;
  return new URL(connectionString);
}

function decodeUrlComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch (error: unknown) {
    if (error instanceof URIError) return value;
    throw error;
  }
}

export function redactPgConnectionString(connectionString: string): string {
  const url = parseConnectionUrl(connectionString);
  if (!url) return "postgresql://[redacted]";

  const host = url.hostname || "unknown-host";
  const database =
    decodeUrlComponent(url.pathname.replace(/^\/+/, "").split("/")[0] ?? "") ||
    "unknown-database";
  return `postgresql://${host}/${encodeURIComponent(database)}`;
}

function connectionSecrets(connectionString: string): string[] {
  const url = parseConnectionUrl(connectionString);
  if (!url) return [connectionString].filter(Boolean);

  return [connectionString, url.username, url.password]
    .flatMap((value) => [value, decodeUrlComponent(value)])
    .filter(
      (value, index, values) =>
        value.length > 0 && values.indexOf(value) === index
    );
}

export function redactPgDiagnostic(
  error: unknown,
  connectionString: string
): string {
  let diagnostic = error instanceof Error ? error.message : String(error);
  const redactedConnectionString = redactPgConnectionString(connectionString);

  for (const secret of connectionSecrets(connectionString)) {
    diagnostic = diagnostic.split(secret).join(redactedConnectionString);
  }

  diagnostic = diagnostic.replace(POSTGRES_URL_PATTERN, (candidate) => {
    const trailing = candidate.match(/[.,;:!?)}\]]+$/)?.[0] ?? "";
    const url = trailing ? candidate.slice(0, -trailing.length) : candidate;
    return `${redactPgConnectionString(url)}${trailing}`;
  });
  return diagnostic.replace(KEY_VALUE_SECRET_PATTERN, "$1[redacted]");
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
  const safeError = redactPgDiagnostic(error, connectionString);
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
  const probe = new pg.Client({ connectionString });
  let connected = false;
  let available = false;
  let error: unknown;

  try {
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
    if (connected) {
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
