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
 *   - **node embedding** optionally seeds and scores entities from the
 *     Postgres ledger, then maps them directly to chunks.
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
import {
  hasOptionalArms,
  resolveOptionalArms,
  runOptionalArms,
  selectRetrievalResults,
} from "./optional-arms.js";
import type { OptionalArmResults } from "./optional-arms.js";
import type {
  ArmResult,
  ChunkReranker,
  FusedHit,
  GraphRanker,
  NeighborChunkRow,
  RetrieveConfig,
  RetrieveOutputEnvelope,
} from "./types.js";
import type { RetrievedChunk, StorageBackend } from "../types.js";
import { supportsNeighborChunks } from "../storage/backend.js";
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

  // Fusion weights may fall back to the archived graph config. Optional-arm
  // gates themselves remain owned by their production/archived configs.
  const weights = deps.retrieveConfig ?? deps.graphConfig;
  const arms = resolveOptionalArms(deps);
  const fusing = hasOptionalArms(arms);
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
    return assembleVectorOnlyResult(vectorSearch, args, deps, reranker);
  }

  const [retrieved, optionalResults] = await Promise.all([
    vectorSearch,
    runOptionalArms(queryEmbedding, args, searchOpts, arms),
  ]);
  return assembleFusedResult(retrieved, optionalResults, {
    args,
    deps,
    reranker,
    rerankWindow,
    weights,
  });
}

interface FusedAssemblyContext {
  args: AssembleArgs;
  deps: AssembleDeps;
  reranker: ChunkReranker | undefined;
  rerankWindow: number | undefined;
  weights: RetrieveConfig;
}

async function assembleVectorOnlyResult(
  vectorSearch: Promise<RetrievedChunk[]>,
  args: AssembleArgs,
  deps: AssembleDeps,
  reranker: ChunkReranker | undefined
): Promise<RetrieveOutputEnvelope> {
  const retrieved = await vectorSearch;
  const reranked = await maybeRerank(
    toFusedFromRetrieved(retrieved),
    args,
    deps.retrieveConfig,
    reranker
  );
  const neighbors = await expandNeighborEvidence(
    reranked.hits,
    args,
    deps.retrieveConfig,
    deps.storage
  );
  return buildEnvelope(
    neighbors.hits,
    mergeDegraded(reranked.degraded, neighbors.degraded),
    undefined
  );
}

async function assembleFusedResult(
  retrieved: RetrievedChunk[],
  optionalResults: OptionalArmResults,
  context: FusedAssemblyContext
): Promise<RetrieveOutputEnvelope> {
  const { args, deps, reranker, rerankWindow, weights } = context;
  const { optional, graphPriority, remainder } = selectRetrievalResults(
    retrieved,
    optionalResults
  );
  const fused = assembleGraphPriority(
    graphPriority,
    remainder,
    weights,
    rerankWindow ?? args.limit
  );
  const reranked = await maybeRerank(
    fused,
    args,
    deps.retrieveConfig,
    reranker
  );
  const neighbors = await expandNeighborEvidence(
    reranked.hits,
    args,
    deps.retrieveConfig,
    deps.storage
  );
  return buildEnvelope(
    neighbors.hits,
    mergeDegraded(
      mergeDegraded(degradedFlag(optional), reranked.degraded),
      neighbors.degraded
    ),
    buildDebug(deps.debug, retrieved.length, optional)
  );
}

/**
 * `degraded` marks an arm that was ATTEMPTED and could not deliver: a
 * lexical arm that threw, a graph arm that threw or under-floored, or a
 * node-embedding read that threw. An arm that simply found nothing has not
 * degraded, and neither has one the
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

interface NeighborOutcome {
  hits: FusedHit[];
  degraded: true | undefined;
}

/**
 * Add same-source evidence after all ranking and reranking decisions.
 *
 * The ranked hits remain first; neighbors only fill otherwise-unused slots,
 * so the Host `limit` remains a hard cap. A backend without the optional
 * ledger seam skips this step, while a failed optional read preserves the
 * ranked answer and marks it degraded.
 */
async function expandNeighborEvidence(
  hits: readonly FusedHit[],
  args: AssembleArgs,
  config: RetrieveConfig | undefined,
  storage: StorageBackend
): Promise<NeighborOutcome> {
  const width = config?.neighborWidth ?? 0;
  if (width === 0 || hits.length === 0) {
    return { hits: [...hits], degraded: undefined };
  }
  if (!Number.isInteger(width) || width < 0) {
    throw new GraphragError(
      `neighborWidth must be a non-negative integer, got ${width}`,
      "INVALID_INPUT"
    );
  }
  if (!supportsNeighborChunks(storage)) {
    return { hits: [...hits], degraded: undefined };
  }

  try {
    const rows = await storage.chunksByChunkIds(
      hits.map((hit) => hit.id),
      args.validAt,
      width
    );
    const rankedIds = new Set(hits.map((hit) => hit.id));
    const anchorSources = new Set(hits.map((hit) => hit.source_ref));
    const evidence: FusedHit[] = [];
    for (const row of rows) {
      if (rankedIds.has(row.id) || !anchorSources.has(row.source_ref)) {
        continue;
      }
      rankedIds.add(row.id);
      evidence.push({
        id: row.id,
        content: row.content,
        source_ref: row.source_ref,
        valid_window: normalizeNeighborWindow(row),
        rrfScore: 0,
        arms: [],
      });
    }
    return {
      hits: [...hits, ...evidence].slice(0, args.limit),
      degraded: undefined,
    };
  } catch {
    // EXIT: fail-open — 保留已排名结果，并通过 degraded:true 告知调用方
    return { hits: [...hits], degraded: true };
  }
}

function normalizeNeighborWindow(
  row: NeighborChunkRow | RetrievedChunk
): [string, string | null] {
  return "valid_window" in row
    ? row.valid_window
    : [row.valid_from, row.valid_until];
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
