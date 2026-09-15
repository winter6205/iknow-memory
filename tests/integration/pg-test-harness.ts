import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { describe } from "vitest";

import {
  redactPgConnectionString,
  redactPgDiagnostic,
} from "../../src/core/storage/pg-diagnostics.js";

export { redactPgConnectionString, redactPgDiagnostic };

const DEFAULT_CONNECTION_STRING = "postgresql://postgres@localhost/postgres";
const DB_URL_ENV = "GRAPHRAG_MEMORY_DB_URL";

export interface ResolvePgConnectionStringOptions {
  dotenvPath?: string;
}

export interface PgIntegrationHarnessOptions {
  label: string;
  testPath: string;
  expectedCommand: string;
  schemaPrefix: string;
  defaultConnectionString?: string;
  requiresVector?: boolean;
}

/**
 * Same rule as `loadEnv` / `readEnv` in `src/config.ts`: a key *present* on
 * `process.env` (even blank) is an explicit pin and must not fall through
 * to `.env.local`. Vitest does not inject non-`VITE_` keys from that file,
 * so suites that only look at `process.env` would otherwise skip whenever
 * the developer followed the runbook (`cp .env.example .env.local`).
 */
function unquoteDotenvValue(value: string): string | undefined {
  let v = value.trim();
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    v = v.slice(1, -1);
  }
  if (v.startsWith("<") && v.endsWith(">")) return undefined;
  return v;
}

function parseDotenvFile(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of contents.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    const parsed = unquoteDotenvValue(line.slice(i + 1));
    if (parsed === undefined) continue;
    out[line.slice(0, i).trim()] = parsed;
  }
  return out;
}

function readDotenvValue(path: string, key: string): string | undefined {
  if (!existsSync(path)) return undefined;
  return parseDotenvFile(readFileSync(path, "utf8"))[key];
}

/**
 * Resolve the Postgres connection string a suite should use: an explicitly
 * set `GRAPHRAG_MEMORY_DB_URL` wins over `.env.local`, which wins over the
 * caller's default.
 */
export function resolvePgConnectionString(
  defaultConnectionString: string,
  options?: ResolvePgConnectionStringOptions
): string {
  if (Object.prototype.hasOwnProperty.call(process.env, DB_URL_ENV)) {
    const configured = process.env[DB_URL_ENV];
    if (configured !== undefined && configured.trim() !== "") {
      return configured;
    }
    return defaultConnectionString;
  }
  const dotenvPath = options?.dotenvPath ?? join(process.cwd(), ".env.local");
  const fromFile = readDotenvValue(dotenvPath, DB_URL_ENV);
  if (fromFile !== undefined && fromFile.trim() !== "") {
    return fromFile;
  }
  return defaultConnectionString;
}

/**
 * Loud-skip locally; hard-fail in CI so a missing Postgres cannot exit 0.
 * Mirrors `tests/integration/bm25-pg.test.ts`.
 */
export function describeWhenPostgresAvailable(
  probe: ProbeResult,
  warning: PgUnavailableWarningOptions
): typeof describe | typeof describe.skip {
  if (probe.available) return describe;
  warnPgUnavailable(warning);
  if (process.env.CI === "true") {
    throw new Error(
      `Postgres unreachable at ${redactPgConnectionString(warning.connectionString)} in CI; loud-skip is local-only`
    );
  }
  return describe.skip;
}

export interface PgIntegrationHarness {
  readonly connectionString: string;
  readonly schema: string;
  readonly schemaConnectionString: string;
  /**
   * `describe` when the probe reached Postgres, `describe.skip` otherwise.
   * Typed as the union because `describe.skip` is a `ChainableFunction`
   * (so `.skipIf` / `.runIf` cannot be taken from the value), not the
   * `SuiteAPI` that `typeof describe` names.
   */
  readonly describePg: typeof describe | typeof describe.skip;
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

export interface ProbeResult {
  available: boolean;
  error?: unknown;
}

export async function probePostgres(
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
  const connectionString = resolvePgConnectionString(
    options.defaultConnectionString ?? DEFAULT_CONNECTION_STRING
  );
  const schema = `${options.schemaPrefix}_${randomUUID().replace(/-/g, "")}`;
  const schemaConnectionString = withSchemaSearchPath(connectionString, schema);
  const probe = await probePostgres(
    connectionString,
    options.requiresVector ?? false
  );
  const describePg = describeWhenPostgresAvailable(probe, {
    ...options,
    connectionString,
    error: probe.error ?? new Error("Postgres probe failed"),
    requiresVector: options.requiresVector ?? false,
  });

  return {
    connectionString,
    schema,
    schemaConnectionString,
    describePg,
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
