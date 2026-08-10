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
export type { GraphArmStorage } from "../retrieval/types.js";
import type { StorageBackend } from "../types.js";
import type { GraphArmStorage } from "../retrieval/types.js";

/**
 * Graph-rag storage backend: the chunk-store contract plus an OPTIONAL
 * graph-arm seed seam. Additive — never a breaking change for chunk-only
 * implementations.
 */
export interface GraphRagStorageBackend extends StorageBackend {
  graphArmSeed?: GraphArmStorage;
}
