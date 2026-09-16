/**
 * dashboard-api graph endpoints — /api/graph and /api/entities/:id/backlinks (T4).
 *
 * Inject a fake CypherSession. Wire: 200 {nodes, edges} / {entity, inbound, outbound};
 * empty projection is 200; unconfigured or unreachable is structured
 * NEO4J_UNAVAILABLE (never a fail-open empty graph).
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import type { CypherSession } from "../../src/core/graph/neo4j-ppr.js";
import { boot, fetchJson, memoryDeps } from "./helpers.js";
import type { DashboardServerDeps } from "../../src/dashboard-api/index.js";

interface FakeGraph {
  nodes: Array<Record<string, unknown>>;
  edges: Array<Record<string, unknown>>;
  entity: Array<Record<string, unknown>>;
  inbound: Array<Record<string, unknown>>;
  outbound: Array<Record<string, unknown>>;
  fail?: boolean;
}

/**
 * A neo4j-driver session is single-flight: a second `run()` while the
 * previous one is still outstanding throws. The fake mirrors that contract
 * so a `Promise.all([session.run(...), session.run(...)])` regression is
 * observable. Resolution is deferred a microtask, otherwise a
 * synchronously-returning fake could never overlap and the bug would hide.
 */
const SINGLE_FLIGHT_MESSAGE = "session already has work in flight";

/** Concurrency high-water mark observed by the fake session. */
interface FakeSessionStats {
  /** Highest number of `run()` calls seen in flight at the same time. */
  maxConcurrentRuns: number;
}

function fakeSessionFactory(fake: FakeGraph, stats: FakeSessionStats) {
  let inFlight = 0;
  const session: CypherSession = {
    async run(cypher: string) {
      // Count and record before the overlap check so a Promise.all regression
      // observably drives maxConcurrentRuns to 2 rather than merely throwing.
      inFlight += 1;
      if (inFlight > stats.maxConcurrentRuns)
        stats.maxConcurrentRuns = inFlight;
      try {
        if (inFlight > 1) throw new Error(SINGLE_FLIGHT_MESSAGE);
        await Promise.resolve();
        if (fake.fail) {
          throw new Error(
            "Neo4j at bolt://127.0.0.1:7687 is unreachable: connection refused"
          );
        }
        if (cypher.includes("RELATION")) {
          if (!cypher.includes("$id")) return fake.edges;
          const outbound = /\{\s*id:\s*\$id\s*\}\s*\)\s*-\[/.test(cypher);
          return outbound ? fake.outbound : fake.inbound;
        }
        return cypher.includes("$id") ? fake.entity : fake.nodes;
      } finally {
        inFlight -= 1;
      }
    },
    async close() {
      return;
    },
  };
  return () => session;
}

function graphDeps(
  fake: FakeGraph,
  stats: FakeSessionStats = { maxConcurrentRuns: 0 }
): DashboardServerDeps {
  return {
    ...memoryDeps(),
    openGraphSession: fakeSessionFactory(fake, stats),
  };
}

const ENT_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_ID = "22222222-2222-2222-2222-222222222222";

const baseFake: FakeGraph = {
  nodes: [
    { id: ENT_ID, name: "Alice", type: "person" },
    { id: OTHER_ID, name: "Acme", type: "system" },
  ],
  edges: [{ from: ENT_ID, to: OTHER_ID, type: "works_for" }],
  entity: [{ id: ENT_ID, name: "Alice", type: "person" }],
  inbound: [
    {
      from: OTHER_ID,
      to: ENT_ID,
      type: "delegates_to",
      from_name: "Acme",
      from_type: "system",
    },
  ],
  outbound: [
    {
      from: ENT_ID,
      to: OTHER_ID,
      type: "works_for",
      to_name: "Acme",
      to_type: "system",
    },
  ],
};

describe("dashboard-api /api/graph", () => {
  it("returns nodes and edges from the read-only projection", async () => {
    const { baseUrl } = await boot(graphDeps(baseFake));
    const res = await fetchJson(`${baseUrl}/api/graph`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      nodes: [
        { id: ENT_ID, name: "Alice", type: "person" },
        { id: OTHER_ID, name: "Acme", type: "system" },
      ],
      edges: [{ from: ENT_ID, to: OTHER_ID, type: "works_for" }],
    });
  });

  it("returns an empty graph (200) when Neo4j answers with no rows", async () => {
    const { baseUrl } = await boot(
      graphDeps({ ...baseFake, nodes: [], edges: [] })
    );
    const res = await fetchJson(`${baseUrl}/api/graph`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ nodes: [], edges: [] });
  });

  it("maps a connection failure to 503 NEO4J_UNAVAILABLE, not an empty graph", async () => {
    const { baseUrl } = await boot(graphDeps({ ...baseFake, fail: true }));
    const res = await fetchJson(`${baseUrl}/api/graph`);
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      error: { code: "NEO4J_UNAVAILABLE" },
    });
    expect(res.body).not.toMatchObject({ nodes: [] });
  });

  it("returns 503 NEO4J_UNAVAILABLE when no sidecar is configured", async () => {
    const { baseUrl } = await boot();
    const res = await fetchJson(`${baseUrl}/api/graph`);
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      error: { code: "NEO4J_UNAVAILABLE" },
    });
  });
});

describe("dashboard-api /api/entities/:id/backlinks", () => {
  it("returns the entity plus inbound and outbound neighbor rows", async () => {
    const { baseUrl } = await boot(graphDeps(baseFake));
    const res = await fetchJson(`${baseUrl}/api/entities/${ENT_ID}/backlinks`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      entity: { id: ENT_ID, name: "Alice", type: "person" },
      inbound: [
        {
          id: OTHER_ID,
          name: "Acme",
          type: "system",
          relation: "delegates_to",
        },
      ],
      outbound: [
        { id: OTHER_ID, name: "Acme", type: "system", relation: "works_for" },
      ],
    });
  });

  it("returns 404 NOT_FOUND for an unknown entity id", async () => {
    const { baseUrl } = await boot(
      graphDeps({ ...baseFake, entity: [], inbound: [], outbound: [] })
    );
    const res = await fetchJson(`${baseUrl}/api/entities/${ENT_ID}/backlinks`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: { code: "NOT_FOUND" } });
    const body = res.body as { error: { message: string } };
    expect(body.error.message).not.toMatch(/no handler/);
  });

  it("maps a connection failure to 503 NEO4J_UNAVAILABLE", async () => {
    const { baseUrl } = await boot(graphDeps({ ...baseFake, fail: true }));
    const res = await fetchJson(`${baseUrl}/api/entities/${ENT_ID}/backlinks`);
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      error: { code: "NEO4J_UNAVAILABLE" },
    });
  });

  it("returns 503 NEO4J_UNAVAILABLE when no sidecar is configured", async () => {
    const { baseUrl } = await boot();
    const res = await fetchJson(`${baseUrl}/api/entities/${ENT_ID}/backlinks`);
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      error: { code: "NEO4J_UNAVAILABLE" },
    });
  });
});

/**
 * Regression: a real neo4j-driver session is single-flight — concurrent
 * `run()` calls throw. `fakeSessionFactory` above records the concurrency
 * high-water mark, so these assert the two queries actually ran one after
 * the other (never 2 in flight), not merely that the response body matched.
 * A `Promise.all` regression in `projection-reads` would overlap the queries
 * and drive `maxConcurrentRuns` to 2.
 */
describe("dashboard-api graph reads are single-flight on one session", () => {
  it("/api/graph issues its two queries without overlapping", async () => {
    const stats: FakeSessionStats = { maxConcurrentRuns: 0 };
    const { baseUrl } = await boot(graphDeps(baseFake, stats));
    const res = await fetchJson(`${baseUrl}/api/graph`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      nodes: [
        { id: ENT_ID, name: "Alice", type: "person" },
        { id: OTHER_ID, name: "Acme", type: "system" },
      ],
      edges: [{ from: ENT_ID, to: OTHER_ID, type: "works_for" }],
    });
    expect(stats.maxConcurrentRuns).toBe(1);
  });

  it("/api/entities/:id/backlinks issues its three queries without overlapping", async () => {
    const stats: FakeSessionStats = { maxConcurrentRuns: 0 };
    const { baseUrl } = await boot(graphDeps(baseFake, stats));
    const res = await fetchJson(`${baseUrl}/api/entities/${ENT_ID}/backlinks`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      entity: { id: ENT_ID, name: "Alice", type: "person" },
      inbound: [
        {
          id: OTHER_ID,
          name: "Acme",
          type: "system",
          relation: "delegates_to",
        },
      ],
      outbound: [
        { id: OTHER_ID, name: "Acme", type: "system", relation: "works_for" },
      ],
    });
    expect(stats.maxConcurrentRuns).toBe(1);
  });
});

describe("dashboard-api Cypher SSOT", () => {
  it("does not keep MATCH Cypher strings in dashboard-api", () => {
    const root = join(import.meta.dirname, "..", "..", "src", "dashboard-api");
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (name.endsWith(".ts")) {
          const src = readFileSync(full, "utf8");
          if (/MATCH\s+\(/.test(src)) hits.push(full);
        }
      }
    };
    walk(root);
    expect(hits).toEqual([]);
  });
});
