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
export type { GraphArmStorage, Neo4jArmStorage } from "../retrieval/types.js";
import type {
  RetrievedChunk,
  SearchOptions,
  StorageBackend,
} from "../types.js";
import type { GraphArmStorage, Neo4jArmStorage } from "../retrieval/types.js";

/**
 * Graph-rag storage backend: the chunk-store contract plus the OPTIONAL
 * graph-arm seams. Additive — never a breaking change for chunk-only
 * implementations.
 *
 * Two seams, one per graph arm, because they ask the ledger different
 * questions: `graphArmSeed` traverses `triples` in SQL (archived, #58),
 * while `neo4jArmSeed` only maps entity ids the graph engine already
 * ranked back onto chunks (#70).
 */
export interface GraphRagStorageBackend extends StorageBackend {
  graphArmSeed?: GraphArmStorage;
  neo4jArmSeed?: Neo4jArmStorage;
}

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
