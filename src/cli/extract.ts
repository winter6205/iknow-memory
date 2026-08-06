/**
 * Extraction CLI — offline trigger for the LLM triple-extraction + merge
 * pipeline (T6). Never an MCP tool: the server stays ingest+retrieve only.
 *
 * Pipeline: scan `chunks` with no `succeeded` extraction_records row → batch →
 * per-chunk transaction (record + entities + triples) → out.
 *
 * Exit-code map (spec's "exit codes 0/1/2" contract):
 *   0 success — incl. `--dry-run`, `--list-unmapped`, and mark-and-continue
 *     batches where SOME chunks failed extraction (Success Criterion #6).
 *   1 config / fatal — bad DB URL, Postgres unreachable, ConfigError.
 *   2 usage error (unknown/malformed flag) OR a write-partial-failure (a
 *     chunk's transaction rolled back — distinct from the expected per-chunk
 *     extraction failures mark-and-continue absorbs).
 *
 * LLM client: `AnthropicLLMClient` when GRAPHRAG_MEMORY_ANTHROPIC_API_KEY is
 * set, else `FakeLLMClient` (canned ok) so `--dry-run` and CI run keyless.
 */
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";

import { loadEnv, ConfigError, type GraphragEnv } from "../config.js";
import { createLogger, type Logger } from "../logging.js";
import { upSchemaP0 } from "../core/storage/schema-p0.js";
import { extractChunk, type ChunkInput } from "../core/extraction/extract.js";
import type { ExtractionOutput } from "../core/extraction/types.js";
import {
  AnthropicLLMClient,
  FakeLLMClient,
  type LLMClient,
} from "../core/extraction/llm-client.js";
import { upsertTriple } from "../core/extraction/dedup.js";
import {
  insertRecord,
  markSucceeded,
  markFailed,
  newRecordId,
  type Queryable,
} from "../core/extraction/records.js";
import {
  mergeEntitiesWithGating,
  type CandidateEntity,
  type IncomingEntity,
} from "../core/entities/merge.js";
import {
  FakeEmbedder,
  NineRouterEmbedder,
  type EmbeddingClient,
} from "../core/embedder.js";

export interface CliFlags {
  batchSize: number;
  dryRun: boolean;
  since: string | null;
  onlyFailed: boolean;
  listUnmapped: boolean;
}

const DEFAULT_FLAGS: CliFlags = {
  batchSize: 64,
  dryRun: false,
  since: null,
  onlyFailed: false,
  listUnmapped: false,
};

const USAGE = `usage: extract [--batch-size N] [--dry-run] [--since ISO8601] [--only-failed] [--list-unmapped]`;

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
    else if (arg === "--batch-size") {
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
    } else {
      return { ok: false, error: `unknown flag: "${arg}"` };
    }
    i += 1;
  }
  return { ok: true, flags };
}

/** Top-level entry, testable: parse flags, route, map results to exit codes. */
export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    process.stderr.write(`${USAGE}\nextract: ${parsed.error}\n`);
    return 2;
  }
  try {
    if (parsed.flags.listUnmapped) return await listUnmapped(deps);
    return await runPipeline(deps, parsed.flags);
  } catch (err) {
    reportFatal(deps.logger, err);
    return 1;
  }
}

function reportFatal(logger: Logger, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`extract fatal: ${msg}\n`);
  logger.error("extract-fatal", { error: msg });
}

/** Execute the scan → batch → per-chunk-transaction write pipeline. */
async function runPipeline(deps: CliDeps, flags: CliFlags): Promise<number> {
  const client = await deps.pool.connect();
  try {
    await upSchemaP0(client as unknown as PoolClient, deps.dims);
    const chunks = await scanChunks(client, flags);
    if (flags.dryRun) {
      await dryRunPlan(deps, chunks);
      return 0;
    }
    const summary = await processBatch(deps, client, flags, chunks);
    return summary.writeFailures > 0 ? 2 : 0;
  } finally {
    client.release();
  }
}

async function scanChunks(
  client: Queryable,
  flags: CliFlags
): Promise<ChunkInput[]> {
  const where: string[] = [
    `NOT EXISTS (SELECT 1 FROM extraction_records r WHERE r.chunk_id = c.id AND r.status = 'succeeded')`,
  ];
  const values: unknown[] = [];
  if (flags.since) {
    values.push(flags.since);
    where.push(`c.created_at >= $${values.length}`);
  }
  if (flags.onlyFailed) {
    where.push(
      `c.id IN (SELECT chunk_id FROM (
         SELECT chunk_id, status,
           row_number() OVER (PARTITION BY chunk_id ORDER BY created_at DESC) rn
         FROM extraction_records
       ) t WHERE rn = 1 AND status = 'failed')`
    );
  }
  const { rows } = await client.query(
    `SELECT c.id, c.content FROM chunks c
     WHERE ${where.join(" AND ")}
     ORDER BY c.created_at
     LIMIT $${values.length + 1}`,
    [...values, flags.batchSize]
  );
  return rows.map((r) => ({
    id: r.id as string,
    content: r.content as string,
  }));
}

/** `--list-unmapped`: report relation_raw buckets, no LLM, no extraction. */
async function listUnmapped(deps: CliDeps): Promise<number> {
  const client = await deps.pool.connect();
  try {
    await upSchemaP0(client as unknown as PoolClient, deps.dims);
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

/** Dry-run: simulate extraction, print what would happen, write no rows. */
async function dryRunPlan(deps: CliDeps, chunks: ChunkInput[]): Promise<void> {
  deps.logger.info("dry-run-plan", { chunks: chunks.length });
  for (const chunk of chunks) {
    const outcome = await extractChunk(chunk, { llm: deps.llm });
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

interface BatchOutcome {
  writeFailures: number;
  succeeded: number;
  failed: number;
}

/** Run the batch, one transaction per chunk (record + entities + triples). */
async function processBatch(
  deps: CliDeps,
  client: CliClient,
  flags: CliFlags,
  chunks: ChunkInput[]
): Promise<BatchOutcome> {
  const batchId = newRecordId();
  const startedAt = deps.now ? deps.now() : new Date().toISOString();
  let writeFailures = 0;
  let succeeded = 0;
  let failed = 0;
  for (const chunk of chunks) {
    const out = await processChunk(deps, client, chunk, batchId, startedAt);
    if (out.kind === "write-failure") writeFailures += 1;
    else if (out.kind === "ok") succeeded += 1;
    else failed += 1;
  }
  deps.logger.info("extract-batch-complete", {
    batchId,
    batchSize: flags.batchSize,
    processed: chunks.length,
    succeeded,
    failed,
    writeFailures,
  });
  return { writeFailures, succeeded, failed };
}

type ChunkOutcome =
  { kind: "ok" } | { kind: "failed" } | { kind: "write-failure" };

/** One chunk in one transaction; mark-and-continue on every failure leg. */
async function processChunk(
  deps: CliDeps,
  client: CliClient,
  chunk: ChunkInput,
  batchId: string,
  startedAt: string
): Promise<ChunkOutcome> {
  const recordId = newRecordId();
  await client.query("BEGIN");
  try {
    await insertRecord(client, {
      id: recordId,
      batchId,
      chunkId: chunk.id,
      startedAt,
    });
    const outcome = await extractChunk(chunk, { llm: deps.llm });
    if (outcome.kind === "failed") {
      await markFailed(client, recordId, {
        code: outcome.errorCode,
        msg: outcome.errorMsg,
      });
      await client.query("COMMIT");
      deps.logger.info("chunk-failed", {
        chunkId: chunk.id,
        code: outcome.errorCode,
      });
      return { kind: "failed" };
    }
    const counts = await persistOutputs(
      deps,
      client,
      chunk.id,
      outcome.outputs,
      startedAt
    );
    await markSucceeded(client, recordId, {
      triplesCount: counts.triples,
      unmappedCount: counts.unmapped,
    });
    await client.query("COMMIT");
    return { kind: "ok" };
  } catch (err) {
    await client.query("ROLLBACK");
    deps.logger.error("chunk-write-failed", {
      chunkId: chunk.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return { kind: "write-failure" };
  }
}

/** Resolve/create entities and upsert triples for one chunk's outputs. */
async function persistOutputs(
  deps: CliDeps,
  client: CliClient,
  chunkId: string,
  outputs: ExtractionOutput[],
  startedAt: string
): Promise<{ triples: number; unmapped: number }> {
  let triples = 0;
  let unmapped = 0;
  for (const out of outputs) {
    const headId = await resolveEntity(deps, client, {
      canonicalName: out.head,
      type: out.headType,
      description: out.description,
    });
    const tailId = await resolveEntity(deps, client, {
      canonicalName: out.tail,
      type: out.tailType,
      description: out.description,
    });
    await upsertTriple(client, {
      headId,
      tailId,
      relationRaw: out.relationRaw,
      relationNorm: out.relationNorm,
      confidence: out.confidence,
      sourceChunkId: chunkId,
      validWindow: { start: startedAt, end: null },
    });
    triples += 1;
    if (out.relationNorm === "UNMAPPED") unmapped += 1;
  }
  return { triples, unmapped };
}

/**
 * Resolve the incoming entity via the merge gates, then persist. Merge →
 * reuse the survivor id; created-new / reject → insert a fresh row (the
 * gray-zone log already recorded the rejection via the merge default sink).
 */
async function resolveEntity(
  deps: CliDeps,
  client: CliClient,
  incoming: IncomingEntity
): Promise<string> {
  const live = await loadEntities(client);
  const { canonicalId, decision } = await mergeEntitiesWithGating(
    incoming,
    live,
    {
      embedder: deps.embedder,
    }
  );
  if (decision !== "created-new" && decision.kind === "merge") {
    return canonicalId;
  }
  const id = randomUUID();
  await insertEntity(client, id, incoming);
  return id;
}

/** Load live entities as merge candidates. DB stores no description column. */
async function loadEntities(client: Queryable): Promise<CandidateEntity[]> {
  const { rows } = await client.query(
    `SELECT id, canonical_name, type FROM entities WHERE retired = false`,
    []
  );
  return rows.map((r) => ({
    id: r.id as string,
    canonicalName: r.canonical_name as string,
    type: r.type as string,
    description: "",
  }));
}

async function insertEntity(
  client: Queryable,
  id: string,
  incoming: IncomingEntity
): Promise<void> {
  await client.query(
    `INSERT INTO entities (id, canonical_name, type, metadata, retired)
     VALUES ($1, $2, $3, '{}', false)`,
    [id, incoming.canonicalName, incoming.type]
  );
}

const CANNED_OUTPUT = {
  head: "Alice",
  headType: "person",
  relationRaw: "works at",
  relationNorm: "MEMBER_OF",
  tail: "Acme",
  tailType: "system",
  description: "Alice works at Acme",
  evidenceSpan: "Alice works at Acme",
  confidence: 0.9,
};

/** Build the LLM client from env: real when a key is set, else a fake. */
function buildLlm(): LLMClient {
  const apiKey = process.env.GRAPHRAG_MEMORY_ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    // No key → scripted fake; canned ok so dry-run has deterministic output.
    return new FakeLLMClient({
      scripted: async () => ({ kind: "ok", outputs: [CANNED_OUTPUT] }),
    });
  }
  const baseUrl = process.env.GRAPHRAG_MEMORY_ANTHROPIC_BASE_URL?.trim();
  const model = process.env.GRAPHRAG_MEMORY_ANTHROPIC_MODEL?.trim();
  if (!baseUrl || !model) {
    throw new ConfigError(
      "GRAPHRAG_MEMORY_ANTHROPIC_BASE_URL and GRAPHRAG_MEMORY_ANTHROPIC_MODEL are required when GRAPHRAG_MEMORY_ANTHROPIC_API_KEY is set"
    );
  }
  return new AnthropicLLMClient({ apiKey, baseUrl, model });
}

/** Build the embedder from env (mirrors src/index.ts buildDeps). */
function buildEmbedder(env: GraphragEnv): EmbeddingClient {
  if (env.embedApiKey && env.embedBaseUrl && env.embedModel) {
    return new NineRouterEmbedder({
      baseUrl: env.embedBaseUrl,
      model: env.embedModel,
      apiKey: env.embedApiKey,
      dimensions: env.embedDimensions,
    });
  }
  return new FakeEmbedder(env.embedDimensions);
}

/** Wire real deps from env and run; used by main(). */
export async function runCliFromEnv(argv: string[]): Promise<number> {
  let env: GraphragEnv;
  try {
    env = loadEnv();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`extract config error: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
  if (!env.dbUrl) {
    process.stderr.write(
      "extract config error: GRAPHRAG_MEMORY_DB_URL is required\n"
    );
    return 1;
  }
  const pool = new Pool({ connectionString: env.dbUrl });
  const deps: CliDeps = {
    pool,
    llm: buildLlm(),
    embedder: buildEmbedder(env),
    dims: env.embedDimensions,
    logger: createLogger(env.logLevel),
  };
  try {
    return await runCli(argv, deps);
  } finally {
    await pool.end();
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
    process.stderr.write(
      `extract fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`
    );
    process.exit(1);
  });
}
