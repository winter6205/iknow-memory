/**
 * Neo4j GDS Personalized-PageRank adapter (specs/neo4j-graph-arm.md T4).
 *
 * The adapter is the only place that speaks Cypher for retrieve. This suite
 * drives it through a fake session, so it asserts the CONVERSATION — project,
 * stream, drop — and the read-only contract, without a live graph. The
 * live proof lives in tests/integration/neo4j-ppr-arm.test.ts.
 *
 * Procedure names and hyperparameters are deliberately NOT frozen here: the
 * spec leaves them as implementer headroom, so the tests assert that the
 * options steer the emitted Cypher rather than pinning one forever-default.
 */
import { describe, it, expect } from "vitest";

import {
  buildPprCypher,
  createPprRanker,
  DROP_GRAPH_CYPHER,
  PROJECT_GRAPH_CYPHER,
  type CypherSession,
} from "../../src/core/graph/neo4j-ppr.js";

/** Records every statement and hands back scripted rows for the stream. */
class FakeSession implements CypherSession {
  readonly statements: Array<{
    cypher: string;
    params: Record<string, unknown>;
  }> = [];
  streamRows: Array<Record<string, unknown>> = [];
  failOn: string | undefined;
  closed = 0;

  async run(
    cypher: string,
    params: Record<string, unknown>
  ): Promise<Array<Record<string, unknown>>> {
    this.statements.push({ cypher, params });
    if (this.failOn !== undefined && cypher.includes(this.failOn)) {
      throw new Error(`cypher failed: ${this.failOn}`);
    }
    return cypher.includes("pageRank") ? this.streamRows : [];
  }

  async close(): Promise<void> {
    this.closed += 1;
  }

  kinds(): string[] {
    return this.statements.map(({ cypher }) => {
      if (cypher.includes("gds.graph.project")) return "project";
      if (cypher.includes("pageRank")) return "stream";
      if (cypher.includes("gds.graph.drop")) return "drop";
      return "other";
    });
  }
}

function ranking(id: string, score: number): Record<string, unknown> {
  return { entityId: id, score };
}

describe("createPprRanker — the PPR conversation", () => {
  it("projects, streams, then drops the ephemeral graph", async () => {
    const session = new FakeSession();
    session.streamRows = [ranking("e1", 0.9), ranking("e2", 0.4)];
    const ranker = createPprRanker(session);

    const ranked = await ranker.rankEntities(["seed-1"], 10);

    expect(session.kinds()).toEqual(["project", "stream", "drop"]);
    expect(ranked).toEqual([
      { id: "e1", score: 0.9 },
      { id: "e2", score: 0.4 },
    ]);
  });

  it("anchors the ranking on the seed ids it was given", async () => {
    const session = new FakeSession();
    const ranker = createPprRanker(session);

    await ranker.rankEntities(["seed-1", "seed-2"], 10);

    const stream = session.statements[1]!;
    expect(stream.params["seedIds"]).toEqual(["seed-1", "seed-2"]);
    expect(stream.cypher).toContain("sourceNodes");
  });

  it("names one throwaway graph per call and drops that same name", async () => {
    const session = new FakeSession();
    const ranker = createPprRanker(session);

    await ranker.rankEntities(["seed-1"], 10);
    await ranker.rankEntities(["seed-1"], 10);

    const names = session.statements.map((s) => s.params["graphName"]);
    expect(new Set(names.slice(0, 3)).size).toBe(1);
    expect(new Set(names.slice(3)).size).toBe(1);
    // A shared name across calls would make two concurrent retrieves fight
    // over one GDS catalog entry.
    expect(names[0]).not.toBe(names[3]);
  });

  it("truncates the ranking to the requested limit", async () => {
    const session = new FakeSession();
    session.streamRows = [
      ranking("e1", 0.9),
      ranking("e2", 0.5),
      ranking("e3", 0.1),
    ];
    const ranker = createPprRanker(session);

    const ranked = await ranker.rankEntities(["seed-1"], 2);

    expect(ranked.map((r) => r.id)).toEqual(["e1", "e2"]);
  });

  it("touches the graph at all only when there is a seed to anchor on", async () => {
    const session = new FakeSession();
    const ranker = createPprRanker(session);

    // An unanchored PageRank is plain global PageRank — the wrong answer,
    // and an expensive one. Refuse the round trip instead.
    expect(await ranker.rankEntities([], 10)).toEqual([]);
    expect(session.statements).toEqual([]);
  });

  it("drops the projection even when the ranking step fails", async () => {
    const session = new FakeSession();
    session.failOn = "pageRank";
    const ranker = createPprRanker(session);

    await expect(ranker.rankEntities(["seed-1"], 10)).rejects.toThrow(
      /pageRank/
    );
    // Leaking a projection would pin the whole graph in memory until the
    // next restart.
    expect(session.kinds()).toEqual(["project", "stream", "drop"]);
  });

  it("propagates a projection failure without attempting to stream", async () => {
    const session = new FakeSession();
    session.failOn = "gds.graph.project";
    const ranker = createPprRanker(session);

    await expect(ranker.rankEntities(["seed-1"], 10)).rejects.toThrow(
      /gds.graph.project/
    );
    expect(session.kinds()).toEqual(["project"]);
  });

  it("closes the session it was handed", async () => {
    const session = new FakeSession();
    const ranker = createPprRanker(session);

    await ranker.close();

    expect(session.closed).toBe(1);
  });
});

describe("PPR Cypher — read-only and steerable", () => {
  const statements = [
    PROJECT_GRAPH_CYPHER,
    buildPprCypher({ dampingFactor: 0.85, maxIterations: 20, tolerance: 1e-7 }),
    DROP_GRAPH_CYPHER,
  ];

  // ADR-0001: Neo4j is a read-only projection. The retrieve path must not
  // write product data — only the projection CLIs may, and they use their
  // own MERGE statements.
  it.each(["CREATE", "MERGE", "DELETE", "REMOVE", "SET"])(
    "never writes to the graph (%s)",
    (keyword) => {
      const pattern = new RegExp(`\\b${keyword}\\b`, "i");
      for (const cypher of statements) {
        expect(cypher).not.toMatch(pattern);
      }
    }
  );

  it("reads entities and relations, and asks for undirected traversal", () => {
    expect(PROJECT_GRAPH_CYPHER).toContain(":Entity");
    expect(PROJECT_GRAPH_CYPHER).toContain(":RELATION");
    // A directed projection would make a tail entity unreachable from its
    // head, which is not what "related to the seed" means.
    expect(PROJECT_GRAPH_CYPHER).toContain("undirectedRelationshipTypes");
  });

  it("puts the hyperparameters the caller chose into the statement", () => {
    const tuned = buildPprCypher({
      dampingFactor: 0.5,
      maxIterations: 7,
      tolerance: 0.001,
    });
    expect(tuned).toContain("dampingFactor: 0.5");
    expect(tuned).toContain("maxIterations: 7");
    expect(tuned).toContain("tolerance: 0.001");
  });

  it("rejects a hyperparameter that is not a finite number", () => {
    expect(() =>
      buildPprCypher({
        dampingFactor: Number.NaN,
        maxIterations: 20,
        tolerance: 1e-7,
      })
    ).toThrow(/dampingFactor/);
  });

  it("keeps unreachable entities out of the result", () => {
    // Personalized PageRank scores everything the seeds cannot reach as 0;
    // returning those would hand the arm the entire graph.
    expect(buildPprCypher()).toContain("score > 0");
  });
});
