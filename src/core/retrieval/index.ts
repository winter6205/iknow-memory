/**
 * Retrieval orchestrator — vector arm ∥ optional arms + ranking + envelope.
 *
 * Public entry point: `assembleRetrievalResult(args, deps)`. The function is
 * the single wire between the retrieve tool (`src/tools/retrieve.ts`) and the
 * retrieval bounded context (`src/core/retrieval/*`). It does NOT own any
 * state and does NOT mutate `deps`.
 *
 * Arms:
 *   - **vector** always runs; its failure is released only when another
 *     eligible arm succeeds, otherwise the call returns a typed error.
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
 * The wire envelope contains only `chunks` plus optional degradation fields.
 * Debug diagnostics are retained as non-enumerable internal metadata for the
 * offline evaluator, so they cannot leak into the MCP JSON payload.
 *
 * The query is embedded once when credentials are available and the vector
 * feeds every arm that needs it. Missing credentials are unattempted;
 * configured providers that fail are fail-open when another arm can answer.
 *
 * Optional arms are fail-open: each is wrapped so a throw becomes an empty
 * `ArmResult` carrying a `failureReason`; the central capability registry
 * turns that observation into a named `degraded_reasons` entry while any
 * successful arm's results still reach the caller.
 */
import { assembleGraphPriority } from "./graph-priority.js";
import { RRF_K } from "./rrf.js";
import { maybeRerank, rerankWindowSize } from "./rerank.js";
import {
  hasOptionalArms,
  resolveOptionalArms,
  runOptionalArms,
  selectRetrievalResults,
} from "./optional-arms.js";
import type { OptionalArmResults } from "./optional-arms.js";
import { CAPABILITY_REGISTRY } from "./types.js";
import type {
  ArmResult,
  ArmName,
  CapabilityObservation,
  DegradedCapability,
  ChunkReranker,
  DegradedReason,
  FusedHit,
  GraphRanker,
  NeighborChunkRow,
  ProjectionDrainWaiter,
  RetrieveConfig,
  RetrieveOutputEnvelope,
} from "./types.js";
import type { EntityLexicalStorage } from "./types.js";
import type {
  RetrievedChunk,
  SearchOptions,
  StorageBackend,
} from "../types.js";
import {
  supportsNeighborChunks,
  supportsProjectionDrain,
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
 * Exported so the 档 A arm (mode-a-arm.ts) fetches children at the same
 * depth instead of duplicating the constant.
 */
export const ARM_CANDIDATE_POOL = 50;
const DEFAULT_WAIT_FOR_DRAIN_TIMEOUT_MS = 5_000;

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
  /** Optional Elasticsearch precision-layer chunk search. */
  lexical?: import("../storage/backend.js").LexicalStorageBackend;
  /** Optional Elasticsearch precision-layer entity search. */
  entityLexical?: EntityLexicalStorage;
  /** Hybrid retrieval config. Absent → vector-only. */
  retrieveConfig?: RetrieveConfig;
  /** Opt-in archived graph arm; absent on the production path. */
  graphConfig?: RetrieveConfig;
  /**
   * Neo4j PPR ranker, wired only when a sidecar URI is configured. Absent
   * while graph is default-on is an unattempted capability and is marked
   * `degraded` by the central envelope decision.
   */
  graphRanker?: GraphRanker;
  /**
   * Temporary LLM reranker, wired only when rerank is enabled AND the
   * Anthropic trio is complete. Absent + enable-on is unattempted and is
   * marked `degraded` by the central envelope decision.
   */
  reranker?: ChunkReranker;
  /** Injectable debug gate; wired to `DEBUG=1` by the tool. */
  debug?: boolean;
  /**
   * Injected capability observations make unavailable/failing capabilities
   * testable without changing production arm defaults. The final envelope
   * decision still comes from the central registry below.
   */
  capabilityObservations?: readonly CapabilityObservation[];
  /** Optional read-only projection outbox wait seam. */
  projectionDrain?: ProjectionDrainWaiter;
}

interface AssemblyResult {
  hits: FusedHit[];
  observations: CapabilityObservation[];
  debug: Record<string, unknown> | undefined;
}

interface VectorSearchOutcome {
  retrieved: RetrievedChunk[];
  failureReason?: string;
  failureState?: "unattempted" | "attempted-and-failed";
  failureCode?: GraphragError["code"];
}

interface QueryEmbeddingOutcome {
  embedding?: number[];
  failureReason?: string;
  failureState?: "unattempted" | "attempted-and-failed";
  failureCode?: GraphragError["code"];
}

const ARM_CAPABILITY: Readonly<Record<ArmName, DegradedCapability>> = {
  vector: "vector",
  bm25: "keyword_bm25",
  graph: "graph_ppr",
  "node-embedding": "node_embedding",
  "community-summary": "community_summary",
};

export async function assembleRetrievalResult(
  args: AssembleArgs,
  deps: AssembleDeps
): Promise<RetrieveOutputEnvelope> {
  // One embed per retrieve when credentials are available: the same vector
  // feeds the vector search and the graph arm's seed lookup. Missing
  // credentials skip this call entirely; a configured provider that throws
  // is converted to an attempted-and-failed vector outcome.
  const queryEmbedding = await resolveQueryEmbedding(deps.embedder, args.query);
  const embedding = queryEmbedding.embedding;

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

  const searchOpts: SearchOptions = {
    limit: Math.max(args.limit, candidatePool, rerankWindow ?? 0),
    validAt: args.validAt,
    ...(args.filters !== undefined ? { filters: args.filters } : {}),
    ...(deps.retrieveConfig !== undefined
      ? { precision: precisionSearchOptions(deps.retrieveConfig) }
      : {}),
  };
  const vectorSearch =
    embedding === undefined
      ? Promise.resolve({
          retrieved: [],
          failureReason: queryEmbedding.failureReason,
          failureState: queryEmbedding.failureState,
          failureCode: queryEmbedding.failureCode,
        })
      : resolveVectorSearch(
          startVectorSearch(deps.storage, embedding, searchOpts)
        );

  // An active arm always implies its own config — the lexical arm implies
  // `retrieveConfig`, the graph arm implies `graphConfig` — so the
  // `weights === undefined` half is unreachable at runtime. It is what
  // narrows `weights` for the `rrfFuse` call below.
  if (!fusing || weights === undefined) {
    const vector = await vectorSearch;
    // T12: an unattempted vector arm (embedding credentials absent) is a
    // skipped capability, not a failure — a degraded empty envelope is the
    // contract, matching the fused path. Only an attempted-and-failed arm
    // with no surviving partner arm escalates to all-arms-failed. The ES
    // precision layer made this combination reachable on the production
    // path: pgvector no longer carries a lexical arm, so unconfigured ES +
    // unconfigured embeddings leaves vector as the sole arm.
    if (
      vector.failureReason !== undefined &&
      vector.failureState !== "unattempted"
    ) {
      throw allArmsFailed(vector);
    }
    const result = await assembleVectorOnlyResult(
      vector.retrieved,
      args,
      deps,
      reranker
    );
    const waited = await waitForProjectionDrain(result, deps);
    return buildEnvelope(
      waited.hits,
      [
        // Mirror assembleFusedResult: surface the skipped vector arm so the
        // degraded envelope names it (vector:unattempted).
        ...(vector.failureReason !== undefined
          ? [
              observation(
                "vector",
                vector.failureState ?? "attempted-and-failed"
              ),
            ]
          : []),
        ...waited.observations,
        ...arms.observations,
        ...(deps.capabilityObservations ?? []),
      ],
      waited.debug
    );
  }

  const [vector, optionalResults] = await Promise.all([
    vectorSearch,
    runOptionalArms(embedding, args, searchOpts, arms),
  ]);
  if (shouldRejectAllArms(vector, optionalResults)) {
    throw allArmsFailed(vector, optionalResults);
  }
  const result = await assembleFusedResult(vector.retrieved, optionalResults, {
    args,
    deps,
    reranker,
    rerankWindow,
    weights,
    vectorFailureReason: vector.failureReason,
    vectorFailureState: vector.failureState,
  });
  const waited = await waitForProjectionDrain(result, deps);
  return buildEnvelope(
    waited.hits,
    [
      ...waited.observations,
      ...arms.observations,
      ...(deps.capabilityObservations ?? []),
    ],
    waited.debug
  );
}

function startVectorSearch(
  storage: StorageBackend,
  embedding: number[],
  options: SearchOptions
): Promise<RetrievedChunk[]> {
  try {
    return storage.search(embedding, options);
  } catch (err) {
    return Promise.reject(err);
  }
}

async function resolveVectorSearch(
  search: Promise<RetrievedChunk[]>
): Promise<VectorSearchOutcome> {
  try {
    return { retrieved: await search };
  } catch (err) {
    return {
      retrieved: [],
      failureReason: failureMessage(err),
      failureState: "attempted-and-failed",
      failureCode: err instanceof GraphragError ? err.code : undefined,
    };
  }
}

function shouldRejectAllArms(
  vector: VectorSearchOutcome,
  optional: OptionalArmResults
): boolean {
  if (vector.failureReason === undefined) return false;
  const optionalArms = optionalResultsList(optional);
  const graphArms = optionalArms.filter((arm) => arm.arm === "graph");
  if (graphArms.length > 0 && graphArms.every((arm) => arm.hits.length === 0)) {
    return true;
  }
  return optionalArms.every((arm) => arm.belowFloor);
}

function allArmsFailed(
  vector: VectorSearchOutcome,
  optional?: OptionalArmResults
): GraphragError {
  const failures = [
    ...(vector.failureReason === undefined
      ? []
      : [`vector: ${vector.failureReason}`]),
    ...(optional === undefined
      ? []
      : optionalResultsList(optional)
          .filter((arm) => arm.belowFloor)
          .map(
            (arm) =>
              `${arm.arm}: ${arm.failureReason ?? "arm could not deliver"}`
          )),
  ];
  const graphArms =
    optional === undefined
      ? []
      : optionalResultsList(optional).filter((arm) => arm.arm === "graph");
  if (
    vector.failureReason !== undefined &&
    graphArms.length > 0 &&
    graphArms.every((arm) => arm.hits.length === 0)
  ) {
    failures.push("graph: no hit while vector fallback was unavailable");
  }
  return new GraphragError(
    `all retrieval arms failed${failures.length > 0 ? `: ${failures.join("; ")}` : ""}`,
    vector.failureCode ?? "STORAGE_ERROR"
  );
}

function optionalResultsList(optional: OptionalArmResults): ArmResult[] {
  return [
    ...optional.weighted,
    ...(optional.neo4j === undefined ? [] : [optional.neo4j]),
    ...(optional.nodeEmbedding === undefined ? [] : [optional.nodeEmbedding]),
    ...(optional.communitySummary === undefined
      ? []
      : [optional.communitySummary]),
  ];
}

function failureMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Waiting happens after ranking so a timeout or outbox error can return the
 * answer already assembled for this request. The wait port is read-only:
 * another process owns the Neo4j-writing drain.
 */
async function waitForProjectionDrain(
  result: AssemblyResult,
  deps: AssembleDeps
): Promise<AssemblyResult> {
  if (deps.retrieveConfig?.waitForDrainEnabled !== true) return result;

  const waiter = deps.projectionDrain ?? getProjectionDrain(deps.storage);
  if (waiter === undefined) {
    // EXIT: configured wait without an observation seam cannot be fulfilled;
    // preserve the ranking and expose the optional-path degradation.
    return withObservation(result, "projection_drain", "attempted-and-failed");
  }

  const timeoutMs =
    deps.retrieveConfig.waitForDrainTimeoutMs ??
    DEFAULT_WAIT_FOR_DRAIN_TIMEOUT_MS;
  try {
    await withTimeout(waiter.waitForProjectionDrain(timeoutMs), timeoutMs);
    return result;
  } catch {
    // EXIT: fail-open — return the pre-wait ranking and mark it degraded.
    return withObservation(result, "projection_drain", "attempted-and-failed");
  }
}

function getProjectionDrain(
  storage: StorageBackend
): ProjectionDrainWaiter | undefined {
  return supportsProjectionDrain(storage) ? storage : undefined;
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new GraphragError(
                "projection drain wait timed out",
                "STORAGE_ERROR"
              )
            ),
          timeoutMs
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

interface FusedAssemblyContext {
  args: AssembleArgs;
  deps: AssembleDeps;
  reranker: ChunkReranker | undefined;
  rerankWindow: number | undefined;
  weights: RetrieveConfig;
  vectorFailureReason?: string;
  vectorFailureState?: "unattempted" | "attempted-and-failed";
}

async function assembleVectorOnlyResult(
  retrieved: RetrievedChunk[],
  args: AssembleArgs,
  deps: AssembleDeps,
  reranker: ChunkReranker | undefined
): Promise<AssemblyResult> {
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
  return {
    hits: neighbors.hits,
    observations: [
      ...(reranked.unattempted === true
        ? [observation("rerank", "unattempted")]
        : []),
      ...(reranked.degraded === true
        ? [observation("rerank", "attempted-and-failed")]
        : []),
      ...(neighbors.failed
        ? [observation("neighbor_evidence", "attempted-and-failed")]
        : []),
    ],
    debug: undefined,
  };
}

async function assembleFusedResult(
  retrieved: RetrievedChunk[],
  optionalResults: OptionalArmResults,
  context: FusedAssemblyContext
): Promise<AssemblyResult> {
  const {
    args,
    deps,
    reranker,
    rerankWindow,
    weights,
    vectorFailureReason,
    vectorFailureState,
  } = context;
  const { optional, communityPriority, graphPriority, remainder } =
    selectRetrievalResults(retrieved, optionalResults);
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
  const prioritized = prependCommunityPriority(
    communityPriority,
    reranked.hits,
    args.limit,
    graphPriority?.hits.length ?? 0
  );
  const neighbors = await expandNeighborEvidence(
    prioritized,
    args,
    deps.retrieveConfig,
    deps.storage
  );
  return {
    hits: neighbors.hits,
    observations: [
      ...(vectorFailureReason !== undefined
        ? [observation("vector", vectorFailureState ?? "attempted-and-failed")]
        : []),
      ...observationsFromOptional(optional),
      ...optionalResults.observations,
      ...(reranked.unattempted === true
        ? [observation("rerank", "unattempted")]
        : []),
      ...(reranked.degraded === true
        ? [observation("rerank", "attempted-and-failed")]
        : []),
      ...(neighbors.failed
        ? [observation("neighbor_evidence", "attempted-and-failed")]
        : []),
    ],
    debug: buildDebug(
      deps.debug,
      retrieved.length,
      optional,
      vectorFailureReason
    ),
  };
}

/**
 * Convert arm outcomes into typed observations. The arm implementations only
 * report their local delivery outcome; this function does not decide the wire
 * flag or construct a reason string.
 */
function observationsFromOptional(
  optional: readonly ArmResult[]
): CapabilityObservation[] {
  return optional.flatMap((arm) => [
    ...(arm.observations ?? []),
    ...(arm.belowFloor
      ? [observation(ARM_CAPABILITY[arm.arm], "attempted-and-failed")]
      : []),
  ]);
}

/**
 * The one observation shape, built in one place. Exported for the 档 arms
 * (review I3): they own their capabilities' states but must not own a
 * second factory each — same precedent as `buildEnvelope` and
 * `ARM_CANDIDATE_POOL`.
 */
export function observation(
  capability: DegradedCapability,
  state: CapabilityObservation["state"]
): CapabilityObservation {
  return { capability, state };
}

function withObservation(
  result: AssemblyResult,
  capability: DegradedCapability,
  state: CapabilityObservation["state"]
): AssemblyResult {
  return {
    ...result,
    observations: [...result.observations, observation(capability, state)],
  };
}

interface NeighborOutcome {
  hits: FusedHit[];
  failed: boolean;
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
    return { hits: [...hits], failed: false };
  }
  if (!Number.isInteger(width) || width < 0) {
    throw new GraphragError(
      `neighborWidth must be a non-negative integer, got ${width}`,
      "INVALID_INPUT"
    );
  }
  if (!supportsNeighborChunks(storage)) {
    return { hits: [...hits], failed: false };
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
      failed: false,
    };
  } catch {
    // EXIT: fail-open — 保留已排名结果，并通过 degraded:true 告知调用方
    return { hits: [...hits], failed: true };
  }
}

function normalizeNeighborWindow(
  row: NeighborChunkRow | RetrievedChunk
): [string, string | null] {
  return "valid_window" in row
    ? row.valid_window
    : [row.valid_from, row.valid_until];
}

/** Return the adapter only when the caller explicitly enabled reranking. */
function getReranker(deps: AssembleDeps): ChunkReranker | undefined {
  if (deps.retrieveConfig?.rerankEnabled !== true) return undefined;
  return deps.reranker;
}

function precisionSearchOptions(
  config: RetrieveConfig
): NonNullable<SearchOptions["precision"]> {
  return {
    ...(config.k1 !== undefined ? { k1: config.k1 } : {}),
    ...(config.b !== undefined ? { b: config.b } : {}),
    ...(config.cjkSegmentationEnabled !== undefined
      ? { cjkSegmentation: config.cjkSegmentationEnabled }
      : {}),
    ...(config.phraseEnabled !== undefined
      ? { phrase: config.phraseEnabled }
      : {}),
    ...(config.fieldBoostEnabled !== undefined
      ? { fieldBoost: config.fieldBoostEnabled }
      : {}),
    ...(config.fieldBoosts !== undefined
      ? { fieldBoosts: config.fieldBoosts }
      : {}),
  };
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
 * Missing credentials are represented by an unavailable embedder and skip
 * the call. A configured embedder that throws, or returns no usable vector,
 * is captured as an attempted-and-failed vector outcome so lexical retrieval
 * can still release a marked partial response.
 */
async function resolveQueryEmbedding(
  embedder: EmbeddingClient,
  query: string
): Promise<QueryEmbeddingOutcome> {
  if (embedder.available === false) {
    return {
      failureReason: "embedding credentials are not configured",
      failureState: "unattempted",
    };
  }
  try {
    return { embedding: await embedQuery(embedder, query) };
  } catch (err) {
    return {
      failureReason: failureMessage(err),
      failureState: "attempted-and-failed",
      failureCode: err instanceof GraphragError ? err.code : undefined,
    };
  }
}

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
  const chunk: RetrieveOutputEnvelope["chunks"][number] = {
    id: hit.id,
    content: hit.content,
    source_ref: hit.source_ref,
    valid_window: hit.valid_window,
    score: hit.rrfScore,
  };
  if (hit.metadata !== undefined) chunk.metadata = hit.metadata;
  return chunk;
}

/** Put enabled community summaries after the graph-priority prefix. */
function prependCommunityPriority(
  summary: ArmResult | undefined,
  ranked: FusedHit[],
  limit: number,
  graphPriorityLength: number
): FusedHit[] {
  const summaryHits = summary?.hits ?? [];
  if (summaryHits.length === 0) return ranked;
  const topScore = ranked[0]?.rrfScore ?? 0;
  const placed = new Set(summaryHits.map((hit) => hit.id));
  const graphPrefix = ranked.slice(0, graphPriorityLength);
  const fill = ranked
    .slice(graphPriorityLength)
    .filter((hit) => !placed.has(hit.id));
  const lead: FusedHit[] = summaryHits.slice(0, limit).map((hit, i) => ({
    id: hit.id,
    content: hit.content,
    source_ref: hit.source_ref,
    valid_window: hit.valid_window,
    rrfScore: topScore + 1 / (RRF_K + i + 1),
    arms: [hit.arm],
    ...(hit.metadata !== undefined ? { metadata: hit.metadata } : {}),
  }));
  return [...graphPrefix, ...lead, ...fill].slice(0, limit);
}

/**
 * Build the output envelope from all observations in one place. This is the
 * sole decision point for the four degraded rules and the only place that
 * attaches the optional wire fields. Exported for the 档 A arm, which owns
 * a different ranking path but must not own a second envelope builder.
 */
export function buildEnvelope(
  fused: FusedHit[],
  observations: readonly CapabilityObservation[],
  debug: Record<string, unknown> | undefined
): RetrieveOutputEnvelope {
  const out: RetrieveOutputEnvelope = { chunks: fused.map(projectFused) };
  const degradedReasons = resolveDegradedReasons(observations);
  if (degradedReasons.length > 0) {
    out.degraded = true;
    out.degraded_reasons = degradedReasons;
  }
  if (debug !== undefined) {
    Object.defineProperty(out, "debug", {
      configurable: true,
      enumerable: false,
      value: debug,
    });
  }
  return out;
}

/**
 * Apply the registry's only four set rules. `disabled` and `succeeded`
 * observations intentionally produce no reason; an unattempted observation
 * qualifies only when the registry declares that capability default-on.
 */
function resolveDegradedReasons(
  observations: readonly CapabilityObservation[]
): DegradedReason[] {
  const selected = new Set<DegradedReason>();
  for (const item of observations) {
    const definition = CAPABILITY_REGISTRY[item.capability];
    if (definition === undefined) continue;
    if (item.state === "attempted-and-failed") {
      selected.add(definition.attemptedAndFailed);
    } else if (item.state === "unattempted" && definition.defaultOn) {
      selected.add(definition.unattempted);
    }
  }

  return (Object.keys(CAPABILITY_REGISTRY) as DegradedCapability[]).flatMap(
    (capability) => {
      const definition = CAPABILITY_REGISTRY[capability];
      return [definition.unattempted, definition.attemptedAndFailed].filter(
        (reason) => selected.has(reason)
      );
    }
  );
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
  optional: ArmResult[],
  vectorFailureReason?: string
): Record<string, unknown> | undefined {
  if (!enabled) return undefined;
  const debug: Record<string, unknown> = { vectorHits };
  if (vectorFailureReason !== undefined) {
    debug.vectorFailureReason = vectorFailureReason;
  }
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
