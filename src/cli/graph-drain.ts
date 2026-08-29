/**
 * Projection drain — apply pending `projection_outbox` intents to the Neo4j
 * read-only projection (specs/neo4j-graph-arm.md T3, SC4; ADR-0001).
 *
 * The other half of T2's outbox: extract emits an intent inside the same
 * transaction as the ledger rows it describes, and this CLI is what makes the
 * graph catch up. An intent names a SUBJECT, never a snapshot, so the drain
 * re-reads the current entity/triple from Postgres — the only system of record
 * — and MERGEs it. Two consequences worth stating: intents need no ordering
 * rule between them, and a re-drain can never push a stale value.
 *
 * Offline operator tool, never an MCP surface. Postgres stays the SoR and this
 * path plus the backfill CLI remain the only writers of the graph (SC1).
 *
 * Modes (one per run):
 *   (default)       drain — claim pending intents in batches, MERGE, mark
 *                   done. Re-runnable: every write is a MERGE on the ledger
 *                   id and a `done` intent is never claimed again.
 *   --dry-run       report queue depth per status. Opens no Neo4j connection,
 *                   writes nothing.
 *   --retry-failed  move failed intents back to pending for the next drain.
 *                   Postgres only.
 *
 * Exit-code map (shared with graph-backfill):
 *   0 success — drain completed, or a --dry-run / --retry-failed run.
 *   1 config / fatal — missing GRAPHRAG_MEMORY_DB_URL, Postgres unreachable,
 *     ConfigError (including a missing Neo4j URI on the draining path).
 *   2 usage error (unknown / malformed / mutually exclusive flags).
 *   3 loud skip — Neo4j is configured but unreachable. The queue is intact
 *     (untouched intents stay pending, an in-flight batch is marked failed
 *     with its error), so an operator scripting the projection can treat 3 as
 *     "try later" while still seeing the Validation block on stderr.
 *
 * Projection GC is drain-only: an intent whose subject has since been retired
 * or deleted resolves to no live ledger row, so the stale graph subject is
 * deleted before the intent is marked done. Backfill still only projects live
 * ledger rows; it does not sweep arbitrary graph subjects.
 */
import { Pool } from "pg";

import {
  ConfigError,
  NEO4J_URI_VAR,
  loadEnv,
  type Neo4jConfig,
} from "../config.js";
import { createLogger, type Logger } from "../logging.js";
import { connectNeo4j } from "../core/graph/neo4j-writer.js";
import {
  loadEntitiesByIds,
  loadTriplesByIds,
  type LedgerClient,
} from "../core/graph/ledger-source.js";
import {
  GraphUnavailableError,
  type GraphWriter,
} from "../core/graph/types.js";
import { upSchemaProjection } from "../core/storage/schema-projection.js";
import {
  claimPendingIntents,
  countIntentsByStatus,
  markIntentsDone,
  markIntentsFailed,
  reArmFailedIntents,
  type OutboxIntent,
} from "../core/storage/projection-outbox.js";

export interface DrainFlags {
  /** Intents claimed per transaction and per Neo4j MERGE statement. */
  batchSize: number;
  dryRun: boolean;
  retryFailed: boolean;
}

const DEFAULT_FLAGS: DrainFlags = {
  batchSize: 200,
  dryRun: false,
  retryFailed: false,
};

const USAGE = `usage: graph-drain [--batch-size N] [--dry-run | --retry-failed]`;

/** Minimal client surface accepted by both pg.PoolClient and test fakes. */
export interface DrainClient extends LedgerClient {
  release(): void;
}

export interface DrainPool {
  connect(): Promise<DrainClient>;
  end(): Promise<void>;
}

export interface DrainDeps {
  pool: DrainPool;
  logger: Logger;
  /**
   * Opens the projection target. Throws `GraphUnavailableError` when Neo4j is
   * configured but not reachable, `ConfigError` when it is not configured at
   * all. Injected so the CLI is testable without a live instance.
   */
  connectGraph: () => Promise<GraphWriter>;
}

type ParsedArgs =
  { ok: true; flags: DrainFlags } | { ok: false; error: string };

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: DrainFlags = { ...DEFAULT_FLAGS };
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;
    if (arg === "--dry-run") flags.dryRun = true;
    else if (arg === "--retry-failed") flags.retryFailed = true;
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
  if (flags.dryRun && flags.retryFailed) {
    return {
      ok: false,
      error: `--dry-run and --retry-failed are mutually exclusive`,
    };
  }
  return { ok: true, flags };
}

/** Top-level entry, testable: parse flags, route, map results to exit codes. */
export async function runCli(argv: string[], deps: DrainDeps): Promise<number> {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    process.stderr.write(`${USAGE}\ngraph-drain: ${parsed.error}\n`);
    return 2;
  }
  const client = await deps.pool.connect();
  try {
    await upSchemaProjection(client);
    if (parsed.flags.dryRun) return await dryRun(deps, client);
    if (parsed.flags.retryFailed) return await retryFailed(deps, client);
    return await drain(deps, client, parsed.flags);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`graph-drain fatal: ${msg}\n`);
    deps.logger.error("graph-drain-fatal", { error: msg });
    return 1;
  } finally {
    client.release();
  }
}

/** `--dry-run`: report the queue, open nothing, write nothing. */
async function dryRun(deps: DrainDeps, client: DrainClient): Promise<number> {
  const counts = await countIntentsByStatus(client);
  deps.logger.info("graph-drain-plan", counts);
  return 0;
}

/** `--retry-failed`: re-arm failed intents so the next drain picks them up. */
async function retryFailed(
  deps: DrainDeps,
  client: DrainClient
): Promise<number> {
  const rearmed = await reArmFailedIntents(client);
  deps.logger.info("graph-drain-retry-armed", { rearmed });
  return 0;
}

interface DrainTotals {
  intents: number;
  nodes: number;
  edges: number;
  unresolved: number;
  batches: number;
}

/**
 * Default mode: claim → project → mark done, batch after batch, until the
 * queue is empty. Each batch is its own transaction, so an interrupted run
 * keeps the batches it finished and leaves the rest pending.
 */
async function drain(
  deps: DrainDeps,
  client: DrainClient,
  flags: DrainFlags
): Promise<number> {
  let writer: GraphWriter | undefined;
  const totals: DrainTotals = {
    intents: 0,
    nodes: 0,
    edges: 0,
    unresolved: 0,
    batches: 0,
  };
  try {
    writer = await deps.connectGraph();
    await writer.ensureConstraints();
    for (;;) {
      const batch = await drainBatch(deps, client, writer, flags.batchSize);
      if (batch.intents === 0) break;
      totals.intents += batch.intents;
      totals.nodes += batch.nodes;
      totals.edges += batch.edges;
      totals.unresolved += batch.unresolved;
      totals.batches += 1;
    }
    deps.logger.info("graph-drain-complete", { ...totals });
    return 0;
  } catch (err) {
    if (err instanceof GraphUnavailableError) return loudSkip(deps, err);
    throw err;
  } finally {
    if (writer) await writer.close();
  }
}

interface BatchOutcome {
  intents: number;
  nodes: number;
  edges: number;
  unresolved: number;
}

interface UnresolvedSubjects {
  entity: string[];
  triple: string[];
}

const EMPTY_BATCH: BatchOutcome = {
  intents: 0,
  nodes: 0,
  edges: 0,
  unresolved: 0,
};

/**
 * One batch, one Postgres transaction.
 *
 * The claim holds `FOR UPDATE SKIP LOCKED` row locks for the whole projection,
 * which is what lets a second drain run beside this one without projecting the
 * same subject twice. The transaction spans the Neo4j write on purpose: if the
 * process dies mid-batch, the intents are still pending and the next run
 * re-MERGEs them, which is safe precisely because every write is a MERGE.
 */
async function drainBatch(
  deps: DrainDeps,
  client: DrainClient,
  writer: GraphWriter,
  batchSize: number
): Promise<BatchOutcome> {
  await client.query("BEGIN");
  let claimed: OutboxIntent[] = [];
  try {
    claimed = await claimPendingIntents(client, batchSize);
    if (claimed.length === 0) {
      await client.query("COMMIT");
      return EMPTY_BATCH;
    }
    const outcome = await project(deps, client, writer, claimed);
    const marked = await markIntentsDone(
      client,
      claimed.map((intent) => intent.id)
    );
    if (marked !== claimed.length) {
      // The rows are locked by this transaction, so the UPDATE cannot miss
      // one. If it does, the queue would never shrink and the loop above
      // would spin forever — name it instead.
      throw new Error(
        `drain marked ${marked} of ${claimed.length} claimed intents done`
      );
    }
    await client.query("COMMIT");
    return outcome;
  } catch (err) {
    await rollbackQuietly(deps, client);
    await recordFailure(deps, client, claimed, err);
    throw err;
  }
}

/**
 * Resolve the claimed subjects against the ledger and MERGE them.
 *
 * Nodes before edges, and the edges' endpoints are merged alongside the
 * entity intents: `MERGE_EDGES` MATCHes its endpoints instead of creating
 * them, so an edge whose node intent happens to land in a later batch would
 * otherwise be dropped in silence. Re-merging a node that is already projected
 * is free — that is what MERGE means.
 */
async function project(
  deps: DrainDeps,
  client: DrainClient,
  writer: GraphWriter,
  claimed: readonly OutboxIntent[]
): Promise<BatchOutcome> {
  const entityIds = subjectIds(claimed, "entity");
  const tripleIds = subjectIds(claimed, "triple");
  const edges = await loadTriplesByIds(client, tripleIds);
  const nodeIds = new Set(entityIds);
  for (const edge of edges) {
    nodeIds.add(edge.headId);
    nodeIds.add(edge.tailId);
  }
  const nodes = await loadEntitiesByIds(client, [...nodeIds]);
  await writer.mergeNodes(nodes);
  await writer.mergeEdges(edges);
  const unresolvedSubjects = reportUnresolved(deps, claimed, {
    entity: new Set(nodes.map((node) => node.id)),
    triple: new Set(edges.map((edge) => edge.id)),
  });
  await writer.deleteEdges(unresolvedSubjects.triple);
  await writer.deleteNodes(unresolvedSubjects.entity);
  return {
    intents: claimed.length,
    nodes: nodes.length,
    edges: edges.length,
    unresolved:
      unresolvedSubjects.entity.length + unresolvedSubjects.triple.length,
  };
}

function subjectIds(
  claimed: readonly OutboxIntent[],
  kind: "entity" | "triple"
): string[] {
  return claimed
    .filter((intent) => intent.subject.kind === kind)
    .map((intent) => intent.subject.id);
}

/**
 * Name the intents whose subject the ledger no longer answers for — retired,
 * merged away, or (for a triple) hanging off a retired endpoint. They are
 * still marked done by the caller: there is nothing left to project and a
 * `failed` row would be a permanent red the queue can never clear. Return the
 * ids so the drain can garbage-collect their stale projection subjects.
 */
function reportUnresolved(
  deps: DrainDeps,
  claimed: readonly OutboxIntent[],
  resolved: { entity: Set<string>; triple: Set<string> }
): UnresolvedSubjects {
  const unresolved: UnresolvedSubjects = { entity: [], triple: [] };
  for (const intent of claimed) {
    if (resolved[intent.subject.kind].has(intent.subject.id)) continue;
    unresolved[intent.subject.kind].push(intent.subject.id);
    deps.logger.warn("graph-drain-subject-gone", {
      intentId: intent.id,
      kind: intent.subject.kind,
      subjectId: intent.subject.id,
    });
  }
  return unresolved;
}

/**
 * Roll the batch back. A failing ROLLBACK is logged, not thrown: the caller is
 * already carrying the error the operator needs to see, and replacing it with
 * a secondary one would hide why the drain stopped.
 */
async function rollbackQuietly(
  deps: DrainDeps,
  client: DrainClient
): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch (err) {
    // EXIT: 原始错误由调用方抛出，这里只补记二次失败
    deps.logger.error("graph-drain-rollback-failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Record the batch as failed AFTER the rollback, in its own statement, so the
 * `attempts` bump and `last_error` survive — inside the rolled-back
 * transaction they would vanish with it. Same reason as above for swallowing
 * only the secondary error.
 */
async function recordFailure(
  deps: DrainDeps,
  client: DrainClient,
  claimed: readonly OutboxIntent[],
  cause: unknown
): Promise<void> {
  if (claimed.length === 0) return;
  const message = cause instanceof Error ? cause.message : String(cause);
  try {
    await markIntentsFailed(
      client,
      claimed.map((intent) => intent.id),
      message
    );
  } catch (err) {
    // EXIT: 原始错误由调用方抛出，这里只补记二次失败
    deps.logger.error("graph-drain-mark-failed-failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Neo4j is configured but not answering. Report it in the Validation shape the
 * test rules use so an unattended run cannot be mistaken for a drained queue,
 * and exit 3 (re-run safe) rather than 1.
 */
function loudSkip(deps: DrainDeps, err: GraphUnavailableError): number {
  process.stderr.write(
    `\ngraph-drain: Neo4j unreachable at ${err.uri}\n` +
      "Validation:\n" +
      "- Not run: Neo4j projection (outbox drain)\n" +
      "- Expected command: npm run graph:drain\n" +
      `- Blocking issue: ${err.message}\n`
  );
  deps.logger.warn("graph-drain-skipped", {
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
      process.stderr.write(`graph-drain config error: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
  if (!dbUrl) {
    process.stderr.write(
      "graph-drain config error: GRAPHRAG_MEMORY_DB_URL is required\n"
    );
    return 1;
  }
  const pool = new Pool({ connectionString: dbUrl });
  try {
    return await runCli(argv, {
      pool: pool as unknown as DrainPool,
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
      `${NEO4J_URI_VAR} is required to drain the projection outbox; pass --dry-run or --retry-failed for a Postgres-only run`
    );
  }
  return connectNeo4j(config);
}

/** Top-level entry: wire real deps, exit with the CLI exit code. */
export async function main(): Promise<void> {
  const code = await runCliFromEnv(process.argv.slice(2));
  process.exit(code);
}

// Run only when invoked directly. Mirrors src/cli/graph-backfill.ts isMain.
const isMain = (() => {
  if (typeof process === "undefined") return false;
  const arg1 = process.argv[1];
  if (!arg1) return false;
  return (
    arg1.endsWith("cli/graph-drain.ts") || arg1.endsWith("cli/graph-drain.js")
  );
})();

if (isMain) {
  main().catch((err) => {
    process.stderr.write(
      `graph-drain fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`
    );
    process.exit(1);
  });
}
