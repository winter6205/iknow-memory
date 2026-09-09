/**
 * Read-only Neo4j projection queries for the dashboard graph surfaces.
 * Cypher SSOT lives here — dashboard-api must not own MATCH strings.
 */
import type { CypherSession } from "./neo4j-ppr.js";

export const GRAPH_NODES_CYPHER =
  "MATCH (e:Entity) RETURN e.id AS id, e.canonical_name AS name, e.type AS type ORDER BY e.id";

export const GRAPH_EDGES_CYPHER =
  "MATCH (a:Entity)-[r:RELATION]->(b:Entity) RETURN a.id AS `from`, b.id AS `to`, r.relation_norm AS type ORDER BY r.id";

export const BACKLINK_ENTITY_CYPHER =
  "MATCH (e:Entity {id: $id}) RETURN e.id AS id, e.canonical_name AS name, e.type AS type";

export const BACKLINK_EDGES_CYPHER =
  "MATCH (a:Entity)-[r:RELATION]->(b:Entity {id: $id}) RETURN a.id AS `from`, b.id AS `to`, r.relation_norm AS type ORDER BY r.id";

export interface GraphProjectionNode {
  id: string;
  name: string;
  type: string;
}

export interface GraphProjectionEdge {
  from: string;
  to: string;
  type: string;
}

export interface GraphProjection {
  nodes: GraphProjectionNode[];
  edges: GraphProjectionEdge[];
}

export type EntityBacklinks =
  | { found: false }
  | {
      found: true;
      entity: GraphProjectionNode;
      inbound: GraphProjectionEdge[];
    };

function toNode(row: Record<string, unknown>): GraphProjectionNode {
  return {
    id: String(row["id"]),
    name: String(row["name"] ?? ""),
    type: String(row["type"]),
  };
}

function toEdge(row: Record<string, unknown>): GraphProjectionEdge {
  return {
    from: String(row["from"]),
    to: String(row["to"]),
    type: String(row["type"]),
  };
}

export async function readGraphProjection(
  session: CypherSession
): Promise<GraphProjection> {
  const [nodeRows, edgeRows] = await Promise.all([
    session.run(GRAPH_NODES_CYPHER, {}),
    session.run(GRAPH_EDGES_CYPHER, {}),
  ]);
  return {
    nodes: nodeRows.map(toNode),
    edges: edgeRows.map(toEdge),
  };
}

export async function readEntityBacklinks(
  session: CypherSession,
  id: string
): Promise<EntityBacklinks> {
  const [entityRows, inboundRows] = await Promise.all([
    session.run(BACKLINK_ENTITY_CYPHER, { id }),
    session.run(BACKLINK_EDGES_CYPHER, { id }),
  ]);
  const first = entityRows[0];
  if (first === undefined) return { found: false };
  return {
    found: true,
    entity: toNode(first),
    inbound: inboundRows.map(toEdge),
  };
}
