/**
 * Retrieval layer types — bounded context for the graph-arm + RRF fusion
 * pipeline (spec-3, p0-integration T2).
 *
 * No project imports (this file is a leaf). Errors follow the
 * *Error suffix convention from src/core/errors.ts.
 */

/**
 * A retrieval arm the fusion layer understands.
 *
 * `vector` + `bm25` + `graph` are the production hybrid (#59/#70). `graph`
 * names the ARM, not its engine: on production it is the Neo4j PPR arm
 * (`neo4j-graph-arm.ts`), and it is still the name the archived SQL
 * one-hop arm answers to when a caller injects a `graphConfig` explicitly
 * (#58, `docs/runbooks/sql-graph-arm-archived.md`). Only one of the two
 * ever runs in a given call, so one name and one `w_graph` weight cover
 * both — a fourth arm name would fork the weight table for an arm that is
 * off the default path.
 */
export type ArmName = "vector" | "bm25" | "graph";

/** A single hit produced by one retrieval arm. */
export interface ArmHit {
  /** Chunk id (UUID string); the RRF fuse key. */
  id: string;
  /** Origin arm: which pipeline produced this hit. */
  arm: ArmName;
  /** 1-based rank within the producing arm. */
  rank: number;
  /**
   * Optional pre-fusion score: cosine similarity 0-1 for the vector arm,
   * `ts_rank` output for BM25, graph-arm relevance for graph. Scales are
   * NOT comparable across arms — RRF fuses on rank, not on this value.
   */
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
  arm: ArmName;
  hits: ArmHit[];
  /**
   * True when this arm was attempted and could not deliver — any optional
   * arm, not just graph. The graph arm sets it on a throw OR on missing
   * `graphArmFloor`; the BM25 arm sets it on a throw. It is what flips
   * `degraded` on the envelope, so an arm that merely found nothing leaves
   * it false.
   */
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
  arms: ArmName[];
}

/** Configuration for the retrieval pipeline (loaded from env, see src/config.ts). */
export interface RetrieveConfig {
  /** Weight for the vector arm in RRF. */
  w_vec: number;
  /** Weight for the BM25 lexical arm in RRF. */
  w_bm25: number;
  /** Weight for the graph arm in RRF. */
  w_graph: number;
  /** Whether the BM25 arm runs at all. Off → vector-only, and NOT degraded. */
  bm25Enabled: boolean;
  /**
   * Whether the Neo4j graph arm runs at all. Off → vector (+BM25) only,
   * and NOT degraded: an operator switching an arm off is a choice, the
   * same contract `bm25Enabled` carries. Absent Neo4j config is a
   * separate, equally non-degrading reason to skip the arm.
   */
  graphEnabled: boolean;
  /** Top-K seed entities from the embedding seed query. */
  entityLinkTopK: number;
  /** Hard cap on total candidates pulled from the graph arm. */
  candidateCap: number;
  /** Minimum number of graph-arm hits before degraded flips to false. */
  graphArmFloor: number;
}

/** One entity ranked by the graph engine, with the engine's own score. */
export interface RankedEntity {
  /** Ledger entity id — the same uuid Postgres and Neo4j both key on. */
  id: string;
  /**
   * Engine relevance (PPR mass). Comparable only within one ranking, and
   * NOT the arm's fusion key: RRF fuses on rank. Carried so an operator
   * can see why an entity surfaced (#57 — a score may be projected, it
   * must not become the ranking algorithm).
   */
  score: number;
}

/**
 * Port: query-anchored ranking over the projected graph.
 *
 * Implemented by the Neo4j GDS PPR adapter (`src/core/graph/neo4j-ppr.ts`),
 * which this context deliberately does not import — retrieval declares the
 * shape it needs and the server wires an implementation in. `undefined` at
 * the wiring point means "no sidecar configured", which is a SKIP, never a
 * failure (spec SC7).
 */
export interface GraphRanker {
  rankEntities(
    seedEntityIds: readonly string[],
    limit: number
  ): Promise<RankedEntity[]>;
}

/**
 * A chunk reached from a ranked entity through `triples.source_chunk_id`.
 *
 * `entity_id` is what makes the hop back into Postgres rank-preserving:
 * chunks never enter Neo4j (ADR-0001), so the arm re-attaches the graph's
 * ordering to the rows itself.
 */
export interface EntityChunkRow {
  entity_id: string;
  id: string;
  content: string;
  source_ref: string;
  valid_from: string;
  valid_until: string | null;
}

/**
 * Postgres side of the Neo4j graph arm: entity seeds in, their chunks out.
 *
 * Shares `seedEntitiesByEmbedding` with the archived SQL arm's seam by
 * shape (spec A7 allows reusing the entity-linking idea), but not the
 * one-hop JOIN — the traversal moved to the graph engine.
 */
export interface Neo4jArmStorage {
  seedEntitiesByEmbedding(
    embedding: number[],
    topK: number
  ): Promise<Array<{ id: string; canonical_name: string }>>;
  chunksByEntityIds(
    entityIds: readonly string[],
    validAt: string,
    limit: number
  ): Promise<EntityChunkRow[]>;
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
  /**
   * Optional: present (true) when an optional arm was ATTEMPTED and could
   * not deliver — the graph arm under-flooring or erroring, or the BM25
   * arm throwing. Deliberately absent when BM25 is simply disabled by
   * config: "you turned it off" is not a degradation.
   */
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
    public readonly arm: ArmName
  ) {
    super(message);
    this.name = "RetrievalArmError";
  }
}
