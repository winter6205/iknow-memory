/**
 * Extraction CLI — offline trigger for the LLM triple-extraction + merge
 * pipeline (T6).
 *
 * Thin shell by design: flags / IO / exit codes / deps assembly live here;
 * the scan → batch → per-chunk-transaction persist orchestration is the
 * lifted core pipeline in `src/core/extraction/pipeline.ts` +
 * `src/core/extraction/persist.ts`, shared with the MCP extract tool (the
 * server never imports `src/cli`). This file owns NO second persist
 * implementation.
 *
 * Pipeline: scan `chunks` with no `succeeded` extraction_records row → batch →
 * per-chunk transaction (record + entities + triples) → out.
 *
 * Exit-code map (spec's "exit codes 0/1/2" contract):
 *   0 success — incl. `--dry-run`, `--list-unmapped`, `--list-failed`,
 *     `--backfill-embeddings`, and mark-and-continue batches where SOME
 *     chunks failed extraction (Success Criterion #6).
 *   1 config / fatal — bad DB URL, Postgres unreachable, ConfigError.
 *   2 usage error (unknown / malformed / mutually exclusive flags) OR a
 *     write-partial-failure (a chunk's transaction rolled back — distinct
 *     from the expected per-chunk extraction failures mark-and-continue
 *     absorbs).
 *
 * LLM / embedder credentials: built via `src/core/extraction/clients.ts`
 * (`buildLlmClient` / `buildEmbedderClient`), which carries the CR High #1 /
 * #3 guards — a real extraction with no ANTHROPIC_AUTH_TOKEN and any
 * vector-persisting run without embedding credentials throw ConfigError
 * (exit 1) instead of silently writing canned triples / fake vectors. The
 * keyless fakes are legal only for the non-persisting flags `--dry-run`,
 * `--list-unmapped` and `--list-failed`.
 */
import { Pool } from "pg";

import { loadEnv, ConfigError, type GraphragEnv } from "../config.js";
import { createLogger, writeStderr, type Logger } from "../logging.js";
import { ElasticsearchPrecisionLayer } from "../core/storage/elasticsearch-precision.js";
import { upSchemaBootstrap } from "../core/storage/schema-bootstrap.js";
import { listFailed } from "../core/extraction/records.js";
import type { ChunkInput } from "../core/extraction/extract.js";
import { runExtractMethod } from "../core/extraction/method.js";
import {
  selectPendingChunks,
  selectPendingChunksBySourceRef,
  processBatch,
} from "../core/extraction/pipeline.js";
import { embedEntity, toVectorLiteral } from "../core/extraction/persist.js";
import {
  buildLlmClient,
  buildEmbedderClient,
} from "../core/extraction/clients.js";
import type { LLMClient } from "../core/extraction/llm-client.js";
import type { EmbeddingClient } from "../core/embedder.js";
import { EXTRACT_METHODS, type ExtractMethod } from "../core/types.js";

export interface CliFlags {
  batchSize: number;
  dryRun: boolean;
  since: string | null;
  onlyFailed: boolean;
  listUnmapped: boolean;
  listFailed: boolean;
  /** `--list-failed` batch filter; null means "every batch". */
  batchId: string | null;
  /**
   * T1 version spine: `--method standard|fast`. null = flag absent, which
   * the pipeline reads as its "standard" default (spec SC3: the default job
   * is standard; Fast never runs unasked).
   */
  method: ExtractMethod | null;
  /** `--source-ref REF`: extract that 资料's pending chunks instead of the global scan. */
  sourceRef: string | null;
  /** A9 repair mode; never set by a normal extraction run. */
  backfillEmbeddings: boolean;
}

const DEFAULT_FLAGS: CliFlags = {
  batchSize: 64,
  dryRun: false,
  since: null,
  onlyFailed: false,
  listUnmapped: false,
  listFailed: false,
  batchId: null,
  method: null,
  sourceRef: null,
  backfillEmbeddings: false,
};

const USAGE = `usage: extract [--batch-size N] [--dry-run] [--since ISO8601] [--only-failed] [--method standard|fast] [--source-ref REF] [--list-unmapped] [--list-failed [--batch-id UUID]] [--backfill-embeddings]`;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Minimal client surface accepted by both pg.PoolClient and test fakes. */
export interface CliClient {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
  release(): void;
}

/** Minimal pool: one leased connection per run + shutdown. */
export interface CliPool {
  connect(): Promise<CliClient>;
  end(): Promise<void>;
}

export interface CliDeps {
  pool: CliPool;
  llm: LLMClient;
  embedder: EmbeddingClient;
  dims: number;
  logger: Logger;
  /** Injectable clock for deterministic started_at in tests. */
  now?: () => string;
  /**
   * Optional ES derived-index writer. Mirrors the `push` tool pattern
   * (src/tools/push.ts): authority writes always win, ES write failures
   * log `keyword_bm25:attempted-and-failed` and never abort the chunk
   * transaction. Absent when no precision layer is configured.
   */
  precision?: import("../core/storage/elasticsearch-precision.js").PrecisionIndexer;
  /**
   * T4 write-time supersede switch. Forwarded to the persist half so a
   * contradicting older row is retired in the same per-chunk transaction
   * instead of accumulating until an offline consolidate `--apply`.
   * The wiring (`runCliFromEnv`) reads `env.extractWriteTimeSupersede`,
   * which is ON by default per ADR-0009 with an explicit off as the
   * escape hatch; an omitted value (test injection) keeps the pre-T4
   * merge-on-overlap shape.
   */
  writeTimeSupersede?: boolean;
}

type ParsedArgs = { ok: true; flags: CliFlags } | { ok: false; error: string };

/**
 * Parse CLI flags manually (no new dep). Value flags fail fast on a missing /
 * non-parseable value; unknown flags surface a usage error (exit 2).
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const flags: CliFlags = { ...DEFAULT_FLAGS };
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;
    if (arg === "--dry-run") flags.dryRun = true;
    else if (arg === "--only-failed") flags.onlyFailed = true;
    else if (arg === "--list-unmapped") flags.listUnmapped = true;
    else if (arg === "--list-failed") flags.listFailed = true;
    else if (arg === "--backfill-embeddings") flags.backfillEmbeddings = true;
    else if (arg === "--batch-id") {
      // Validated here so a malformed value is a usage error (exit 2) rather
      // than a Postgres `invalid input syntax for type uuid` fatal (exit 1).
      const raw = argv[i + 1];
      if (raw === undefined || !UUID_RE.test(raw)) {
        return { ok: false, error: `--batch-id requires a UUID` };
      }
      flags.batchId = raw;
      i += 1;
    } else if (arg === "--batch-size") {
      const n = Number(argv[i + 1]);
      if (!Number.isInteger(n) || n <= 0) {
        return { ok: false, error: `--batch-size requires a positive integer` };
      }
      flags.batchSize = n;
      i += 1;
    } else if (arg === "--since") {
      const raw = argv[i + 1];
      if (raw === undefined || Number.isNaN(Date.parse(raw))) {
        return { ok: false, error: `--since requires an ISO8601 timestamp` };
      }
      flags.since = raw;
      i += 1;
    } else if (arg === "--method") {
      // Validated against the shared vocabulary here so a typo is a usage
      // error (exit 2), not a fatal at the dispatch seam.
      const raw = argv[i + 1];
      if (
        raw === undefined ||
        !(EXTRACT_METHODS as readonly string[]).includes(raw)
      ) {
        return {
          ok: false,
          error: `--method requires ${EXTRACT_METHODS.join(" or ")}`,
        };
      }
      flags.method = raw as ExtractMethod;
      i += 1;
    } else if (arg === "--source-ref") {
      const raw = argv[i + 1];
      if (raw === undefined || raw.length === 0) {
        return { ok: false, error: `--source-ref requires a non-empty value` };
      }
      flags.sourceRef = raw;
      i += 1;
    } else {
      return { ok: false, error: `unknown flag: "${arg}"` };
    }
    i += 1;
  }
  const conflict = flagConflict(flags);
  if (conflict) return { ok: false, error: conflict };
  return { ok: true, flags };
}

/**
 * The flag combinations `runCli`'s routing cannot honour, named as usage
 * errors (exit 2) instead of silently resolved by routing order.
 *
 * `runCli` picks ONE mode per run in a fixed if-chain, so a second mode flag
 * is not "also applied", it is dropped. `--dry-run --backfill-embeddings` was
 * the load-bearing case: backfill is routed before the dry-run branch, so the
 * pair ran the repair mode's UPDATEs under a flag whose whole contract is
 * "writes nothing".
 */
function flagConflict(flags: CliFlags): string | null {
  const modes: Array<[string, boolean]> = [
    ["--list-unmapped", flags.listUnmapped],
    ["--list-failed", flags.listFailed],
    ["--backfill-embeddings", flags.backfillEmbeddings],
  ];
  const selected = modes.filter(([, on]) => on).map(([name]) => name);
  if (selected.length > 1) {
    return `${selected[0]} and ${selected[1]} are mutually exclusive`;
  }
  if (flags.dryRun && flags.backfillEmbeddings) {
    return `--dry-run and --backfill-embeddings are mutually exclusive`;
  }
  // `--batch-id` only filters the `--list-failed` report; accepting it on any
  // other path would silently ignore it instead of naming the mistake.
  if (flags.batchId !== null && !flags.listFailed) {
    return `--batch-id is only valid with --list-failed`;
  }
  // T1: `--method` and `--source-ref` steer the extraction run only; on a
  // report/repair mode both would be silently dropped, so name the mistake
  // (same doctrine as --batch-id above).
  if (selected.length === 1) {
    if (flags.method !== null)
      return `--method is only valid for extraction runs, not with ${selected[0]}`;
    if (flags.sourceRef !== null)
      return `--source-ref is only valid for extraction runs, not with ${selected[0]}`;
  }
  // The source_ref selector has its own scan; --since/--only-failed filter
  // the global pending scan and would be silently ignored if combined.
  if (flags.sourceRef !== null && flags.since !== null) {
    return `--source-ref and --since are mutually exclusive`;
  }
  if (flags.sourceRef !== null && flags.onlyFailed) {
    return `--source-ref and --only-failed are mutually exclusive`;
  }
  return null;
}

/** Top-level entry, testable: parse flags, route, map results to exit codes. */
export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    writeStderr(`${USAGE}\nextract: ${parsed.error}\n`);
    return 2;
  }
  try {
    if (parsed.flags.listUnmapped) return await listUnmapped(deps);
    if (parsed.flags.listFailed) {
      return await listFailedReport(deps, parsed.flags);
    }
    if (parsed.flags.backfillEmbeddings) {
      return await backfillEmbeddings(deps);
    }
    return await runPipeline(deps, parsed.flags);
  } catch (err) {
    reportFatal(deps.logger, err);
    return 1;
  }
}

function reportFatal(logger: Logger, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  writeStderr(`extract fatal: ${msg}\n`);
  logger.error("extract-fatal", { error: msg });
}

/**
 * Execute the scan → batch → per-chunk-transaction write pipeline by
 * delegating to the lifted core module (`src/core/extraction/pipeline.ts`):
 * this file contributes the connection, the schema bootstrap, the CLI flag
 * mapping and the exit code — not a second persist implementation.
 */
async function runPipeline(deps: CliDeps, flags: CliFlags): Promise<number> {
  const client = await deps.pool.connect();
  // null method = --method absent = the pipeline's standard default (SC3).
  const method = flags.method;
  try {
    await upSchemaBootstrap(client, deps.dims);
    const chunks =
      flags.sourceRef !== null
        ? (
            await selectPendingChunksBySourceRef(
              client,
              flags.sourceRef,
              flags.batchSize
            )
          ).chunks
        : await selectPendingChunks(client, {
            batchSize: flags.batchSize,
            since: flags.since,
            onlyFailed: flags.onlyFailed,
          });
    if (flags.dryRun) {
      await dryRunPlan(deps, chunks, method);
      return 0;
    }
    const summary = await processBatch(deps, client, chunks, {
      batchSize: flags.batchSize,
      ...(method !== null ? { method } : {}),
    });
    return summary.writeFailures > 0 ? 2 : 0;
  } finally {
    client.release();
  }
}

/** `--list-unmapped`: report relation_raw buckets, no LLM, no extraction. */
async function listUnmapped(deps: CliDeps): Promise<number> {
  const client = await deps.pool.connect();
  try {
    await upSchemaBootstrap(client, deps.dims);
    const { rows } = await client.query(
      `SELECT relation_raw, count(*)::int AS count
       FROM triples WHERE relation_norm = 'UNMAPPED'
       GROUP BY relation_raw ORDER BY count DESC`,
      []
    );
    if (rows.length === 0) deps.logger.info("no-unmapped-relations");
    for (const r of rows) {
      deps.logger.info("unmapped", {
        relation_raw: r.relation_raw,
        count: r.count,
      });
    }
    return 0;
  } finally {
    client.release();
  }
}

/**
 * `--list-failed` (A15): report failed `extraction_records` rows, no LLM,
 * no extraction, no writes. `--batch-id` narrows the report to one batch.
 *
 * `listFailed()` returns its rows `created_at`-ascending; A15 asks for
 * newest-first and `records.ts` is not this flag's surface, so the ordering
 * flip is applied here on the already-bounded failed-row set.
 */
async function listFailedReport(
  deps: CliDeps,
  flags: CliFlags
): Promise<number> {
  const client = await deps.pool.connect();
  try {
    await upSchemaBootstrap(client, deps.dims);
    const rows = await listFailed(
      client,
      flags.batchId ? { batchId: flags.batchId } : {}
    );
    if (rows.length === 0) {
      deps.logger.info("no-failed-records", { batchId: flags.batchId });
      return 0;
    }
    for (const r of [...rows].reverse()) {
      deps.logger.info("failed-record", {
        chunk_id: r.chunk_id ?? null,
        batch_id: r.batch_id ?? null,
        error_code: r.error_code ?? null,
        error_msg: r.error_msg ?? null,
        created_at: r.created_at ?? null,
      });
    }
    return 0;
  } finally {
    client.release();
  }
}

/**
 * `--backfill-embeddings` (A9): the idempotent NULL-embedding repair mode.
 * Every live entity whose `embedding` is NULL is embedded from its stored
 * `metadata.description` (empty string when the key is absent) through the
 * same `computeEntityEmbeddingText` SSOT the insert path uses, then UPDATEd.
 *
 * Its own flag, never a step of a normal extraction run: no chunk scan, no
 * LLM call, no extraction record — the UPDATE below is the only write.
 *
 * Idempotency is observable in the run output: an immediate second run scans
 * 0 rows and reports `backfilled: 0`. Each row is its own auto-committed
 * UPDATE instead of one batch transaction, so an interrupted repair keeps
 * the rows it already filled and a re-run picks up the remainder.
 */
async function backfillEmbeddings(deps: CliDeps): Promise<number> {
  const client = await deps.pool.connect();
  try {
    await upSchemaBootstrap(client, deps.dims);
    const { rows } = await client.query(
      `SELECT id, canonical_name,
              coalesce(metadata->>'description', '') AS description
         FROM entities
        WHERE retired = false AND embedding IS NULL
        ORDER BY created_at`,
      []
    );
    let backfilled = 0;
    for (const row of rows) {
      backfilled += await backfillOne(deps, client, row);
    }
    deps.logger.info("backfill-embeddings-complete", {
      scanned: rows.length,
      backfilled,
    });
    return 0;
  } finally {
    client.release();
  }
}

/**
 * Embed and UPDATE one scanned row; returns how many rows the UPDATE actually
 * changed, which is what the run reports. The `embedding IS NULL` guard is
 * repeated in the WHERE clause so a vector some other writer stored between
 * the scan and this UPDATE survives (A8 first-write-wins) and is counted as
 * not backfilled rather than silently overwritten.
 */
async function backfillOne(
  deps: CliDeps,
  client: CliClient,
  row: { id: string; canonical_name: string; description: string | null }
): Promise<number> {
  const embedding = await embedEntity(deps, {
    canonicalName: row.canonical_name,
    description: row.description ?? "",
  });
  const { rows } = await client.query(
    `UPDATE entities SET embedding = $2::vector
      WHERE id = $1 AND embedding IS NULL
      RETURNING id`,
    [row.id, toVectorLiteral(embedding)]
  );
  return rows.length;
}

/** Dry-run: simulate extraction, print what would happen, write no rows. */
async function dryRunPlan(
  deps: CliDeps,
  chunks: ChunkInput[],
  method: ExtractMethod | null
): Promise<void> {
  deps.logger.info("dry-run-plan", { chunks: chunks.length });
  for (const chunk of chunks) {
    // Same dispatch seam as the real batch: a dry run must show the outcome
    // the requested method would produce (incl. the sealed fast leg), not a
    // standard-only preview that could promise a run the seam would refuse.
    const outcome = await runExtractMethod(method ?? "standard", chunk, {
      llm: deps.llm,
    });
    if (outcome.kind === "failed") {
      deps.logger.info("dry-run-chunk-would-fail", {
        chunkId: chunk.id,
        code: outcome.errorCode,
      });
      continue;
    }
    const unmapped = outcome.outputs.filter(
      (o) => o.relationNorm === "UNMAPPED"
    ).length;
    deps.logger.info("dry-run-chunk-would-write", {
      chunkId: chunk.id,
      triples: outcome.outputs.length,
      unmapped,
    });
  }
}

/**
 * True when the invocation runs the LLM extraction write path. Anything else
 * (`--dry-run`, `--list-unmapped`, `--list-failed`, `--backfill-embeddings`)
 * makes no use of LLM output, so keyless operation may fall back to the
 * scripted fake (`buildLlmClient`'s guard).
 */
function isRealExtraction(flags: CliFlags): boolean {
  return !(
    flags.dryRun ||
    flags.listUnmapped ||
    flags.listFailed ||
    flags.backfillEmbeddings
  );
}

/** True when the invocation writes a vector into `entities.embedding`. */
function persistsEmbeddings(flags: CliFlags): boolean {
  if (flags.backfillEmbeddings) return true;
  return !(flags.dryRun || flags.listUnmapped || flags.listFailed);
}

/**
 * Assemble the CLI's dependency bundle from the validated env.
 *
 * Split out of `runCliFromEnv` the same way `src/index.ts` splits
 * `buildStorage` / `buildEmbedder` / `buildPrecision` out of `buildDeps`, so
 * the entry point carries only the one branch pair that decides which client
 * each credential guard builds. The ES precision layer stays there — its
 * `close()` shares the pool's `finally`.
 *
 * The credential guards (`buildLlmClient` / `buildEmbedderClient`) still run
 * inside this call, so the caller keeps them within its ConfigError → exit 1
 * mapping. Optional pieces keep the `...(cond ? {k: v} : {})` form so an
 * unconfigured one leaves its key absent — the shape the inline literal had.
 */
function buildCliDeps(
  env: GraphragEnv,
  pool: CliPool,
  precision: CliDeps["precision"],
  flags: CliFlags
): CliDeps {
  return {
    pool,
    llm: buildLlmClient(
      {
        authToken: process.env.ANTHROPIC_AUTH_TOKEN,
        baseUrl: process.env.GRAPHRAG_MEMORY_ANTHROPIC_BASE_URL,
        model: process.env.GRAPHRAG_MEMORY_ANTHROPIC_MODEL,
      },
      { extraction: isRealExtraction(flags) }
    ),
    embedder: buildEmbedderClient(
      {
        apiKey: env.embedApiKey,
        baseUrl: env.embedBaseUrl,
        model: env.embedModel,
        dimensions: env.embedDimensions,
      },
      { persistsEmbeddings: persistsEmbeddings(flags) }
    ),
    dims: env.embedDimensions,
    logger: createLogger(env.logLevel),
    ...(precision !== undefined ? { precision } : {}),
    writeTimeSupersede: env.extractWriteTimeSupersede,
  };
}

/** Wire real deps from env and run; used by main(). */
export async function runCliFromEnv(argv: string[]): Promise<number> {
  let env: GraphragEnv;
  try {
    env = loadEnv();
  } catch (err) {
    if (err instanceof ConfigError) {
      writeStderr(`extract config error: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
  if (!env.dbUrl) {
    writeStderr("extract config error: GRAPHRAG_MEMORY_DB_URL is required\n");
    return 1;
  }
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    writeStderr(`${USAGE}\nextract: ${parsed.error}\n`);
    return 2;
  }
  const pool = new Pool({ connectionString: env.dbUrl });
  // Mirror the server wiring (src/index.ts buildDeps): the ES precision
  // layer is built when the env block is configured (k1/b from env.retrieval)
  // and stays undefined otherwise — a silent no-op for every precision call
  // in the pipeline, matching the MCP push/ingest path. Without this, the
  // extract CLI's entity projection was unreachable in production and the
  // entity index could only be repaired by a manual `npm run es:reindex`.
  const precision =
    env.elasticsearch === undefined
      ? undefined
      : new ElasticsearchPrecisionLayer(env.elasticsearch, {
          k1: env.retrieval.k1,
          b: env.retrieval.b,
        });
  try {
    // The credential guards run inside `buildCliDeps` (hence inside this
    // try): a ConfigError here is the typed "refusing to persist without
    // credentials" failure mapped to exit 1 below — never a silent fake
    // fallback on a persisting path (CR High #1 / #3).
    return await runCli(argv, buildCliDeps(env, pool, precision, parsed.flags));
  } catch (err) {
    if (err instanceof ConfigError) {
      writeStderr(`extract config error: ${err.message}\n`);
      return 1;
    }
    throw err;
  } finally {
    await pool.end();
    if (precision !== undefined) await precision.close();
  }
}

/** Top-level entry: wire real deps, exit with the CLI exit code. */
export async function main(): Promise<void> {
  const code = await runCliFromEnv(process.argv.slice(2));
  process.exit(code);
}

// Run only when invoked directly. Mirrors src/index.ts isMain.
const isMain = (() => {
  if (typeof process === "undefined") return false;
  const arg1 = process.argv[1];
  if (!arg1) return false;
  return arg1.endsWith("cli/extract.ts") || arg1.endsWith("cli/extract.js");
})();

if (isMain) {
  main().catch((err) => {
    writeStderr(
      `extract fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`
    );
    process.exit(1);
  });
}
