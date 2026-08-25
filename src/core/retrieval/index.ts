/**
 * T5 retrieval orchestrator — vector arm + graph arm + RRF fusion + envelope.
 *
 * Public entry point: `assembleRetrievalResult(args, deps)`. The function is
 * the single wire between the retrieve tool (`src/tools/retrieve.ts`) and the
 * retrieval bounded context (`src/core/retrieval/*`). It does NOT own any
 * state and does NOT mutate `deps`; both arms are pure with respect to the
 * caller.
 *
 * Boundary contract (spec-3 p0-integration):
 *   - storage with `graphArmSeed?: GraphArmStorage` (the one PgvectorBackend
 *     implements; MemoryBackend stays plain) → RRF fusion path.
 *   - storage without `graphArmSeed` → vector-only path → envelope is
 *     EXACTLY `{ chunks: RetrievedChunk[] }` with no `degraded` / `debug`
 *     keys (Success Criterion #4).
 *
 * The query is embedded once here and the vector is passed into both arms,
 * which then run concurrently (G5 levers, spec p0-wiring-closure A12). An
 * embedder that yields no usable vector raises `GraphragError`
 * ("EMBEDDING_FAILED") before either arm starts — it is never fail-open.
 *
 * The graph arm is fail-open: storage errors become `belowFloor: true` with
 * a `failureReason`, and `runGraphArmSafe` catches anything unexpected so a
 * graph failure can never reject the fused call.
 */
import { rrfFuse } from "./rrf.js";
import { runGraphArm, type GraphArmDeps } from "./graph-arm.js";
import type {
  ArmHit,
  ArmResult,
  FusedHit,
  GraphArmStorage,
  RetrieveConfig,
  RetrieveOutputEnvelope,
} from "./types.js";
import type { RetrievedChunk, StorageBackend } from "../types.js";
import type { GraphRagStorageBackend } from "../storage/backend.js";
import type { EmbeddingClient } from "../embedder.js";
import { GraphragError } from "../errors.js";

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
 * `graphConfig` is optional so the tool can defer wiring to a future
 * ticket (T6/T7). When omitted, the orchestrator skips the graph arm
 * regardless of whether `storage.graphArmSeed` exists (no graph config =
 * no fusion).
 */
export interface AssembleDeps {
  embedder: EmbeddingClient;
  /** May or may not carry `graphArmSeed` (see `GraphRagStorageBackend`). */
  storage: StorageBackend;
  graphConfig?: RetrieveConfig;
  /** Injectable debug gate; wired to `DEBUG=1` by the tool. */
  debug?: boolean;
}

export async function assembleRetrievalResult(
  args: AssembleArgs,
  deps: AssembleDeps
): Promise<RetrieveOutputEnvelope> {
  // One embed per retrieve (G5 lever (a)): the same vector feeds the vector
  // search and the graph arm's seed lookup. Embed failure keeps its
  // pre-lever behavior — it propagates before either arm starts.
  const queryEmbedding = await embedQuery(deps.embedder, args.query);
  const vectorSearch = deps.storage.search(queryEmbedding, {
    limit: args.limit,
    validAt: args.validAt,
    ...(args.filters !== undefined ? { filters: args.filters } : {}),
  });

  const graph = getGraphSeed(deps);
  if (graph === undefined) {
    // Vector-only: chunks flow through unchanged. RetrievedChunk is
    // already structurally identical to the envelope chunk shape, so no
    // projection is needed for the empty-extra-keys contract.
    return { chunks: await vectorSearch };
  }

  // Concurrent arms (G5 lever (b)). The graph arm is wrapped fail-open, so
  // it never rejects and can never take the vector results down with it.
  const [retrieved, graphResult] = await Promise.all([
    vectorSearch,
    runGraphArmSafe(
      queryEmbedding,
      { storage: graph.seed, config: graph.config },
      new Date(args.validAt)
    ),
  ]);

  const fused = rrfFuse(
    toVectorResult(retrieved),
    graphResult,
    graph.config,
    args.limit
  );
  const degraded = graphResult.belowFloor ? (true as const) : undefined;
  const debug = buildDebug(deps.debug, retrieved.length, graphResult);
  return buildEnvelope(fused, degraded, debug);
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
    hits: retrieved.map((r, i) => toVectorHit(r, i)),
    belowFloor: false,
  };
}

/** Single vector hit — rank is 1-based position in the search output. */
function toVectorHit(r: RetrievedChunk, i: number): ArmHit {
  return {
    id: r.id,
    arm: "vector",
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
 * loose (Record<string, unknown>) so future arms can add fields without
 * breaking the envelope type.
 */
function buildDebug(
  enabled: boolean | undefined,
  vectorHits: number,
  graph: ArmResult
): Record<string, unknown> | undefined {
  if (!enabled) return undefined;
  const debug: Record<string, unknown> = {
    vectorHits,
    graphHits: graph.hits.length,
    graphBelowFloor: graph.belowFloor,
  };
  if (graph.failureReason !== undefined)
    debug["failureReason"] = graph.failureReason;
  return debug;
}
