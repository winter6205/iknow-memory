/**
 * Index-time hierarchical Leiden community detection over the Neo4j projection.
 *
 * The detector owns only the GDS read session. Community summaries remain
 * Postgres ledger data and are written by the summary CLI, never by Neo4j.
 * Each call uses a throwaway projection so it cannot become stale relative
 * to the projection outbox.
 *
 * Detection shape (ADR-0011): project undirected → optional
 * largest-connected-component filter via `gds.wcc` → `gds.leiden.stream`
 * with `includeIntermediateCommunities` → drop projection. The live-probed
 * GDS 2.13 output column is `intermediateCommunityIds`: an array of
 * community ids ordered finest → coarsest (level k = index k − 1; its last
 * element is the final `communityId`). GDS Leiden has no native
 * cluster-size cap, so oversized communities are split by deterministic
 * sorted chunking. A fixed integer seed keeps the same graph + seed
 * reproducible to the same partition.
 */
import { randomUUID } from "node:crypto";
import neo4j, { type Driver } from "neo4j-driver";

import type { Neo4jConfig } from "../../config.js";
import { writeStderr } from "../../logging.js";
import { GraphUnavailableError } from "./types.js";

export interface Community {
  id: string;
  entityIds: string[];
  /**
   * Leiden hierarchy level (1 = finest). Optional so pre-Leiden callers and
   * fixtures that build literals without a level keep compiling; the
   * detector always sets it.
   */
  level?: number;
}

export interface CypherSession {
  run(
    cypher: string,
    params: Record<string, unknown>
  ): Promise<Array<Record<string, unknown>>>;
  close(): Promise<void>;
}

export interface CommunityDetectorOptions {
  /** Hard cap on members per reported community; enforced by sorted chunking. */
  maxClusterSize?: number;
  /** Restrict detection to the largest connected component (gds.wcc). */
  useLcc?: boolean;
  /** Fixed integer Leiden seed for reproducible partitions. */
  randomSeed?: number;
}

/** Spec Open Question 2 resolved as the implementer-chosen fixed seed. */
export const LEIDEN_DEFAULT_RANDOM_SEED = 42;
export const LEIDEN_DEFAULT_MAX_CLUSTER_SIZE = 10;

export const COMMUNITY_PROJECT_CYPHER = `MATCH (source:Entity)
  WITH count(source) AS entityCount
  WHERE entityCount > 0
  CALL gds.graph.project($graphName, 'Entity',
                         {RELATION: {orientation: 'UNDIRECTED'}})
  YIELD graphName, nodeCount, relationshipCount
  RETURN graphName, nodeCount, relationshipCount`;

/** Largest connected component: one row, member ids, tie-broken by componentId. */
export const COMMUNITY_LCC_CYPHER = `CALL gds.wcc.stream($graphName)
  YIELD nodeId, componentId
  WITH componentId, collect(gds.util.asNode(nodeId).id) AS entityIds
  RETURN componentId, entityIds
  ORDER BY size(entityIds) DESC, componentId
  LIMIT 1`;

export const COMMUNITY_LEIDEN_CYPHER = `CALL gds.leiden.stream($graphName,
    {includeIntermediateCommunities: true, randomSeed: $randomSeed})
  YIELD nodeId, intermediateCommunityIds
  RETURN gds.util.asNode(nodeId).id AS entityId, intermediateCommunityIds
  ORDER BY entityId`;

export const COMMUNITY_DROP_CYPHER = `CALL gds.graph.drop($graphName, false)
  YIELD graphName RETURN graphName`;

export interface CommunityDetector {
  detect(): Promise<Community[]>;
  close(): Promise<void>;
}

/**
 * Create a detector over an already testable session. The temporary graph is
 * always dropped, including when projection, wcc, or Leiden throws.
 */
export function createCommunityDetector(
  session: CypherSession,
  options: CommunityDetectorOptions = {}
): CommunityDetector {
  const maxClusterSize = options.maxClusterSize ?? LEIDEN_DEFAULT_MAX_CLUSTER_SIZE;
  const useLcc = options.useLcc ?? true;
  const randomSeed = options.randomSeed ?? LEIDEN_DEFAULT_RANDOM_SEED;
  if (!Number.isInteger(maxClusterSize) || maxClusterSize < 1) {
    throw new TypeError(
      `community detector: maxClusterSize must be a positive integer, got ${String(maxClusterSize)}`
    );
  }
  if (!Number.isInteger(randomSeed)) {
    throw new TypeError(
      `community detector: randomSeed must be an integer, got ${String(randomSeed)}`
    );
  }
  return {
    async detect() {
      const graphName = `community-${randomUUID()}`;
      try {
        const projectionRows = await session.run(COMMUNITY_PROJECT_CYPHER, {
          graphName,
        });
        if (projectionRows.length === 0) return [];
        let lccMembers: Set<string> | undefined;
        if (useLcc) {
          const lccRows = await session.run(COMMUNITY_LCC_CYPHER, {
            graphName,
          });
          lccMembers = new Set(
            lccRows.length > 0 ? toStringList(lccRows[0]["entityIds"]) : []
          );
        }
        const leidenRows = await session.run(COMMUNITY_LEIDEN_CYPHER, {
          graphName,
          randomSeed,
        });
        return toHierarchicalCommunities(leidenRows, lccMembers, maxClusterSize);
      } finally {
        await dropQuietly(session, graphName);
      }
    },
    close: () => session.close(),
  };
}

/** Open a lazy Neo4j driver for the index-time summary CLI. */
export function createNeo4jCommunityDetector(
  config: Neo4jConfig,
  options: CommunityDetectorOptions = {}
): CommunityDetector {
  let driver: Driver | undefined;
  const session: CypherSession = {
    async run(cypher, params) {
      driver ??= openDriver(config);
      const current = driver.session();
      try {
        const result = await current.run(cypher, toDriverParameters(params));
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
  return createCommunityDetector(session, options);
}

/**
 * The JS driver serializes a plain integer as a Cypher Float, and GDS
 * rejects a Float `randomSeed` ("must be of type Long"). Integer params
 * therefore become driver Integers at this boundary; the CypherSession seam
 * (and the fake unit tests) keep seeing plain numbers.
 */
function toDriverParameters(
  params: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    out[key] =
      typeof value === "number" && Number.isInteger(value)
        ? neo4j.int(value)
        : value;
  }
  return out;
}

/**
 * Group `gds.leiden.stream` rows by (level, communityId), drop members
 * outside the largest component, then split oversized communities into
 * deterministic sorted chunks.
 */
function toHierarchicalCommunities(
  rows: Array<Record<string, unknown>>,
  lccMembers: Set<string> | undefined,
  maxClusterSize: number
): Community[] {
  return splitIntoOrderedChunks(
    groupCommunitiesByLevel(rows, lccMembers),
    maxClusterSize
  );
}

/**
 * Collect members per (level, leiden communityId), skipping rows outside the
 * largest component. `intermediateCommunityIds` is consumed by ARRAY INDEX —
 * level k = index k − 1 (finest first, live-probed against GDS 2.13). Never
 * iterate it with Object.entries: that would present the indices as string
 * keys and silently mis-number (or drop) the finest level. Ids are numbered
 * per level, so the same id at two levels stays two distinct communities.
 */
function groupCommunitiesByLevel(
  rows: Array<Record<string, unknown>>,
  lccMembers: Set<string> | undefined
): Map<number, Map<string, string[]>> {
  const groups = new Map<number, Map<string, string[]>>();
  for (const row of rows) {
    const entityId = String(row["entityId"]);
    if (lccMembers !== undefined && !lccMembers.has(entityId)) continue;
    const levels = row["intermediateCommunityIds"];
    if (!Array.isArray(levels)) continue;
    for (let index = 0; index < levels.length; index += 1) {
      addMember(groups, index + 1, String(levels[index]), entityId);
    }
  }
  return groups;
}

/** Insert one member, creating the (level, communityId) buckets on demand. */
function addMember(
  groups: Map<number, Map<string, string[]>>,
  level: number,
  communityId: string,
  entityId: string
): void {
  const byId = groups.get(level) ?? new Map<string, string[]>();
  const members = byId.get(communityId) ?? [];
  members.push(entityId);
  byId.set(communityId, members);
  groups.set(level, byId);
}

/**
 * Split oversized communities into deterministic sorted chunks. Chunk ids:
 * the first chunk keeps the Leiden community id; later chunks append `-2`,
 * `-3`, … . Output is globally ordered by (level, numeric communityId,
 * chunk index).
 */
function splitIntoOrderedChunks(
  groups: Map<number, Map<string, string[]>>,
  maxClusterSize: number
): Community[] {
  const entries: CommunityEntry[] = [];
  for (const [level, byId] of groups) {
    for (const [communityId, members] of byId) {
      members.sort(compareEntityIds);
      let chunkIndex = 0;
      for (let start = 0; start < members.length; start += maxClusterSize) {
        entries.push({
          level,
          communityId,
          chunkIndex,
          community: {
            id: chunkIndex === 0 ? communityId : `${communityId}-${chunkIndex + 1}`,
            entityIds: members.slice(start, start + maxClusterSize),
            level,
          },
        });
        chunkIndex += 1;
      }
    }
  }
  entries.sort(compareEntries);
  return entries.map((entry) => entry.community);
}

interface CommunityEntry {
  level: number;
  communityId: string;
  chunkIndex: number;
  community: Community;
}

/** Sort by level, then numeric Leiden id, then chunk index (never "X-10" vs "X-2"). */
function compareEntries(a: CommunityEntry, b: CommunityEntry): number {
  const byLevel = a.level - b.level;
  if (byLevel !== 0) return byLevel;
  const aNumber = Number(a.communityId);
  const bNumber = Number(b.communityId);
  if (Number.isFinite(aNumber) && Number.isFinite(bNumber)) {
    if (aNumber !== bNumber) return aNumber - bNumber;
  } else if (a.communityId !== b.communityId) {
    return a.communityId < b.communityId ? -1 : 1;
  }
  return a.chunkIndex - b.chunkIndex;
}

/** Code-unit ordering, locale-independent so chunking is reproducible. */
function compareEntityIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function toStringList(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.map(String) : [];
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
