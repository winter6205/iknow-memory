/**
 * Retrieval layer types — bounded context for the graph-arm + RRF fusion
 * pipeline (spec-3, p0-integration T2).
 *
 * No value imports (this file stays a runtime leaf; the only edge is the
 * type-only `EntityType` from extraction, erased at compile time). Errors
 * follow the *Error suffix convention from src/core/errors.ts.
 */
import type { EntityType } from "../extraction/entity-type.js";

/**
 * A retrieval arm the fusion layer understands.
 *
 * `vector` + `bm25` + `graph` are the production hybrid (#59/#70). `graph`
 * names the ARM, not its engine: on production it is the Neo4j PPR arm
 * (`neo4j-graph-arm.ts`), and it is still the name the archived SQL
 * one-hop arm answers to when a caller injects a `graphConfig` explicitly
 * (#58, `docs/runbooks/sql-graph-arm-archived.md`). Only one of the two
 * ever runs in a given call, so one name and one `w_graph` weight cover
 * both — the optional node-embedding arm has its own name so debug output
 * can distinguish direct Postgres ranking from Neo4j graph ranking.
 */
export type ArmName =
  "vector" | "bm25" | "graph" | "node-embedding" | "community-summary";

/**
 * Bounded capability names used by the degradation registry.
 *
 * The first eight names are the retrieval-stack capability vocabulary. The
 * remaining names cover existing optional read paths so that every degraded
 * response can still identify its failed capability without publishing a
 * free-form string.
 */
export type DegradedCapability =
  | "vector"
  | "keyword_bm25"
  | "cjk_segmentation"
  | "phrase"
  | "field_boost"
  | "graph_ppr"
  | "rrf"
  | "rerank"
  | "node_embedding"
  | "community_summary"
  | "neighbor_evidence"
  | "projection_drain"
  | "parent_window"
  | "community_report"
  | "window_fill";

export type CapabilityState =
  "disabled" | "unattempted" | "attempted-and-failed" | "succeeded";

/** One typed observation supplied to the central degradation decision. */
export interface CapabilityObservation {
  capability: DegradedCapability;
  state: CapabilityState;
}

/**
 * Wire-safe bounded reason values. The state suffix is part of each value, so
 * consumers never have to infer whether a capability was skipped or failed.
 */
export const DEGRADED_REASON_CODES = [
  "vector:unattempted",
  "vector:attempted-and-failed",
  "keyword_bm25:unattempted",
  "keyword_bm25:attempted-and-failed",
  "cjk_segmentation:unattempted",
  "cjk_segmentation:attempted-and-failed",
  "phrase:unattempted",
  "phrase:attempted-and-failed",
  "field_boost:unattempted",
  "field_boost:attempted-and-failed",
  "graph_ppr:unattempted",
  "graph_ppr:attempted-and-failed",
  "rrf:unattempted",
  "rrf:attempted-and-failed",
  "rerank:unattempted",
  "rerank:attempted-and-failed",
  "node_embedding:unattempted",
  "node_embedding:attempted-and-failed",
  "community_summary:unattempted",
  "community_summary:attempted-and-failed",
  "neighbor_evidence:unattempted",
  "neighbor_evidence:attempted-and-failed",
  "projection_drain:unattempted",
  "projection_drain:attempted-and-failed",
  "parent_window:unattempted",
  "parent_window:attempted-and-failed",
  "community_report:unattempted",
  "community_report:attempted-and-failed",
  "window_fill:unattempted",
  "window_fill:attempted-and-failed",
] as const;

export type DegradedReason = (typeof DEGRADED_REASON_CODES)[number];

interface CapabilityDefinition {
  readonly defaultOn: boolean;
  readonly unattempted: DegradedReason;
  readonly attemptedAndFailed: DegradedReason;
}

/**
 * Single capability registry. Envelope decisions use this table rather than
 * arm-specific flag logic; future capability switches can extend this table
 * without changing the wire shape.
 */
export const CAPABILITY_REGISTRY = {
  vector: {
    defaultOn: true,
    unattempted: "vector:unattempted",
    attemptedAndFailed: "vector:attempted-and-failed",
  },
  keyword_bm25: {
    defaultOn: true,
    unattempted: "keyword_bm25:unattempted",
    attemptedAndFailed: "keyword_bm25:attempted-and-failed",
  },
  cjk_segmentation: {
    defaultOn: true,
    unattempted: "cjk_segmentation:unattempted",
    attemptedAndFailed: "cjk_segmentation:attempted-and-failed",
  },
  phrase: {
    defaultOn: true,
    unattempted: "phrase:unattempted",
    attemptedAndFailed: "phrase:attempted-and-failed",
  },
  field_boost: {
    defaultOn: true,
    unattempted: "field_boost:unattempted",
    attemptedAndFailed: "field_boost:attempted-and-failed",
  },
  graph_ppr: {
    defaultOn: true,
    unattempted: "graph_ppr:unattempted",
    attemptedAndFailed: "graph_ppr:attempted-and-failed",
  },
  rrf: {
    defaultOn: true,
    unattempted: "rrf:unattempted",
    attemptedAndFailed: "rrf:attempted-and-failed",
  },
  rerank: {
    defaultOn: true,
    unattempted: "rerank:unattempted",
    attemptedAndFailed: "rerank:attempted-and-failed",
  },
  node_embedding: {
    defaultOn: false,
    unattempted: "node_embedding:unattempted",
    attemptedAndFailed: "node_embedding:attempted-and-failed",
  },
  community_summary: {
    defaultOn: false,
    unattempted: "community_summary:unattempted",
    attemptedAndFailed: "community_summary:attempted-and-failed",
  },
  neighbor_evidence: {
    defaultOn: false,
    unattempted: "neighbor_evidence:unattempted",
    attemptedAndFailed: "neighbor_evidence:attempted-and-failed",
  },
  projection_drain: {
    defaultOn: false,
    unattempted: "projection_drain:unattempted",
    attemptedAndFailed: "projection_drain:attempted-and-failed",
  },
  // 档 A (ADR-0060): the child→parent window lookup. default-on because an
  // A retrieve without it could only ever cite child text, which ADR-0060
  // forbids; B never observes this capability, so its envelope is unchanged.
  parent_window: {
    defaultOn: true,
    unattempted: "parent_window:unattempted",
    attemptedAndFailed: "parent_window:attempted-and-failed",
  },
  // 档 C (fin ADR-0070): the two report arms (ES ∥ report vectors).
  // default-on because reports ARE the 档 — a C that could run neither arm
  // has nothing to cite and must not look like a healthy miss. Only named
  // `unattempted` when NEITHER arm could run; one surviving arm answering
  // is a healthy partial, so single-arm seam absence stays silent.
  community_report: {
    defaultOn: true,
    unattempted: "community_report:unattempted",
    attemptedAndFailed: "community_report:attempted-and-failed",
  },
  // 档 C drop: the optional window fill after a report hit. An
  // off-by-filter drop emits no observation at all, so `unattempted`
  // never fires on the C path; default-off keeps the pair honest if a
  // future caller names a skipped fill.
  window_fill: {
    defaultOn: false,
    unattempted: "window_fill:unattempted",
    attemptedAndFailed: "window_fill:attempted-and-failed",
  },
} as const satisfies Record<DegradedCapability, CapabilityDefinition>;

/** Named retrieval mode bundles exposed by the retrieve tool. */
export type RetrievePreset = "conservative" | "balanced" | "tokenmax";

export const RETRIEVE_PRESETS = [
  "conservative",
  "balanced",
  "tokenmax",
] as const satisfies readonly RetrievePreset[];

export const DEFAULT_RETRIEVE_PRESET: RetrievePreset = "balanced";

/** The recall and evidence levers owned by a mode bundle. */
export interface RetrievePresetBundle {
  entityLinkTopK: number;
  candidateCap: number;
  w_vec: number;
  w_bm25: number;
  neighborWidth: number;
}

/**
 * Preset values are immutable so concurrent retrieve calls cannot share a
 * mutable ranking configuration. Conservative and tokenmax deliberately
 * bracket the balanced defaults without changing the wire envelope.
 */
export const RETRIEVE_PRESET_BUNDLES: Readonly<
  Record<RetrievePreset, RetrievePresetBundle>
> = {
  conservative: {
    entityLinkTopK: 4,
    candidateCap: 25,
    w_vec: 0.7,
    w_bm25: 0.15,
    neighborWidth: 0,
  },
  balanced: {
    entityLinkTopK: 8,
    candidateCap: 50,
    w_vec: 0.7,
    w_bm25: 0.15,
    neighborWidth: 1,
  },
  tokenmax: {
    entityLinkTopK: 16,
    candidateCap: 100,
    w_vec: 0.7,
    w_bm25: 0.15,
    neighborWidth: 2,
  },
};

export function isRetrievePreset(value: string): value is RetrievePreset {
  return (RETRIEVE_PRESETS as readonly string[]).includes(value);
}

/**
 * Wire-safe metadata a hit may carry. A union member per citable-body
 * provenance kind; single source so ArmHit, FusedHit and the envelope
 * cannot drift apart when a 档 adds one.
 *
 * `parent-window` (档 A, ADR-0060): the hit's text is the parent 抽图窗
 * body; the lexical children that produced the hit are recorded here as
 * span metadata only — they are never a second citable body or ranker.
 */
export type RetrieveHitMetadata =
  | {
      kind: "community-summary";
      communityId: string;
    }
  | {
      kind: "parent-window";
      /** The 资料 (parent window) row id the text came from. */
      sourceDocId: string;
      /** Contributing children in best-rank-first order. */
      children: Array<{
        chunkId: string;
        /** Zero-based child ordinal in the parent; null = legacy row. */
        ordinal: number | null;
        /** The child's lexical score. */
        score: number;
      }>;
    };

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
  metadata?: RetrieveHitMetadata;
}

/** Result of one retrieval arm. */
export interface ArmResult {
  arm: ArmName;
  hits: ArmHit[];
  /**
   * True when this arm was attempted and could not deliver — any optional
   * arm, not just graph. The graph arm sets it on a throw OR on missing
   * `graphArmFloor`; the BM25 arm sets it on a throw. It is what flips
   * the central capability observation to attempted-and-failed, so an arm
   * that merely found nothing leaves the envelope non-degraded.
   */
  belowFloor: boolean;
  /** Human-readable failure reason when the arm is unavailable. */
  failureReason?: string;
  /**
   * Additional capability observations produced while an arm remains
   * fail-open. Entity seed fusion uses this to report a failed lexical
   * lookup while still returning graph results from vector seeds.
   */
  observations?: CapabilityObservation[];
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
  metadata?: RetrieveHitMetadata;
}

/** Configuration for the retrieval pipeline (loaded from env, see src/config.ts). */
export interface RetrieveConfig {
  /** Named mode bundle selected at startup; defaults to balanced. */
  preset: RetrievePreset;
  /** RRF denominator offset; omitted by legacy callers, defaulting to 60. */
  rrfK?: number;
  /** Weight for the vector arm in RRF. */
  w_vec: number;
  /** Weight for the BM25 lexical arm in RRF. */
  w_bm25: number;
  /** Weight for the graph arm in RRF. */
  w_graph: number;
  /** Okapi BM25 term-frequency saturation. */
  k1?: number;
  /** Okapi BM25 document-length normalization. */
  b?: number;
  /** Whether the BM25 arm runs at all. Off → vector-only, and NOT degraded. */
  bm25Enabled: boolean;
  /** Whether the shared vector capability is included in the retrieval run. */
  vectorEnabled?: boolean;
  /** Whether the same query is fused with reciprocal rank fusion. */
  rrfEnabled?: boolean;
  /** Whether the precision layer segments CJK query text. */
  cjkSegmentationEnabled?: boolean;
  /** Whether exact phrase clauses participate in lexical ranking. */
  phraseEnabled?: boolean;
  /** Whether configured lexical field boosts participate in ranking. */
  fieldBoostEnabled?: boolean;
  /** Optional field boost map consumed by the precision layer. */
  fieldBoosts?: Record<string, number>;
  /**
   * Whether the Neo4j graph arm runs at all. Off → vector (+BM25) only
   * without a degradation; absent Neo4j config while this stays enabled is
   * an unattempted default-on capability.
   */
  graphEnabled: boolean;
  /**
   * Temporary LLM rerank after Host ranking. Default on. On without the
   * Anthropic trio is unattempted and the envelope is degraded.
   */
  rerankEnabled: boolean;
  /**
   * Optional direct entity-embedding retrieval. Off preserves the T1
   * graph-priority/RRF path exactly.
   */
  nodeEmbeddingEnabled?: boolean;
  /**
   * Optional topic-level community summary recall. When omitted, the
   * tokenmax preset enables it; balanced and conservative stay unchanged.
   */
  communitySummaryEnabled?: boolean;
  /** Top-K seed entities from the embedding seed query. */
  entityLinkTopK: number;
  /** Hard cap on total candidates pulled from the graph arm. */
  candidateCap: number;
  /** Number of same-source neighboring chunks enabled by the bundle. */
  neighborWidth: number;
  /** Minimum number of graph-arm hits before degraded flips to false. */
  graphArmFloor: number;
  /** Whether retrieve waits for the projection outbox to drain. */
  waitForDrainEnabled?: boolean;
  /** Maximum time retrieve waits for the projection outbox, in milliseconds. */
  waitForDrainTimeoutMs?: number;
}

/**
 * The levers NO preset bundle owns, with their startup default values.
 * Single source (review I1): the retrieve tool's preset fallback and the
 * 档 C fusion fallback each rebuilt this same literal, three copies in
 * all — this constant replaces all three without changing any value.
 * Lives in this leaf module so tools and arms can share it without an
 * ESM cycle (the same reason wire-filters.ts is a leaf).
 */
const RETRIEVE_BASE_LEVERS: Omit<RetrieveConfig, keyof RetrievePresetBundle> = {
  preset: DEFAULT_RETRIEVE_PRESET,
  w_graph: 0.15,
  bm25Enabled: true,
  graphEnabled: true,
  rerankEnabled: false,
  graphArmFloor: 3,
};

/** A preset bundle's levers over the single-source base defaults. */
export function retrieveConfigForPreset(preset: RetrievePreset): RetrieveConfig {
  return { ...RETRIEVE_PRESET_BUNDLES[preset], ...RETRIEVE_BASE_LEVERS };
}

/**
 * The fusion config used when no operator config arrived: the default
 * preset's bundle over the base levers.
 */
export const DEFAULT_RETRIEVE_CONFIG: RetrieveConfig = retrieveConfigForPreset(
  DEFAULT_RETRIEVE_PRESET
);

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

/** Candidate returned by one entity-finding route before seed RRF. */
export interface EntitySeedCandidate {
  id: string;
  canonical_name: string;
  score?: number;
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
 * Port: optional post-ranking permutation of retrieve candidates.
 *
 * Declared here the same way `GraphRanker` is: retrieval owns the shape,
 * the Anthropic adapter lives outside this folder so `src/index.ts` can
 * construct it without importing `src/core/retrieval/*`.
 */
export interface RerankCandidate {
  id: string;
  content: string;
}

export interface ChunkReranker {
  permute(
    query: string,
    candidates: readonly RerankCandidate[]
  ): Promise<readonly string[]>;
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

/** A chunk row returned by the same-source neighbor lookup. */
export interface NeighborChunkRow {
  id: string;
  content: string;
  source_ref: string;
  valid_from: string;
  valid_until: string | null;
}

/**
 * Postgres chunk ledger seam for neighboring evidence.
 *
 * The lookup is intentionally expressed in chunk ids rather than source refs:
 * the storage layer owns ingest ordering and can select the rows immediately
 * around the already-ranked anchors.
 */
export interface NeighborChunkStorage {
  chunksByChunkIds(
    chunkIds: readonly string[],
    validAt: string,
    width: number
  ): Promise<NeighborChunkRow[]>;
}

/**
 * One child→parent resolution row for 档 A (plans/search-mode-retrieve.md
 * T2, ADR-0060). The parent body is the citable text; the child id and
 * ordinal locate the hit span inside it. A chunk whose back-pointer or
 * 资料 row is missing yields NO row — the arm must then degrade, never
 * cite the child alone.
 */
export interface ParentWindowRow {
  /** The child chunk id this row was requested for. */
  chunk_id: string;
  /** The parent 资料 (抽图窗) row id — the citation key. */
  source_doc_id: string;
  /** Zero-based child ordinal; null = legacy row without one. */
  ordinal: number | null;
  /** Parent body text — the 抽图窗 content from `source_documents`. */
  content: string;
}

/**
 * Postgres chunk-ledger seam for 档 A's child→parent window lookup.
 *
 * Deliberately keyed on chunk ids, not source refs: the lexical arm (ES or
 * in-memory BM25) already returns chunk ids, and the (source_doc_id,
 * ordinal) back-pointers (operator-console T1) are the only parent pointer
 * with a single SoR — the ES chunk docs stay parent-blind by design.
 */
export interface ParentWindowStorage {
  parentWindowsByChunkIds(
    chunkIds: readonly string[]
  ): Promise<ParentWindowRow[]>;
}

/**
 * Postgres entity-embedding read path: entity seeds in, their chunks out.
 *
 * The optional score is the cosine similarity calculated by Postgres. A
 * backend may omit it when it only exposes deterministic seed order.
 * `entityType` (plans/entity-type-and-filter.md T3) restricts the seed to
 * one entity type; absent = every type, byte-for-byte the old behavior.
 */
export interface EntityEmbeddingStorage {
  seedEntitiesByEmbedding(
    embedding: number[],
    topK: number,
    entityType?: EntityType
  ): Promise<Array<{ id: string; canonical_name: string; score?: number }>>;
  chunksByEntityIds(
    entityIds: readonly string[],
    validAt: string,
    limit: number
  ): Promise<EntityChunkRow[]>;
}

/**
 * Entity lookup supplied by the precision layer during seed finding.
 * `entityType` narrows the lexical seed exactly like the vector seed, so
 * the RRF fusion cannot smuggle other types into a filtered seed set.
 */
export interface EntityLexicalStorage {
  searchEntities(
    query: string,
    limit: number,
    precision?: {
      k1?: number;
      b?: number;
      cjkSegmentation?: boolean;
      phrase?: boolean;
      fieldBoost?: boolean;
      fieldBoosts?: Record<string, number>;
    },
    entityType?: EntityType
  ): Promise<Array<{ id: string; canonical_name: string; score?: number }>>;
}

/** A ledger-stored community summary exposed as a retrieve candidate. */
export interface CommunitySummaryRow {
  id: string;
  communityId: string;
  summary: string;
  score?: number;
}

/** Postgres seam for optional topic-level summary recall. */
export interface CommunitySummaryStorage {
  getCommunitySummaryByCommunityId(
    communityId: string
  ): Promise<CommunitySummaryRow | undefined>;
  searchCommunitySummaries(
    embedding: number[],
    limit: number
  ): Promise<CommunitySummaryRow[]>;
}

/**
 * One row of the corpus-level C-ready singleton `community_index_state`
 * (schema-bootstrap; written by the community-summary CLI, demoted by the
 * extract pipeline). The status/failure spellings are the core types
 * `COMMUNITY_INDEX_STATUS` / `COMMUNITY_SUMMARY_INDEX_FAILURE` constants —
 * kept as plain strings here because this file is a type leaf.
 */
export interface CommunityIndexStateRow {
  status: string;
  failure_code: string | null;
}

/**
 * Read seam for the C-ready state (plans/search-mode-retrieve.md T3).
 *
 * Retrieve forwards the readiness verdict verbatim: absent row, non-ready
 * status, or a carried failure_code all mean 档 C is NOT ready and the arm
 * must type `community_summary_index_failure` — readiness is never
 * inferred from the summary table having rows.
 */
export interface CommunityIndexStateStorage {
  getCommunityIndexState(): Promise<CommunityIndexStateRow | undefined>;
}

/**
 * Lexical search over community REPORT text — the ES half of 档 C's two
 * parallel arms (fin ADR-0070). Separate from `CommunitySummaryStorage`
 * because it is the derived precision-index read (query text in, ranked
 * rows out) while that seam is the ledger's vector read.
 *
 * Deliberately NOT part of `PrecisionIndexer` in this ticket: the live
 * summary-index write side belongs to the graph-index plan T5 wave, and
 * an uncallable index method would be dead code. The C arm discovers this
 * port structurally on whatever object is wired as `deps.lexical`, so the
 * later ES-side ticket only has to add the method.
 */
export interface CommunityReportLexicalStorage {
  searchCommunitySummariesLexical(
    query: string,
    limit: number
  ): Promise<CommunitySummaryRow[]>;
}

/** Read-only port for waiting on an externally running projection drain. */
export interface ProjectionDrainWaiter {
  waitForProjectionDrain(timeoutMs: number): Promise<void>;
}

/** The Neo4j PPR arm reuses the same Postgres entity read seam. */
export interface Neo4jArmStorage extends EntityEmbeddingStorage {}

/** Storage seam for the graph arm; implemented optionally by StorageBackend. */
export interface GraphArmStorage {
  seedEntitiesByEmbedding(
    embedding: number[],
    topK: number,
    entityType?: EntityType
  ): Promise<Array<{ id: string; canonical_name: string; score?: number }>>;
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
    metadata?: RetrieveHitMetadata;
  }>;
  /** Optional: true only when the central capability decision finds reasons. */
  degraded?: boolean;
  /**
   * Optional bounded reasons. An absent list is equivalent to `[]`.
   *
   * `debug` is internal, non-enumerable diagnostics retained for the offline
   * evaluator; it is not part of the retrieve JSON wire shape.
   */
  degraded_reasons?: DegradedReason[];
  /** Internal diagnostics, never serialized into the retrieve response. */
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
