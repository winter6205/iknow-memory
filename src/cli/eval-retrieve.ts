/**
 * Retrieve eval CLI — score the frozen gold set against the production
 * fusion path and write a git-tracked P@5 / R@5 baseline
 * (specs/retrieve-p5.md T2; SC4–SC6, SC11).
 *
 * Offline operator tool, never an MCP surface (SC7): the eval answers a
 * question about retrieval quality, which no Host asks and no Host should
 * be able to trigger.
 *
 * What it does, in order: load the frozen gold + seed corpus, embed and
 * upsert the corpus into the injected backend, run every gold query
 * through `assembleRetrievalResult` — the SAME orchestrator the MCP
 * `retrieve` tool calls, imported here rather than reimplemented, so a
 * change to RRF weights or fusion shows up in the next baseline (SC4) —
 * score each fused ranking at rank 5, and replace the baseline file
 * atomically.
 *
 * Three contracts worth naming:
 *
 *   - **The offline evaluator disables unavailable production adapters.**
 *     The seeded MemoryBackend has no Neo4j sidecar or rerank token, so this
 *     CLI explicitly switches those capabilities off. The baseline records
 *     `armSet` as `vector+bm25` and the process exits 0 (SC5).
 *   - **A failed query fails the run.** If the assembler throws, the run
 *     stops with a typed error naming the query. Recording an empty
 *     top-5 instead would publish a lower P@5 that looks exactly like a
 *     retrieval regression.
 *   - **A degraded arm fails the run too.** Optional arms are fail-open,
 *     so an arm that errors comes back as an empty contribution rather
 *     than a throw — and `armSet` would still name it, because the arm
 *     did start (specs/retrieve-graph-priority.md SC8). Publishing that
 *     is the same lie the previous contract refuses: the graph arm leads
 *     the ranking under graph-priority, so a baseline labelled
 *     `vector+bm25+graph` whose graph arm never delivered is a
 *     fallback-RRF baseline wearing a graph-led label.
 *
 * Storage is always the corpus the harness seeded, never an operator's
 * live store: a baseline is only comparable across runs if the searched
 * corpus is frozen (A8).
 *
 * Exit-code map:
 *   0 success — every gold query scored and the baseline was replaced,
 *     including the two-arm no-Neo4j-URI run.
 *   1 config / fatal — unusable gold or corpus fixture, an assembler
 *     throw, a failed baseline write, or a ConfigError from the env.
 *   2 usage error (unknown / malformed flag).
 *
 * Env: the same block every entry point in this package reads, via
 * `loadEnv()` — `GRAPHRAG_MEMORY_EMBED_DIMENSIONS` is required, and an
 * embedding API key is optional. The offline evaluator deliberately keeps
 * its deterministic FakeEmbedder exception so a second run is byte-stable;
 * the production server never wires that exception into retrieve.
 */
import { ConfigError, loadEnv } from "../config.js";
import { createLogger, type Logger } from "../logging.js";
import { FakeEmbedder, NineRouterEmbedder } from "../core/embedder.js";
import type { EmbeddingClient } from "../core/embedder.js";
import { MemoryBackend } from "../core/storage/memory-backend.js";
import type { StorageBackend } from "../core/types.js";
import { assembleRetrievalResult } from "../core/retrieval/index.js";
import type {
  GraphRanker,
  RetrieveConfig,
  RetrieveOutputEnvelope,
} from "../core/retrieval/types.js";
import {
  armSetFromDebug,
  loadCorpus,
  loadGoldSet,
  renderBaseline,
  scoreAtFive,
  seedCorpus,
  summarizeScores,
  writeBaselineAtomic,
  DEFAULT_BASELINE_PATH,
  DEFAULT_CORPUS_PATH,
  DEFAULT_GOLD_PATH,
  EvalRunError,
  type BaselineQuery,
  type BaselineReport,
  type GoldQuery,
  type QueryScore,
} from "../core/eval/index.js";

/**
 * How deep the eval asks retrieve to go. Independent of the metric's own
 * rank-5 cutoff, which the scorer owns: asking for more than 5 costs
 * nothing and keeps the recorded ranking comparable with what a Host
 * (default limit 10) would have seen.
 */
const DEFAULT_LIMIT = 10;

const USAGE = `usage: eval-retrieve [--gold PATH] [--corpus PATH] [--out PATH] [--limit N] [--valid-at ISO8601]`;

export interface EvalFlags {
  goldPath: string;
  corpusPath: string;
  outPath: string;
  /** Top-K asked of retrieve; scoring still cuts at rank 5. */
  limit: number;
  /** Temporal reference point handed to every query. */
  validAt: string;
}

/** The orchestrator seam — production by default, injectable for tests. */
export type RetrievalAssembler = typeof assembleRetrievalResult;

export interface EvalDeps {
  embedder: EmbeddingClient;
  /** Seeded with the frozen corpus by this CLI before any query runs. */
  storage: StorageBackend;
  /** Production retrieval knobs; the eval never retunes them (A6). */
  retrieveConfig: RetrieveConfig;
  /**
   * Graph ranker for the Neo4j arm — the arm that LEADS the ranking when
   * it returns anything, rather than voting at `w_graph`. The offline
   * default disables this production adapter; callers testing graph-priority
   * explicitly enable it in `retrieveConfig`.
   */
  graphRanker?: GraphRanker;
  logger: Logger;
  /**
   * Overrides the production assembler. Exists for the injected-throw
   * case in the spec's Testing Strategy; leaving it unset is what makes
   * the CLI score the same fusion path MCP `retrieve` uses (SC4).
   */
  assemble?: RetrievalAssembler;
}

type ParsedArgs = { ok: true; flags: EvalFlags } | { ok: false; error: string };

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: EvalFlags = {
    goldPath: DEFAULT_GOLD_PATH,
    corpusPath: DEFAULT_CORPUS_PATH,
    outPath: DEFAULT_BASELINE_PATH,
    limit: DEFAULT_LIMIT,
    validAt: new Date().toISOString(),
  };
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      return { ok: false, error: `${arg} requires a value` };
    }
    if (arg === "--gold") flags.goldPath = value;
    else if (arg === "--corpus") flags.corpusPath = value;
    else if (arg === "--out") flags.outPath = value;
    else if (arg === "--limit") {
      const n = Number(value);
      if (!Number.isInteger(n) || n <= 0) {
        return { ok: false, error: `--limit requires a positive integer` };
      }
      flags.limit = n;
    } else if (arg === "--valid-at") {
      if (Number.isNaN(Date.parse(value))) {
        return {
          ok: false,
          error: `--valid-at requires an ISO 8601 timestamp`,
        };
      }
      flags.validAt = value;
    } else {
      return { ok: false, error: `unknown flag: "${arg}"` };
    }
    i += 2;
  }
  return { ok: true, flags };
}

/** Top-level entry, testable: parse flags, run, map failures to exit codes. */
export async function runCli(argv: string[], deps: EvalDeps): Promise<number> {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    process.stderr.write(`${USAGE}\neval-retrieve: ${parsed.error}\n`);
    return 2;
  }
  try {
    const report = await runEval(parsed.flags, deps);
    await writeBaselineAtomic(parsed.flags.outPath, renderBaseline(report));
    deps.logger.info("eval-retrieve-complete", {
      baseline: parsed.flags.outPath,
      armSet: report.armSet,
      queries: report.queryCount,
      meanPAt5: report.meanPAt5,
      meanRAt5: report.meanRAt5,
    });
    return 0;
  } catch (err) {
    // EXIT: 退出码 1 + stderr 上行给操作者；baseline 未被写入，旧文件保持原样
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`eval-retrieve failed: ${message}\n`);
    deps.logger.error("eval-retrieve-failed", { error: message });
    return 1;
  }
}

/**
 * Score every gold query and build the report. Throws typed errors —
 * the caller owns the exit code and the fact that nothing is written on
 * the way out.
 */
async function runEval(
  flags: EvalFlags,
  deps: EvalDeps
): Promise<BaselineReport> {
  const gold = loadGoldSet(flags.goldPath);
  const corpus = loadCorpus(flags.corpusPath);
  if (gold.corpus !== corpus.version) {
    throw new EvalRunError(
      `gold fixture targets corpus "${gold.corpus}" but "${flags.corpusPath}" is "${corpus.version}"; scoring them against each other would produce a meaningless baseline`
    );
  }
  await seedCorpus(corpus, deps.embedder, deps.storage);

  const entries: BaselineQuery[] = [];
  const scores: QueryScore[] = [];
  let armSet: string | undefined;
  for (const goldQuery of gold.queries) {
    const envelope = await retrieveOne(goldQuery, flags, deps);
    assertArmsDelivered(envelope, goldQuery.id);
    armSet = reconcileArmSet(armSet, envelope, goldQuery.id);
    const score = scoreAtFive(
      envelope.chunks.map((chunk) => chunk.id),
      goldQuery.relevant,
      goldQuery.id
    );
    scores.push(score);
    entries.push({
      id: goldQuery.id,
      query: goldQuery.query,
      top5: score.top5,
      pAt5: score.pAt5,
      rAt5: score.rAt5,
    });
  }

  const summary = summarizeScores(scores);
  return {
    schema: "iknow-retrieve-p5/v1",
    gold: gold.version,
    corpus: corpus.version,
    // `armSet` is set on the first iteration and the gold set is never
    // empty (the loader enforces 8-15), so the fallback is unreachable —
    // it is here to narrow the type, not to paper over a missing value.
    armSet: armSet ?? "vector",
    queryCount: summary.queryCount,
    meanPAt5: summary.meanPAt5,
    meanRAt5: summary.meanRAt5,
    queries: entries,
  };
}

/**
 * Run one gold query through the production orchestrator.
 *
 * `debug: true` is not a diagnostic here: the debug payload is how the
 * orchestrator reports which arms it actually ran, and reading `armSet`
 * from that report is what keeps the baseline from claiming an arm the
 * fusion never used.
 */
async function retrieveOne(
  goldQuery: GoldQuery,
  flags: EvalFlags,
  deps: EvalDeps
): Promise<RetrieveOutputEnvelope> {
  const assemble = deps.assemble ?? assembleRetrievalResult;
  try {
    return await assemble(
      { query: goldQuery.query, validAt: flags.validAt, limit: flags.limit },
      {
        embedder: deps.embedder,
        storage: deps.storage,
        retrieveConfig: deps.retrieveConfig,
        ...(deps.graphRanker !== undefined
          ? { graphRanker: deps.graphRanker }
          : {}),
        debug: true,
      }
    );
  } catch (err) {
    // EXIT: 以 typed EvalRunError 上抛，整轮 eval 失败；不以空 top5 顶替该 query
    throw new EvalRunError(
      `retrieval failed for gold query "${goldQuery.id}": ${err instanceof Error ? err.message : String(err)}`,
      goldQuery.id
    );
  }
}

/**
 * Stop the run when an arm was attempted and could not deliver.
 *
 * `armSet` reads arm PARTICIPATION off the debug payload, so a fail-open
 * arm that errored is still named there — correctly, since it did start.
 * That label is only honest about the ranking when the arm also finished:
 * under graph-priority the graph arm owns the head of every list, so a
 * baseline stamped `vector+bm25+graph` whose graph arm errored records a
 * pure vector+BM25 fallback under a graph-led name, and the P@5 gap
 * against the previous baseline reads as a retrieval regression instead
 * of the outage it is.
 */
function assertArmsDelivered(
  envelope: RetrieveOutputEnvelope,
  queryId: string
): void {
  if (envelope.degraded !== true) return;
  // EXIT: typed EvalRunError → 退出码 1；baseline 不写入，旧文件保持原样
  throw new EvalRunError(
    `retrieval degraded for gold query "${queryId}": ${describeArmFailures(envelope.debug)}; scoring a degraded arm set would publish a baseline naming an arm that never contributed`,
    queryId
  );
}

/**
 * Name the arms behind a `degraded` envelope, from the per-arm reasons
 * the orchestrator emits as `<arm>FailureReason`. The legacy bare
 * `failureReason` alias is skipped by the same pattern, so the graph arm
 * is reported once. An arm can also degrade without a reason (the
 * archived SQL arm under-flooring), hence the fallback.
 */
function describeArmFailures(
  debug: Record<string, unknown> | undefined
): string {
  const reasons: string[] = [];
  for (const [key, value] of Object.entries(debug ?? {})) {
    const arm = /^(.+)FailureReason$/.exec(key)?.[1];
    if (arm !== undefined) reasons.push(`${arm} arm failed: ${String(value)}`);
  }
  return reasons.length > 0
    ? reasons.join("; ")
    : "an optional arm returned below-floor results";
}

/**
 * The arm set is a property of the wiring, not of the query, so it must
 * be identical for every query in a run. A disagreement means an arm
 * appeared or vanished mid-run; recording either value would label the
 * whole baseline with a configuration that only some queries saw.
 */
function reconcileArmSet(
  previous: string | undefined,
  envelope: RetrieveOutputEnvelope,
  queryId: string
): string {
  const current = armSetFromDebug(envelope.debug);
  if (previous !== undefined && previous !== current) {
    throw new EvalRunError(
      `arm set changed mid-run at gold query "${queryId}": earlier queries ran "${previous}", this one ran "${current}"`,
      queryId
    );
  }
  return current;
}

/**
 * Wire real deps from env and run; used by main().
 *
 * No Neo4j ranker is constructed. The eval searches the corpus this CLI
 * just seeded into a chunk-only backend, and explicitly disables the
 * production graph and rerank adapters so missing offline integrations do
 * not become part of the frozen SC-29 baseline.
 */
export async function runCliFromEnv(argv: string[]): Promise<number> {
  let embedder: EmbeddingClient;
  let storage: StorageBackend;
  let retrieveConfig: RetrieveConfig;
  let logger: Logger;
  try {
    const env = loadEnv();
    logger = createLogger(env.logLevel);
    // SC-29 freezes this CLI as a local, chunk-only evaluator. Its seeded
    // MemoryBackend has no Neo4j or rerank adapter, so switch those
    // default-on production capabilities off explicitly rather than
    // publishing a degraded baseline.
    retrieveConfig = {
      ...env.retrieval,
      graphEnabled: false,
      rerankEnabled: false,
    };
    storage = new MemoryBackend(env.embedDimensions);
    embedder = buildEmbedder(env);
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`eval-retrieve config error: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
  try {
    return await runCli(argv, { embedder, storage, retrieveConfig, logger });
  } finally {
    await storage.close();
  }
}

/**
 * FakeEmbedder unless the operator configured a real endpoint. This
 * exception is scoped to the offline evaluator; the production server
 * wires UnavailableEmbedder when credentials are absent.
 */
function buildEmbedder(env: ReturnType<typeof loadEnv>): EmbeddingClient {
  if (
    env.embedApiKey === undefined ||
    env.embedBaseUrl === undefined ||
    env.embedModel === undefined
  ) {
    return new FakeEmbedder(env.embedDimensions);
  }
  return new NineRouterEmbedder({
    baseUrl: env.embedBaseUrl,
    model: env.embedModel,
    apiKey: env.embedApiKey,
    dimensions: env.embedDimensions,
  });
}

/** Top-level entry: wire real deps, exit with the CLI exit code. */
export async function main(): Promise<void> {
  const code = await runCliFromEnv(process.argv.slice(2));
  process.exit(code);
}

// Run only when invoked directly. Mirrors src/cli/graph-drain.ts isMain.
const isMain = (() => {
  if (typeof process === "undefined") return false;
  const arg1 = process.argv[1];
  if (!arg1) return false;
  return (
    arg1.endsWith("cli/eval-retrieve.ts") ||
    arg1.endsWith("cli/eval-retrieve.js")
  );
})();

if (isMain) {
  main().catch((err) => {
    process.stderr.write(
      `eval-retrieve fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`
    );
    process.exit(1);
  });
}
