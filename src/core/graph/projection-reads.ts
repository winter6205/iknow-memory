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
  "MATCH (a:Entity)-[r:RELATION]->(b:Entity {id: $id}) RETURN a.id AS `from`, b.id AS `to`, r.relation_norm AS type, a.canonical_name AS from_name, a.type AS from_type, b.canonical_name AS to_name, b.type AS to_type ORDER BY r.id";

export const OUTLINK_EDGES_CYPHER =
  "MATCH (a:Entity {id: $id})-[r:RELATION]->(b:Entity) RETURN a.id AS `from`, b.id AS `to`, r.relation_norm AS type, a.canonical_name AS from_name, a.type AS from_type, b.canonical_name AS to_name, b.type AS to_type ORDER BY r.id";

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
      outbound: GraphProjectionEdge[];
    };

/** HTTP neighbor row for GET /api/entities/:id/backlinks (not /api/graph). */
export interface EntityNeighbor {
  id: string;
  name: string;
  type: string;
  relation: string;
}

type NamedProjectionEdge = GraphProjectionEdge & {
  from_name: string;
  to_name: string;
  from_type: string;
  to_type: string;
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

function toNamedEdge(row: Record<string, unknown>): NamedProjectionEdge {
  return {
    ...toEdge(row),
    from_name: String(row["from_name"] ?? ""),
    to_name: String(row["to_name"] ?? ""),
    from_type: String(row["from_type"] ?? ""),
    to_type: String(row["to_type"] ?? ""),
  };
}

export function inboundNeighbor(edge: GraphProjectionEdge): EntityNeighbor {
  const named = edge as NamedProjectionEdge;
  return {
    id: edge.from,
    name: named.from_name ?? "",
    type: named.from_type ?? "",
    relation: edge.type,
  };
}

export function outboundNeighbor(edge: GraphProjectionEdge): EntityNeighbor {
  const named = edge as NamedProjectionEdge;
  return {
    id: edge.to,
    name: named.to_name ?? "",
    type: named.to_type ?? "",
    relation: edge.type,
  };
}

export async function readGraphProjection(
  session: CypherSession
): Promise<GraphProjection> {
  // Sequential, not Promise.all: a neo4j-driver session rejects a second
  // run() while the first is in flight. Same style as neo4j-ppr.ts.
  const nodeRows = await session.run(GRAPH_NODES_CYPHER, {});
  const edgeRows = await session.run(GRAPH_EDGES_CYPHER, {});
  return {
    nodes: nodeRows.map(toNode),
    edges: edgeRows.map(toEdge),
  };
}

export async function readEntityBacklinks(
  session: CypherSession,
  id: string
): Promise<EntityBacklinks> {
  // Sequential, not Promise.all — see readGraphProjection.
  const entityRows = await session.run(BACKLINK_ENTITY_CYPHER, { id });
  const inboundRows = await session.run(BACKLINK_EDGES_CYPHER, { id });
  const outboundRows = await session.run(OUTLINK_EDGES_CYPHER, { id });
  const first = entityRows[0];
  if (first === undefined) return { found: false };
  return {
    found: true,
    entity: toNode(first),
    inbound: inboundRows.map(toNamedEdge),
    outbound: outboundRows.map(toNamedEdge),
  };
}
