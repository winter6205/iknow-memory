/**
 * Personalized PageRank over the Neo4j projection, via Neo4j GDS
 * (specs/neo4j-graph-arm.md T4; #70/#72).
 *
 * This is the READ half of the sidecar — the mirror of `neo4j-writer.ts`,
 * which owns the only writes. Nothing here touches product data: the arm
 * projects the existing `(:Entity)-[:RELATION]->(:Entity)` graph into the
 * GDS in-memory catalog, streams a seed-anchored PageRank off it, and drops
 * the projection again. ADR-0001 holds — Postgres stays the system of
 * record and the retrieve path never writes to the graph.
 *
 * Three statements per call, in that order, with the drop in a `finally`:
 * a leaked projection would pin the whole graph in heap until restart.
 * The projection is per-call and throwaway rather than a long-lived named
 * graph: a cached projection would answer from whatever the ledger looked
 * like when it was built, and the projection outbox drains continuously.
 * Refreshing a shared graph instead is the obvious next step if the
 * per-call cost ever matters — that is a tuning decision, not a contract.
 *
 * Procedure names and hyperparameters are implementer HEADROOM per the
 * spec, so they are options with defaults rather than frozen constants:
 * `createNeo4jPprRanker(config, { dampingFactor, ... })` re-tunes the arm
 * without touching this file's callers.
 */
import { randomUUID } from "node:crypto";

import neo4j, { type Driver } from "neo4j-driver";

import type { Neo4jConfig } from "../../config.js";
import { GraphUnavailableError } from "./types.js";

/** One Cypher round trip — all the PPR flow needs from a driver. */
export interface CypherSession {
  run(
    cypher: string,
    params: Record<string, unknown>
  ): Promise<Array<Record<string, unknown>>>;
  close(): Promise<void>;
}

/** GDS PageRank knobs. Defaults match the GDS defaults for damping/iterations. */
export interface PprOptions {
  dampingFactor: number;
  maxIterations: number;
  tolerance: number;
}

export const DEFAULT_PPR_OPTIONS: PprOptions = {
  dampingFactor: 0.85,
  maxIterations: 20,
  tolerance: 1e-7,
};

/** One entity and its PPR mass. Structurally the retrieval `RankedEntity`. */
export interface EntityRanking {
  id: string;
  score: number;
}

/** What the retrieve arm consumes; `close` is for the owner of the driver. */
export interface PprRanker {
  rankEntities(
    seedEntityIds: readonly string[],
    limit: number
  ): Promise<EntityRanking[]>;
  close(): Promise<void>;
}

/**
 * Project every `:Entity` and every `:RELATION` into the GDS catalog.
 *
 * `OPTIONAL MATCH` so an entity with no relation is still projected: a seed
 * missing from the projection makes the PageRank call fail outright, and an
 * isolated entity is a perfectly ordinary ledger row.
 *
 * Undirected because "related to the seed" has no direction — the ledger's
 * `works_for` edge should let a query about the person reach the company
 * and a query about the company reach the person.
 */
export const PROJECT_GRAPH_CYPHER = `MATCH (source:Entity)
     OPTIONAL MATCH (source)-[:RELATION]->(target:Entity)
     WITH gds.graph.project($graphName, source, target, {},
                            {undirectedRelationshipTypes: ['*']}) AS g
     RETURN g.graphName AS graphName, g.nodeCount AS nodeCount,
            g.relationshipCount AS relationshipCount`;

/** `false` = do not fail when the graph is already gone. */
export const DROP_GRAPH_CYPHER = `CALL gds.graph.drop($graphName, false)
     YIELD graphName RETURN graphName`;

/**
 * Build the seed-anchored PageRank stream.
 *
 * Hyperparameters are interpolated as Cypher literals rather than bound as
 * parameters because GDS types its config strictly (`maxIterations` is a
 * Long, `dampingFactor` a Double) while the driver sends every JS number as
 * a Float. They are validated as finite numbers first — nothing here is
 * caller-supplied text, and this keeps it that way.
 *
 * `WHERE size(sources) > 0` guards the anchor: PageRank with an empty
 * `sourceNodes` list silently degenerates into global PageRank, which
 * answers a different question. No rows reach the procedure, so it does
 * not run at all.
 *
 * `WHERE score > 0` drops everything the seeds cannot reach — without it
 * the arm would receive the entire graph in seed order.
 */
export function buildPprCypher(opts: PprOptions = DEFAULT_PPR_OPTIONS): string {
  const damping = literal("dampingFactor", opts.dampingFactor);
  const iterations = literal("maxIterations", Math.trunc(opts.maxIterations));
  const tolerance = literal("tolerance", opts.tolerance);
  return `MATCH (seed:Entity) WHERE seed.id IN $seedIds
     WITH collect(seed) AS sources
     WHERE size(sources) > 0
     CALL gds.pageRank.stream($graphName, {
       sourceNodes: sources,
       dampingFactor: ${damping},
       maxIterations: ${iterations},
       tolerance: ${tolerance}
     })
     YIELD nodeId, score
     WITH gds.util.asNode(nodeId).id AS entityId, score
     WHERE score > 0
     RETURN entityId, score
     ORDER BY score DESC, entityId ASC`;
}

function literal(name: string, value: number): string {
  if (!Number.isFinite(value)) {
    throw new TypeError(`PPR ${name} must be a finite number, got ${value}`);
  }
  return String(value);
}

/**
 * The PPR conversation over an already-open session. Exported separately
 * from the driver-backed factory so the flow is testable without a graph.
 */
export function createPprRanker(
  session: CypherSession,
  opts: PprOptions = DEFAULT_PPR_OPTIONS
): PprRanker {
  const streamCypher = buildPprCypher(opts);
  return {
    async rankEntities(seedEntityIds, limit) {
      if (seedEntityIds.length === 0) return [];
      const graphName = `ppr-${randomName()}`;
      await session.run(PROJECT_GRAPH_CYPHER, { graphName });
      try {
        const rows = await session.run(streamCypher, {
          graphName,
          seedIds: [...seedEntityIds],
        });
        return rows.slice(0, limit).map(toRanking);
      } finally {
        await dropQuietly(session, graphName);
      }
    },
    close: () => session.close(),
  };
}

/**
 * Drop the throwaway projection. A failure here is logged, never thrown:
 * by this point the ranking is already computed (or already failing for a
 * reason the caller needs to see), and replacing that with a catalog
 * cleanup error would hide it. The leaked projection is reported instead.
 */
async function dropQuietly(
  session: CypherSession,
  graphName: string
): Promise<void> {
  try {
    await session.run(DROP_GRAPH_CYPHER, { graphName });
  } catch (err) {
    // EXIT: 原始结果/错误由调用方继续处理，这里只记录残留的 GDS 投影
    console.warn(
      `neo4j-ppr: failed to drop projection ${graphName}: ` +
        `${err instanceof Error ? err.message : String(err)}`
    );
  }
}

function toRanking(row: Record<string, unknown>): EntityRanking {
  return { id: String(row["entityId"]), score: Number(row["score"]) };
}

function randomName(): string {
  return randomUUID();
}

/**
 * Open a PPR ranker against `config` — the already-validated
 * `loadEnv().neo4j` block, so this file never re-reads the env.
 *
 * The driver is created on the FIRST ranking, not here: a server whose
 * operator configured a sidecar but never retrieves should not dial it, and
 * a sidecar that is down must surface as a fail-open retrieve rather than a
 * server that refuses to start. Driver-level failures come back as
 * `GraphUnavailableError`, the same type the projection CLIs already map to
 * a loud skip.
 */
export function createNeo4jPprRanker(
  config: Neo4jConfig,
  opts: PprOptions = DEFAULT_PPR_OPTIONS
): PprRanker {
  let driver: Driver | undefined;
  const session: CypherSession = {
    async run(cypher, params) {
      driver ??= openDriver(config);
      const s = driver.session();
      try {
        const result = await s.run(cypher, params);
        return result.records.map((record) => record.toObject());
      } catch (err) {
        throw new GraphUnavailableError(config.uri, err);
      } finally {
        await s.close();
      }
    },
    async close() {
      await driver?.close();
      driver = undefined;
    },
  };
  return createPprRanker(session, opts);
}

function openDriver(config: Neo4jConfig): Driver {
  const auth =
    config.user !== undefined && config.password !== undefined
      ? neo4j.auth.basic(config.user, config.password)
      : undefined;
  return neo4j.driver(config.uri, auth);
}
