/**
 * Retrieval layer types — bounded context for the graph-arm + RRF fusion
 * pipeline (spec-3, p0-integration T2).
 *
 * No project imports (this file is a leaf). Errors follow the
 * *Error suffix convention from src/core/errors.ts.
 */

/** A single hit produced by either retrieval arm (vector or graph). */
export interface ArmHit {
  /** Chunk id (UUID string); the RRF fuse key. */
  id: string;
  /** Origin arm: which pipeline produced this hit. */
  arm: "vector" | "graph";
  /** 1-based rank within the producing arm. */
  rank: number;
  /** Optional pre-fusion score (cosine similarity 0-1, or graph-arm relevance). */
  score: number;
  /** Pre-rendered chunk content for downstream projection. */
  content: string;
  /** Provenance back to the ingested source. */
  source_ref: string;
  /** Temporal validity window for filtering. */
  valid_window: [string, string | null];
}

/** Result of one retrieval arm. */
export interface ArmResult {
  arm: "vector" | "graph";
  hits: ArmHit[];
  /** True if this arm could not satisfy the floor (graph arm only). */
  belowFloor: boolean;
  /** Human-readable failure reason when the arm is unavailable. */
  failureReason?: string;
}

/** A fused hit after RRF. */
export interface FusedHit {
  id: string;
  content: string;
  source_ref: string;
  valid_window: [string, string | null];
  rrfScore: number;
  /** Which arm(s) contributed to this hit. */
  arms: Array<"vector" | "graph">;
}

/** Configuration for the retrieval pipeline (loaded from env, see src/core/config.ts). */
export interface RetrieveConfig {
  /** Weight for the vector arm in RRF. */
  w_vec: number;
  /** Weight for the graph arm in RRF. */
  w_graph: number;
  /** Top-K seed entities from the embedding seed query. */
  entityLinkTopK: number;
  /** Hard cap on total candidates pulled from the graph arm. */
  candidateCap: number;
  /** Minimum number of graph-arm hits before degraded flips to false. */
  graphArmFloor: number;
}

/** Storage seam for the graph arm; implemented optionally by StorageBackend. */
export interface GraphArmStorage {
  seedEntitiesByEmbedding(
    embedding: number[],
    topK: number
  ): Promise<Array<{ id: string; canonical_name: string }>>;
  chunksByOneHopFromEntities(
    seedIds: string[],
    validAt: string,
    limit: number
  ): Promise<
    Array<{
      id: string;
      content: string;
      source_ref: string;
      valid_from: string;
      valid_until: string | null;
    }>
  >;
}

/** Output envelope — the retrieve tool wire shape. */
export interface RetrieveOutputEnvelope {
  chunks: Array<{
    id: string;
    content: string;
    source_ref: string;
    valid_window: [string, string | null];
    score: number;
  }>;
  /** Optional: present (true) when the graph arm under-floors or errors. */
  degraded?: true;
  /** Optional debug payload, only present when DEBUG=1 is set. */
  debug?: Record<string, unknown>;
}

// --- Errors (all suffix `Error`, all extend Error) ---

export class RetrieveConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetrieveConfigError";
  }
}

export class RetrievalArmError extends Error {
  constructor(
    message: string,
    public readonly arm: "vector" | "graph"
  ) {
    super(message);
    this.name = "RetrievalArmError";
  }
}
