/**
 * dashboard-api graph endpoints — /api/graph and /api/entities/:id/backlinks (T4).
 *
 * Inject a fake CypherSession. Wire: 200 {nodes, edges} / {entity, inbound};
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
  fail?: boolean;
}

function fakeSessionFactory(fake: FakeGraph) {
  const session: CypherSession = {
    async run(cypher: string) {
      if (fake.fail) {
        throw new Error(
          "Neo4j at bolt://127.0.0.1:7687 is unreachable: connection refused"
        );
      }
      if (cypher.includes("RELATION")) {
        return cypher.includes("$id") ? fake.inbound : fake.edges;
      }
      return cypher.includes("$id") ? fake.entity : fake.nodes;
    },
    async close() {
      return;
    },
  };
  return () => session;
}

function graphDeps(fake: FakeGraph): DashboardServerDeps {
  return {
    ...memoryDeps(),
    openGraphSession: fakeSessionFactory(fake),
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
  inbound: [{ from: OTHER_ID, to: ENT_ID, type: "delegates_to" }],
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
  it("returns the entity plus its inbound edges", async () => {
    const { baseUrl } = await boot(graphDeps(baseFake));
    const res = await fetchJson(`${baseUrl}/api/entities/${ENT_ID}/backlinks`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      entity: { id: ENT_ID, name: "Alice", type: "person" },
      inbound: [{ from: OTHER_ID, to: ENT_ID, type: "delegates_to" }],
    });
  });

  it("returns 404 NOT_FOUND for an unknown entity id", async () => {
    const { baseUrl } = await boot(
      graphDeps({ ...baseFake, entity: [], inbound: [] })
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
