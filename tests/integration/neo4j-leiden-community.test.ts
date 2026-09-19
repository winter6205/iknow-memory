/**
 * neo4j-leiden-community: the real community detector against a live Neo4j
 * + GDS (graph-index-standard-fast T2 smoke). Everything the fake-Cypher
 * sessions assume about `gds.leiden.stream` output is checked against the
 * actual procedure here — the fake/live divergence that let
 * `Unknown procedure output: intermediateCommunities` ship is exactly what
 * this suite exists to prevent.
 *
 * The fixture drives `createNeo4jCommunityDetector` the same way
 * src/cli/community-summary.ts wires it (loadEnv-shaped Neo4jConfig,
 * default options: seed 42, lcc on, sorted chunking). Topology and expected
 * partitions are the live-probed ground truth for GDS 2.13.2 / Neo4j 5.26
 * with randomSeed 42: two K4 cliques joined by one edge, a tail hanging off
 * the second clique (main component), and a two-node speck component that
 * the largest-connected-component filter must drop.
 *
 * Loud-skip (never a silent pass, never a red build without the sidecar):
 * - `GRAPHRAG_MEMORY_NEO4J_URI` unset or the instance unreachable;
 * - `gds.leiden.stream` not installed;
 * - foreign `:Entity` nodes present (the projection is database-wide, and
 *   the community edition has no multi-database isolation);
 * - foreign named GDS graphs present (the "no leaked projection" check
 *   asserts an empty catalog).
 *
 * Unlike graph-neo4j.test.ts this suite builds its Neo4jConfig from the raw
 * GRAPHRAG_MEMORY_NEO4J_* triple rather than loadEnv(): the detector never
 * touches Postgres, embeddings, rerank or BM25, so loadEnv's unrelated
 * fail-start variables would gate a pure-GDS smoke on env it does not use.
 * The shape matches parseNeo4jConfig's validated {uri, user, password}.
 *
 * To run it:
 *   docker run -d --rm -p 7687:7687 \
 *     -e NEO4J_AUTH=neo4j/<password> -e NEO4J_PLUGINS='["graph-data-science"]' \
 *     neo4j:5
 *   GRAPHRAG_MEMORY_NEO4J_URI=bolt://localhost:7687 \
 *     GRAPHRAG_MEMORY_NEO4J_USER=neo4j \
 *     GRAPHRAG_MEMORY_NEO4J_PASSWORD=<password> \
 *     npx vitest run tests/integration/neo4j-leiden-community.test.ts
 *
 * Fixture nodes carry a per-run UUID `smokeRun` marker and are DETACH
 * DELETEd in afterAll — even when a case failed mid-run.
 */
import { randomUUID } from "node:crypto";
import neo4j, { type Driver } from "neo4j-driver";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { NEO4J_URI_VAR, type Neo4jConfig } from "../../src/config.js";
import { createNeo4jCommunityDetector } from "../../src/core/graph/neo4j-community.js";
import type { Community } from "../../src/core/graph/neo4j-community.js";
import { redactDiagnostic } from "../../src/logging.js";

/** Per-run marker so teardown only ever touches this suite's nodes. */
const MARKER = randomUUID();

/** Main component: K4(a) — one edge — K4(b), tail t1 off b4. */
const CLIQUE_A: [string, string, string, string] = ["a1", "a2", "a3", "a4"];
const CLIQUE_B: [string, string, string, string] = ["b1", "b2", "b3", "b4"];
const TAIL = "t1";
const MAIN = [...CLIQUE_A, ...CLIQUE_B, TAIL];
/** Speck component: a connected pair — IN the projection, OUT via lcc. */
const SPECK = ["s1", "s2"];

const EDGES: Array<[string, string]> = [
  ...cliqueEdges(CLIQUE_A),
  ...cliqueEdges(CLIQUE_B),
  ["a4", "b1"],
  ["b4", TAIL],
  [SPECK[0]!, SPECK[1]!],
];

/** All six undirected pairs of a 4-clique, in order. */
function cliqueEdges([w, x, y, z]: [string, string, string, string]): Array<
  [string, string]
> {
  return [[w, x], [w, y], [w, z], [x, y], [x, z], [y, z]];
}

/** Entity.id values are fresh UUIDs per run; name keeps assertions readable. */
const IDS = new Map<string, string>(
  [...MAIN, ...SPECK].map((name) => [name, randomUUID()])
);
const id = (name: string): string => IDS.get(name)!;
const sorted = (names: string[]): string[] =>
  [...names].map(id).sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));

function skipLoudly(reason: string): void {
  console.warn(`\n[neo4j-leiden-community] ${reason}\n`);
  console.warn(
    "Validation:\n" +
      "- Not run: tests/integration/neo4j-leiden-community.test.ts\n" +
      `- Expected command: ${NEO4J_URI_VAR}=bolt://localhost:7687 GRAPHRAG_MEMORY_NEO4J_USER=neo4j GRAPHRAG_MEMORY_NEO4J_PASSWORD=<password> npx vitest run tests/integration/neo4j-leiden-community.test.ts\n` +
      `- Blocking issue: ${reason}\n`
  );
}

function readTrimmed(name: string): string | undefined {
  const raw = process.env[name]?.trim();
  return raw === "" ? undefined : raw;
}

function probeDriver(settings: Neo4jConfig): Driver {
  const auth =
    settings.user !== undefined && settings.password !== undefined
      ? neo4j.auth.basic(settings.user, settings.password)
      : undefined;
  return neo4j.driver(settings.uri, auth);
}

function readRows(
  driver: Driver,
  cypher: string
): Promise<Array<Record<string, unknown>>> {
  return (async () => {
    const session = driver.session();
    try {
      const res = await session.run(cypher);
      return res.records.map((r) => r.toObject());
    } finally {
      await session.close();
    }
  })();
}

let SETTINGS: Neo4jConfig | undefined;
let READY = false;
const uri = readTrimmed(NEO4J_URI_VAR);
if (uri === undefined) {
  skipLoudly(`${NEO4J_URI_VAR} is not set — no live GDS to smoke`);
} else {
  SETTINGS = {
    uri,
    user: readTrimmed("GRAPHRAG_MEMORY_NEO4J_USER"),
    password: readTrimmed("GRAPHRAG_MEMORY_NEO4J_PASSWORD"),
  };
  try {
    const probe = probeDriver(SETTINGS);
    await probe.verifyConnectivity();
    const leiden = await readRows(
      probe,
      "SHOW PROCEDURES YIELD name WHERE name = 'gds.leiden.stream' " +
        "RETURN count(*) AS hits"
    );
    const foreign = await readRows(
      probe,
      "CALL { MATCH (n:Entity) RETURN count(n) AS entities } " +
        "CALL { CALL gds.graph.list() YIELD graphName " +
        "RETURN count(graphName) AS graphs } " +
        "RETURN entities, graphs"
    );
    await probe.close();
    const leidenHits = Number(leiden[0]?.hits ?? 0);
    const entities = Number(foreign[0]?.entities ?? 0);
    const graphs = Number(foreign[0]?.graphs ?? 0);
    if (leidenHits === 0) {
      skipLoudly("gds.leiden.stream is not installed — GDS missing or too old");
    } else if (entities > 0) {
      skipLoudly(
        `${entities} foreign :Entity nodes already exist — the graph ` +
          "projection is database-wide and they would join the communities"
      );
    } else if (graphs > 0) {
      skipLoudly(
        `${graphs} foreign named GDS graphs already exist — the leak check ` +
          "needs an empty graph catalog"
      );
    } else {
      READY = true;
    }
  } catch (err) {
    skipLoudly(
      "cannot reach Neo4j at " +
        redactDiagnostic(uri) +
        ": " +
        redactDiagnostic(err instanceof Error ? err.message : String(err))
    );
  }
}
const describeSuite = READY ? describe : describe.skip;

describeSuite(
  "neo4j-leiden-community: real detector over a live GDS Leiden",
  () => {
    let driver: Driver;

    async function exec(
      cypher: string,
      params: Record<string, unknown> = {}
    ): Promise<Array<Record<string, unknown>>> {
      const session = driver.session();
      try {
        const res = await session.executeWrite((tx) => tx.run(cypher, params));
        return res.records.map((r) => r.toObject());
      } finally {
        await session.close();
      }
    }

    async function graphCatalog(): Promise<string[]> {
      const rows = await exec(
        "CALL gds.graph.list() YIELD graphName RETURN graphName"
      );
      return rows.map((row) => String(row.graphName));
    }

    beforeAll(async () => {
      driver = probeDriver(SETTINGS!);
      await exec(
        `UNWIND $nodes AS n
         MERGE (e:Entity {id: n.uuid})
         SET e.smokeRun = $marker, e.canonical_name = n.name`,
        {
          nodes: [...IDS].map(([name, uuid]) => ({ name, uuid })),
          marker: MARKER,
        }
      );
      await exec(
        `UNWIND $edges AS e
         MATCH (a:Entity {id: e.from}),(b:Entity {id: e.to})
         CREATE (a)-[:RELATION {id: e.uuid}]->(b)`,
        {
          edges: EDGES.map(([from, to]) => ({
            from: id(from),
            to: id(to),
            uuid: randomUUID(),
          })),
        }
      );
    });

    afterAll(async () => {
      // Best-effort teardown on ANY exit path: this run's nodes, then any
      // projection a failed case left behind (names are random UUIDs, so
      // match the detector's `community-` prefix; the gate proved no
      // foreign graphs exist, so this can only hit our own leaks).
      try {
        await exec(
          `MATCH (e:Entity) WHERE e.smokeRun = $marker DETACH DELETE e`,
          { marker: MARKER }
        );
      } catch (err) {
        console.warn(`teardown nodes failed: ${String(err)}`);
      }
      try {
        const leaks = (await graphCatalog()).filter((name) =>
          name.startsWith("community-")
        );
        for (const name of leaks) {
          await exec(`CALL gds.graph.drop($name, false) YIELD graphName RETURN graphName`, { name });
        }
      } catch (err) {
        console.warn(`teardown projections failed: ${String(err)}`);
      }
      await driver.close();
    });

    /** Run the REAL detector exactly as community-summary.ts wires it. */
    async function detect(
      options: Parameters<typeof createNeo4jCommunityDetector>[1] = {}
    ): Promise<Community[]> {
      const detector = createNeo4jCommunityDetector(SETTINGS!, options);
      try {
        return await detector.detect();
      } finally {
        await detector.close();
      }
    }

    it("detects the probed fine partition on the main component and excludes the speck pair", async () => {
      const communities = await detect();
      // Live-probed GDS 2.13.2 + seed 42: the bridged K4s split at the
      // finest level and the tail joins its clique's community.
      const level1 = communities.filter((c) => c.level === 1);
      expect(level1).toHaveLength(2);
      const memberSets = level1
        .map((c) => [...c.entityIds].sort())
        .sort((x, y) => (x[0]! < y[0]! ? -1 : 1));
      const expected = [
        sorted(CLIQUE_A),
        sorted([...CLIQUE_B, TAIL]),
      ].sort((x, y) => (x[0]! < y[0]! ? -1 : 1));
      expect(memberSets).toEqual(expected);
      // Every main node covered exactly once; nothing outside the main
      // component — the speck pair is connected (so it IS projected) and
      // must be dropped by the largest-connected-component filter.
      const all = communities.flatMap((c) => c.entityIds);
      expect(new Set(all).size).toBe(MAIN.length);
      expect(new Set(all)).toEqual(new Set(MAIN.map(id)));
      expect(all).not.toContain(id(SPECK[0]!));
      expect(all).not.toContain(id(SPECK[1]!));
    });

    it("assigns Community.level from the probed array semantics (index 0 = level 1 = finest)", async () => {
      const communities = await detect();
      expect(communities.length).toBeGreaterThan(0);
      for (const community of communities) {
        expect(community.level).toBe(1);
      }
    });

    it("is deterministic: two consecutive runs return identical communities", async () => {
      const first = await detect();
      const second = await detect();
      expect(second).toEqual(first);
    });

    it("caps communities at maxClusterSize with deterministic -2/-3 chunk ids", async () => {
      // Cap 2 against communities of 4 and 5 members: chunked into
      // [2,2] and [2,2,1] with the first chunk keeping the bare Leiden id.
      const communities = (await detect({ maxClusterSize: 2 })).filter(
        (c) => c.level === 1
      );
      expect(communities.length).toBe(5);
      for (const community of communities) {
        expect(community.entityIds.length).toBeLessThanOrEqual(2);
      }
      const byBase = new Map<string, Community[]>();
      for (const community of communities) {
        const base = community.id.replace(/-\d+$/, "");
        byBase.set(base, [...(byBase.get(base) ?? []), community]);
      }
      expect([...byBase.keys()]).toHaveLength(2);
      for (const [base, chunks] of byBase) {
        const indexes = chunks.map((c) =>
          c.id === base ? 1 : Number(c.id.slice(base.length + 1))
        );
        expect(indexes.sort((x, y) => x - y)).toEqual(
          Array.from({ length: chunks.length }, (_, i) => i + 1)
        );
      }
      const chunkSizes = [...byBase.values()]
        .flatMap((chunks) => chunks.map((c) => c.entityIds.length))
        .sort((x, y) => x - y);
      expect(chunkSizes).toEqual([1, 2, 2, 2, 2]);
      // Chunking preserves coverage: the union is still the main component.
      expect(
        new Set(communities.flatMap((c) => c.entityIds))
      ).toEqual(new Set(MAIN.map(id)));
    });

    it("leaves no projection behind in the GDS graph catalog", async () => {
      await detect();
      expect(await graphCatalog()).toEqual([]);
    });
  }
);
