/**
 * Projection CLI — push the Postgres ledger into the Neo4j read-only
 * projection, or re-arm the outbox so the projector catches up
 * (specs/neo4j-graph-arm.md T2, SC1–SC2; ADR-0001).
 *
 * Offline operator tool, never an MCP surface: the server stays
 * ingest+retrieve, and Postgres stays the only system of record. Chunks are
 * never read and never projected.
 *
 * Modes (one per run):
 *   (default)     backfill — MERGE every live entity/triple into Neo4j.
 *                 Idempotent: MERGE keys on the ledger id, so a re-run
 *                 updates in place and an interrupted run just resumes.
 *   --reconcile   enqueue one pending `projection_outbox` intent per live
 *                 subject so the T3 drain converges. Postgres only.
 *   --dry-run     report what would be projected. Writes nothing, opens no
 *                 Neo4j connection.
 *
 * Exit-code map:
 *   0 success — backfill completed, or a --dry-run / --reconcile run.
 *   1 config / fatal — missing GRAPHRAG_MEMORY_DB_URL, Postgres unreachable,
 *     ConfigError (including a missing Neo4j URI on the projecting path).
 *   2 usage error (unknown / malformed / mutually exclusive flags).
 *   3 loud skip — Neo4j is configured but unreachable. Nothing was left
 *     half-projected that a re-run cannot fix, so this is deliberately not a
 *     fatal: an operator scripting the projection can treat 3 as "try later"
 *     while still seeing the Validation block on stderr.
 */
import { Pool } from "pg";

import {
  ConfigError,
  NEO4J_URI_VAR,
  loadEnv,
  type Neo4jConfig,
} from "../config.js";
import { createLogger, type Logger, writeStderr } from "../logging.js";
import { connectNeo4j } from "../core/graph/neo4j-writer.js";
import {
  SCAN_START,
  scanEntities,
  scanTriples,
  type LedgerClient,
  type ScanPage,
} from "../core/graph/ledger-source.js";
import {
  GraphUnavailableError,
  type GraphWriter,
} from "../core/graph/types.js";
import { upSchemaProjection } from "../core/storage/schema-projection.js";
import {
  emitProjectionIntents,
  type ProjectionSubject,
} from "../core/storage/projection-outbox.js";

export interface BackfillFlags {
  /** Rows per ledger scan page and per Neo4j MERGE statement. */
  batchSize: number;
  dryRun: boolean;
  reconcile: boolean;
}

const DEFAULT_FLAGS: BackfillFlags = {
  batchSize: 500,
  dryRun: false,
  reconcile: false,
};

const USAGE = `usage: graph-backfill [--batch-size N] [--dry-run | --reconcile]`;

/** Minimal client surface accepted by both pg.PoolClient and test fakes. */
export interface BackfillClient extends LedgerClient {
  release(): void;
}

export interface BackfillPool {
  connect(): Promise<BackfillClient>;
  end(): Promise<void>;
}

export interface BackfillDeps {
  pool: BackfillPool;
  logger: Logger;
  /**
   * Opens the projection target. Throws `GraphUnavailableError` when Neo4j is
   * configured but not reachable, `ConfigError` when it is not configured at
   * all. Injected so the CLI is testable without a live instance.
   */
  connectGraph: () => Promise<GraphWriter>;
}

type ParsedArgs =
  { ok: true; flags: BackfillFlags } | { ok: false; error: string };

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: BackfillFlags = { ...DEFAULT_FLAGS };
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;
    if (arg === "--dry-run") flags.dryRun = true;
    else if (arg === "--reconcile") flags.reconcile = true;
    else if (arg === "--batch-size") {
      const n = Number(argv[i + 1]);
      if (!Number.isInteger(n) || n <= 0) {
        return { ok: false, error: `--batch-size requires a positive integer` };
      }
      flags.batchSize = n;
      i += 1;
    } else {
      return { ok: false, error: `unknown flag: "${arg}"` };
    }
    i += 1;
  }
  // Routing picks ONE mode, so a second mode flag would be dropped rather
  // than also applied — name it instead of resolving it by if-chain order.
  if (flags.dryRun && flags.reconcile) {
    return {
      ok: false,
      error: `--dry-run and --reconcile are mutually exclusive`,
    };
  }
  return { ok: true, flags };
}

/** Top-level entry, testable: parse flags, route, map results to exit codes. */
export async function runCli(
  argv: string[],
  deps: BackfillDeps
): Promise<number> {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    writeStderr(`${USAGE}\ngraph-backfill: ${parsed.error}\n`);
    return 2;
  }
  const client = await deps.pool.connect();
  try {
    if (parsed.flags.dryRun) return await dryRun(deps, client, parsed.flags);
    if (parsed.flags.reconcile) {
      return await reconcile(deps, client, parsed.flags);
    }
    return await backfill(deps, client, parsed.flags);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    writeStderr(`graph-backfill fatal: ${msg}\n`);
    deps.logger.error("graph-backfill-fatal", { error: msg });
    return 1;
  } finally {
    client.release();
  }
}

/**
 * Walk a keyset-paginated scan, handing each page to `onPage`. Returns the
 * total row count. Pages are never accumulated: an initial backfill of a large
 * ledger must not need the whole graph in memory.
 */
async function eachPage<T extends { id: string }>(
  scan: (page: ScanPage) => Promise<T[]>,
  batchSize: number,
  onPage: (rows: T[]) => Promise<void>
): Promise<number> {
  let after = SCAN_START;
  let total = 0;
  for (;;) {
    const rows = await scan({ after, limit: batchSize });
    if (rows.length === 0) return total;
    await onPage(rows);
    total += rows.length;
    after = rows[rows.length - 1]!.id;
    if (rows.length < batchSize) return total;
  }
}

/** `--dry-run`: count both scans, touch nothing. */
async function dryRun(
  deps: BackfillDeps,
  client: BackfillClient,
  flags: BackfillFlags
): Promise<number> {
  const entities = await eachPage(
    (page) => scanEntities(client, page),
    flags.batchSize,
    async () => {}
  );
  const triples = await eachPage(
    (page) => scanTriples(client, page),
    flags.batchSize,
    async () => {}
  );
  deps.logger.info("graph-backfill-plan", { entities, triples });
  return 0;
}

/**
 * Default mode: MERGE the whole live ledger into Neo4j. Nodes are projected
 * before edges because `mergeEdges` MATCHes its endpoints rather than creating
 * them (see neo4j-writer.ts).
 */
async function backfill(
  deps: BackfillDeps,
  client: BackfillClient,
  flags: BackfillFlags
): Promise<number> {
  let writer: GraphWriter | undefined;
  try {
    writer = await deps.connectGraph();
    await writer.ensureConstraints();
    const target = writer;
    const nodes = await eachPage(
      (page) => scanEntities(client, page),
      flags.batchSize,
      (rows) => target.mergeNodes(rows)
    );
    const edges = await eachPage(
      (page) => scanTriples(client, page),
      flags.batchSize,
      (rows) => target.mergeEdges(rows)
    );
    deps.logger.info("graph-backfill-complete", {
      nodes,
      edges,
      batchSize: flags.batchSize,
    });
    return 0;
  } catch (err) {
    if (err instanceof GraphUnavailableError) return loudSkip(deps, err);
    throw err;
  } finally {
    if (writer) await writer.close();
  }
}

/**
 * `--reconcile`: enqueue a pending intent per live subject. The emit's
 * ON CONFLICT DO NOTHING plus the partial UNIQUE index make a repeat run a
 * no-op instead of a growing queue, so this is safe to schedule.
 */
async function reconcile(
  deps: BackfillDeps,
  client: BackfillClient,
  flags: BackfillFlags
): Promise<number> {
  await upSchemaProjection(client);
  let queued = 0;
  const emit = async (subjects: ProjectionSubject[]): Promise<void> => {
    queued += await emitProjectionIntents(client, subjects);
  };
  const entities = await eachPage(
    (page) => scanEntities(client, page),
    flags.batchSize,
    (rows) => emit(rows.map((row) => ({ kind: "entity", id: row.id })))
  );
  const triples = await eachPage(
    (page) => scanTriples(client, page),
    flags.batchSize,
    (rows) => emit(rows.map((row) => ({ kind: "triple", id: row.id })))
  );
  deps.logger.info("graph-reconcile-complete", { entities, triples, queued });
  return 0;
}

/**
 * Neo4j is configured but not answering. Report it in the Validation shape the
 * test rules use so an unattended run cannot be mistaken for a completed
 * projection, and exit 3 (re-run safe) rather than 1.
 */
function loudSkip(deps: BackfillDeps, err: GraphUnavailableError): number {
  writeStderr(
    `\ngraph-backfill: Neo4j unreachable at ${err.uri}\n` +
      "Validation:\n" +
      "- Not run: Neo4j projection (backfill)\n" +
      "- Expected command: npm run graph:backfill\n" +
      `- Blocking issue: ${err.message}\n`
  );
  deps.logger.warn("graph-backfill-skipped", {
    reason: "neo4j-unreachable",
    uri: err.uri,
  });
  return 3;
}

/** Wire real deps from env and run; used by main(). */
export async function runCliFromEnv(argv: string[]): Promise<number> {
  let dbUrl: string | undefined;
  let neo4j: Neo4jConfig | undefined;
  let logger: Logger;
  try {
    const env = loadEnv();
    dbUrl = env.dbUrl;
    neo4j = env.neo4j;
    logger = createLogger(env.logLevel);
  } catch (err) {
    if (err instanceof ConfigError) {
      writeStderr(`graph-backfill config error: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
  if (!dbUrl) {
    writeStderr(
      "graph-backfill config error: GRAPHRAG_MEMORY_DB_URL is required\n"
    );
    return 1;
  }
  const pool = new Pool({ connectionString: dbUrl });
  try {
    return await runCli(argv, {
      pool: pool as unknown as BackfillPool,
      logger,
      connectGraph: () => openConfiguredNeo4j(neo4j),
    });
  } finally {
    await pool.end();
  }
}

/**
 * An absent block (no URI configured) is a ConfigError here, not a silent
 * skip: this CLI was invoked precisely to project, so "no target configured"
 * is an operator mistake — the skip-without-degraded rule belongs to the
 * retrieve arm, which was not asked to touch Neo4j.
 */
async function openConfiguredNeo4j(
  config: Neo4jConfig | undefined
): Promise<GraphWriter> {
  if (config === undefined) {
    throw new ConfigError(
      `${NEO4J_URI_VAR} is required to project into Neo4j; pass --reconcile or --dry-run for a Postgres-only run`
    );
  }
  return connectNeo4j(config);
}

/** Top-level entry: wire real deps, exit with the CLI exit code. */
export async function main(): Promise<void> {
  const code = await runCliFromEnv(process.argv.slice(2));
  process.exit(code);
}

// Run only when invoked directly. Mirrors src/cli/extract.ts isMain.
const isMain = (() => {
  if (typeof process === "undefined") return false;
  const arg1 = process.argv[1];
  if (!arg1) return false;
  return (
    arg1.endsWith("cli/graph-backfill.ts") ||
    arg1.endsWith("cli/graph-backfill.js")
  );
})();

if (isMain) {
  main().catch((err) => {
    writeStderr(
      `graph-backfill fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`
    );
    process.exit(1);
  });
}
