/**
 * graph-drain-gc-pg: projection GC for retired/deleted ledger rows (Q-T3;
 * specs/retrieve-graph-quality.md SC4 slice 2).
 *
 * What only a real Postgres can prove here:
 *   - the drain's `deleteNodes`/`deleteEdges` calls (the GC mechanism; the
 *     merge path is the projection mechanism) really fire when the ledger
 *     subject has been retired or deleted since the intent was emitted —
 *     a recording fake whose `delete*` are no-ops hides a missing branch;
 *   - an empty ledger still backfills cleanly (no rows means no MERGE, but
 *     the path itself must not throw and must return exit 0).
 *
 * The Neo4j half (real DELETE / DETACH DELETE in a live graph) lives in
 * tests/integration/graph-neo4j.test.ts, which loud-skips without an
 * instance. Here the graph is a recording fake that captures every
 * `delete*` call, so the suite stays green on a machine that has Postgres
 * but no Neo4j.
 *
 * Loud skip + Validation block when Postgres is unreachable, per
 * docs/.claude/rules/test.md.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  runCli as runBackfillCli,
  type BackfillDeps,
  type BackfillPool,
} from "../../src/cli/graph-backfill.js";
import {
  runCli as runDrainCli,
  type DrainDeps,
  type DrainPool,
} from "../../src/cli/graph-drain.js";
import {
  type GraphEdge,
  type GraphNode,
  type GraphWriter,
} from "../../src/core/graph/types.js";
import { upSchemaBootstrap } from "../../src/core/storage/schema-bootstrap.js";
import { warnPgUnavailable } from "./pg-test-harness.js";

const DIM = 8;
const BASE_DB_URL = "postgresql://postgres@localhost/postgres";
const GC_SCHEMA = `graph_drain_gc_${randomUUID().slice(0, 8)}`;
const EMPTY_SCHEMA = `graph_backfill_empty_${randomUUID().slice(0, 8)}`;

function gcSchemaDbUrl(): string {
  return `${BASE_DB_URL}?options=-c%20search_path%3D${GC_SCHEMA}%2Cpublic`;
}

function emptySchemaDbUrl(): string {
  return `${BASE_DB_URL}?options=-c%20search_path%3D${EMPTY_SCHEMA}%2Cpublic`;
}

const ALICE = "11111111-1111-4111-8111-111111111111";
const ACME = "22222222-2222-4222-8222-222222222222";
const RETIRED = "33333333-3333-4333-8333-333333333333";
const TRIPLE = "44444444-4444-4444-8444-444444444444";
const VALID_FROM = "2026-08-01T00:00:00.000Z";

/**
 * Recording writer that captures every delete* call. The existing
 * graph-drain-pg RecordingWriter drops deletes on the floor (they are
 * not what that suite is asserting); this one is shaped so the GC
 * assertions can see exactly which ids were targeted.
 */
class GcRecordingWriter implements GraphWriter {
  nodes: GraphNode[] = [];
  edges: GraphEdge[] = [];
  deletedNodes: string[] = [];
  deletedEdges: string[] = [];
  async ensureConstraints(): Promise<void> {}
  async mergeNodes(nodes: readonly GraphNode[]): Promise<void> {
    this.nodes.push(...nodes);
  }
  async mergeEdges(edges: readonly GraphEdge[]): Promise<void> {
    this.edges.push(...edges);
  }
  async deleteNodes(ids: readonly string[]): Promise<void> {
    this.deletedNodes.push(...ids);
  }
  async deleteEdges(ids: readonly string[]): Promise<void> {
    this.deletedEdges.push(...ids);
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
  warnPgUnavailable({
    label: "graph-drain-gc-pg",
    testPath: "tests/integration/graph-drain-gc-pg.test.ts",
    expectedCommand:
      "npx vitest run tests/integration/graph-drain-gc-pg.test.ts",
    connectionString: BASE_DB_URL,
    error: err,
    requiresVector: false,
  });
}
const describePg = PG_AVAILABLE ? describe : describe.skip;

describePg(
  "graph-drain-gc-pg: drain GC for retired/deleted subjects (SC4)",
  () => {
    let client: pg.Client;

    beforeAll(async () => {
      client = new pg.Client({ connectionString: BASE_DB_URL });
      await client.connect();
      await client.query("CREATE EXTENSION IF NOT EXISTS vector");
      await client.query(`DROP SCHEMA IF EXISTS "${GC_SCHEMA}" CASCADE`);
      await client.query(`CREATE SCHEMA "${GC_SCHEMA}"`);
      await client.query(`SET search_path TO "${GC_SCHEMA}", public`);
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
      await client.query(`DROP SCHEMA IF EXISTS "${GC_SCHEMA}" CASCADE`);
      await client.end();
    });

    /** Two live entities with one edge, plus a retired entity (no edge). */
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
      subjectId: string
    ): Promise<string> {
      const id = randomUUID();
      await client.query(
        `INSERT INTO projection_outbox
           (id, subject_kind, subject_id, status, created_at)
         VALUES ($1, $2, $3, 'pending', now())`,
        [id, kind, subjectId]
      );
      return id;
    }

    async function runDrain(): Promise<{
      code: number;
      writer: GcRecordingWriter;
      lines: Logged[];
    }> {
      const writer = new GcRecordingWriter();
      const pool = new pg.Pool({ connectionString: gcSchemaDbUrl() });
      const lines: Logged[] = [];
      const deps: DrainDeps = {
        pool: pool as unknown as DrainPool,
        logger: recordingLogger(lines),
        connectGraph: async () => writer,
      };
      try {
        return { code: await runDrainCli([], deps), writer, lines };
      } finally {
        await pool.end();
      }
    }

    it("calls deleteNodes with the retired entity id, not with the surviving ids", async () => {
      await enqueue("entity", RETIRED);

      const { code, writer } = await runDrain();

      expect(code).toBe(0);
      // SC4 retire: the retired subject's stale graph node is targeted by id.
      expect(writer.deletedNodes).toEqual([RETIRED]);
      // Surviving ids are NOT deleted.
      expect(writer.deletedNodes).not.toContain(ALICE);
      expect(writer.deletedNodes).not.toContain(ACME);
      // No merge for the retired subject.
      expect(writer.nodes.find((n) => n.id === RETIRED)).toBeUndefined();
      // No edges in scope here — TRIPLE was not enqueued.
      expect(writer.deletedEdges).toEqual([]);
      expect(writer.edges).toEqual([]);
    });

    it("calls deleteEdges with a triple id that has been DELETEd from the ledger", async () => {
      // SC4 ledger delete: physically remove the triple row, then enqueue an
      // intent for the now-missing subject. The drain must GC the stale graph
      // edge by id.
      await client.query("DELETE FROM triples WHERE id = $1", [TRIPLE]);
      await enqueue("triple", TRIPLE);

      const { code, writer } = await runDrain();

      expect(code).toBe(0);
      // SC4 delete: the deleted triple's stale graph edge is targeted by id.
      expect(writer.deletedEdges).toEqual([TRIPLE]);
      // No nodes were touched — the deleted triple had no orphan endpoints.
      expect(writer.deletedNodes).toEqual([]);
      // The deleted subject was not merged.
      expect(writer.edges.find((e) => e.id === TRIPLE)).toBeUndefined();
    });
  }
);

describePg(
  "graph-drain-gc-pg: empty ledger still backfills (SC4 empty graph)",
  () => {
    let client: pg.Client;

    beforeAll(async () => {
      client = new pg.Client({ connectionString: BASE_DB_URL });
      await client.connect();
      await client.query("CREATE EXTENSION IF NOT EXISTS vector");
      await client.query(`DROP SCHEMA IF EXISTS "${EMPTY_SCHEMA}" CASCADE`);
      await client.query(`CREATE SCHEMA "${EMPTY_SCHEMA}"`);
      await client.query(`SET search_path TO "${EMPTY_SCHEMA}", public`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS chunks (
          id uuid PRIMARY KEY,
          content text NOT NULL,
          embedding vector(${DIM}) NOT NULL
        )`);
      await upSchemaBootstrap(client, DIM, 2000);
      // No entities / triples seeded: the ledger is empty.
    });

    afterAll(async () => {
      await client.query(`DROP SCHEMA IF EXISTS "${EMPTY_SCHEMA}" CASCADE`);
      await client.end();
    });

    it("backfills an empty ledger against an empty graph without throwing", async () => {
      const writer = new GcRecordingWriter();
      const pool = new pg.Pool({ connectionString: emptySchemaDbUrl() });
      const lines: Logged[] = [];
      const deps: BackfillDeps = {
        pool: pool as unknown as BackfillPool,
        logger: recordingLogger(lines),
        connectGraph: async () => writer,
      };
      let code: number;
      try {
        code = await runBackfillCli([], deps);
      } finally {
        await pool.end();
      }
      expect(code).toBe(0);
      expect(writer.nodes).toEqual([]);
      expect(writer.edges).toEqual([]);
      expect(writer.deletedNodes).toEqual([]);
      expect(writer.deletedEdges).toEqual([]);
      expect(lines).toContainEqual({
        msg: "graph-backfill-complete",
        fields: { nodes: 0, edges: 0, batchSize: 500 },
      });
    });
  }
);
