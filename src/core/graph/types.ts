/**
 * The projection target contract (specs/neo4j-graph-arm.md; ADR-0001).
 *
 * Neo4j is a read-only projection of the Postgres ledger, so the shapes below
 * are deliberately narrower than the ledger rows: a node is
 * `{id, canonical_name, type}` with no embedding, an edge carries
 * `relation_norm` + confidence + valid bounds, and there is no chunk shape at
 * all — chunks never enter the graph.
 *
 * The writer is an interface so the backfill CLI (T2) and the outbox drain
 * (T3) share one idempotent MERGE surface, and so tests can drive both without
 * a live database.
 */

/** A projected entity. No embedding: vector search stays in Postgres. */
export interface GraphNode {
  id: string;
  canonicalName: string;
  type: string;
}

/**
 * A projected triple. `validFrom` / `validUntil` are ISO-8601 strings (null
 * upper bound = forever, matching the ledger's tstzrange), `confidence` rides
 * along for inspection but must not become the graph ranking algorithm (#57).
 */
export interface GraphEdge {
  id: string;
  headId: string;
  tailId: string;
  relationNorm: string;
  confidence: number;
  validFrom: string | null;
  validUntil: string | null;
}

/**
 * Projection write surface. Merge calls are keyed by the ledger id; delete
 * calls remove stale subjects that no longer have a live ledger row.
 */
export interface GraphWriter {
  /** Uniqueness constraints the MERGEs rely on. Idempotent. */
  ensureConstraints(): Promise<void>;
  mergeNodes(nodes: readonly GraphNode[]): Promise<void>;
  mergeEdges(edges: readonly GraphEdge[]): Promise<void>;
  deleteNodes(ids: readonly string[]): Promise<void>;
  deleteEdges(ids: readonly string[]): Promise<void>;
  close(): Promise<void>;
}

/** The public reason this graph arm did not run: a configured but silent peer. */
export const GRAPH_UNAVAILABLE_CODE = "NEO4J_UNAVAILABLE" as const;

/**
 * Neo4j is configured but not usable right now (down, refusing connections,
 * auth rejected, connection dropped mid-run).
 *
 * A distinct type because the callers treat it distinctly: the backfill CLI
 * turns it into a loud skip with a re-run-safe exit code instead of a fatal,
 * and the retrieve arm (T4) will fail open on it. It is NOT a `GraphragError`:
 * no MCP handler surfaces this code, and widening the tool-facing taxonomy for
 * a CLI/projection concern would leak the projection into the server contract.
 */
export class GraphUnavailableError extends Error {
  readonly code = GRAPH_UNAVAILABLE_CODE;
  constructor(
    readonly uri: string,
    readonly cause: unknown
  ) {
    super(
      `Neo4j at ${uri} is unreachable: ${cause instanceof Error ? cause.message : String(cause)}`
    );
    this.name = "GraphUnavailableError";
  }
}
