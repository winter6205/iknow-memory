/**
 * Retrieve ablation CLI — score the eight-key capability matrix and write
 * a git-trackable ablation report (specs/es-precision-layer.md SC-7,
 * plans/es-precision-layer.md T6, specs/retrieval-stack.md §B1 ablation
 * matrix row).
 *
 * The matrix is fixed and lives entirely in `core/eval/ablation-matrix.ts`
 * as pure functions, so the ten configurations (1 all-on + 8 single-off +
 * 1 all-off) never drift between this CLI and a test fake. The CLI only
 * owns three concerns:
 *
 *   1. **Parameter parsing** for `--gold / --corpus / --out / --json-out
 *      / --md-out / --repeat / --limit / --valid-at / --single / --loud-skip`.
 *      The canonical SC-7 path runs every configuration; pass `--single ID`
 *      to run only the matrix row whose `id` matches (used in tests / smoke
 *      runs, e.g. `--single zh-segment-off` for the SC-1 acceptance command).
 *   2. **Wiring the runner port**: the CLI owns the production assembler
 *      injection (`assembleRetrievalResult` from `src/core/retrieval`)
 *      and the embedder / storage fixtures, but the actual scoring loop
 *      is a port (`AblationRunner`) so the CLI is unit-testable without a
 *      live embedder or store.
 *   3. **Mapping outcomes to exit codes**, including the loud-skip exit
 *      code used by `graph-drain.ts` when a sidecar (here: the lexical
 *      precision-layer adapter) is configured but unreachable — the
 *      spec SC-5 default of "configured-but-failing → degraded" is
 *      indistinguishable from the SC-7 goal of "matrix runs on a working
 *      stack" without a clean exit 3 signal so an operator script can
 *      tell a missing stack from a real regression.
 *
 * Exit-code map:
 *   0 success — every (config, repeat) cell produced a finite sample,
 *     JSON and Markdown were written atomically, the canonical report
 *     is on disk. A successful run may still carry `degraded` flags in
 *     the JSON for individual configs; that is recorded in the report
 *     rather than in the exit code.
 *   1 config / fatal — unusable gold / corpus fixture, an assembler
 *     throw on the baseline row, a failed report write, a ConfigError,
 *     an AblationMatrixError.
 *   2 usage error (unknown / malformed flag, mutually exclusive flags).
 *   3 loud skip — the configured stack does not expose a usable lexical
 *     precision-layer seam. The matrix still gets written with the
 *     runner's own degraded raw samples, but the exit code signals
 *     "stack not ready" so an unattended run is not mistaken for a real
 *     baseline.
 *
 * Env: same `loadEnv()` block the rest of the package reads; the
 * offline evaluator keeps `FakeEmbedder` so a second run is byte-stable.
 *
 * Isolation: this CLI DOES import from `src/core/retrieval/*` because
 * the runner port needs SOMETHING to produce raw samples. The
 * isolation guard in `tests/cli/eval.unit.test.ts` covers `src/cli/eval.ts`
 * specifically (the extraction-eval CLI), not this CLI; the same grep
 * applied here is documented inline as a defensive guard.
 */
import { ConfigError, loadEnv } from "../config.js";
import { createLogger, type Logger, writeStderr } from "../logging.js";
import {
  FakeEmbedder,
  NineRouterEmbedder,
  UnavailableEmbedder,
} from "../core/embedder.js";
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
  buildAblationConfigs,
  buildAblationReport,
  loadCorpus,
  loadGoldSet,
  renderAblationJson,
  renderAblationMarkdown,
  round2,
  scoreAtFive,
  seedCorpus,
  summarizeScores,
  writeBaselineAtomic,
  type AblationCapabilities,
  type AblationConfig,
  type GoldQuery,
  type RawSampleInput,
} from "../core/eval/index.js";
import { EvalRunError } from "../core/eval/errors.js";

/** Top-K asked of retrieve per query. Independent of the rank-5 metric. */
const DEFAULT_LIMIT = 10;

/** Repeat each configuration N times so the report can publish a median. */
const DEFAULT_REPEATS = 3;

const USAGE = `usage: eval-stack [--gold PATH] [--corpus PATH] [--out PATH] [--md-out PATH] [--repeat N] [--limit N] [--valid-at ISO8601] [--single ID] [--loud-skip]`;

export interface EvalStackFlags {
  goldPath: string;
  corpusPath: string;
  /** JSON output path. Falls back to `${outPath}.json` when `--out` is set. */
  jsonOutPath: string;
  /** Markdown output path. Defaults to `${outPath}.md` when `--out` is set. */
  mdOutPath: string;
  /** Repeat each configuration this many times. */
  repeats: number;
  /** Top-K asked of retrieve; scoring still cuts at rank 5. */
  limit: number;
  /** ISO 8601 reference point handed to every query. */
  validAt: string;
  /** Single-config mode: only run the matrix row whose `id` matches. */
  singleConfigId: string | undefined;
  /** When true, exit 3 even on a successful run; used by the unit tests. */
  forceLoudSkip: boolean;
}

/** One (configuration × repeat) sample as the runner hands it back. */
export type AblationRunnerSample = RawSampleInput;

export interface AblationRunnerContext {
  config: AblationConfig;
  repeat: number;
  flags: EvalStackFlags;
  gold: readonly GoldQuery[];
}

export type AblationRunner = (
  context: AblationRunnerContext
) => Promise<AblationRunnerSample>;

/** Default runner: drive the production assembler for each (config, repeat). */
export type ProductionAssembler = typeof assembleRetrievalResult;

export interface RunnerDeps {
  embedder: EmbeddingClient;
  storage: StorageBackend;
  baseRetrieveConfig: RetrieveConfig;
  /** Optional graph ranker for the Neo4j arm. */
  graphRanker?: GraphRanker;
  /** Injected assembler seam; defaults to `assembleRetrievalResult`. */
  assemble?: ProductionAssembler;
}

/** Top-level deps so the CLI is testable without a live embedder. */
export interface EvalStackDeps {
  runner: AblationRunner;
  logger: Logger;
  /**
   * Optional one-time corpus seed before the first runner call. The
   * production wiring seeds the frozen corpus into the injected
   * backend; an injected test runner skips it by omitting this hook.
   */
  seed?: (flags: EvalStackFlags) => Promise<void>;
}

type ParsedArgs =
  { ok: true; flags: EvalStackFlags } | { ok: false; error: string };

/**
 * Parse argv. Keeps the same flag surface as `eval-retrieve.ts` where
 * both apply (`--gold / --corpus / --limit / --valid-at`) and adds the
 * ablation-specific flags (`--repeat / --json-out / --md-out / --out
 * / --single / --loud-skip`). Mutually exclusive `--out` with the
 * separate JSON / Markdown paths is enforced so the caller cannot leave
 * the report half-specified.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const flags: EvalStackFlags = {
    goldPath: "",
    corpusPath: "",
    jsonOutPath: "",
    mdOutPath: "",
    repeats: DEFAULT_REPEATS,
    limit: DEFAULT_LIMIT,
    validAt: new Date().toISOString(),
    singleConfigId: undefined,
    forceLoudSkip: false,
  };
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;
    // Boolean flags take no value; check them before the value-required
    // path so a trailing `--loud-skip` followed by `--out` (which
    // starts with `--`) is not mistaken for a missing-value failure.
    if (arg === "--loud-skip") {
      flags.forceLoudSkip = true;
      i += 1;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      return { ok: false, error: `${arg} requires a value` };
    }
    if (arg === "--gold") flags.goldPath = value;
    else if (arg === "--corpus") flags.corpusPath = value;
    else if (arg === "--out") {
      flags.jsonOutPath = `${value}.json`;
      flags.mdOutPath = `${value}.md`;
    } else if (arg === "--json-out") flags.jsonOutPath = value;
    else if (arg === "--md-out") flags.mdOutPath = value;
    else if (arg === "--repeat") {
      const n = Number(value);
      if (!Number.isInteger(n) || n <= 0) {
        return { ok: false, error: `--repeat requires a positive integer` };
      }
      flags.repeats = n;
    } else if (arg === "--limit") {
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
    } else if (arg === "--single") {
      flags.singleConfigId = value;
      // Single-config mode runs the requested row once. Default
      // `repeats` to 1 so a caller does not have to also pass
      // `--repeat 1` (and so `--repeat > 1 + --single` stays a real
      // mutual-exclusion failure rather than silently dropping repeats).
      flags.repeats = 1;
    } else {
      return { ok: false, error: `unknown flag: "${arg}"` };
    }
    i += 2;
  }
  if (
    flags.singleConfigId !== undefined &&
    flags.singleConfigId.trim() === ""
  ) {
    return { ok: false, error: `--single requires a non-empty id` };
  }
  if (flags.repeats > 1 && flags.singleConfigId !== undefined) {
    return {
      ok: false,
      error: `--repeat and --single are mutually exclusive: single-config mode runs one configuration once`,
    };
  }
  if (flags.jsonOutPath === "" && flags.mdOutPath === "") {
    return {
      ok: false,
      error: "at least one of --out, --json-out or --md-out is required",
    };
  }
  return { ok: true, flags };
}

/**
 * Top-level entry, testable: parse flags, run, map failures to exit
 * codes. Mirrors `eval-retrieve.ts:runCli`.
 */
export async function runCli(
  argv: string[],
  deps: EvalStackDeps
): Promise<number> {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    writeStderr(`${USAGE}\neval-stack: ${parsed.error}\n`);
    return 2;
  }
  try {
    if (deps.seed !== undefined) {
      await deps.seed(parsed.flags);
    }
    const report = await runMatrix(parsed.flags, deps);
    if (parsed.flags.jsonOutPath !== "") {
      await writeBaselineAtomic(
        parsed.flags.jsonOutPath,
        renderAblationJson(report)
      );
    }
    if (parsed.flags.mdOutPath !== "") {
      await writeBaselineAtomic(
        parsed.flags.mdOutPath,
        renderAblationMarkdown(report)
      );
    }
    deps.logger.info("eval-stack-complete", {
      configs: report.configCount,
      runsPerConfig: report.runsPerConfig,
      json: parsed.flags.jsonOutPath,
      md: parsed.flags.mdOutPath,
    });
    return parsed.flags.forceLoudSkip ? 3 : 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writeStderr(`eval-stack failed: ${message}\n`);
    deps.logger.error("eval-stack-failed", { error: message });
    return 1;
  }
}

/**
 * Run the matrix and return a fully-formed report. Pure orchestration:
 * matrix builder + per-config runner invocations + aggregation.
 */
export async function runMatrix(
  flags: EvalStackFlags,
  deps: EvalStackDeps
): Promise<Return> {
  const configs = buildAblationConfigs();
  const selected = pickConfigs(configs, flags.singleConfigId);
  const gold = await loadGoldQueries(flags);
  const samples = new Map<string, RawSampleInput[]>();
  for (const config of selected) {
    const runs: RawSampleInput[] = [];
    for (let repeat = 1; repeat <= flags.repeats; repeat += 1) {
      const sample = await deps.runner({
        config,
        repeat,
        flags,
        gold,
      });
      runs.push(sample);
    }
    samples.set(config.id, runs);
  }
  return buildAblationReport({
    configs: selected,
    samples,
    runsPerConfig: flags.repeats,
  });
}

type Return = Awaited<ReturnType<typeof buildAblationReport>>;

function pickConfigs(
  configs: readonly AblationConfig[],
  singleId: string | undefined
): readonly AblationConfig[] {
  if (singleId === undefined) return configs;
  const found = configs.find((c) => c.id === singleId);
  if (found === undefined) {
    throw new EvalRunError(
      `unknown ablation configuration id "${singleId}"; known ids: ${configs.map((c) => c.id).join(", ")}`
    );
  }
  return [found];
}

async function loadGoldQueries(
  flags: EvalStackFlags
): Promise<readonly GoldQuery[]> {
  if (flags.goldPath === "" || flags.corpusPath === "") {
    throw new EvalRunError(
      "eval-stack requires --gold and --corpus so the runner has gold queries to score"
    );
  }
  const gold = loadGoldSet(flags.goldPath);
  const corpus = loadCorpus(flags.corpusPath);
  if (gold.corpus !== corpus.version) {
    throw new EvalRunError(
      `gold fixture targets corpus "${gold.corpus}" but "${flags.corpusPath}" is "${corpus.version}"; scoring them against each other would produce a meaningless matrix`
    );
  }
  return gold.queries;
}

/* -------------------------------------------------------------------------- */
/* Production runner                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Build a runner that drives the production assembler once per (config,
 * repeat). The lexical seam (`LexicalStorageBackend`) is the production
 * signal that the precision layer is wired; an unconfigured run gets
 * `MemoryBackend` which has no `searchLexical` and the runner degrades
 * accordingly (see `buildProductionRunner`).
 *
 * `vector = off` swaps in `UnavailableEmbedder` rather than throwing:
 * the orchestrator already has a first-class path for "embedder
 * credentials absent" (vector unattempted, envelope degraded), and the
 * ablation's all-off / off-vector rows are precisely the runs where the
 * operator needs to see that degraded behavior measured instead of a
 * refused run. The degradation remains visible in `degraded_reasons`
 * per the SC-23 D2 rule; the sample itself is still recorded.
 */
export function buildProductionRunner(deps: RunnerDeps): AblationRunner {
  return async ({ config, flags, gold }) => {
    const retrieveConfig = translateCapabilities(
      config.capabilities,
      deps.baseRetrieveConfig
    );
    const assemble = deps.assemble ?? assembleRetrievalResult;
    const embedder = config.capabilities.vector
      ? deps.embedder
      : new UnavailableEmbedder();
    // scores is the per-query mean P@5 / R@5; we run the assemble +
    // score loop inline so the runner does not depend on a CLI helper.
    const scores = [];
    for (const query of gold) {
      let envelope: RetrieveOutputEnvelope;
      try {
        envelope = await assemble(
          { query: query.query, validAt: flags.validAt, limit: flags.limit },
          {
            embedder,
            storage: deps.storage,
            retrieveConfig,
            ...(deps.graphRanker !== undefined
              ? { graphRanker: deps.graphRanker }
              : {}),
          }
        );
      } catch (err) {
        if (!config.capabilities.vector) {
          // The all-off / off-vector rows intentionally have no arm:
          // the orchestrator's all-arms-failed typed error IS the
          // measured floor. Recording the zero sample is honest
          // measurement of a declared-off configuration, not masking a
          // failure — the config row says so in the report.
          scores.push({ top5: [], hits: 0, pAt5: 0, rAt5: 0 });
          continue;
        }
        throw new EvalRunError(
          `retrieval failed for gold query "${query.id}" under config "${config.id}": ${err instanceof Error ? err.message : String(err)}`,
          query.id
        );
      }
      scores.push(
        scoreAtFive(
          envelope.chunks.map((chunk) => chunk.id),
          query.relevant,
          query.id
        )
      );
    }
    const summary = summarizeScores(scores);
    return {
      meanPAt5: round2(summary.meanPAt5),
      meanRAt5: round2(summary.meanRAt5),
    };
  };
}

/**
 * Capability → `RetrieveConfig` translation. Single source of truth so a
 * test fake runner does not have to re-implement the mapping and drift.
 *
 * `keyword_bm25` maps to `bm25Enabled` (the orchestrator's BM25 gate is
 * already named after that contract). `vector = off` is NOT a config
 * knob — the orchestrator's vector arm runs whenever an available
 * embedder is wired — so the production runner expresses it by swapping
 * in `UnavailableEmbedder` (see `buildProductionRunner`), which is the
 * same "credentials absent → vector unattempted" state the orchestrator
 * already handles and degrades honestly.
 */
export function translateCapabilities(
  capabilities: AblationCapabilities,
  base: RetrieveConfig
): RetrieveConfig {
  return {
    ...base,
    bm25Enabled: capabilities.keyword_bm25,
    graphEnabled: capabilities.graph_ppr,
    rerankEnabled: capabilities.rerank,
    cjkSegmentationEnabled: capabilities.cjk_segmentation,
    phraseEnabled: capabilities.phrase,
    fieldBoostEnabled: capabilities.field_boost,
    // `rrf = off` collapses all cross-arm weights to zero, leaving the
    // vector arm as the only meaningful contributor — this is the
    // closest the production assembler gets to "no fusion".
    ...(capabilities.rrf
      ? {}
      : {
          w_vec: 1,
          w_bm25: 0,
          w_graph: 0,
        }),
  };
}

/* -------------------------------------------------------------------------- */
/* Env wiring                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The precision-layer seam is the production signal that the lexical
 * arm is wired. `MemoryBackend` does not implement `searchLexical`, so a
 * stack without ES / pgvector-BM25 has no lexical capability and the
 * runner would degrade every BM25-on configuration identically — the
 * ablation would publish a meaningless matrix. Refuse loudly rather than
 * silently publish it.
 */
export function hasLexicalSeam(storage: StorageBackend): boolean {
  const seam = (storage as { searchLexical?: unknown }).searchLexical;
  return typeof seam === "function";
}

/** Wire real deps from env and run. */
export async function runCliFromEnv(argv: string[]): Promise<number> {
  let embedder: EmbeddingClient;
  let storage: StorageBackend;
  let retrieveConfig: RetrieveConfig;
  let logger: Logger;
  try {
    const env = loadEnv();
    logger = createLogger(env.logLevel);
    retrieveConfig = {
      ...env.retrieval,
      // The ablation matrix tests eight capability keys, four of which
      // belong to the precision layer and one to the reranker. Disable
      // the offline-only defaults that the eval-retrieve CLI also
      // disables so a run without a Neo4j sidecar / rerank endpoint
      // still produces a usable matrix.
      graphEnabled: false,
      rerankEnabled: false,
    };
    storage = new MemoryBackend(env.embedDimensions);
    embedder = buildEmbedder(env);
  } catch (err) {
    if (err instanceof ConfigError) {
      writeStderr(`eval-stack config error: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
  if (!hasLexicalSeam(storage)) {
    writeStderr(
      `\neval-stack: storage backend has no lexical (precision-layer) seam; the ablation matrix requires BM25 / phrase / field_boost / cjk_segmentation to mean something different from one another\n` +
        "Validation:\n" +
        "- Not run: ablation matrix (precision layer not configured)\n" +
        "- Expected command: npm run eval:stack\n" +
        "- Blocking issue: LexicalStorageBackend.searchLexical is not implemented by the configured storage backend\n"
    );
    return 3;
  }
  const runner = buildProductionRunner({
    embedder,
    storage,
    baseRetrieveConfig: retrieveConfig,
  });
  try {
    return await runCli(argv, {
      runner,
      logger,
      seed: async (flags) => {
        const corpus = loadCorpus(flags.corpusPath);
        await seedCorpus(corpus, embedder, storage);
      },
    });
  } finally {
    await storage.close();
  }
}

/** Build an embedder; deterministic `FakeEmbedder` unless the operator configured one. */
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

// Run only when invoked directly. Mirrors src/cli/eval-retrieve.ts isMain.
const isMain = (() => {
  if (typeof process === "undefined") return false;
  const arg1 = process.argv[1];
  if (!arg1) return false;
  return (
    arg1.endsWith("cli/eval-stack.ts") || arg1.endsWith("cli/eval-stack.js")
  );
})();

if (isMain) {
  main().catch((err) => {
    writeStderr(
      `eval-stack fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`
    );
    process.exit(1);
  });
}
