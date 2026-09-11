/**
 * graph-drain-pg: the Postgres half of the outbox drain against a real
 * database (specs/neo4j-graph-arm.md SC4).
 *
 * What only a real Postgres can prove here:
 *   - the failure record SURVIVES the batch rollback — `attempts` and
 *     `last_error` are written in their own statement after the transaction
 *     the Neo4j error aborted, and a fake cannot show that;
 *   - `--retry-failed` does not trip the partial UNIQUE index (one pending
 *     intent per subject) when a subject failed twice or already has a
 *     pending intent — the index is the whole reason those guards exist;
 *   - `FOR UPDATE SKIP LOCKED` really does hand two concurrent drains
 *     disjoint work instead of the same rows;
 *   - the `status` CHECK constraint accepts every transition the drain makes.
 *
 * The graph is a recording fake, so this file stays green on a machine that
 * has Postgres but no Neo4j; the real MERGE lives in
 * tests/integration/graph-neo4j.test.ts.
 *
 * Loud skip + Validation block when Postgres is unreachable, per
 * docs/.claude/rules/test.md.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  runCli,
  type DrainDeps,
  type DrainPool,
} from "../../src/cli/graph-drain.js";
import { claimPendingIntents } from "../../src/core/storage/projection-outbox.js";
import { upSchemaBootstrap } from "../../src/core/storage/schema-bootstrap.js";
import {
  GraphUnavailableError,
  type GraphEdge,
  type GraphNode,
  type GraphWriter,
} from "../../src/core/graph/types.js";
import { warnPgUnavailable } from "./pg-test-harness.js";

const DIM = 8;
const BASE_DB_URL = "postgresql://postgres@localhost/postgres";
const SCHEMA = `graph_drain_${randomUUID().slice(0, 8)}`;

function schemaDbUrl(): string {
  return `${BASE_DB_URL}?options=-c%20search_path%3D${SCHEMA}%2Cpublic`;
}

const ALICE = "11111111-1111-4111-8111-111111111111";
const ACME = "22222222-2222-4222-8222-222222222222";
const RETIRED = "33333333-3333-4333-8333-333333333333";
const TRIPLE = "44444444-4444-4444-8444-444444444444";
const VALID_FROM = "2026-08-01T00:00:00.000Z";

class RecordingWriter implements GraphWriter {
  nodes: GraphNode[] = [];
  edges: GraphEdge[] = [];
  /** Set to make every mergeNodes call fail, as an unreachable graph would. */
  failWith: GraphUnavailableError | undefined;
  async ensureConstraints(): Promise<void> {}
  async mergeNodes(nodes: readonly GraphNode[]): Promise<void> {
    if (this.failWith) throw this.failWith;
    this.nodes.push(...nodes);
  }
  async mergeEdges(edges: readonly GraphEdge[]): Promise<void> {
    this.edges.push(...edges);
  }
  async deleteNodes(_ids: readonly string[]): Promise<void> {}
  async deleteEdges(_ids: readonly string[]): Promise<void> {}
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
  warnPgUnavailable({
    label: "graph-drain-pg",
    testPath: "tests/integration/graph-drain-pg.test.ts",
    expectedCommand: "npx vitest run tests/integration/graph-drain-pg.test.ts",
    connectionString: BASE_DB_URL,
    error: err,
    requiresVector: false,
  });
}
const describePg = PG_AVAILABLE ? describe : describe.skip;

describePg("graph-drain-pg: outbox lifecycle against real Postgres", () => {
  let client: pg.Client;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: BASE_DB_URL });
    await client.connect();
    await client.query("CREATE EXTENSION IF NOT EXISTS vector");
    await client.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await client.query(`CREATE SCHEMA "${SCHEMA}"`);
    await client.query(`SET search_path TO "${SCHEMA}", public`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS chunks (
        id uuid PRIMARY KEY,
        content text NOT NULL,
        embedding vector(${DIM}) NOT NULL
      )`);
    await upSchemaBootstrap(client, DIM, 2000);
    await seedLedger();
  });

  afterAll(async () => {
    await client.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await client.end();
  });

  beforeEach(async () => {
    await client.query(`DELETE FROM projection_outbox`);
  });

  /** Two live entities with one edge, plus a retired entity. */
  async function seedLedger(): Promise<void> {
    for (const [id, name, type, retired] of [
      [ALICE, "Alice Smith", "person", false],
      [ACME, "Acme Corp", "system", false],
      [RETIRED, "Old Alias", "person", true],
    ] as const) {
      await client.query(
        `INSERT INTO entities (id, canonical_name, type, retired)
           VALUES ($1, $2, $3, $4)`,
        [id, name, type, retired]
      );
    }
    await client.query(
      `INSERT INTO triples
         (id, head_id, tail_id, relation_raw, relation_norm, confidence,
          valid_window)
         VALUES ($1, $2, $3, 'works at', 'works_for', 0.9,
                 tstzrange($4, NULL, '[)'))`,
      [TRIPLE, ALICE, ACME, VALID_FROM]
    );
  }

  async function enqueue(
    kind: "entity" | "triple",
    subjectId: string,
    over: { status?: string; createdAt?: string } = {}
  ): Promise<string> {
    const id = randomUUID();
    await client.query(
      `INSERT INTO projection_outbox
         (id, subject_kind, subject_id, status, created_at)
       VALUES ($1, $2, $3, $4, coalesce($5::timestamptz, now()))`,
      [id, kind, subjectId, over.status ?? "pending", over.createdAt ?? null]
    );
    return id;
  }

  async function rows(): Promise<
    {
      id: string;
      subject_kind: string;
      subject_id: string;
      status: string;
      attempts: number;
      last_error: string | null;
      processed_at: Date | null;
    }[]
  > {
    const res = await client.query(
      `SELECT id, subject_kind, subject_id, status, attempts, last_error,
              processed_at
         FROM projection_outbox
        ORDER BY created_at, subject_kind, id`
    );
    return res.rows;
  }

  /** Run the CLI against the isolated schema with a recording graph writer. */
  async function run(
    argv: string[] = [],
    writer = new RecordingWriter()
  ): Promise<{ code: number; writer: RecordingWriter; lines: Logged[] }> {
    const pool = new pg.Pool({ connectionString: schemaDbUrl() });
    const lines: Logged[] = [];
    const deps: DrainDeps = {
      pool: pool as unknown as DrainPool,
      logger: recordingLogger(lines),
      connectGraph: async () => writer,
    };
    try {
      return { code: await runCli(argv, deps), writer, lines };
    } finally {
      await pool.end();
    }
  }

  it("drains pending intents to done and MERGEs the live ledger rows", async () => {
    await enqueue("entity", ALICE);
    await enqueue("triple", TRIPLE);

    const { code, writer, lines } = await run();

    expect(code).toBe(0);
    expect(writer.nodes.map((n) => n.id).sort()).toEqual([ALICE, ACME].sort());
    expect(writer.edges).toHaveLength(1);
    expect(writer.edges[0]).toMatchObject({
      id: TRIPLE,
      headId: ALICE,
      tailId: ACME,
      relationNorm: "works_for",
      confidence: 0.9,
      validFrom: VALID_FROM,
      validUntil: null,
    });
    for (const row of await rows()) {
      expect(row.status).toBe("done");
      expect(row.attempts).toBe(1);
      expect(row.processed_at).not.toBeNull();
      expect(row.last_error).toBeNull();
    }
    expect(lines).toContainEqual({
      msg: "graph-drain-complete",
      fields: { intents: 2, nodes: 2, edges: 1, unresolved: 0, batches: 1 },
    });
  });

  it("a second drain claims nothing (SC4 re-drain safe)", async () => {
    await enqueue("entity", ALICE);
    await run();

    const second = await run();

    expect(second.code).toBe(0);
    expect(second.writer.nodes).toEqual([]);
    expect(second.lines).toContainEqual({
      msg: "graph-drain-complete",
      fields: { intents: 0, nodes: 0, edges: 0, unresolved: 0, batches: 0 },
    });
    expect((await rows())[0]!.attempts).toBe(1);
  });

  it("records the failure after the rollback: attempts + last_error persist", async () => {
    await enqueue("entity", ALICE);
    const writer = new RecordingWriter();
    writer.failWith = new GraphUnavailableError(
      "neo4j://localhost:7687",
      new Error("ECONNREFUSED")
    );

    const { code } = await run([], writer);

    expect(code).toBe(3);
    const [row] = await rows();
    expect(row!.status).toBe("failed");
    expect(row!.attempts).toBe(1);
    expect(row!.last_error).toContain("ECONNREFUSED");
    expect(row!.processed_at).not.toBeNull();
  });

  it("--retry-failed re-arms a failed intent and the next drain lands it", async () => {
    await enqueue("entity", ALICE);
    const writer = new RecordingWriter();
    writer.failWith = new GraphUnavailableError(
      "neo4j://localhost:7687",
      new Error("ECONNREFUSED")
    );
    expect((await run([], writer)).code).toBe(3);

    const retry = await run(["--retry-failed"]);
    expect(retry.code).toBe(0);
    expect(retry.lines).toContainEqual({
      msg: "graph-drain-retry-armed",
      fields: { rearmed: 1 },
    });
    expect((await rows())[0]).toMatchObject({
      status: "pending",
      attempts: 1,
      last_error: null,
      processed_at: null,
    });

    const recovered = await run();
    expect(recovered.code).toBe(0);
    expect(recovered.writer.nodes.map((n) => n.id)).toEqual([ALICE]);
    expect((await rows())[0]).toMatchObject({ status: "done", attempts: 2 });
  });

  it("--retry-failed keeps the one-pending-intent-per-subject index intact", async () => {
    // Two failed intents for one subject (failed, re-emitted, failed again)
    // plus a subject that already has a pending intent: re-arming all of them
    // would violate projection_outbox_pending_subject_idx and abort.
    await enqueue("entity", ALICE, {
      status: "failed",
      createdAt: "2026-08-01T00:00:00Z",
    });
    await enqueue("entity", ALICE, {
      status: "failed",
      createdAt: "2026-08-02T00:00:00Z",
    });
    await enqueue("entity", ACME, { status: "failed" });
    await enqueue("entity", ACME);

    const { code, lines } = await run(["--retry-failed"]);

    expect(code).toBe(0);
    // ALICE: only the newest failed intent is re-armed. ACME: already pending,
    // so its failed intent stays visible instead of duplicating the queue.
    expect(lines).toContainEqual({
      msg: "graph-drain-retry-armed",
      fields: { rearmed: 1 },
    });
    const all = await rows();
    const pending = all.filter((r) => r.status === "pending");
    expect(pending.map((r) => r.subject_id).sort()).toEqual(
      [ALICE, ACME].sort()
    );
    expect(all.filter((r) => r.status === "failed")).toHaveLength(2);
  });

  it("marks an intent whose subject is retired done, and reports it", async () => {
    await enqueue("entity", RETIRED);

    const { code, writer, lines } = await run();

    expect(code).toBe(0);
    expect(writer.nodes).toEqual([]);
    expect((await rows())[0]!.status).toBe("done");
    expect(lines).toContainEqual({
      msg: "graph-drain-subject-gone",
      fields: expect.objectContaining({ subjectId: RETIRED }),
    });
  });

  it("hands two concurrent claims disjoint intents (FOR UPDATE SKIP LOCKED)", async () => {
    await enqueue("entity", ALICE);
    await enqueue("entity", ACME);

    const [a, b] = [await claimant(), await claimant()];
    try {
      const first = await claimPendingIntents(a, 1);
      const second = await claimPendingIntents(b, 1);

      expect(first).toHaveLength(1);
      expect(second).toHaveLength(1);
      expect(second[0]!.id).not.toBe(first[0]!.id);
      // A third claimant sees an empty queue rather than a locked row.
      const c = await claimant();
      try {
        expect(await claimPendingIntents(c, 10)).toEqual([]);
      } finally {
        await release(c);
      }
    } finally {
      await release(a);
      await release(b);
    }
  });

  it("--dry-run reports the queue without touching it", async () => {
    await enqueue("entity", ALICE);
    await enqueue("entity", ACME, { status: "failed" });

    const { code, writer, lines } = await run(["--dry-run"]);

    expect(code).toBe(0);
    expect(writer.nodes).toEqual([]);
    expect(lines).toContainEqual({
      msg: "graph-drain-plan",
      fields: { pending: 1, done: 0, failed: 1 },
    });
    expect((await rows()).map((r) => r.status).sort()).toEqual([
      "failed",
      "pending",
    ]);
  });

  /** A connection holding an open transaction, for the SKIP LOCKED check. */
  async function claimant(): Promise<pg.Client> {
    const c = new pg.Client({ connectionString: schemaDbUrl() });
    await c.connect();
    await c.query("BEGIN");
    return c;
  }

  async function release(c: pg.Client): Promise<void> {
    await c.query("ROLLBACK");
    await c.end();
  }
});
