import { describe, expect, it } from "vitest";
import {
  COMMUNITY_DROP_CYPHER,
  COMMUNITY_LCC_CYPHER,
  COMMUNITY_LEIDEN_CYPHER,
  COMMUNITY_PROJECT_CYPHER,
  LEIDEN_DEFAULT_MAX_CLUSTER_SIZE,
  LEIDEN_DEFAULT_RANDOM_SEED,
  createCommunityDetector,
  type Community,
  type CypherSession,
} from "../../src/core/graph/neo4j-community.js";

interface RecordedCall {
  cypher: string;
  params: Record<string, unknown>;
}

interface FakeSessionOptions {
  projectionRows?: Array<Record<string, unknown>>;
  lccRows?: Array<Record<string, unknown>>;
  leidenRows?: Array<Record<string, unknown>>;
  failOn?: string;
}

/** Fake CypherSession: no live Neo4j/GDS. Routes canned rows per query. */
function fakeSession(opts: FakeSessionOptions = {}): {
  session: CypherSession;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const session: CypherSession = {
    async run(cypher, params) {
      calls.push({ cypher, params });
      if (opts.failOn === cypher) {
        throw new Error("GDS unavailable");
      }
      if (cypher === COMMUNITY_PROJECT_CYPHER) {
        return opts.projectionRows ?? [{ nodeCount: 3 }];
      }
      if (cypher === COMMUNITY_LCC_CYPHER) {
        return opts.lccRows ?? [];
      }
      if (cypher === COMMUNITY_LEIDEN_CYPHER) {
        return opts.leidenRows ?? [];
      }
      return [];
    },
    async close() {},
  };
  return { session, calls };
}

/**
 * One `gds.leiden.stream` row as GDS 2.13 really emits it:
 * `intermediateCommunityIds` is an ARRAY of integer community ids ordered
 * finest → coarsest (level k = array index k − 1, last element =
 * communityId). Ids restart per level, so the same id can reappear at a
 * different level — see the live-probe evidence in the integration smoke.
 */
function leidenRow(
  entityId: string,
  communityIdsByLevelAscending: number[]
): Record<string, unknown> {
  return { entityId, intermediateCommunityIds: communityIdsByLevelAscending };
}

function communitiesOfLevel(
  communities: Community[],
  level: number
): Community[] {
  return communities.filter((community) => community.level === level);
}

describe("Neo4j GDS hierarchical Leiden community detector", () => {
  it("projects the graph, filters by the largest component, streams Leiden, and drops the projection", async () => {
    const { session, calls } = fakeSession({
      lccRows: [
        {
          componentId: 7,
          entityIds: ["entity-a", "entity-b", "entity-c"],
        },
      ],
      leidenRows: [
        leidenRow("entity-a", [101, 201]),
        leidenRow("entity-b", [101, 201]),
        leidenRow("entity-c", [102, 201]),
      ],
    });

    const detector = createCommunityDetector(session);
    await expect(detector.detect()).resolves.toEqual([
      { id: "101", entityIds: ["entity-a", "entity-b"], level: 1 },
      { id: "102", entityIds: ["entity-c"], level: 1 },
      { id: "201", entityIds: ["entity-a", "entity-b", "entity-c"], level: 2 },
    ]);
    expect(calls.map((call) => call.cypher)).toEqual([
      COMMUNITY_PROJECT_CYPHER,
      COMMUNITY_LCC_CYPHER,
      COMMUNITY_LEIDEN_CYPHER,
      COMMUNITY_DROP_CYPHER,
    ]);
  });

  it("surfaces intermediate Leiden levels as hierarchical communities", async () => {
    const all = ["entity-a", "entity-b", "entity-c", "entity-d"];
    const { session } = fakeSession({
      lccRows: [{ componentId: 1, entityIds: all }],
      leidenRows: [
        leidenRow("entity-a", [11, 21, 31]),
        leidenRow("entity-b", [11, 21, 31]),
        leidenRow("entity-c", [12, 22, 31]),
        leidenRow("entity-d", [12, 22, 31]),
      ],
    });

    const communities = await createCommunityDetector(session).detect();
    expect(communitiesOfLevel(communities, 1)).toEqual([
      { id: "11", entityIds: ["entity-a", "entity-b"], level: 1 },
      { id: "12", entityIds: ["entity-c", "entity-d"], level: 1 },
    ]);
    expect(communitiesOfLevel(communities, 2)).toEqual([
      { id: "21", entityIds: ["entity-a", "entity-b"], level: 2 },
      { id: "22", entityIds: ["entity-c", "entity-d"], level: 2 },
    ]);
    expect(communitiesOfLevel(communities, 3)).toEqual([
      {
        id: "31",
        entityIds: ["entity-a", "entity-b", "entity-c", "entity-d"],
        level: 3,
      },
    ]);
  });

  it("keeps per-level numbering apart when the same community id appears at two levels", async () => {
    // Real GDS output (live-probed, 2.13.2): ids restart each level, so a
    // node's row can legitimately read [2, 9, 2] — community 2 at level 1
    // and community 2 again at level 3. They must not merge.
    const all = ["entity-a", "entity-b", "entity-c"];
    const { session } = fakeSession({
      lccRows: [{ componentId: 1, entityIds: all }],
      leidenRows: [
        leidenRow("entity-a", [2, 9, 2]),
        leidenRow("entity-b", [2, 9, 2]),
        leidenRow("entity-c", [11, 9, 2]),
      ],
    });

    const communities = await createCommunityDetector(session).detect();
    expect(communities).toEqual([
      { id: "2", entityIds: ["entity-a", "entity-b"], level: 1 },
      { id: "11", entityIds: ["entity-c"], level: 1 },
      { id: "9", entityIds: all, level: 2 },
      { id: "2", entityIds: all, level: 3 },
    ]);
  });

  it("skips a Leiden row whose intermediate ids are not an array", async () => {
    const { session } = fakeSession({
      lccRows: [{ componentId: 1, entityIds: ["entity-a", "entity-b"] }],
      leidenRows: [
        leidenRow("entity-a", [101]),
        { entityId: "entity-b", intermediateCommunityIds: null },
      ],
    });

    const communities = await createCommunityDetector(session).detect();
    expect(communities).toEqual([
      { id: "101", entityIds: ["entity-a"], level: 1 },
    ]);
  });

  it("excludes entities outside the largest connected component when lcc is on", async () => {
    const { session } = fakeSession({
      lccRows: [{ componentId: 4, entityIds: ["entity-a", "entity-b"] }],
      leidenRows: [
        leidenRow("entity-a", [101]),
        leidenRow("entity-b", [101]),
        leidenRow("entity-speck", [102]),
      ],
    });

    const communities = await createCommunityDetector(session).detect();
    expect(communities).toEqual([
      { id: "101", entityIds: ["entity-a", "entity-b"], level: 1 },
    ]);
  });

  it("keeps every entity when wcc reports a single component", async () => {
    const { session } = fakeSession({
      lccRows: [{ componentId: 1, entityIds: ["entity-a", "entity-b"] }],
      leidenRows: [leidenRow("entity-a", [101]), leidenRow("entity-b", [101])],
    });

    const communities = await createCommunityDetector(session).detect();
    expect(communities).toEqual([
      { id: "101", entityIds: ["entity-a", "entity-b"], level: 1 },
    ]);
  });

  it("skips the wcc query entirely when use_lcc is disabled", async () => {
    const { session, calls } = fakeSession({
      leidenRows: [leidenRow("entity-a", [101])],
    });

    const communities = await createCommunityDetector(session, {
      useLcc: false,
    }).detect();
    expect(communities).toEqual([
      { id: "101", entityIds: ["entity-a"], level: 1 },
    ]);
    expect(calls.map((call) => call.cypher)).toEqual([
      COMMUNITY_PROJECT_CYPHER,
      COMMUNITY_LEIDEN_CYPHER,
      COMMUNITY_DROP_CYPHER,
    ]);
  });

  it("runs Leiden with the fixed default integer seed for reproducibility", async () => {
    const { session, calls } = fakeSession();

    await createCommunityDetector(session).detect();
    const leiden = calls.find((call) => call.cypher === COMMUNITY_LEIDEN_CYPHER);
    expect(leiden?.params["randomSeed"]).toBe(42);
    expect(LEIDEN_DEFAULT_RANDOM_SEED).toBe(42);
  });

  it("lets the caller override the Leiden seed", async () => {
    const { session, calls } = fakeSession();

    await createCommunityDetector(session, { randomSeed: 2026 }).detect();
    const leiden = calls.find((call) => call.cypher === COMMUNITY_LEIDEN_CYPHER);
    expect(leiden?.params["randomSeed"]).toBe(2026);
  });

  it("chunks an oversized community deterministically in sorted member order", async () => {
    const members = ["e5", "e1", "e2", "e3", "e4"];
    const { session } = fakeSession({
      lccRows: [{ componentId: 1, entityIds: members }],
      leidenRows: members.map((entityId) => leidenRow(entityId, [500])),
    });

    const communities = await createCommunityDetector(session, {
      maxClusterSize: 2,
    }).detect();
    expect(communities).toEqual([
      { id: "500", entityIds: ["e1", "e2"], level: 1 },
      { id: "500-2", entityIds: ["e3", "e4"], level: 1 },
      { id: "500-3", entityIds: ["e5"], level: 1 },
    ]);
  });

  it("respects the default max cluster size of ten when chunking", async () => {
    expect(LEIDEN_DEFAULT_MAX_CLUSTER_SIZE).toBe(10);
    const members = Array.from({ length: 11 }, (_, i) =>
      `entity-${String(i).padStart(2, "0")}`
    );
    const { session } = fakeSession({
      lccRows: [{ componentId: 1, entityIds: members }],
      leidenRows: members.map((entityId) => leidenRow(entityId, [900])),
    });

    const communities = await createCommunityDetector(session).detect();
    expect(communities).toEqual([
      { id: "900", entityIds: members.slice(0, 10), level: 1 },
      { id: "900-2", entityIds: ["entity-10"], level: 1 },
    ]);
  });

  it("treats an empty projection result as no communities", async () => {
    const { session, calls } = fakeSession({ projectionRows: [] });

    const communities = await createCommunityDetector(session).detect();
    expect(communities).toEqual([]);
    expect(calls.map((call) => call.cypher)).toEqual([
      COMMUNITY_PROJECT_CYPHER,
      COMMUNITY_DROP_CYPHER,
    ]);
  });

  it("treats an empty Leiden stream result as no communities", async () => {
    const { session } = fakeSession({
      lccRows: [{ componentId: 1, entityIds: ["entity-a"] }],
      leidenRows: [],
    });

    await expect(createCommunityDetector(session).detect()).resolves.toEqual(
      []
    );
  });

  it("drops the temporary projection when Leiden fails and preserves the error", async () => {
    const { session, calls } = fakeSession({ failOn: COMMUNITY_LEIDEN_CYPHER });

    const detector = createCommunityDetector(session);
    await expect(detector.detect()).rejects.toThrow("GDS unavailable");
    expect(calls[calls.length - 1]?.cypher).toBe(COMMUNITY_DROP_CYPHER);
  });

  it("drops the temporary projection when the wcc query fails and preserves the error", async () => {
    const { session, calls } = fakeSession({ failOn: COMMUNITY_LCC_CYPHER });

    const detector = createCommunityDetector(session);
    await expect(detector.detect()).rejects.toThrow("GDS unavailable");
    expect(calls[calls.length - 1]?.cypher).toBe(COMMUNITY_DROP_CYPHER);
  });

  it("rejects a non-positive max cluster size at construction", () => {
    const { session } = fakeSession();
    expect(() =>
      createCommunityDetector(session, { maxClusterSize: 0 })
    ).toThrow(TypeError);
    expect(() =>
      createCommunityDetector(session, { maxClusterSize: 1.5 })
    ).toThrow(TypeError);
  });

  it("rejects a non-integer Leiden seed at construction", () => {
    const { session } = fakeSession();
    expect(() =>
      createCommunityDetector(session, { randomSeed: 4.2 })
    ).toThrow(TypeError);
  });
});
