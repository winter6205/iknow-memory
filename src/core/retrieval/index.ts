/**
 * Retrieval orchestrator — vector arm ∥ optional arms + ranking + envelope.
 *
 * Public entry point: `assembleRetrievalResult(args, deps)`. The function is
 * the single wire between the retrieve tool (`src/tools/retrieve.ts`) and the
 * retrieval bounded context (`src/core/retrieval/*`). It does NOT own any
 * state and does NOT mutate `deps`.
 *
 * Arms:
 *   - **vector** always runs, and its failure is the caller's failure.
 *   - **BM25** runs when `retrieveConfig.bm25Enabled` is set and the backend
 *     implements the lexical seam. This is the production partner arm (#59).
 *   - **graph** runs when `retrieveConfig.graphEnabled` is set, a
 *     `graphRanker` was wired (i.e. a Neo4j sidecar is configured) and the
 *     backend implements the `neo4jArmSeed` seam. That is the production
 *     third arm (#70). The ARCHIVED SQL one-hop arm answers to the same
 *     name and runs only when a caller passes `graphConfig` explicitly and
 *     the Neo4j arm is not active — the default server wiring passes no
 *     `graphConfig` (#58, `docs/runbooks/sql-graph-arm-archived.md`).
 *
 * Ranking is GRAPH-PRIORITY (`graph-priority.ts`,
 * specs/retrieve-graph-priority.md): the Neo4j arm's own order leads
 * `chunks[]` whenever that arm returns anything, and `rrfFuse` over the
 * remaining arms fills the leftover `limit` slots. Every other case — arm
 * skipped, empty, or failed — ranks by that same fusion, so an arm that
 * contributed nothing never votes.
 *
 * When no optional arm is active the envelope is EXACTLY
 * `{ chunks: RetrievedChunk[] }` — no `degraded`, no `debug`, even under the
 * debug gate. That covers a chunk-only backend AND an operator who switched
 * BM25 off: turning an arm off is a choice, not a degradation, so it must
 * not show up as one on the wire.
 *
 * The query is embedded once and the vector feeds every arm that needs it.
 * An embedder that yields no usable vector raises `GraphragError`
 * ("EMBEDDING_FAILED") before any arm starts — never fail-open.
 *
 * Optional arms are fail-open: each is wrapped so a throw becomes an empty
 * `ArmResult` carrying a `failureReason`, which surfaces as `degraded: true`
 * on the envelope while the vector results still reach the caller.
 */
import { assembleGraphPriority } from "./graph-priority.js";
import { maybeRerank, rerankWindowSize } from "./rerank.js";
import { runGraphArm, type GraphArmDeps } from "./graph-arm.js";
import { runNeo4jGraphArm, type Neo4jGraphArmDeps } from "./neo4j-graph-arm.js";
import type {
  ArmHit,
  ArmName,
  ArmResult,
  ChunkReranker,
  FusedHit,
  GraphArmStorage,
  GraphRanker,
  RetrieveConfig,
  RetrieveOutputEnvelope,
} from "./types.js";
import type { RetrievedChunk, StorageBackend } from "../types.js";
import {
  supportsLexicalSearch,
  supportsNeo4jArm,
  type GraphRagStorageBackend,
  type LexicalStorageBackend,
} from "../storage/backend.js";
import type { EmbeddingClient } from "../embedder.js";
import { GraphragError } from "../errors.js";

/**
 * How many candidates each arm draws when its results will be fused.
 *
 * Fetching only `limit` per arm would make the lexical arm nearly inert:
 * a chunk the vector arm ranks below the cut could reach fusion only as a
 * BM25-only hit worth `w_bm25 / (k + 1)` ≈ 0.0025, which cannot outrank a
 * vector-only hit at `w_vec / (k + 1)` ≈ 0.011. Drawing deeper lets the
 * two arms actually agree on a chunk, and agreement is the signal RRF
 * exists to reward. Only the FUSED list is cut to `limit`.
 *
 * The mode bundle's `candidateCap` controls this pool when a configured arm
 * is active; this fallback keeps legacy callers at the balanced width.
 */
const ARM_CANDIDATE_POOL = 50;

/** Inputs — what the orchestrator needs from the retrieve tool. */
export interface AssembleArgs {
  query: string;
  /** ISO 8601; the retrieve handler already defaults to "now". */
  validAt: string;
  /** Top-K truncation; the retrieve handler already defaults to 10. */
  limit: number;
  /**
   * Exact-match source_ref / metadata.* filters, passed through to the
   * vector arm only. The graph arm does its own seed-entity / one-hop
   * filtering (no filters apply to seed-similarity or graph traversal).
   * Optional: absent → unfiltered vector search.
   */
  filters?: Record<string, string>;
}

/**
 * Deps injected by the retrieve tool.
 *
 * `retrieveConfig` carries the production hybrid knobs (BM25 weight and
 * enable switch). `graphConfig` is separate and opt-in: supplying it is
 * the only way to run the archived SQL graph arm, which is why the
 * default server wiring omits it (#58).
 */
export interface AssembleDeps {
  embedder: EmbeddingClient;
  /** May implement the lexical and/or graph seams; neither is required. */
  storage: StorageBackend;
  /** Hybrid retrieval config. Absent → vector-only. */
  retrieveConfig?: RetrieveConfig;
  /** Opt-in archived graph arm; absent on the production path. */
  graphConfig?: RetrieveConfig;
  /**
   * Neo4j PPR ranker, wired only when a sidecar URI is configured. Absent
   * is the SC7 case: the arm is not attempted and the envelope carries no
   * `degraded` — an operator who configured no graph engine has not
   * suffered a failed graph call.
   */
  graphRanker?: GraphRanker;
  /**
   * Temporary LLM reranker, wired only when rerank is enabled AND the
   * Anthropic trio is complete. Absent + enable-on is a skip, not degraded.
   */
  reranker?: ChunkReranker;
  /** Injectable debug gate; wired to `DEBUG=1` by the tool. */
  debug?: boolean;
}

export async function assembleRetrievalResult(
  args: AssembleArgs,
  deps: AssembleDeps
): Promise<RetrieveOutputEnvelope> {
  // One embed per retrieve: the same vector feeds the vector search and
  // the graph arm's seed lookup. Embed failure propagates before any arm
  // starts.
  const queryEmbedding = await embedQuery(deps.embedder, args.query);

  // Fusion WEIGHTS may fall back: a legacy graph-arm caller passes only
  // `graphConfig`, production passes only `retrieveConfig`, and RRF needs
  // weights either way. The BM25 GATE must NOT fall back — `getLexicalArm`
  // reads `deps.retrieveConfig` alone, so injecting the archived graph arm
  // can never switch the lexical arm on behind the operator's back.
  const weights = deps.retrieveConfig ?? deps.graphConfig;
  const lexical = getLexicalArm(deps);
  const neo4jGraph = getNeo4jGraphArm(deps);
  // At most ONE graph arm per call: both answer to the arm name "graph",
  // so running the pair would double-weight the same chunk and collide in
  // the debug payload. Production wins over the archive.
  const graph = neo4jGraph === undefined ? getGraphSeed(deps) : undefined;
  const fusing =
    lexical !== undefined || graph !== undefined || neo4jGraph !== undefined;
  const reranker = getReranker(deps);
  const rerankWindow =
    reranker !== undefined && deps.retrieveConfig !== undefined
      ? rerankWindowSize(args.limit, deps.retrieveConfig.candidateCap)
      : undefined;
  const candidatePool =
    fusing && weights !== undefined && weights.preset !== undefined
      ? weights.candidateCap
      : ARM_CANDIDATE_POOL;

  const searchOpts = {
    limit: Math.max(args.limit, candidatePool, rerankWindow ?? 0),
    validAt: args.validAt,
    ...(args.filters !== undefined ? { filters: args.filters } : {}),
  };
  const vectorSearch = deps.storage.search(queryEmbedding, searchOpts);

  // An active arm always implies its own config — the lexical arm implies
  // `retrieveConfig`, the graph arm implies `graphConfig` — so the
  // `weights === undefined` half is unreachable at runtime. It is what
  // narrows `weights` for the `rrfFuse` call below.
  if (!fusing || weights === undefined) {
    // Vector-only: chunks flow through unchanged unless a reranker is wired.
    const retrieved = await vectorSearch;
    const reranked = await maybeRerank(
      toFusedFromRetrieved(retrieved),
      args,
      deps.retrieveConfig,
      reranker
    );
    return buildEnvelope(reranked.hits, reranked.degraded, undefined);
  }

  // Every optional arm is launched before the first await so they overlap
  // rather than run in series. Each is wrapped fail-open, so none can
  // reject and take the vector results down with it.
  const pending: Array<Promise<ArmResult>> = [];
  if (lexical !== undefined) {
    pending.push(runLexicalArmSafe(lexical, args.query, searchOpts));
  }
  if (graph !== undefined) {
    pending.push(
      runGraphArmSafe(
        queryEmbedding,
        { storage: graph.seed, config: graph.config },
        new Date(args.validAt)
      )
    );
  }
  // The Neo4j arm is awaited on its own handle, not merged into `pending`:
  // graph priority is bound to THIS arm's result object, and the archived
  // SQL arm above answers to the same arm name.
  const neo4jPending =
    neo4jGraph !== undefined
      ? runNeo4jGraphArm(queryEmbedding, neo4jGraph, args.validAt)
      : undefined;

  const [retrieved, weighted, neo4jResult] = await Promise.all([
    vectorSearch,
    Promise.all(pending),
    neo4jPending,
  ]);

  const optional =
    neo4jResult === undefined ? weighted : [...weighted, neo4jResult];
  const fused = assembleGraphPriority(
    neo4jResult,
    [toVectorResult(retrieved), ...weighted],
    weights,
    rerankWindow ?? args.limit
  );
  const reranked = await maybeRerank(
    fused,
    args,
    deps.retrieveConfig,
    reranker
  );
  return buildEnvelope(
    reranked.hits,
    mergeDegraded(degradedFlag(optional), reranked.degraded),
    buildDebug(deps.debug, retrieved.length, optional)
  );
}

/**
 * `degraded` marks an arm that was ATTEMPTED and could not deliver: a
 * lexical arm that threw, or a graph arm that threw or under-floored. An
 * arm that simply found nothing has not degraded, and neither has one the
 * operator turned off — those never reach this function.
 */
function degradedFlag(optional: ArmResult[]): true | undefined {
  return optional.some((arm) => arm.belowFloor) ? true : undefined;
}

function mergeDegraded(
  arm: true | undefined,
  rerank: true | undefined
): true | undefined {
  return arm === true || rerank === true ? true : undefined;
}

/** Enable-on without a wired adapter is a skip, not degraded. */
function getReranker(deps: AssembleDeps): ChunkReranker | undefined {
  if (deps.retrieveConfig?.rerankEnabled !== true) return undefined;
  return deps.reranker;
}

function toFusedFromRetrieved(retrieved: RetrievedChunk[]): FusedHit[] {
  return retrieved.map((r) => ({
    id: r.id,
    content: r.content,
    source_ref: r.source_ref,
    valid_window: r.valid_window,
    rrfScore: r.score,
    arms: ["vector"],
  }));
}

/**
 * Embed the query into the single vector both arms share.
 *
 * An embedder that resolves without a usable vector (empty batch, or a
 * zero-length vector) is a failure, not a degradation: `undefined` would
 * otherwise flow into `storage.search` and `runGraphArm` and surface as a
 * downstream TypeError or a silently unfiltered search. Raising the typed
 * `EMBEDDING_FAILED` here keeps the pre-lever contract — embed failure
 * propagates before either arm starts — and leaves the graph arm's
 * fail-open degradation contract for graph-arm failures only.
 */
async function embedQuery(
  embedder: EmbeddingClient,
  query: string
): Promise<number[]> {
  const [queryEmbedding] = await embedder.embed([query]);
  if (queryEmbedding === undefined || queryEmbedding.length === 0) {
    throw new GraphragError(
      "query embedding empty: embedder returned no usable vector for the retrieve query",
      "EMBEDDING_FAILED"
    );
  }
  return queryEmbedding;
}

/**
 * Resolve the graph-arm seam. Returns undefined when ANY of the three
 * prerequisites is missing: graphConfig unset, backend type not narrowable
 * to `GraphRagStorageBackend`, or backend not carrying `graphArmSeed`.
 */
function getGraphSeed(
  deps: AssembleDeps
): { seed: GraphArmStorage; config: RetrieveConfig } | undefined {
  if (deps.graphConfig === undefined) return undefined;
  // Narrow the chunk-only contract to the optional graph-rag seam. The
  // runtime guard is `"graphArmSeed" in`; the cast just teaches TS that a
  // backend exposing the key implements GraphRagStorageBackend.
  if (!("graphArmSeed" in deps.storage)) return undefined;
  const rag = deps.storage as GraphRagStorageBackend;
  if (rag.graphArmSeed === undefined) return undefined;
  return { seed: rag.graphArmSeed, config: deps.graphConfig };
}

/**
 * Resolve the production Neo4j graph arm. Returns undefined — "do not run
 * it", NOT "it failed" — when any of the three prerequisites is missing:
 *
 *   - no `retrieveConfig`, or the operator set `graphEnabled=false` (SC9);
 *   - no `graphRanker`, which is how "no Neo4j URI configured" reaches
 *     this layer (SC7). The distinction the spec insists on lives here:
 *     cannot attempt ≠ failed attempt, so neither case sets `degraded`;
 *   - the backend has no `neo4jArmSeed` seam (MemoryBackend).
 *
 * The gate reads `deps.retrieveConfig` only, never `graphConfig`: opting
 * into the archived SQL arm must not switch the production arm on.
 */
function getNeo4jGraphArm(deps: AssembleDeps): Neo4jGraphArmDeps | undefined {
  const config = deps.retrieveConfig;
  if (config === undefined || !config.graphEnabled) return undefined;
  if (deps.graphRanker === undefined) return undefined;
  if (!supportsNeo4jArm(deps.storage)) return undefined;
  return {
    storage: deps.storage.neo4jArmSeed,
    ranker: deps.graphRanker,
    config,
  };
}

/**
 * Resolve the BM25 arm. Returns undefined — meaning "do not run it", NOT
 * "it failed" — when any prerequisite is missing: no `retrieveConfig`, the
 * operator disabled it, or the backend has no lexical seam. None of those
 * set `degraded`, because none of them is an attempt.
 *
 * The gate reads `deps.retrieveConfig` and nothing else. Falling back to
 * `graphConfig` would let a caller who only opted into the archived graph
 * arm (#58) turn on a lexical arm it never asked for, and `graphConfig`
 * carries a `bm25Enabled` field purely because both share `RetrieveConfig`.
 */
function getLexicalArm(deps: AssembleDeps): LexicalStorageBackend | undefined {
  const config = deps.retrieveConfig;
  if (config === undefined || !config.bm25Enabled) return undefined;
  if (!supportsLexicalSearch(deps.storage)) return undefined;
  return deps.storage;
}

/**
 * Run the BM25 arm, converting a throw into a degraded empty result.
 * Ranks are 1-based positions in the arm's own output — RRF fuses on
 * those, never on the backend-specific lexical score.
 */
async function runLexicalArmSafe(
  storage: LexicalStorageBackend,
  query: string,
  opts: { limit: number; validAt: string; filters?: Record<string, string> }
): Promise<ArmResult> {
  try {
    const hits = await storage.searchLexical(query, opts);
    return {
      arm: "bm25",
      hits: hits.map((hit, i) => toArmHit(hit, "bm25", i)),
      belowFloor: false,
    };
  } catch (err) {
    // EXIT: degraded:true + failureReason 上行 envelope，调用方可见
    return {
      arm: "bm25",
      hits: [],
      belowFloor: true,
      failureReason: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Wrap `runGraphArm` so an unexpected throw degrades instead of rejecting.
 * This is what keeps `Promise.all` fail-open: the vector arm's results
 * survive any graph-arm failure.
 */
async function runGraphArmSafe(
  queryEmbedding: number[],
  deps: GraphArmDeps,
  now: Date
): Promise<ArmResult> {
  try {
    return await runGraphArm(queryEmbedding, deps, now);
  } catch (err) {
    // EXIT: degraded:true + failureReason 上行 envelope，调用方可见
    return {
      arm: "graph",
      hits: [],
      belowFloor: true,
      failureReason: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Project RetrievedChunk[] into the vector arm's `ArmResult`. */
function toVectorResult(retrieved: RetrievedChunk[]): ArmResult {
  return {
    arm: "vector",
    hits: retrieved.map((r, i) => toArmHit(r, "vector", i)),
    belowFloor: false,
  };
}

/** Single arm hit — rank is the 1-based position in that arm's output. */
function toArmHit(r: RetrievedChunk, arm: ArmName, i: number): ArmHit {
  return {
    id: r.id,
    arm,
    rank: i + 1,
    score: r.score,
    content: r.content,
    source_ref: r.source_ref,
    valid_window: r.valid_window,
  };
}

/** Project FusedHit[] into the envelope chunk shape; score = rrfScore. */
function projectFused(hit: FusedHit): RetrieveOutputEnvelope["chunks"][number] {
  return {
    id: hit.id,
    content: hit.content,
    source_ref: hit.source_ref,
    valid_window: hit.valid_window,
    score: hit.rrfScore,
  };
}

/**
 * Build the output envelope, adding `degraded` / `debug` keys only when
 * their values are non-undefined. This is what keeps the empty-DB /
 * vector-only path EXACTLY `{ chunks: [...] }` (Success Criterion #4).
 */
function buildEnvelope(
  fused: FusedHit[],
  degraded: true | undefined,
  debug: Record<string, unknown> | undefined
): RetrieveOutputEnvelope {
  const out: RetrieveOutputEnvelope = { chunks: fused.map(projectFused) };
  if (degraded !== undefined) out.degraded = degraded;
  if (debug !== undefined) out.debug = debug;
  return out;
}

/**
 * Build the debug payload gated on `DEBUG=1`. Shape is intentionally
 * loose (Record<string, unknown>) so a new arm can add fields without
 * breaking the envelope type.
 *
 * Only arms that actually ran get keys, so an operator reading the
 * payload can tell "the BM25 arm found nothing" (`bm25Hits: 0`) apart
 * from "the BM25 arm never ran" (no `bm25Hits` key at all).
 */
function buildDebug(
  enabled: boolean | undefined,
  vectorHits: number,
  optional: ArmResult[]
): Record<string, unknown> | undefined {
  if (!enabled) return undefined;
  const debug: Record<string, unknown> = { vectorHits };
  for (const arm of optional) {
    debug[`${arm.arm}Hits`] = arm.hits.length;
    if (arm.arm === "graph") debug["graphBelowFloor"] = arm.belowFloor;
    if (arm.failureReason !== undefined) {
      debug[`${arm.arm}FailureReason`] = arm.failureReason;
      // Retained under its legacy key: the graph-arm e2e suites and the
      // p0 runbooks both read `failureReason`.
      if (arm.arm === "graph") debug["failureReason"] = arm.failureReason;
    }
  }
  return debug;
}
