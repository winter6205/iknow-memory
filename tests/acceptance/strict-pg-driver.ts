import type pg from "pg";

import {
  createPgIntegrationHarness,
  probePostgres,
  resolvePgConnectionString,
  type PgIntegrationHarness,
} from "../integration/pg-test-harness.js";

const DEFAULT_CONNECTION_STRING = "postgresql://postgres@localhost/postgres";

export interface StrictPgDriverOptions {
  readonly envName: string;
  readonly testPath: string;
  readonly expectedCommand: string;
  readonly label: string;
  readonly schemaPrefix: string;
  readonly dependency: string;
}

export interface StrictPgDriver {
  readonly harness: PgIntegrationHarness;
  readonly schemaConnectionString: string;
  readonly schema: string;
  dropOwnSchema(client: pg.Client): Promise<void>;
}

export async function openStrictPgDriver(
  options: StrictPgDriverOptions
): Promise<StrictPgDriver> {
  if (process.env[options.envName] !== "1") {
    // EXIT: the strict marker is absent, empty, or not `1`. The module load
    // throws before any harness, probe or schema exists, so the run exits
    // non-zero naming the absent flag instead of reporting a skipped lane.
    throw new Error(
      [
        `${options.envName}=1 is required to run this acceptance driver.`,
        "Validation:",
        `- Not run: ${options.testPath}`,
        `- Expected command: ${options.expectedCommand}`,
        `- Blocking issue: ${options.envName} is ${describeMarker(
          process.env[options.envName]
        )}, so ${options.dependency} evidence would be skipped.`,
        "- This driver deliberately has no skip path: a skipped acceptance run is not evidence.",
      ].join("\n")
    );
  }

  const connectionString = resolvePgConnectionString(DEFAULT_CONNECTION_STRING);
  const probe = await probePostgres(connectionString, true);
  if (!probe.available) {
    // EXIT: PostgreSQL or pgvector is unreachable from GRAPHRAG_MEMORY_DB_URL.
    // The module load throws before the harness is created, so no schema is
    // created and no suite in the lane can report green.
    throw new Error(
      [
        "Validation:",
        `- Not run: ${options.testPath}`,
        `- Expected command: ${options.expectedCommand}`,
        `- Blocking issue: ${options.dependency} is unreachable — ${
          probe.error instanceof Error ? probe.error.message : String(probe.error)
        }`,
        `- Database variable: GRAPHRAG_MEMORY_DB_URL is ${
          Object.prototype.hasOwnProperty.call(
            process.env,
            "GRAPHRAG_MEMORY_DB_URL"
          )
            ? "set"
            : "absent, so the default development DSN was used"
        }`,
        "- This driver deliberately has no skip path: a skipped acceptance run is not evidence.",
      ].join("\n")
    );
  }

  const harness = await createPgIntegrationHarness({
    label: options.label,
    testPath: options.testPath,
    expectedCommand: options.expectedCommand,
    schemaPrefix: options.schemaPrefix,
    defaultConnectionString: DEFAULT_CONNECTION_STRING,
    requiresVector: true,
  });

  return {
    harness,
    schemaConnectionString: harness.schemaConnectionString,
    schema: harness.schema,
    async dropOwnSchema(client: pg.Client): Promise<void> {
      if (!harness.schema.startsWith(`${options.schemaPrefix}_`)) {
        // EXIT: the teardown reached a schema this run's own prefix does not
        // name. It refuses and the schema survives, so a schema this run never
        // created is never dropped as if it had.
        throw new Error(
          `refusing to drop a schema outside this run's prefix: ${harness.schema} does not start with ${options.schemaPrefix}_`
        );
      }
      await harness.dropSchema(client);
    },
  };
}

function describeMarker(value: string | undefined): string {
  if (value === undefined) return "absent";
  if (value === "") return "present but empty";
  return 'set to a value other than "1"';
}

export interface NotRunEntry {
  readonly claim: string;
  readonly owner: string;
  readonly reason: string;
}

export interface NotRunCase {
  readonly caseId: string;
  readonly expectedCommand: string;
  readonly owner: string;
  readonly entries: readonly NotRunEntry[];
}

export function notRunBlock(target: NotRunCase): string {
  return [
    "Validation:",
    ...target.entries.map(
      (entry) =>
        `Not run: ${target.caseId} ${entry.claim} — owner ${entry.owner} — ${entry.reason}`
    ),
    `- Expected command: ${target.expectedCommand}`,
    `- Blocking issue: ${target.caseId} is not fully runnable, so acceptance stays open under ${target.owner}.`,
  ].join("\n");
}

export function warnNotRun(target: NotRunCase): void {
  if (target.entries.length === 0) return;
  console.warn(`\n[${target.caseId}] ${notRunBlock(target)}\n`);
}

export function requireFullyRunnable(target: NotRunCase): void {
  if (target.entries.length === 0) return;
  // EXIT: at least one claim of this frozen case has no runnable boundary. The
  // case throws a named `Not run` report, so the run exits non-zero instead of
  // counting the absent claim as a pass.
  throw new Error(notRunBlock(target));
}
