/**
 * es-reindex CLI — wipe the derived ES chunk + entity indexes and re-project
 * them from the authoritative Postgres ledger (specs/es-precision-layer.md,
 * docs/runbooks/es-precision-layer.md).
 *
 * Postgres stays the only system of record. This CLI never writes PG; it
 * walks the live ledger in keyset-paginated scans and re-bulk-projects the
 * two derived indexes through `ElasticsearchPrecisionLayer`. Both indexes
 * are wiped once up front (`deleteChunkIndex` / `deleteEntityIndex`), then
 * each page is pushed with the plain `indexChunks` / `indexEntities`
 * upsert — a per-page rebuild (delete-then-index) would erase every
 * previously written page. The bulk path itself slices at
 * BULK_BATCH_SIZE (1000), so a 10k-row ledger is not a single in-memory
 * buffer.
 *
 * Modes (one per run):
 *   (default)     reindex — drop both derived indexes once, recreate both
 *                 from PG page by page. Idempotent: the upsert keys on the
 *                 ledger row id, so a re-run converges on the same shape.
 *   --dry-run     count rows the reindex would project, touch nothing on ES,
 *                 open no ES connection.
 *
 * Exit-code map:
 *   0 success — full reindex completed, or a --dry-run run.
 *   1 config / fatal — missing GRAPHRAG_MEMORY_DB_URL, Postgres unreachable,
 *     GRAPHRAG_MEMORY_ES_URL absent (reindex was asked but no target is
 *     configured), or any non-ES / non-PG throwable surfaced during the run.
 *   2 usage error (unknown / malformed flag).
 *
 * The CLI deliberately treats an unconfigured ES block as ConfigError, not
 * as a loud-skip: this tool was invoked specifically to push to ES, so
 * "no target configured" is an operator mistake. The skip-without-degraded
 * rule belongs to the retrieve arm (which treats unconfigured ES as
 * unattempted), not to a CLI whose job is the push.
 */
import { Pool } from "pg";

import {
  ConfigError,
  loadEnv,
  type ElasticsearchConfig,
  type GraphragEnv,
} from "../config.js";
import { createLogger, type Logger, writeStderr } from "../logging.js";
import {
  ElasticsearchPrecisionLayer,
  type EntityIndexRecord,
  type PrecisionIndexer,
} from "../core/storage/elasticsearch-precision.js";
import {
  ENTITY_PROJECTION_PAGE_SQL,
  projectEntityIndexRecords,
} from "../core/storage/entity-projection.js";
import type { ChunkRecord } from "../core/types.js";

export interface ReindexFlags {
  /** Ledger rows scanned per page; also the per-call slice handed to ES bulk. */
  batchSize: number;
  dryRun: boolean;
}

const DEFAULT_FLAGS: ReindexFlags = {
  batchSize: 500,
  dryRun: false,
};

const USAGE = `usage: es-reindex [--batch-size N] [--dry-run]`;
/**
 * Scan boundary emitted at the top of each keyset page. Sorts before every
 * v4 UUID, so it is the natural first cursor for both `chunks` (uuid) and
 * `entities` (uuid) sweeps.
 */
const SCAN_START = "00000000-0000-0000-0000-000000000000";

/**
 * The minimal query surface the reindex needs from a Postgres client. Both
 * `pg.PoolClient` and test fakes implement this; nothing else from the
 * backend leaks into the CLI.
 */
export interface ReindexClient {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
  release(): void;
}

export interface ReindexPool {
  connect(): Promise<ReindexClient>;
  end(): Promise<void>;
}

/**
 * The factory the CLI uses to open the precision-layer target. Production
 * injects a constructor that wires `ElasticsearchPrecisionLayer`; tests
 * inject a fake so no live cluster is needed. Throwing here is the same
 * fatal path the production code surfaces as exit 1.
 */
export type OpenIndexer = (
  env: GraphragEnv,
  es: ElasticsearchConfig
) => Promise<PrecisionIndexer>;

export interface ReindexDeps {
  pool: ReindexPool;
  logger: Logger;
  /**
   * Opens the precision-layer target. Throws ConfigError when the env has no
   * ES block (the reindex was asked for, no target is configured). Injected
   * so the CLI is testable without a live cluster.
   */
  openIndexer: OpenIndexer;
}

type ParsedArgs =
  { ok: true; flags: ReindexFlags } | { ok: false; error: string };

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: ReindexFlags = { ...DEFAULT_FLAGS };
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;
    if (arg === "--dry-run") flags.dryRun = true;
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
  return { ok: true, flags };
}

/** Top-level entry, testable: parse flags, route, map failures to exit codes. */
export async function runCli(
  argv: string[],
  deps: ReindexDeps,
  env: GraphragEnv
): Promise<number> {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    writeStderr(`${USAGE}\nes-reindex: ${parsed.error}\n`);
    return 2;
  }
  const client = await deps.pool.connect();
  try {
    if (parsed.flags.dryRun) {
      return await dryRun(deps, client, parsed.flags);
    }
    return await reindex(deps, client, env, parsed.flags);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    writeStderr(`es-reindex fatal: ${msg}\n`);
    deps.logger.error("es-reindex-fatal", { error: msg });
    return 1;
  } finally {
    client.release();
  }
}

/**
 * Scan both ledger tables in pages, accumulate nothing, count.
 * `--dry-run` never opens the ES client and never deletes an index, so an
 * operator can size the run before the destructive mode lands.
 */
async function dryRun(
  deps: ReindexDeps,
  client: ReindexClient,
  flags: ReindexFlags
): Promise<number> {
  const chunks = await eachChunkPage(client, flags.batchSize, async () => {});
  const entities = await eachEntityPage(
    client,
    flags.batchSize,
    async () => {}
  );
  deps.logger.info("es-reindex-plan", { chunks, entities });
  return 0;
}

/**
 * Default mode: open the precision layer, drop both derived indexes once,
 * then re-create them page by page from the live ledger sweep.
 *
 * The per-page call is `indexChunks`/`indexEntities` (pure upsert), NOT
 * `rebuildChunks`/`rebuildEntities` (delete-then-index): a rebuild per page
 * would make page 2's delete erase page 1's documents, leaving the index
 * with only the final page. The single pre-sweep delete keeps "drop +
 * recreate" semantics whole while every page accumulates.
 *
 * Chunk sweep runs before entity sweep: the CLI is a recovery tool, so
 * chunk freshness is the more common ask, and a chunk-only reindex remains
 * a sensible partial step if the entity sweep throws (the chunk index is
 * already whole).
 */
async function reindex(
  deps: ReindexDeps,
  client: ReindexClient,
  env: GraphragEnv,
  flags: ReindexFlags
): Promise<number> {
  let indexer: PrecisionIndexer | undefined;
  try {
    indexer = await deps.openIndexer(
      env,
      env.elasticsearch as ElasticsearchConfig
    );
    const target = indexer;
    // One wipe per index, before the sweep — never per page.
    await target.deleteChunkIndex();
    await target.deleteEntityIndex();
    const chunks = await eachChunkPage(
      client,
      flags.batchSize,
      async (rows) => {
        await target.indexChunks(rows);
      }
    );
    const entities = await eachEntityPage(
      client,
      flags.batchSize,
      async (rows) => {
        await target.indexEntities(rows);
      }
    );
    deps.logger.info("es-reindex-complete", {
      chunks,
      entities,
      batchSize: flags.batchSize,
    });
    return 0;
  } finally {
    if (indexer) await indexer.close();
  }
}

/**
 * Walk a keyset-paginated chunk sweep, handing each page to `onPage`.
 * Returns the total row count. Pages are never accumulated: an initial
 * reindex of a large ledger must not need the whole projection in memory.
 */
async function eachChunkPage(
  client: ReindexClient,
  batchSize: number,
  onPage: (rows: ChunkRecord[]) => Promise<void>
): Promise<number> {
  let after = SCAN_START;
  let total = 0;
  for (;;) {
    const { rows } = await client.query(
      `SELECT id, content, source_ref, metadata,
              valid_from, valid_until, created_at
         FROM chunks
        WHERE id > $1
        ORDER BY id
        LIMIT $2`,
      [after, batchSize]
    );
    const page = (rows as RawChunkRow[]).map(toChunkRecord);
    if (page.length === 0) return total;
    await onPage(page);
    total += page.length;
    after = page[page.length - 1]!.id;
    if (page.length < batchSize) return total;
  }
}

/**
 * Walk a keyset-paginated entity + alias sweep, handing each page to
 * `onPage`. The ledger's `entities.canonical_name` plus the joined rows
 * from `entity_aliases` form the alias set the precision layer indexes;
 * retired rows are excluded up-front, mirroring the graph backfill's live
 * rule (so an ES query that resolves to a canonical name still maps to a
 * live row in PG, not a tombstone).
 *
 * T5 makes the projection a shared helper (`entity-projection.ts`); this
 * function is now a thin scan loop that drives the same SQL the extract
 * pipeline uses per-chunk, so the two paths cannot disagree on what a
 * "live entity + all aliases" projection means.
 */
async function eachEntityPage(
  client: ReindexClient,
  batchSize: number,
  onPage: (rows: EntityIndexRecord[]) => Promise<void>
): Promise<number> {
  let after = SCAN_START;
  let total = 0;
  for (;;) {
    const { rows } = await client.query(ENTITY_PROJECTION_PAGE_SQL, [
      after,
      batchSize,
    ]);
    const page = projectEntityIndexRecords(rows as RawEntityRow[]);
    if (page.length === 0) return total;
    await onPage(page);
    total += page.length;
    after = page[page.length - 1]!.id;
    if (page.length < batchSize) return total;
  }
}

/** Wire real deps from env and run; used by main(). */
export async function runCliFromEnv(argv: string[]): Promise<number> {
  let env: GraphragEnv;
  try {
    env = loadEnv();
  } catch (err) {
    if (err instanceof ConfigError) {
      writeStderr(`es-reindex config error: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
  if (env.dbUrl === undefined) {
    writeStderr(
      "es-reindex config error: GRAPHRAG_MEMORY_DB_URL is required\n"
    );
    return 1;
  }
  if (env.elasticsearch === undefined) {
    writeStderr(
      "es-reindex config error: GRAPHRAG_MEMORY_ES_URL is required to rebuild the precision layer; pass --dry-run for a Postgres-only scan\n"
    );
    return 1;
  }
  const logger = createLogger(env.logLevel);
  const pool = new Pool({ connectionString: env.dbUrl });
  try {
    return await runCli(
      argv,
      {
        pool: pool as unknown as ReindexPool,
        logger,
        openIndexer: openIndexerFromEnv,
      },
      env
    );
  } finally {
    await pool.end();
  }
}

/** Default `openIndexer` for production. */
async function openIndexerFromEnv(
  _env: GraphragEnv,
  es: ElasticsearchConfig
): Promise<PrecisionIndexer> {
  return new ElasticsearchPrecisionLayer(es);
}

/** Top-level entry: wire real deps, exit with the CLI exit code. */
export async function main(): Promise<void> {
  const code = await runCliFromEnv(process.argv.slice(2));
  process.exit(code);
}

interface RawChunkRow {
  id: string;
  content: string;
  source_ref: string;
  metadata: Record<string, unknown>;
  valid_from: Date | string;
  valid_until: Date | string | null;
  created_at: Date | string;
}

/**
 * Postgres returns `jsonb` as an already-parsed object and `timestamptz` as a
 * `Date`. The precision layer expects ISO strings + a plain `Record<string,
 * unknown>` for metadata, so this module owns the shape translation — the
 * caller never has to think about driver serialization.
 */
function toChunkRecord(row: RawChunkRow): ChunkRecord {
  return {
    id: row.id,
    content: row.content,
    // ChunkRecord requires an embedding column, but the precision layer
    // never reads it. The 1-element placeholder keeps the contract honest
    // and makes accidental downstream use observable in tests.
    embedding: [0],
    source_ref: row.source_ref,
    metadata: row.metadata ?? {},
    valid_from: toIso(row.valid_from),
    valid_until: row.valid_until === null ? null : toIso(row.valid_until),
    created_at: toIso(row.created_at),
  };
}

interface RawEntityRow {
  id: string;
  canonical_name: string;
  type: string;
  retired: boolean;
  aliases: string[];
}

function toIso(value: Date | string): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

// Run only when invoked directly. Mirrors src/cli/graph-backfill.ts isMain.
const isMain = (() => {
  if (typeof process === "undefined") return false;
  const arg1 = process.argv[1];
  if (!arg1) return false;
  return (
    arg1.endsWith("cli/es-reindex.ts") || arg1.endsWith("cli/es-reindex.js")
  );
})();

if (isMain) {
  main().catch((err) => {
    writeStderr(
      `es-reindex fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`
    );
    process.exit(1);
  });
}
