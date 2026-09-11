/**
 * extract-supersede-pg: real-Postgres coverage for write-time supersede
 * (T4 — `GRAPHRAG_MEMORY_EXTRACT_WRITE_TIME_SUPERSEDE`).
 *
 * Drives the real extract pipeline (`processBatch` + `upsertTriple`) against
 * a live `Postgresgres + pgvector` instance, so the assertion exercises the
 * actual FK constraint `triples_superseded_by_fkey` — a fake-client unit
 * suite cannot reproduce a constraint violation. The fixture follows the
 * shape of `tests/cli/consolidate-pg.test.ts` (unique schema per file, loud
 * skip when Postgres is unreachable).
 *
 * Coverage maps to the T4 success criteria:
 *   1. After a forced contradiction with `writeTimeSupersede: true`, the
 *      older row gains `superseded_by` = new row id and its
 *      `valid_window` upper bound is closed at `startedAt`; nothing is
 *      deleted; the new row is live and supersedes nothing.
 *   2. Same flow with `writeTimeSupersede: false` is byte-identical to the
 *      pre-T4 behaviour: the older row stays live, the new row inserts
 *      alongside it, no `superseded_by` set on either.
 *   3. Two concurrent writes racing the same `(head, relation_norm)`
 *      contradiction land in a consistent supersession state: the older
 *      row retires exactly once, pointers form a single terminating chain
 *      (no double-supersede, no cycle), and nothing is deleted — for
 *      EITHER legal interleaving (chained 2-retired/1-live or guarded
 *      1-retired/2-live).
 *
 * The unit suite `tests/extraction/dedup.test.ts` pins the write ORDER
 * (INSERT before the supersede UPDATE) against a fake client that cannot
 * enforce the FK; this suite proves the order against the real constraint.
 *
 * The pre-existing `tests/cli/consolidate-pg.test.ts:138-155` assertion
 * shape (single-row superseded_by / valid_until / projection_outbox) is
 * mirrored here for the write-time path.
 */
import { randomUUID } from "node:crypto";
import pgclient from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { upSchemaBootstrap } from "../../src/core/storage/schema-bootstrap.js";
import { FakeLLMClient } from "../../src/core/extraction/llm-client.js";
import type { ExtractionResponse } from "../../src/core/extraction/types.js";
import { FakeEmbedder } from "../../src/core/embedder.js";
import {
  processBatch,
  selectChunksByIds,
} from "../../src/core/extraction/pipeline.js";
import { warnPgUnavailable } from "./pg-test-harness.js";

const DIM = 64;
const BASE_DB_URL = "postgresql://postgres@localhost/postgres";
const SCHEMA = `extract_supersede_${randomUUID().slice(0, 8)}`;
const NOW = "2026-09-05T00:00:00.000Z";
const ANN_MAX_DIMENSIONS_VAR = "GRAPHRAG_MEMORY_PGVECTOR_ANN_MAX_DIMENSIONS";

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

let PG_AVAILABLE = false;
try {
  const probe = new pgclient.Client({ connectionString: BASE_DB_URL });
  await probe.connect();
  await probe.query("SELECT 1");
  await probe.end();
  PG_AVAILABLE = true;
} catch (err) {
  warnPgUnavailable({
    label: "extract-supersede-pg",
    testPath: "tests/integration/extract-supersede-pg.test.ts",
    expectedCommand:
      "npx vitest run tests/integration/extract-supersede-pg.test.ts",
    connectionString: BASE_DB_URL,
    error: err,
    requiresVector: false,
  });
}
const describePg = PG_AVAILABLE ? describe : describe.skip;

describePg(
  "extract-supersede-pg: write-time supersede against live Postgres",
  () => {
    let admin: pgclient.Client | undefined;

    beforeAll(async () => {
      process.env[ANN_MAX_DIMENSIONS_VAR] = "2000";
      admin = new pgclient.Client({ connectionString: BASE_DB_URL });
      await admin.connect();
      await admin.query("CREATE EXTENSION IF NOT EXISTS vector");
      await resetSchema(admin);
    });

    afterAll(async () => {
      if (admin) {
        await admin.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
        await admin.end();
      }
      if (process.env[ANN_MAX_DIMENSIONS_VAR] === undefined) {
        delete process.env[ANN_MAX_DIMENSIONS_VAR];
      } else {
        process.env[ANN_MAX_DIMENSIONS_VAR] = "2000";
      }
    });

    /**
     * Recreate the isolated schema so each test starts from a clean ledger.
     * Same shape as consolidate-pg: drop + recreate schema, set search_path,
     * seed a minimal `chunks` table, then bootstrap the full ledger.
     */
    async function resetSchema(c: pgclient.Client): Promise<void> {
      await c.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
      await c.query(`CREATE SCHEMA "${SCHEMA}"`);
      await c.query(`SET search_path TO "${SCHEMA}", public`);
      await c.query(`
        CREATE TABLE chunks (
          id          uuid PRIMARY KEY,
          content     text NOT NULL,
          embedding   vector(${DIM}) NOT NULL,
          valid_from  timestamptz NOT NULL DEFAULT now(),
          valid_until timestamptz NULL,
          source_ref  text NOT NULL DEFAULT '',
          metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
          created_at  timestamptz NOT NULL DEFAULT now()
        )
      `);
      await upSchemaBootstrap(c, DIM, 2000);
    }

    /**
     * Seed one chunk whose content carries the evidence span the extractor
     * will need to ground the triple (otherwise the persist gate drops it).
     * Returns the chunk id.
     */
    async function seedChunk(
      c: pgclient.Client,
      content: string
    ): Promise<string> {
      const id = randomUUID();
      const zeroVec = `[${new Array(DIM).fill(0).join(",")}]`;
      await c.query(
        `INSERT INTO chunks (id, content, embedding, created_at)
           VALUES ($1, $2, $3, now())`,
        [id, content, zeroVec]
      );
      return id;
    }

    /** Seed the endpoints (head + one or more tails) of the contradiction. */
    async function seedEntities(
      c: pgclient.Client,
      entities: ReadonlyArray<{ id: string; name: string; type: string }>
    ): Promise<void> {
      for (const e of entities) {
        const zeroVec = `[${new Array(DIM).fill(0).join(",")}]`;
        await c.query(
          `INSERT INTO entities
             (id, canonical_name, type, embedding, metadata, retired)
             VALUES ($1, $2, $3, $4::vector, '{}'::jsonb, false)`,
          [e.id, e.name, e.type, zeroVec]
        );
      }
    }

    /**
     * Run processBatch with `writeTimeSupersede` injected at the deps level.
     * The pool is a per-test pool so a hung transaction cannot leak between
     * tests; the schema-targeted connection string scopes SQL to SCHEMA.
     */
    async function runExtract(opts: {
      chunkIds: string[];
      queue: ExtractionResponse[];
      writeTimeSupersede: boolean;
    }): Promise<{ summary: unknown; batchId: string | undefined }> {
      const pool = new pgclient.Pool({ connectionString: schemaDbUrl() });
      const client = await pool.connect();
      try {
        const chunks = await selectChunksByIds(client, opts.chunkIds);
        const deps = {
          llm: new FakeLLMClient({ queue: opts.queue ?? [] }),
          embedder: new FakeEmbedder(DIM),
          logger: silentLogger(),
          now: () => NOW,
          writeTimeSupersede: opts.writeTimeSupersede,
        };
        const summary = await processBatch(deps, client, chunks);
        return { summary, batchId: summary.batchId };
      } finally {
        client.release();
        await pool.end();
      }
    }

    /**
     * Mirrors consolidate-pg.test.ts:138-155 — single-row shape assertions
     * for the older triple (superseded_by / valid_until closed / projection
     * outbox intent queued), plus the new-row liveness invariants.
     */
    it("ON: forced contradiction retires the older row and inserts the new one", async () => {
      const c = admin!;
      await resetSchema(c);

      // Seed two tails with overlapping windows: the older triple claims
      // head→tail1, the newer extraction claims head→tail2.
      const headId = randomUUID();
      const tail1Id = randomUUID();
      const tail2Id = randomUUID();
      await seedEntities(c, [
        { id: headId, name: "Alice", type: "person" },
        { id: tail1Id, name: "Acme", type: "system" },
        { id: tail2Id, name: "Globex", type: "system" },
      ]);

      // Pre-seed the older triple directly (a contradicting tail, an
      // overlapping validity window). Older created_at than the incoming
      // extraction so the newest-wins rule picks the incoming fact.
      const olderId = randomUUID();
      await c.query(
        `INSERT INTO triples
             (id, head_id, tail_id, relation_raw, relation_norm,
              confidence, valid_window, created_at, extractor)
             VALUES
             ($1, $2, $3, 'works at', 'works_for', 0.8,
              tstzrange('2026-01-01T00:00:00Z', NULL, '[)'),
              '2026-01-01T00:00:00Z', 'llm')`,
        [olderId, headId, tail1Id]
      );

      // Seed one chunk whose content carries the evidence span the
      // extractor emits. The persist gate (`isGrounded`) requires the
      // span to appear in the chunk text.
      const chunkId = await seedChunk(
        c,
        "Alice Smith works at Globex Corp since August"
      );

      const { summary } = await runExtract({
        chunkIds: [chunkId],
        writeTimeSupersede: true,
        queue: [
          {
            kind: "ok",
            outputs: [
              {
                head: "Alice",
                headType: "person",
                relationRaw: "works at",
                relationNorm: "works_for",
                tail: "Globex",
                tailType: "system",
                description: "Alice works at Globex on the platform",
                evidenceSpan: "Alice Smith works at Globex Corp",
                confidence: 0.9,
              },
            ],
          },
        ],
      });

      expect(writeFailuresOf(summary)).toBe(0);

      // The older row must point at the NEW row (which we look up) and
      // its valid_window upper bound must be closed at NOW.
      const result = await c.query<{
        superseded_by: string | null;
        valid_from: Date;
        valid_until: Date | null;
      }>(
        `SELECT superseded_by,
                  lower(valid_window) AS valid_from,
                  upper(valid_window) AS valid_until
             FROM triples
            WHERE id = $1`,
        [olderId]
      );
      const older = result.rows[0];
      expect(older).toBeDefined();
      expect(older!.superseded_by).not.toBeNull();

      // Look up the new row by (head, tail=tail2Id, relation_norm).
      const newRow = await c.query<{
        id: string;
        superseded_by: string | null;
      }>(
        `SELECT id, superseded_by FROM triples
            WHERE head_id = $1 AND tail_id = $2 AND relation_norm = $3`,
        [headId, tail2Id, "works_for"]
      );
      expect(newRow.rows).toHaveLength(1);
      expect(newRow.rows[0]!.superseded_by).toBeNull();

      // Pointer must match: olderRow.superseded_by === newRow.id.
      expect(older!.superseded_by).toBe(newRow.rows[0]!.id);

      // Nothing is deleted — exactly two triples remain (older + new).
      const count = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM triples WHERE head_id = $1`,
        [headId]
      );
      expect(Number(count.rows[0]!.n)).toBe(2);

      // Validity window upper bound closed at NOW (the per-chunk startedAt).
      expect(older!.valid_from.toISOString()).toBe("2026-01-01T00:00:00.000Z");
      expect(older!.valid_until?.toISOString()).toBe(NOW);

      // Both rows queued a projection intent: the new row (fresh edge) and
      // the retired row (its closed window must reach Neo4j, mirroring the
      // offline `--apply` shape).
      const outbox = await c.query<{ subject_id: string; status: string }>(
        `SELECT subject_id, status FROM projection_outbox
          WHERE subject_kind = 'triple'
            AND subject_id = ANY($1::uuid[])`,
        [[olderId, newRow.rows[0]!.id]]
      );
      expect(outbox.rows).toHaveLength(2);
      expect(new Set(outbox.rows.map((r) => r.subject_id))).toEqual(
        new Set([olderId, newRow.rows[0]!.id])
      );
      for (const row of outbox.rows) {
        expect(row.status).toBe("pending");
      }
    });

    /**
     * Byte-identical off-path: with `writeTimeSupersede: false` the older
     * row stays live and the new row is inserted alongside it, no
     * `superseded_by` set on either. This case MUST PASS against current
     * code (the off branch is unchanged).
     */
    it("OFF: same flow leaves the older row live and inserts alongside it (no supersede_by)", async () => {
      const c = admin!;
      await resetSchema(c);

      const headId = randomUUID();
      const tail1Id = randomUUID();
      const tail2Id = randomUUID();
      await seedEntities(c, [
        { id: headId, name: "Bob", type: "person" },
        { id: tail1Id, name: "Initech", type: "system" },
        { id: tail2Id, name: "Hooli", type: "system" },
      ]);

      const olderId = randomUUID();
      await c.query(
        `INSERT INTO triples
             (id, head_id, tail_id, relation_raw, relation_norm,
              confidence, valid_window, created_at, extractor)
             VALUES
             ($1, $2, $3, 'works at', 'works_for', 0.8,
              tstzrange('2026-01-01T00:00:00Z', NULL, '[)'),
              '2026-01-01T00:00:00Z', 'llm')`,
        [olderId, headId, tail1Id]
      );

      const chunkId = await seedChunk(
        c,
        "Bob Jones works at Hooli since August"
      );

      await runExtract({
        chunkIds: [chunkId],
        writeTimeSupersede: false,
        queue: [
          {
            kind: "ok",
            outputs: [
              {
                head: "Bob",
                headType: "person",
                relationRaw: "works at",
                relationNorm: "works_for",
                tail: "Hooli",
                tailType: "system",
                description: "Bob works at Hooli on the platform",
                evidenceSpan: "Bob Jones works at Hooli",
                confidence: 0.9,
              },
            ],
          },
        ],
      });

      const older = await c.query<{
        superseded_by: string | null;
        valid_until: Date | null;
      }>(
        `SELECT superseded_by, upper(valid_window) AS valid_until
             FROM triples WHERE id = $1`,
        [olderId]
      );
      // OFF branch leaves the older row untouched.
      expect(older.rows[0]!.superseded_by).toBeNull();
      expect(older.rows[0]!.valid_until).toBeNull();

      // The new row is inserted alongside — exactly two triples.
      const count = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM triples WHERE head_id = $1`,
        [headId]
      );
      expect(Number(count.rows[0]!.n)).toBe(2);
    });

    /**
     * Two concurrent writers race the same `(head, relation_norm)`
     * contradiction. The candidate picker + idempotent markSuperseded guard
     * (`superseded_by IS NULL`) must produce a consistent supersession
     * state. The integration test runs the two writes through a real
     * pg.Pool so the SQL guard is exercised, not just an in-memory mock.
     *
     * Interleaving note: the two writers can legally land in EITHER final
     * shape. If writer B's contradiction lookup reads writer A's just-
     * committed row, B chains a supersede (older→A→B, 2 retired, 1 live);
     * if both writers only ever see the pre-seeded older row, the
     * `superseded_by IS NULL` guard makes the loser's UPDATE a no-op
     * (1 retired, 2 live). Both satisfy the write-path contract — every
     * fact resolves newest-wins at its own write, nothing is deleted, no
     * row is superseded twice, and the pointer chain from the older row
     * always terminates at a live row. The assertions below pin exactly
     * those order-independent invariants, not one interleaving.
     */
    it("concurrent: two writers racing the same contradiction retire the older row exactly once with a terminating pointer chain", async () => {
      const c = admin!;
      await resetSchema(c);

      const headId = randomUUID();
      const tail1Id = randomUUID();
      const tail2Id = randomUUID();
      const tail3Id = randomUUID();
      await seedEntities(c, [
        { id: headId, name: "Carol", type: "person" },
        { id: tail1Id, name: "Pied Piper", type: "system" },
        { id: tail2Id, name: "Aviato", type: "system" },
        { id: tail3Id, name: "Raviga", type: "system" },
      ]);

      // Older triple already present.
      const olderId = randomUUID();
      await c.query(
        `INSERT INTO triples
             (id, head_id, tail_id, relation_raw, relation_norm,
              confidence, valid_window, created_at, extractor)
             VALUES
             ($1, $2, $3, 'works at', 'works_for', 0.8,
              tstzrange('2026-01-01T00:00:00Z', NULL, '[)'),
              '2026-01-01T00:00:00Z', 'llm')`,
        [olderId, headId, tail1Id]
      );

      // Two chunks, two contradicting tails. Both extracted concurrently.
      const chunkA = await seedChunk(c, "Carol Smith works at Aviato in May");
      const chunkB = await seedChunk(c, "Carol Smith works at Raviga in May");

      const pool = new pgclient.Pool({ connectionString: schemaDbUrl() });
      try {
        const queueA = [
          {
            kind: "ok" as const,
            outputs: [
              {
                head: "Carol",
                headType: "person",
                relationRaw: "works at",
                relationNorm: "works_for",
                tail: "Aviato",
                tailType: "system",
                description: "Carol works at Aviato",
                evidenceSpan: "Carol Smith works at Aviato",
                confidence: 0.9,
              },
            ],
          },
        ];
        const queueB = [
          {
            kind: "ok" as const,
            outputs: [
              {
                head: "Carol",
                headType: "person",
                relationRaw: "works at",
                relationNorm: "works_for",
                tail: "Raviga",
                tailType: "system",
                description: "Carol works at Raviga",
                evidenceSpan: "Carol Smith works at Raviga",
                confidence: 0.9,
              },
            ],
          },
        ];

        const depsA = {
          llm: new FakeLLMClient({ queue: queueA }),
          embedder: new FakeEmbedder(DIM),
          logger: silentLogger(),
          now: () => NOW,
          writeTimeSupersede: true,
        };
        const depsB = {
          llm: new FakeLLMClient({ queue: queueB }),
          embedder: new FakeEmbedder(DIM),
          logger: silentLogger(),
          now: () => NOW,
          writeTimeSupersede: true,
        };

        // Two distinct connections from the same pool = real concurrent
        // writers. Per-chunk transactions already serialise, so the two
        // race is constrained to which one observes the older row's
        // `superseded_by IS NULL` first.
        const clientA = await pool.connect();
        const clientB = await pool.connect();
        try {
          const chunksA = await selectChunksByIds(clientA, [chunkA]);
          const chunksB = await selectChunksByIds(clientB, [chunkB]);
          await Promise.all([
            processBatch(depsA, clientA, chunksA),
            processBatch(depsB, clientB, chunksB),
          ]);
        } finally {
          clientA.release();
          clientB.release();
        }
      } finally {
        await pool.end();
      }

      // Three rows total (nothing deleted): the pre-seeded older row plus
      // the two writers' new rows.
      const all = await c.query<{
        id: string;
        superseded_by: string | null;
      }>(`SELECT id, superseded_by FROM triples WHERE head_id = $1`, [headId]);
      expect(all.rows).toHaveLength(3);

      const byId = new Map(all.rows.map((row) => [row.id, row]));
      const retired = all.rows.filter((row) => row.superseded_by !== null);
      const live = all.rows.filter((row) => row.superseded_by === null);
      expect(retired.length).toBeGreaterThanOrEqual(1);
      expect(retired.length).toBeLessThanOrEqual(2);
      expect(live.length).toBeGreaterThanOrEqual(1);
      expect(live.length).toBeLessThanOrEqual(2);
      expect(retired.length + live.length).toBe(3);

      // The pre-seeded older row is always retired first in the chain —
      // it carries the contradicting window both writers race against.
      const older = byId.get(olderId)!;
      expect(older.superseded_by).not.toBeNull();

      // Invariant 1 — no double-supersede: the `superseded_by IS NULL`
      // guard means a retired row can never be retired again, so no two
      // rows may share a superseded_by target and no row may point at
      // itself. A retired row MAY legally point at another retired row
      // (the chained shape older→A→B), so retired→retired pointers are
      // not asserted against — only a second writer stamping an already-
      // retired row, or a row pointing at itself, would be.
      const targets = new Set<string>();
      for (const row of retired) {
        const target = row.superseded_by!;
        expect(target).not.toBe(row.id); // no self-pointer
        expect(targets.has(target)).toBe(false); // no shared target
        targets.add(target);
      }

      // Invariant 2 — the chain terminates at a live row: walking
      // superseded_by from the older row must reach a row with no pointer
      // within the rows present. Termination is what the no-shared-target
      // invariant above buys: with at most one incoming pointer per row
      // and finitely many rows, the walk can only fail to terminate by
      // entering a cycle, and each step is asserted non-revisited below.
      let cursor: string | null = olderId;
      const walked = new Set<string>();
      while (cursor !== null) {
        expect(walked.has(cursor)).toBe(false); // no cycle
        walked.add(cursor);
        cursor = byId.get(cursor)!.superseded_by;
      }
      expect(walked.size).toBe(retired.length + 1);
    });
  }
);

/**
 * Assert the extract summary carries a numeric `writeFailures` and return
 * it — the write-failure count is what these tests pin, and a structural
 * check here turns a wire-shape drift into a loud assertion failure
 * instead of a silent `undefined` that would pass `.toBe(0)` only by
 * accident of the comparison.
 */
function writeFailuresOf(summary: unknown): number {
  if (typeof summary !== "object" || summary === null) {
    throw new Error("expected summary object");
  }
  const v = (summary as { writeFailures?: unknown }).writeFailures;
  if (typeof v !== "number") {
    throw new Error(`expected writeFailures: number, got ${typeof v}`);
  }
  return v;
}
