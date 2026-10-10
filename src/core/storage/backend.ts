/**
 * Storage backend contract.
 * Concrete implementations: MemoryBackend (dev/test), PgvectorBackend (prod).
 *
 * `StorageBackend` is the chunks-only contract (defined in ../types.ts).
 * `GraphRagStorageBackend` extends it with an OPTIONAL graph-arm seed seam
 * (spec-3 p0-integration T4): implemented by PgvectorBackend only; MemoryBackend
 * stays a plain StorageBackend. Callers must guard with
 * `if (storage.graphArmSeed)` before using the graph arm.
 */
export type { StorageBackend, SearchOptions } from "../types.js";
export type {
  GraphArmStorage,
  EntityEmbeddingStorage,
  NeighborChunkStorage,
  Neo4jArmStorage,
  CommunitySummaryStorage,
  CommunityIndexStateRow,
  CommunityIndexStateStorage,
  CommunityReportLexicalStorage,
  ProjectionDrainWaiter,
  ParentWindowStorage,
  ParentWindowRow,
} from "../retrieval/types.js";
export type { StructuredPublicationStorage } from "../maintenance/publication-types.js";
import { GraphragError } from "../errors.js";
import type {
  EvidenceStore,
  IndexJobStore,
  RetrievedChunk,
  SearchOptions,
  StorageBackend,
} from "../types.js";
import type { StructuredPublicationStorage } from "../maintenance/publication-types.js";
import type {
  GraphArmStorage,
  EntityEmbeddingStorage,
  NeighborChunkStorage,
  Neo4jArmStorage,
  CommunitySummaryStorage,
  CommunityIndexStateStorage,
  CommunityReportLexicalStorage,
  ProjectionDrainWaiter,
  ParentWindowStorage,
} from "../retrieval/types.js";

/**
 * Graph-rag storage backend: the chunk-store contract plus the OPTIONAL
 * graph-arm seams. Additive — never a breaking change for chunk-only
 * implementations.
 *
 * Two seams, one per graph arm, because they ask the ledger different
 * questions: `graphArmSeed` traverses `triples` in SQL (archived),
 * while `neo4jArmSeed` only maps entity ids the graph engine already
 * ranked back onto chunks.
 */
export interface StructuredPublicationBackend extends StorageBackend {
  /** Optional atomic accepted-structured-corpus publication capability. */
  structuredPublication?: StructuredPublicationStorage;
}

export interface GraphRagStorageBackend extends StructuredPublicationBackend {
  graphArmSeed?: GraphArmStorage;
  /** Optional Postgres entity-embedding seed/score read path. */
  entityEmbedding?: EntityEmbeddingStorage;
  neo4jArmSeed?: Neo4jArmStorage;
  /** Optional ledger search over index-time community summaries. */
  communitySummaries?: CommunitySummaryStorage;
}

/** A backend that can observe an externally running projection drain. */
export interface ProjectionDrainBackend
  extends StorageBackend, ProjectionDrainWaiter {}

/** A backend that can feed the Neo4j graph arm both of its Postgres steps. */
export interface Neo4jArmBackend extends StorageBackend {
  neo4jArmSeed: Neo4jArmStorage;
}

/**
 * Runtime narrowing for the Neo4j arm seam. A backend without it is not a
 * degraded backend — MemoryBackend has no ledger to seed from — so callers
 * treat `false` as "skip the arm".
 */
export function supportsNeo4jArm(
  storage: StorageBackend
): storage is Neo4jArmBackend {
  const seam = (storage as Partial<Neo4jArmBackend>).neo4jArmSeed;
  return (
    typeof seam?.seedEntitiesByEmbedding === "function" &&
    typeof seam.chunksByEntityIds === "function"
  );
}

/** Runtime narrowing for the optional Postgres entity-embedding path. */
export function supportsEntityEmbedding(
  storage: StorageBackend
): storage is StorageBackend & { entityEmbedding: EntityEmbeddingStorage } {
  const seam = (
    storage as Partial<{
      entityEmbedding: EntityEmbeddingStorage;
    }>
  ).entityEmbedding;
  return (
    typeof seam?.seedEntitiesByEmbedding === "function" &&
    typeof seam.chunksByEntityIds === "function"
  );
}

/** Runtime narrowing for the optional community-summary read seam. */
export function supportsCommunitySummaries(
  storage: StorageBackend
): storage is StorageBackend & {
  communitySummaries: CommunitySummaryStorage;
} {
  const seam = (
    storage as Partial<{
      communitySummaries: CommunitySummaryStorage;
    }>
  ).communitySummaries;
  return typeof seam?.searchCommunitySummaries === "function";
}

/** Runtime narrowing for the optional read-only projection drain wait. */
export function supportsProjectionDrain(
  storage: StorageBackend
): storage is ProjectionDrainBackend {
  return (
    typeof (storage as Partial<ProjectionDrainBackend>)
      .waitForProjectionDrain === "function"
  );
}

/**
 * A backend that can also answer a lexical (BM25) query, not just a
 * vector one. Optional and additive, like the graph seam above: a
 * chunk-only backend stays a valid `StorageBackend` and the orchestrator
 * simply runs vector-only against it.
 *
 * `searchLexical` returns the same `RetrievedChunk[]` shape as `search`
 * so the retrieval layer can project both arms identically. The `score`
 * scales are NOT comparable between the two — one is cosine similarity,
 * the other a text-rank — which is exactly why fusion is rank-based.
 */
export interface LexicalStorageBackend extends StorageBackend {
  searchLexical(query: string, opts: SearchOptions): Promise<RetrievedChunk[]>;
}

/**
 * Runtime narrowing for the optional lexical seam. Prefer this over an
 * `in` check at call sites so the guard's definition lives next to the
 * interface it guards.
 */
export function supportsLexicalSearch(
  storage: StorageBackend
): storage is LexicalStorageBackend {
  return (
    typeof (storage as Partial<LexicalStorageBackend>).searchLexical ===
    "function"
  );
}

/** Runtime narrowing for the optional same-source neighbor seam. */
export function supportsNeighborChunks(
  storage: StorageBackend
): storage is StorageBackend & NeighborChunkStorage {
  return (
    typeof (storage as Partial<NeighborChunkStorage>).chunksByChunkIds ===
    "function"
  );
}

/** Runtime narrowing for 档 A's optional child→parent window seam. */
export function supportsParentWindows(
  storage: StorageBackend
): storage is StorageBackend & ParentWindowStorage {
  return (
    typeof (storage as Partial<ParentWindowStorage>).parentWindowsByChunkIds ===
    "function"
  );
}

/**
 * Runtime narrowing for 档 C's community_index_state readiness seam
 * (specs/search-mode-retrieve.md). The C arm FAILS CLOSED without it:
 * missing evidence of readiness is not readiness.
 */
export function supportsCommunityIndexState(
  storage: StorageBackend
): storage is StorageBackend & CommunityIndexStateStorage {
  return (
    typeof (storage as Partial<CommunityIndexStateStorage>)
      .getCommunityIndexState === "function"
  );
}

/**
 * Runtime narrowing for the durable index-job ledger (corpus-index-job T2).
 * Takes `unknown` because the submit seam probes whichever object the job
 * store is wired into. The guard checks all four methods so the narrowed
 * type provably satisfies `IndexJobStore` — a partial store fails closed.
 */
export function supportsIndexJobStore(
  candidate: unknown
): candidate is StorageBackend & IndexJobStore {
  const seam = candidate as Partial<IndexJobStore> | null | undefined;
  return (
    typeof seam?.insertJobOrJoin === "function" &&
    typeof seam?.getJob === "function" &&
    typeof seam?.getActiveJobForSource === "function" &&
    typeof seam?.supersedeReadyJobs === "function"
  );
}

/**
 * Runtime narrowing for 档 C's report-text lexical seam (the ES half of
 * ADR-0070's parallel arms). Takes `unknown` because the C arm probes both
 * `deps.lexical` and `deps.storage` structurally — whichever object the
 * precision layer is wired into gains the arm by implementing the method.
 */
export function supportsCommunityReportLexical(
  candidate: unknown
): candidate is CommunityReportLexicalStorage {
  return (
    typeof (
      candidate as Partial<CommunityReportLexicalStorage> | null | undefined
    )?.searchCommunitySummariesLexical === "function"
  );
}

/**
 * Every `EvidenceStore` method, as a key map.
 *
 * Typed `Record<keyof EvidenceStore, true>` rather than a list so the
 * coverage requirement is the type system talking: a method added to the
 * capability without an entry here fails `tsc`, which is the only thing that
 * can notice — a runtime `every` over a shorter list would simply stop
 * checking. It is also a conjunction that cannot be satisfied by a subset of
 * the store.
 */
const EVIDENCE_STORE_METHODS: Record<keyof EvidenceStore, true> = {
  registerSourceVersion: true,
  bindSourceLocator: true,
  recordSupport: true,
  getSupport: true,
  listSupportExtractions: true,
  issueGrant: true,
  issueGrants: true,
  readGrant: true,
  listGrantSupports: true,
  listGrantPinnedExtractions: true,
  setScopeRevisions: true,
  markSourceVersionRetired: true,
  collectSourceVersionPayload: true,
  stopAcceptingObligations: true,
};

/**
 * Runtime narrowing for the immutable source/support storage and the finite
 * row/count grants. Takes `unknown` and checks every method: the store is
 * split in two — a reference can be read without the ability to mint one — so
 * a partial implementation fails closed rather than letting a caller reach a
 * grant it cannot create.
 */
export function supportsEvidenceStore(
  candidate: unknown
): candidate is StorageBackend & EvidenceStore {
  const seam = candidate as Partial<EvidenceStore> | null | undefined;
  const methods: readonly (keyof EvidenceStore)[] = Object.keys(
    EVIDENCE_STORE_METHODS
  ) as readonly (keyof EvidenceStore)[];
  return methods.every((method) => typeof seam?.[method] === "function");
}

/**
 * Content invalidation is stored inside the existing authoritative chunk row
 * so the action needs no new table or column. The key is namespaced to avoid
 * colliding with caller metadata.
 */
export const CONTENT_INVALIDATIONS_METADATA_KEY =
  "__iknow_content_invalidations";

export interface ContentInvalidationRecord {
  chunk_id: string;
  invalidated_at: string;
  triggered_by: string;
}

export interface ContentInvalidationStorage extends StorageBackend {
  /**
   * Close every chunk for `sourceRef` and return this request's records.
   * Repeating the same request returns the same record set.
   */
  invalidateSourceRef(
    sourceRef: string,
    invalidatedAt: string,
    triggeredBy: string
  ): Promise<ContentInvalidationRecord[]>;
  listInvalidations(sourceRef?: string): Promise<ContentInvalidationRecord[]>;
}

export function supportsContentInvalidation(
  storage: StorageBackend
): storage is ContentInvalidationStorage {
  const candidate = storage as Partial<ContentInvalidationStorage>;
  return (
    typeof candidate.invalidateSourceRef === "function" &&
    typeof candidate.listInvalidations === "function"
  );
}

/** Validate and canonicalize the shared invalidation request shape. */
export function normalizeContentInvalidationRequest(
  sourceRef: string,
  invalidatedAt: string,
  triggeredBy: string
): {
  sourceRef: string;
  invalidatedAt: string;
  triggeredBy: string;
} {
  if (sourceRef.trim() === "") {
    throw new GraphragError(
      "content invalidation: source_ref must be a non-empty string",
      "INVALID_INPUT"
    );
  }
  if (triggeredBy.trim() === "") {
    throw new GraphragError(
      "content invalidation: triggered_by must be a non-empty string",
      "INVALID_INPUT"
    );
  }
  const timestamp = Date.parse(invalidatedAt);
  if (Number.isNaN(timestamp)) {
    throw new GraphragError(
      `content invalidation: invalid invalidated_at timestamp "${invalidatedAt}"`,
      "INVALID_INPUT"
    );
  }
  return {
    sourceRef,
    invalidatedAt: new Date(timestamp).toISOString(),
    triggeredBy,
  };
}

/** Read valid invalidation records from the reserved metadata key. */
export function readContentInvalidations(
  metadata: Record<string, unknown>
): ContentInvalidationRecord[] {
  const raw = metadata[CONTENT_INVALIDATIONS_METADATA_KEY];
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(isContentInvalidationRecord)
    .map((record) => ({ ...record }));
}

/** Add one record without duplicating an identical invalidation request. */
export function appendContentInvalidation(
  metadata: Record<string, unknown>,
  record: ContentInvalidationRecord
): Record<string, unknown> {
  const records = readContentInvalidations(metadata);
  if (
    !records.some(
      (existing) =>
        existing.chunk_id === record.chunk_id &&
        existing.invalidated_at === record.invalidated_at &&
        existing.triggered_by === record.triggered_by
    )
  ) {
    records.push(record);
  }
  return {
    ...metadata,
    [CONTENT_INVALIDATIONS_METADATA_KEY]: records,
  };
}

function isContentInvalidationRecord(
  value: unknown
): value is ContentInvalidationRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.chunk_id === "string" &&
    typeof record.invalidated_at === "string" &&
    typeof record.triggered_by === "string"
  );
}
