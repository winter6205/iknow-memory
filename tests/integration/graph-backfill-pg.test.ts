/**
 * graph-backfill-pg: the Postgres half of the projection CLI against a real
 * database (specs/neo4j-graph-arm.md SC2).
 *
 * What only a real Postgres can prove here: the keyset-paginated scans, the
 * live-endpoint JOIN, the `tstzrange` → two ISO strings mapping, and — the
 * load-bearing one — that `--reconcile` is genuinely re-runnable, because its
 * idempotence rests on a partial UNIQUE index that no fake can emulate.
 *
 * The Neo4j half (real MERGE, real re-run) lives in
 * tests/integration/graph-neo4j.test.ts, which loud-skips without an instance.
 * Here the graph is a recording fake, so the suite stays green on a machine
 * that has Postgres but no Neo4j.
 *
 * Loud skip + Validation block when Postgres is unreachable, per
 * docs/.claude/rules/test.md.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  runCli,
  type BackfillDeps,
  type BackfillPool,
} from "../../src/cli/graph-backfill.js";
import { upSchemaP0 } from "../../src/core/storage/schema-p0.js";
import type {
  GraphEdge,
  GraphNode,
  GraphWriter,
} from "../../src/core/graph/types.js";

const DIM = 8;
const BASE_DB_URL = "postgresql://postgres@localhost/postgres";
const SCHEMA = `graph_backfill_${randomUUID().slice(0, 8)}`;

function schemaDbUrl(): string {
  return `${BASE_DB_URL}?options=-c%20search_path%3D${SCHEMA}%2Cpublic`;
}

/** Sorts first, so the fixtures below have a deterministic scan order. */
const ALICE = "11111111-1111-4111-8111-111111111111";
const ACME = "22222222-2222-4222-8222-222222222222";
const RETIRED = "33333333-3333-4333-8333-333333333333";
const VALID_FROM = "2026-08-01T00:00:00.000Z";

class RecordingWriter implements GraphWriter {
  nodes: GraphNode[] = [];
  edges: GraphEdge[] = [];
  async ensureConstraints(): Promise<void> {}
  async mergeNodes(nodes: readonly GraphNode[]): Promise<void> {
    this.nodes.push(...nodes);
  }
  async mergeEdges(edges: readonly GraphEdge[]): Promise<void> {
    this.edges.push(...edges);
  }
  async close(): Promise<void> {}
}

interface Logged {
  msg: string;
  fields: Record<string, unknown> | undefined;
}

function recordingLogger(lines: Logged[]) {
  const push = (msg: string, fields?: Record<string, unknown>) =>
    void lines.push({ msg, fields });
  return {
    level: "info" as const,
    debug: () => {},
    info: push,
    warn: push,
    error: push,
  };
}

let PG_AVAILABLE = false;
try {
  const probe = new pg.Client({ connectionString: BASE_DB_URL });
  await probe.connect();
  await probe.query("SELECT 1");
  await probe.end();
  PG_AVAILABLE = true;
} catch (err) {
  console.warn(
    `\n[graph-backfill-pg] Postgres unreachable at ${BASE_DB_URL}: ${(err as Error).message}\n`
  );
  console.warn(
    "Validation:\n" +
      "- Not run: tests/integration/graph-backfill-pg.test.ts\n" +
      "- Expected command: npx vitest run tests/integration/graph-backfill-pg.test.ts\n" +
      `- Blocking issue: cannot connect to Postgres at ${BASE_DB_URL}\n`
  );
}
const describePg = PG_AVAILABLE ? describe : describe.skip;

describePg("graph-backfill-pg: ledger scans + reconcile idempotence", () => {
  let client: pg.Client | undefined;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: BASE_DB_URL });
    await client.connect();
    await client.query("CREATE EXTENSION IF NOT EXISTS vector");
    await resetSchema(client);
    await seedLedger(client);
  });

  afterAll(async () => {
    if (!client) return;
    await client.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await client.end();
  });

  async function resetSchema(c: pg.Client): Promise<void> {
    await c.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await c.query(`CREATE SCHEMA "${SCHEMA}"`);
    await c.query(`SET search_path TO "${SCHEMA}", public`);
    await c.query(`
      CREATE TABLE IF NOT EXISTS chunks (
        id uuid PRIMARY KEY,
        content text NOT NULL,
        embedding vector(${DIM}) NOT NULL
      )`);
    await upSchemaP0(c, DIM);
  }

  /** Two live entities with one edge, plus a retired entity with a dead edge. */
  async function seedLedger(c: pg.Client): Promise<void> {
    for (const [id, name, type, retired] of [
      [ALICE, "Alice Smith", "person", false],
      [ACME, "Acme Corp", "system", false],
      [RETIRED, "Old Alias", "person", true],
    ] as const) {
      await c.query(
        `INSERT INTO entities (id, canonical_name, type, retired)
           VALUES ($1, $2, $3, $4)`,
        [id, name, type, retired]
      );
    }
    for (const [head, tail] of [
      [ALICE, ACME],
      [RETIRED, ACME],
    ] as const) {
      await c.query(
        `INSERT INTO triples
           (id, head_id, tail_id, relation_raw, relation_norm, confidence,
            valid_window)
           VALUES ($1, $2, $3, 'works at', 'works_for', 0.9,
                   tstzrange($4, NULL, '[)'))`,
        [randomUUID(), head, tail, VALID_FROM]
      );
    }
  }

  /** Run the CLI against the isolated schema with a recording graph writer. */
  async function run(
    argv: string[]
  ): Promise<{ code: number; writer: RecordingWriter; lines: Logged[] }> {
    const pool = new pg.Pool({ connectionString: schemaDbUrl() });
    const writer = new RecordingWriter();
    const lines: Logged[] = [];
    const deps: BackfillDeps = {
      pool: pool as unknown as BackfillPool,
      logger: recordingLogger(lines),
      connectGraph: async () => writer,
    };
    try {
      return { code: await runCli(argv, deps), writer, lines };
    } finally {
      await pool.end();
    }
  }

  async function countIntents(c: pg.Client, status: string): Promise<number> {
    const res = await c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM projection_outbox WHERE status = $1`,
      [status]
    );
    return Number(res.rows[0]!.n);
  }

  it("projects only live entities and edges, with ISO valid bounds", async () => {
    const { code, writer } = await run(["--batch-size", "1"]);

    expect(code).toBe(0);
    expect(writer.nodes).toEqual([
      { id: ALICE, canonicalName: "Alice Smith", type: "person" },
      { id: ACME, canonicalName: "Acme Corp", type: "system" },
    ]);
    expect(writer.edges).toHaveLength(1);
    expect(writer.edges[0]).toMatchObject({
      headId: ALICE,
      tailId: ACME,
      relationNorm: "works_for",
      confidence: 0.9,
      validFrom: VALID_FROM,
      validUntil: null,
    });
  });

  it("a second backfill projects the identical set (SC2 re-run safe)", async () => {
    const first = await run([]);
    const second = await run([]);

    expect(second.code).toBe(0);
    expect(second.writer.nodes).toEqual(first.writer.nodes);
    expect(second.writer.edges).toEqual(first.writer.edges);
  });

  it("--dry-run counts the same rows without writing an intent", async () => {
    const c = client!;
    const before = await countIntents(c, "pending");

    const { code, lines, writer } = await run(["--dry-run"]);

    expect(code).toBe(0);
    expect(lines).toContainEqual({
      msg: "graph-backfill-plan",
      fields: { entities: 2, triples: 1 },
    });
    expect(writer.nodes).toEqual([]);
    expect(await countIntents(c, "pending")).toBe(before);
  });

  it("--reconcile is idempotent: a second run queues nothing new", async () => {
    const c = client!;
    await c.query(`DELETE FROM projection_outbox`);

    const first = await run(["--reconcile"]);
    expect(first.code).toBe(0);
    expect(first.lines).toContainEqual({
      msg: "graph-reconcile-complete",
      fields: { entities: 2, triples: 1, queued: 3 },
    });
    expect(await countIntents(c, "pending")).toBe(3);

    const second = await run(["--reconcile"]);
    expect(second.code).toBe(0);
    expect(second.lines).toContainEqual({
      msg: "graph-reconcile-complete",
      fields: { entities: 2, triples: 1, queued: 0 },
    });
    expect(await countIntents(c, "pending")).toBe(3);
  });

  it("a drained subject can be re-enqueued by the next reconcile", async () => {
    const c = client!;
    await c.query(`DELETE FROM projection_outbox`);
    await run(["--reconcile"]);
    await c.query(
      `UPDATE projection_outbox SET status = 'done', processed_at = now()`
    );

    const again = await run(["--reconcile"]);

    expect(again.code).toBe(0);
    expect(await countIntents(c, "pending")).toBe(3);
    expect(await countIntents(c, "done")).toBe(3);
  });

  it("never reads chunks", async () => {
    // The CLI's own scans are the only statements it issues; a chunks read
    // would mean the projection had started to care about a shape ADR-0001
    // keeps out of the graph. Asserted by content: a chunk id can never
    // appear as a projected node.
    const c = client!;
    const chunkId = randomUUID();
    await c.query(
      `INSERT INTO chunks (id, content, embedding) VALUES ($1, $2, $3)`,
      [
        chunkId,
        "a chunk that must not be projected",
        `[${"0,".repeat(DIM - 1)}0]`,
      ]
    );

    const { writer } = await run([]);

    expect(writer.nodes.map((n) => n.id)).not.toContain(chunkId);
    expect(writer.edges.map((e) => e.id)).not.toContain(chunkId);
  });
});
