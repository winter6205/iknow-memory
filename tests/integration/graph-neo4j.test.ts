/**
 * graph-neo4j: the projection against a real Neo4j (specs/neo4j-graph-arm.md
 * SC2 — "idempotently (re-run safe). Loud-skip if Neo4j unreachable" — and
 * SC4, where the outbox drain applies intents to the same live graph).
 *
 * This is the one file in the suite that needs a live graph. It LOUD-SKIPS
 * with the documented Validation block when `GRAPHRAG_MEMORY_NEO4J_URI` is
 * unset or the instance does not answer, the same shape
 * tests/integration/bm25-pg.test.ts uses for Postgres — never a silent pass,
 * and never a red build on a machine without the sidecar.
 *
 * The connection comes from `loadEnv().neo4j` — the one place the
 * GRAPHRAG_MEMORY_NEO4J_* family is parsed — so this suite exercises the same
 * validated block the projection CLI runs on. `loadEnv()` also demands
 * GRAPHRAG_MEMORY_EMBED_DIMENSIONS, hence the second variable below.
 *
 * To run it:
 *   docker run -d --rm -p 7687:7687 -e NEO4J_AUTH=none neo4j:5
 *   GRAPHRAG_MEMORY_EMBED_DIMENSIONS=2048 \
 *     GRAPHRAG_MEMORY_NEO4J_URI=neo4j://localhost:7687 \
 *     npx vitest run tests/integration/graph-neo4j.test.ts
 *
 * Fixture rows carry per-run UUIDs and are DETACH DELETEd on teardown, so the
 * suite neither collides with nor destroys anything else in the database.
 */
import { randomUUID } from "node:crypto";
import neo4j, { type Driver } from "neo4j-driver";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  runCli,
  type BackfillDeps,
  type BackfillPool,
} from "../../src/cli/graph-backfill.js";
import {
  runCli as runDrainCli,
  type DrainDeps,
  type DrainPool,
} from "../../src/cli/graph-drain.js";
import { connectNeo4j } from "../../src/core/graph/neo4j-writer.js";
import { NEO4J_URI_VAR, loadEnv, type Neo4jConfig } from "../../src/config.js";
import { upSchemaP0 } from "../../src/core/storage/schema-p0.js";

const DIM = 8;
const BASE_DB_URL = "postgresql://postgres@localhost/postgres";
const SCHEMA = `graph_neo4j_${randomUUID().slice(0, 8)}`;
const VALID_FROM = "2026-08-01T00:00:00.000Z";

/** Per-run ids so the fixture is addressable and removable. */
const ALICE = randomUUID();
const ACME = randomUUID();
const TRIPLE = randomUUID();

function schemaDbUrl(): string {
  return `${BASE_DB_URL}?options=-c%20search_path%3D${SCHEMA}%2Cpublic`;
}

function silentLogger() {
  return {
    level: "error" as const,
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

function skipLoudly(reason: string): void {
  console.warn(`\n[graph-neo4j] ${reason}\n`);
  console.warn(
    "Validation:\n" +
      "- Not run: tests/integration/graph-neo4j.test.ts\n" +
      `- Expected command: GRAPHRAG_MEMORY_EMBED_DIMENSIONS=2048 ${NEO4J_URI_VAR}=neo4j://localhost:7687 npx vitest run tests/integration/graph-neo4j.test.ts\n` +
      `- Blocking issue: ${reason}\n`
  );
}

let SETTINGS: Neo4jConfig | undefined;
let READY = false;
try {
  SETTINGS = loadEnv().neo4j;
  if (SETTINGS === undefined) {
    skipLoudly(`${NEO4J_URI_VAR} is not set — no Neo4j to project into`);
  } else {
    const probe = probeDriver(SETTINGS);
    await probe.verifyConnectivity();
    await probe.close();
    const pgProbe = new pg.Client({ connectionString: BASE_DB_URL });
    await pgProbe.connect();
    await pgProbe.end();
    READY = true;
  }
} catch (err) {
  // SETTINGS is still undefined only if loadEnv() itself threw — the no-URI
  // case already skipped above without reaching here. Keep the two apart so a
  // ConfigError is not reported as an unreachable database.
  skipLoudly(
    SETTINGS === undefined
      ? `the environment does not load: ${(err as Error).message}`
      : `cannot reach Neo4j at ${SETTINGS.uri} or Postgres at ${BASE_DB_URL}: ${(err as Error).message}`
  );
}
const describeGraph = READY ? describe : describe.skip;

function probeDriver(settings: Neo4jConfig): Driver {
  const auth =
    settings.user !== undefined && settings.password !== undefined
      ? neo4j.auth.basic(settings.user, settings.password)
      : undefined;
  return neo4j.driver(settings.uri, auth);
}

describeGraph("graph-neo4j: idempotent projection into a live graph", () => {
  let pgClient: pg.Client;
  let driver: Driver;

  beforeAll(async () => {
    pgClient = new pg.Client({ connectionString: BASE_DB_URL });
    await pgClient.connect();
    await pgClient.query("CREATE EXTENSION IF NOT EXISTS vector");
    await pgClient.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await pgClient.query(`CREATE SCHEMA "${SCHEMA}"`);
    await pgClient.query(`SET search_path TO "${SCHEMA}", public`);
    await pgClient.query(`
      CREATE TABLE IF NOT EXISTS chunks (
        id uuid PRIMARY KEY,
        content text NOT NULL,
        embedding vector(${DIM}) NOT NULL
      )`);
    await upSchemaP0(pgClient, DIM);
    await seedLedger();
    driver = probeDriver(SETTINGS!);
  });

  afterAll(async () => {
    await run(`MATCH (e:Entity) WHERE e.id IN $ids DETACH DELETE e`, {
      ids: [ALICE, ACME],
    });
    await driver.close();
    await pgClient.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await pgClient.end();
  });

  async function seedLedger(): Promise<void> {
    for (const [id, name, type] of [
      [ALICE, "Alice Smith", "person"],
      [ACME, "Acme Corp", "system"],
    ] as const) {
      await pgClient.query(
        `INSERT INTO entities (id, canonical_name, type) VALUES ($1, $2, $3)`,
        [id, name, type]
      );
    }
    await pgClient.query(
      `INSERT INTO triples
         (id, head_id, tail_id, relation_raw, relation_norm, confidence,
          valid_window)
         VALUES ($1, $2, $3, 'works at', 'works_for', 0.9,
                 tstzrange($4, NULL, '[)'))`,
      [TRIPLE, ALICE, ACME, VALID_FROM]
    );
  }

  async function run(
    cypher: string,
    params: Record<string, unknown> = {}
  ): Promise<Record<string, unknown>[]> {
    const session = driver.session();
    try {
      const res = await session.executeWrite((tx) => tx.run(cypher, params));
      return res.records.map((r) => r.toObject());
    } finally {
      await session.close();
    }
  }

  /** Run the backfill CLI against real Postgres AND the real graph. */
  async function backfill(argv: string[] = []): Promise<number> {
    const pool = new pg.Pool({ connectionString: schemaDbUrl() });
    const deps: BackfillDeps = {
      pool: pool as unknown as BackfillPool,
      logger: silentLogger(),
      connectGraph: () => connectNeo4j(SETTINGS!),
    };
    try {
      return await runCli(argv, deps);
    } finally {
      await pool.end();
    }
  }

  /** Run the drain CLI against real Postgres AND the real graph. */
  async function drain(argv: string[] = []): Promise<number> {
    const pool = new pg.Pool({ connectionString: schemaDbUrl() });
    const deps: DrainDeps = {
      pool: pool as unknown as DrainPool,
      logger: silentLogger(),
      connectGraph: () => connectNeo4j(SETTINGS!),
    };
    try {
      return await runDrainCli(argv, deps);
    } finally {
      await pool.end();
    }
  }

  async function fixtureCounts(): Promise<{ nodes: number; edges: number }> {
    const rows = await run(
      `MATCH (e:Entity) WHERE e.id IN $ids
       WITH collect(e) AS nodes
       OPTIONAL MATCH (:Entity)-[r:RELATION {id: $tripleId}]->(:Entity)
       RETURN size(nodes) AS nodes, count(r) AS edges`,
      { ids: [ALICE, ACME], tripleId: TRIPLE }
    );
    const row = rows[0]!;
    return {
      nodes: Number(row.nodes),
      edges: Number(row.edges),
    };
  }

  it("projects the ledger and re-projects it without duplicating anything", async () => {
    expect(await backfill()).toBe(0);
    const first = await fixtureCounts();
    expect(first).toEqual({ nodes: 2, edges: 1 });

    // SC2: the whole point of MERGE-on-ledger-id.
    expect(await backfill()).toBe(0);
    expect(await fixtureCounts()).toEqual({ nodes: 2, edges: 1 });
  });

  it("carries the ADR-0001 node and edge shape (no embedding, no chunk)", async () => {
    await backfill();

    const nodes = await run(
      `MATCH (e:Entity {id: $id}) RETURN properties(e) AS props`,
      { id: ALICE }
    );
    expect(nodes[0]!.props).toEqual({
      id: ALICE,
      canonical_name: "Alice Smith",
      type: "person",
    });

    // Neo4j has no null property value: the ledger's unbounded upper bound
    // (forever) projects as an ABSENT `valid_until`, not a stored null.
    const edges = await run(
      `MATCH ()-[r:RELATION {id: $id}]->() RETURN properties(r) AS props`,
      { id: TRIPLE }
    );
    expect(edges[0]!.props).toEqual({
      id: TRIPLE,
      relation_norm: "works_for",
      confidence: 0.9,
      valid_from: VALID_FROM,
    });
  });

  it("re-projects a changed edge in place instead of adding a second one", async () => {
    await backfill();
    await pgClient.query(
      `UPDATE triples SET confidence = 0.42,
              valid_window = tstzrange($2, $3, '[)')
        WHERE id = $1`,
      [TRIPLE, VALID_FROM, "2026-09-01T00:00:00.000Z"]
    );

    expect(await backfill()).toBe(0);

    expect(await fixtureCounts()).toEqual({ nodes: 2, edges: 1 });
    const edges = await run(
      `MATCH ()-[r:RELATION {id: $id}]->() RETURN properties(r) AS props`,
      { id: TRIPLE }
    );
    expect(edges[0]!.props).toMatchObject({
      confidence: 0.42,
      valid_until: "2026-09-01T00:00:00.000Z",
    });
  });

  it("puts no chunk into the graph", async () => {
    await backfill();

    const labels = await run(`CALL db.labels() YIELD label RETURN label`);
    expect(labels.map((r) => r.label)).not.toContain("Chunk");
  });

  it("drains outbox intents into the graph and re-drains as a no-op (SC4)", async () => {
    // Start from an empty graph so what lands here is the drain's work and
    // not a leftover from the backfill cases above.
    await run(`MATCH (e:Entity) WHERE e.id IN $ids DETACH DELETE e`, {
      ids: [ALICE, ACME],
    });
    await pgClient.query(`DELETE FROM projection_outbox`);
    expect(await backfill(["--reconcile"])).toBe(0);

    expect(await drain()).toBe(0);

    expect(await fixtureCounts()).toEqual({ nodes: 2, edges: 1 });
    expect(await intentStatuses()).toEqual({ done: 3 });

    // SC4 re-drain safe: nothing is pending, so nothing is re-projected.
    expect(await drain()).toBe(0);
    expect(await fixtureCounts()).toEqual({ nodes: 2, edges: 1 });
    expect(await intentStatuses()).toEqual({ done: 3 });
  });

  it("garbage-collects a deleted edge and retired node during drain", async () => {
    await run(`MATCH (e:Entity) WHERE e.id IN $ids DETACH DELETE e`, {
      ids: [ALICE, ACME],
    });
    await pgClient.query(`DELETE FROM projection_outbox`);
    expect(await backfill()).toBe(0);
    expect(await fixtureCounts()).toEqual({ nodes: 2, edges: 1 });

    await pgClient.query(`DELETE FROM triples WHERE id = $1`, [TRIPLE]);
    await pgClient.query(
      `INSERT INTO projection_outbox (id, subject_kind, subject_id)
       VALUES ($1, 'triple', $2)`,
      [randomUUID(), TRIPLE]
    );
    expect(await drain()).toBe(0);
    expect(await fixtureCounts()).toEqual({ nodes: 2, edges: 0 });

    await pgClient.query(`UPDATE entities SET retired = true WHERE id = $1`, [
      ALICE,
    ]);
    await pgClient.query(
      `INSERT INTO projection_outbox (id, subject_kind, subject_id)
       VALUES ($1, 'entity', $2)`,
      [randomUUID(), ALICE]
    );
    expect(await drain()).toBe(0);
    expect(await fixtureCounts()).toEqual({ nodes: 1, edges: 0 });
  });

  async function intentStatuses(): Promise<Record<string, number>> {
    const res = await pgClient.query<{ status: string; count: number }>(
      `SELECT status, count(*)::int AS count
         FROM projection_outbox GROUP BY status`
    );
    return Object.fromEntries(res.rows.map((r) => [r.status, r.count]));
  }
});
