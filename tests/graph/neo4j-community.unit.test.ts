import { describe, expect, it } from "vitest";
import {
  COMMUNITY_DROP_CYPHER,
  COMMUNITY_PROJECT_CYPHER,
  COMMUNITY_LOUVAIN_CYPHER,
  createCommunityDetector,
  type CypherSession,
} from "../../src/core/graph/neo4j-community.js";

describe("Neo4j GDS community detector", () => {
  it("projects the graph, streams Louvain communities, and drops the projection", async () => {
    const calls: string[] = [];
    const session: CypherSession = {
      async run(cypher) {
        calls.push(cypher);
        if (cypher === COMMUNITY_PROJECT_CYPHER) {
          return [{ nodeCount: 3 }];
        }
        if (cypher === COMMUNITY_LOUVAIN_CYPHER) {
          return [
            { communityId: 2, entityIds: ["entity-b", "entity-c"] },
            { communityId: 1, entityIds: ["entity-a"] },
          ];
        }
        return [];
      },
      async close() {},
    };

    const detector = createCommunityDetector(session);
    await expect(detector.detect()).resolves.toEqual([
      { id: "1", entityIds: ["entity-a"] },
      { id: "2", entityIds: ["entity-b", "entity-c"] },
    ]);
    expect(calls).toEqual([
      COMMUNITY_PROJECT_CYPHER,
      COMMUNITY_LOUVAIN_CYPHER,
      COMMUNITY_DROP_CYPHER,
    ]);
  });

  it("treats an empty projection result as no communities", async () => {
    const calls: string[] = [];
    const session: CypherSession = {
      async run(cypher) {
        calls.push(cypher);
        if (cypher === COMMUNITY_PROJECT_CYPHER) return [];
        if (cypher === COMMUNITY_DROP_CYPHER) return [];
        throw new Error("Louvain should not run for an empty projection");
      },
      async close() {},
    };

    const detector = createCommunityDetector(session);
    await expect(detector.detect()).resolves.toEqual([]);
    expect(calls).toEqual([
      COMMUNITY_PROJECT_CYPHER,
      COMMUNITY_DROP_CYPHER,
    ]);
  });

  it("drops the temporary projection when Louvain fails and preserves the error", async () => {
    const calls: string[] = [];
    const session: CypherSession = {
      async run(cypher) {
        calls.push(cypher);
        if (cypher === COMMUNITY_PROJECT_CYPHER) {
          return [{ nodeCount: 1 }];
        }
        if (cypher === COMMUNITY_LOUVAIN_CYPHER) {
          throw new Error("GDS unavailable");
        }
        return [];
      },
      async close() {},
    };

    const detector = createCommunityDetector(session);
    await expect(detector.detect()).rejects.toThrow("GDS unavailable");
    expect(calls).toEqual([
      COMMUNITY_PROJECT_CYPHER,
      COMMUNITY_LOUVAIN_CYPHER,
      COMMUNITY_DROP_CYPHER,
    ]);
  });
});
