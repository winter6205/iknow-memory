/**
 * Fact consolidation CLI.
 *
 * The default is a read-only dry-run. It identifies overlapping facts that
 * share a head and relation but disagree on the tail, then reports the
 * newest fact as the proposed replacement. `--apply` writes the
 * `superseded_by` pointer, closes the old validity window, and queues a
 * projection refresh for the changed edge.
 */
import { Pool } from "pg";

import { ConfigError, loadEnv } from "../config.js";
import { createLogger, type Logger } from "../logging.js";
import {
  findSupersessionCandidates,
  type FactRow,
  type SupersessionCandidate,
} from "../core/extraction/supersession.js";
import { emitProjectionIntents } from "../core/storage/projection-outbox.js";

export interface ConsolidateFlags {
  dryRun: boolean;
  apply: boolean;
}

const DEFAULT_FLAGS: ConsolidateFlags = { dryRun: true, apply: false };
const USAGE = "usage: consolidate [--dry-run | --apply]";

export interface ConsolidateClient {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
  release(): void;
}

export interface ConsolidatePool {
  connect(): Promise<ConsolidateClient>;
  end(): Promise<void>;
}

export interface ConsolidateDeps {
  pool: ConsolidatePool;
  logger: Logger;
  now?: () => string;
}

type ParsedArgs =
  { ok: true; flags: ConsolidateFlags } | { ok: false; error: string };

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: ConsolidateFlags = { ...DEFAULT_FLAGS };
  for (const arg of argv) {
    if (arg === "--dry-run") flags.dryRun = true;
    else if (arg === "--apply") {
      flags.apply = true;
      flags.dryRun = false;
    } else {
      return { ok: false, error: `unknown flag: "${arg}"` };
    }
  }
  if (argv.includes("--dry-run") && argv.includes("--apply")) {
    return {
      ok: false,
      error: "--dry-run and --apply are mutually exclusive",
    };
  }
  return { ok: true, flags };
}

export async function runCli(
  argv: string[],
  deps: ConsolidateDeps
): Promise<number> {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    process.stderr.write(`${USAGE}\nconsolidate: ${parsed.error}\n`);
    return 2;
  }

  const client = await deps.pool.connect();
  try {
    const candidates = await loadCandidates(client);
    if (parsed.flags.dryRun) {
      reportPlan(deps.logger, candidates);
      return 0;
    }
    await applyCandidates(
      client,
      candidates,
      deps.now ? deps.now() : new Date().toISOString(),
      deps.logger
    );
    deps.logger.info("consolidate-applied", { candidates: candidates.length });
    return 0;
  } catch (err) {
    reportFatal(deps.logger, err);
    return 1;
  } finally {
    client.release();
  }
}

async function loadCandidates(
  client: ConsolidateClient
): Promise<SupersessionCandidate[]> {
  const { rows } = await client.query(
    `SELECT id, head_id, tail_id, relation_norm, confidence,
            lower(valid_window) AS valid_from,
            upper(valid_window) AS valid_until,
            created_at, superseded_by
       FROM triples
      WHERE superseded_by IS NULL
      ORDER BY head_id, relation_norm, created_at DESC, id DESC`,
    []
  );
  return findSupersessionCandidates(rows as FactRow[]);
}

function reportPlan(
  logger: Logger,
  candidates: readonly SupersessionCandidate[]
): void {
  logger.info("consolidate-plan", { candidates: candidates.length });
  for (const candidate of candidates) {
    logger.info("supersession-candidate", {
      superseded: candidate.superseded.id,
      replacement: candidate.replacement.id,
      relation_norm: candidate.superseded.relation_norm,
    });
  }
}

async function applyCandidates(
  client: ConsolidateClient,
  candidates: readonly SupersessionCandidate[],
  closedAt: string,
  logger: Logger
): Promise<void> {
  await client.query("BEGIN");
  try {
    for (const candidate of candidates) {
      const { rows } = await client.query(
        `UPDATE triples
            SET superseded_by = $2,
                valid_window = tstzrange(
                  lower(valid_window),
                  LEAST(
                    COALESCE(upper(valid_window), $3::timestamptz),
                    $3::timestamptz
                  ),
                  '[)'
                )
          WHERE id = $1
            AND superseded_by IS NULL
            AND lower(valid_window) < $3::timestamptz
          RETURNING id`,
        [candidate.superseded.id, candidate.replacement.id, closedAt]
      );
      if (rows.length === 0) continue;
      await emitProjectionIntents(client, [
        { kind: "triple", id: candidate.superseded.id },
      ]);
    }
    await client.query("COMMIT");
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      logger.error("consolidate-rollback-failed", {
        error:
          rollbackErr instanceof Error
            ? rollbackErr.message
            : String(rollbackErr),
      });
    }
    throw err;
  }
}

function reportFatal(logger: Logger, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`consolidate fatal: ${message}\n`);
  logger.error("consolidate-fatal", { error: message });
}

export async function runCliFromEnv(argv: string[]): Promise<number> {
  let env;
  try {
    env = loadEnv();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`consolidate config error: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
  if (!env.dbUrl) {
    process.stderr.write(
      "consolidate config error: GRAPHRAG_MEMORY_DB_URL is required\n"
    );
    return 1;
  }

  const pool = new Pool({ connectionString: env.dbUrl });
  try {
    return await runCli(argv, {
      pool: pool as unknown as ConsolidatePool,
      logger: createLogger(env.logLevel),
    });
  } finally {
    await pool.end();
  }
}

export async function main(): Promise<void> {
  process.exit(await runCliFromEnv(process.argv.slice(2)));
}

const isMain = (() => {
  const arg1 = process.argv[1];
  return (
    typeof arg1 === "string" &&
    (arg1.endsWith("cli/consolidate.ts") || arg1.endsWith("cli/consolidate.js"))
  );
})();

if (isMain) {
  main().catch((err) => {
    process.stderr.write(
      `consolidate fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`
    );
    process.exit(1);
  });
}
