/**
 * Optional retrieval-arm orchestration.
 *
 * The public assembler owns embedding, vector search, reranking, and the
 * response envelope. This module owns optional-arm gates, concurrent starts,
 * fail-open conversion, and selection of the graph-priority result.
 */
import { runGraphArm, type GraphArmDeps } from "./graph-arm.js";
import {
  getNodeEmbeddingArm,
  startNodeEmbeddingArm,
  type NodeEmbeddingArmDeps,
} from "./node-embedding-arm.js";
import { runNeo4jGraphArm, type Neo4jGraphArmDeps } from "./neo4j-graph-arm.js";
import type {
  ArmHit,
  ArmName,
  ArmResult,
  CommunitySummaryStorage,
  GraphArmStorage,
  GraphRanker,
  RetrieveConfig,
} from "./types.js";
import type {
  RetrievedChunk,
  SearchOptions,
  StorageBackend,
} from "../types.js";
import {
  supportsLexicalSearch,
  supportsCommunitySummaries,
  supportsNeo4jArm,
  type GraphRagStorageBackend,
  type LexicalStorageBackend,
} from "../storage/backend.js";

export interface OptionalArmDeps {
  storage: StorageBackend;
  retrieveConfig?: RetrieveConfig;
  graphConfig?: RetrieveConfig;
  graphRanker?: GraphRanker;
}

export interface OptionalArmSet {
  lexical?: LexicalStorageBackend;
  graph?: { seed: GraphArmStorage; config: RetrieveConfig };
  neo4jGraph?: Neo4jGraphArmDeps;
  nodeEmbedding?: NodeEmbeddingArmDeps;
  communitySummaries?: CommunitySummaryStorage;
}

export interface OptionalArmResults {
  weighted: ArmResult[];
  neo4j?: ArmResult;
  nodeEmbedding?: ArmResult;
  communitySummary?: ArmResult;
}

export interface SelectedRetrievalResults {
  optional: ArmResult[];
  communityPriority: ArmResult | undefined;
  graphPriority: ArmResult | undefined;
  remainder: ArmResult[];
}

/** Resolve every optional arm without attempting an unavailable seam. */
export function resolveOptionalArms(deps: OptionalArmDeps): OptionalArmSet {
  const neo4jGraph = getNeo4jGraphArm(deps);
  return {
    lexical: getLexicalArm(deps),
    graph: neo4jGraph === undefined ? getGraphSeed(deps) : undefined,
    neo4jGraph,
    nodeEmbedding: getNodeEmbeddingArm(deps.retrieveConfig, deps.storage),
    communitySummaries: getCommunitySummaries(deps),
  };
}

export function hasOptionalArms(arms: OptionalArmSet): boolean {
  return (
    arms.lexical !== undefined ||
    arms.graph !== undefined ||
    arms.neo4jGraph !== undefined ||
    arms.nodeEmbedding !== undefined ||
    arms.communitySummaries !== undefined
  );
}

/**
 * Start all configured optional arms before awaiting any result, preserving
 * the retrieve latency contract that vector, lexical, graph, and embedding
 * reads overlap.
 */
export async function runOptionalArms(
  queryEmbedding: number[],
  query: { query: string; validAt: string },
  searchOpts: SearchOptions,
  arms: OptionalArmSet
): Promise<OptionalArmResults> {
  const weighted: Array<Promise<ArmResult>> = [];
  if (arms.lexical !== undefined) {
    weighted.push(runLexicalArmSafe(arms.lexical, query.query, searchOpts));
  }
  if (arms.graph !== undefined) {
    weighted.push(
      runGraphArmSafe(
        queryEmbedding,
        { storage: arms.graph.seed, config: arms.graph.config },
        new Date(query.validAt)
      )
    );
  }

  const neo4j =
    arms.neo4jGraph === undefined
      ? undefined
      : runNeo4jGraphArm(queryEmbedding, arms.neo4jGraph, query.validAt);
  const nodeEmbedding = startNodeEmbeddingArm(
    queryEmbedding,
    arms.nodeEmbedding,
    query.validAt
  );
  const communitySummary =
    arms.communitySummaries === undefined
      ? undefined
      : runCommunitySummarySafe(
          queryEmbedding,
          arms.communitySummaries,
          searchOpts.limit
        );
  const [
    weightedResults,
    neo4jResult,
    nodeEmbeddingResult,
    communitySummaryResult,
  ] = await Promise.all([
    Promise.all(weighted),
    neo4j,
    nodeEmbedding,
    communitySummary,
  ]);
  return {
    weighted: weightedResults,
    neo4j: neo4jResult,
    nodeEmbedding: nodeEmbeddingResult,
    communitySummary: communitySummaryResult,
  };
}

/**
 * Keep optional-arm output assembly in one place. Neo4j owns the priority
 * lead; direct node embedding is the fallback lead when Neo4j contributes
 * no chunks. Both remain visible in `optional` for degraded/debug output.
 */
export function selectRetrievalResults(
  retrieved: RetrievedChunk[],
  results: OptionalArmResults
): SelectedRetrievalResults {
  const optional = [
    ...results.weighted,
    ...(results.neo4j === undefined ? [] : [results.neo4j]),
    ...(results.nodeEmbedding === undefined ? [] : [results.nodeEmbedding]),
    ...(results.communitySummary === undefined
      ? []
      : [results.communitySummary]),
  ];
  const communityPriority =
    results.communitySummary?.hits.length === 0
      ? undefined
      : results.communitySummary;
  const graphPriority = selectGraphPriority(
    results.neo4j,
    results.nodeEmbedding
  );
  return {
    optional,
    communityPriority,
    graphPriority,
    remainder: [toVectorResult(retrieved), ...results.weighted],
  };
}

function selectGraphPriority(
  neo4j: ArmResult | undefined,
  nodeEmbedding: ArmResult | undefined
): ArmResult | undefined {
  if (neo4j !== undefined && neo4j.hits.length !== 0) return neo4j;
  if (nodeEmbedding?.hits.length !== 0) return nodeEmbedding;
  return undefined;
}

function getCommunitySummaries(
  deps: OptionalArmDeps
): CommunitySummaryStorage | undefined {
  const config = deps.retrieveConfig;
  if (
    config === undefined ||
    !(config.communitySummaryEnabled ?? config.preset === "tokenmax")
  ) {
    return undefined;
  }
  if (!supportsCommunitySummaries(deps.storage)) return undefined;
  return deps.storage.communitySummaries;
}

async function runCommunitySummarySafe(
  queryEmbedding: number[],
  storage: CommunitySummaryStorage,
  limit: number
): Promise<ArmResult> {
  try {
    const rows = await storage.searchCommunitySummaries(queryEmbedding, limit);
    return {
      arm: "community-summary",
      hits: rows.map((row, i) => ({
        id: row.id,
        arm: "community-summary",
        rank: i + 1,
        score: row.score ?? 1 / (i + 1),
        content: row.summary,
        source_ref: `community/${row.communityId}`,
        valid_window: ["1970-01-01T00:00:00.000Z", null],
        metadata: {
          kind: "community-summary",
          communityId: row.communityId,
        },
      })),
      belowFloor: false,
    };
  } catch (err) {
    // EXIT: no summary blocks retrieval; degraded preserves observability.
    return {
      arm: "community-summary",
      hits: [],
      belowFloor: true,
      failureReason: err instanceof Error ? err.message : String(err),
    };
  }
}

function getGraphSeed(
  deps: OptionalArmDeps
): { seed: GraphArmStorage; config: RetrieveConfig } | undefined {
  if (deps.graphConfig === undefined) return undefined;
  if (!("graphArmSeed" in deps.storage)) return undefined;
  const rag = deps.storage as GraphRagStorageBackend;
  if (rag.graphArmSeed === undefined) return undefined;
  return { seed: rag.graphArmSeed, config: deps.graphConfig };
}

function getNeo4jGraphArm(
  deps: OptionalArmDeps
): Neo4jGraphArmDeps | undefined {
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

function getLexicalArm(
  deps: OptionalArmDeps
): LexicalStorageBackend | undefined {
  const config = deps.retrieveConfig;
  if (config === undefined || !config.bm25Enabled) return undefined;
  if (!supportsLexicalSearch(deps.storage)) return undefined;
  return deps.storage;
}

async function runLexicalArmSafe(
  storage: LexicalStorageBackend,
  query: string,
  opts: SearchOptions
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

function toVectorResult(retrieved: RetrievedChunk[]): ArmResult {
  return {
    arm: "vector",
    hits: retrieved.map((r, i) => toArmHit(r, "vector", i)),
    belowFloor: false,
  };
}

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
