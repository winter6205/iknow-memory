/**
 * Index-time Louvain community detection over the Neo4j projection.
 *
 * The detector owns only the GDS read session. Community summaries remain
 * Postgres ledger data and are written by the summary CLI, never by Neo4j.
 * Each call uses a throwaway projection so it cannot become stale relative
 * to the projection outbox.
 */
import { randomUUID } from "node:crypto";
import neo4j, { type Driver } from "neo4j-driver";

import type { Neo4jConfig } from "../../config.js";
import { writeStderr } from "../../logging.js";
import { GraphUnavailableError } from "./types.js";

export interface Community {
  id: string;
  entityIds: string[];
}

export interface CypherSession {
  run(
    cypher: string,
    params: Record<string, unknown>
  ): Promise<Array<Record<string, unknown>>>;
  close(): Promise<void>;
}

export const COMMUNITY_PROJECT_CYPHER = `MATCH (source:Entity)
  OPTIONAL MATCH (source)-[:RELATION]->(target:Entity)
  WITH gds.graph.project($graphName, source, target, {},
                         {undirectedRelationshipTypes: ['*']}) AS g
  RETURN g.graphName AS graphName, g.nodeCount AS nodeCount,
         g.relationshipCount AS relationshipCount`;

export const COMMUNITY_LOUVAIN_CYPHER = `CALL gds.louvain.stream($graphName)
  YIELD nodeId, communityId
  WITH communityId, collect(gds.util.asNode(nodeId).id) AS entityIds
  RETURN toString(communityId) AS communityId, entityIds
  ORDER BY communityId`;

export const COMMUNITY_DROP_CYPHER = `CALL gds.graph.drop($graphName, false)
  YIELD graphName RETURN graphName`;

export interface CommunityDetector {
  detect(): Promise<Community[]>;
  close(): Promise<void>;
}

/**
 * Create a detector over an already testable session. The temporary graph is
 * always dropped, including when projection or Louvain throws.
 */
export function createCommunityDetector(
  session: CypherSession
): CommunityDetector {
  return {
    async detect() {
      const graphName = `community-${randomUUID()}`;
      try {
        const projectionRows = await session.run(COMMUNITY_PROJECT_CYPHER, {
          graphName,
        });
        if (projectionRows.length === 0) return [];
        const rows = await session.run(COMMUNITY_LOUVAIN_CYPHER, {
          graphName,
        });
        return rows.map(toCommunity).sort(compareCommunities);
      } finally {
        await dropQuietly(session, graphName);
      }
    },
    close: () => session.close(),
  };
}

/** Open a lazy Neo4j driver for the index-time summary CLI. */
export function createNeo4jCommunityDetector(
  config: Neo4jConfig
): CommunityDetector {
  let driver: Driver | undefined;
  const session: CypherSession = {
    async run(cypher, params) {
      driver ??= openDriver(config);
      const current = driver.session();
      try {
        const result = await current.run(cypher, params);
        return result.records.map((record) => record.toObject());
      } catch (err) {
        throw new GraphUnavailableError(config.uri, err);
      } finally {
        await current.close();
      }
    },
    async close() {
      await driver?.close();
      driver = undefined;
    },
  };
  return createCommunityDetector(session);
}

function toCommunity(row: Record<string, unknown>): Community {
  const rawIds = row["entityIds"];
  const entityIds = Array.isArray(rawIds) ? rawIds.map(String) : [];
  return {
    id: String(row["communityId"]),
    entityIds,
  };
}

function compareCommunities(a: Community, b: Community): number {
  const aNumber = Number(a.id);
  const bNumber = Number(b.id);
  if (Number.isFinite(aNumber) && Number.isFinite(bNumber)) {
    return aNumber - bNumber;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

async function dropQuietly(
  session: CypherSession,
  graphName: string
): Promise<void> {
  try {
    await session.run(COMMUNITY_DROP_CYPHER, { graphName });
  } catch (err) {
    // EXIT: detection error remains primary; cleanup is observable only.
    writeStderr(
      `neo4j-community: failed to drop projection ${graphName}: ` +
        `${err instanceof Error ? err.message : String(err)}\n`
    );
  }
}

function openDriver(config: Neo4jConfig): Driver {
  const auth =
    config.user !== undefined && config.password !== undefined
      ? neo4j.auth.basic(config.user, config.password)
      : undefined;
  return neo4j.driver(config.uri, auth);
}
