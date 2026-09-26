/**
 * Neo4j-backed `GraphWriter` — the only surface in this repo that writes to
 * the graph (ADR-0001: Postgres is the sole system of record, Neo4j is a
 * derived read-only projection fed exclusively by this projection path).
 *
 * Every merge statement is keyed on the ledger id, so re-projecting the same
 * subject updates in place. Deletions are issued only by the T3 drain when a
 * claimed subject no longer exists in the Postgres ledger.
 */
import neo4j, { type Driver } from "neo4j-driver";

import { ConfigError, NEO4J_URI_VAR, type Neo4jConfig } from "../../config.js";
import {
  GraphUnavailableError,
  type GraphEdge,
  type GraphNode,
  type GraphWriter,
} from "./types.js";

/** Ledger id ↔ node identity; also the index every MERGE below seeks on. */
const ENTITY_CONSTRAINT = `CREATE CONSTRAINT entity_id_unique IF NOT EXISTS
  FOR (e:Entity) REQUIRE e.id IS UNIQUE`;

const MERGE_NODES = `UNWIND $rows AS row
  MERGE (e:Entity {id: row.id})
  SET e.canonical_name = row.canonicalName, e.type = row.type`;

/**
 * MATCH (not MERGE) on the endpoints: a node this projection has not seen yet
 * means the ledger scan and the edge scan disagree, and inventing a blank node
 * would put an entity in the graph that Postgres never authorised.
 *
 * Neo4j has no null property value — `SET p = null` REMOVES the property. So
 * an unbounded `valid_until` (forever, the ledger's null upper bound) projects
 * as an absent property, and a bound that is later added replaces the absence.
 * Readers must treat "no valid_until" as "still valid".
 */
const MERGE_EDGES = `UNWIND $rows AS row
  MATCH (head:Entity {id: row.headId})
  MATCH (tail:Entity {id: row.tailId})
  MERGE (head)-[edge:RELATION {id: row.id}]->(tail)
  SET edge.relation_norm = row.relationNorm,
      edge.confidence = row.confidence,
      edge.valid_from = row.validFrom,
      edge.valid_until = row.validUntil`;

const DELETE_NODES = `UNWIND $ids AS id
  MATCH (e:Entity {id: id})
  DETACH DELETE e`;

const DELETE_EDGES = `UNWIND $ids AS id
  MATCH ()-[edge:RELATION {id: id}]->()
  DELETE edge`;

class Neo4jGraphWriter implements GraphWriter {
  constructor(
    private readonly driver: Driver,
    private readonly uri: string
  ) {}

  async ensureConstraints(): Promise<void> {
    await this.write(ENTITY_CONSTRAINT, {});
  }

  async mergeNodes(nodes: readonly GraphNode[]): Promise<void> {
    if (nodes.length === 0) return;
    await this.write(MERGE_NODES, { rows: nodes });
  }

  async mergeEdges(edges: readonly GraphEdge[]): Promise<void> {
    if (edges.length === 0) return;
    await this.write(MERGE_EDGES, { rows: edges });
  }

  async deleteNodes(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.write(DELETE_NODES, { ids: [...ids] });
  }

  async deleteEdges(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.write(DELETE_EDGES, { ids: [...ids] });
  }

  async close(): Promise<void> {
    await this.driver.close();
  }

  /**
   * One managed write transaction per statement. Driver-level failures are
   * re-thrown as `GraphUnavailableError` so a caller never has to pattern-match
   * on Neo4j error codes to tell "the graph is down" from "the query is wrong".
   */
  private async write(
    cypher: string,
    params: Record<string, unknown>
  ): Promise<void> {
    const session = this.driver.session();
    try {
      await session.executeWrite((tx) => tx.run(cypher, params));
    } catch (err) {
      throw new GraphUnavailableError(this.uri, err);
    } finally {
      await session.close();
    }
  }
}

/**
 * Open a writer against `config` — the already-validated `loadEnv().neo4j`
 * block, so this file never re-reads or re-checks the env. Connectivity is
 * verified up front so an unreachable instance is a loud skip before any
 * partial projection runs.
 */
export async function connectNeo4j(config: Neo4jConfig): Promise<GraphWriter> {
  const auth =
    config.user !== undefined && config.password !== undefined
      ? neo4j.auth.basic(config.user, config.password)
      : undefined;
  const driver = neo4j.driver(config.uri, auth);
  try {
    await driver.verifyConnectivity();
  } catch (err) {
    await driver.close();
    throw new GraphUnavailableError(config.uri, err);
  }
  return new Neo4jGraphWriter(driver, config.uri);
}

/**
 * Open the configured projection target, or refuse: an absent block (no URI
 * configured) is a ConfigError, never a silent skip — an operator invoked
 * this path precisely to project, so "no target configured" is their mistake
 * (the skip-without-degraded rule belongs to the retrieve arm, which was not
 * asked to touch Neo4j). `purpose` keeps each caller's own message, with its
 * own flags, next to this one decision.
 */
export async function openConfiguredNeo4j(
  config: Neo4jConfig | undefined,
  purpose: string
): Promise<GraphWriter> {
  if (config === undefined) {
    throw new ConfigError(`${NEO4J_URI_VAR} is required ${purpose}`);
  }
  return connectNeo4j(config);
}
