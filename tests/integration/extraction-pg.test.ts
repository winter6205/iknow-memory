/**
 * extraction-pg: real-Postgres integration tests for the P0 extraction +
 * merge pipeline (T7).
 *
 * Reuses the schema-p0.test.ts harness contract: connect in beforeAll, build
 * a deterministic spec-1 schema (drop P0 tables + a minimal `chunks` stand-in,
 * then upSchemaP0), and SKIP LOUDLY with the project Validation block when
 * Postgres is unreachable — never silently pass (per docs/.claude/rules/test.md).
 * The client uses a unique schema within the required default `postgres`
 * database so Vitest's parallel schema-p0.test.ts worker cannot tear down this
 * suite's rows; all application SQL remains unqualified through search_path.
 *
 * Coverage maps to specs/p0-extraction.md §"Testing Strategy" Integration row
 * and Success Criteria #5/#6/#7/#12:
 *   1. extraction_records pending -> succeeded / failed round-trip (#5/#6).
 *   2. soft merge + chain walk: resolveCanonicalId(B) -> A; deleting the
 *      survivor (A) NULLs B.merged_into (FK ON DELETE SET NULL — #12 rollback).
 *   3. dedup overlap semantics: overlapping valid_window merges (confidence =
 *      max), non-overlapping window creates a second row (#7).
 *   4. All four tables (entities / entity_aliases / triples /
 *      extraction_records) touched in one flow.
 *   5. L0 merge gate against real rows: two same-normalized-name same-type
 *      entities in the DB merge via mergeEntitiesWithGating.
 *
 * Out of scope here (owned by later tickets): the 4-success + 1-failed CLI
 * batch shape of Success Criterion #6 (T9), and the A9 provenance-retention
 * accumulation on dedup merge. test.md's permission-denied and concurrent
 * dimensions are covered by the T8 defensive-contract suite.
 *
 * Isolation: this suite runs in a Vitest worker that is parallel to
 * schema-p0.test.ts, which owns the `public` P0 tables. To avoid a teardown
 * race, this client uses a unique schema (search_path) and drops it at the
 * end; the bare-table-name SQL in the pipeline code is unchanged.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { upSchemaP0 } from "../../src/core/storage/schema-p0.js";
import {
  insertRecord,
  listFailed,
  markFailed,
  markSucceeded,
} from "../../src/core/extraction/records.js";
import { upsertTriple } from "../../src/core/extraction/dedup.js";
import {
  mergeEntitiesWithGating,
  type CandidateEntity,
} from "../../src/core/entities/merge.js";
import { DEFAULT_MERGE_CONFIG } from "../../src/core/entities/types.js";
import { resolveCanonicalId } from "../../src/core/entities/resolve.js";
import { FakeEmbedder } from "../../src/core/embedder.js";
import {
  redactPgConnectionString,
  warnPgUnavailable,
} from "./pg-test-harness.js";

/** Embedding width for the schema — mirrors schema-p0.test.ts. */
const DIM = 1536;

const DB_URL = "postgresql://postgres@localhost/postgres";

/** Unique schema for this file, so the parallel schema-p0.test.ts worker
 * (which drops P0 tables in the public schema) cannot race this suite. */
const SCHEMA = `extraction_pg_${randomUUID().slice(0, 8)}`;

describe("extraction-pg: extraction + merge pipeline against real Postgres (T7)", () => {
  let client: pg.Client | undefined;

  beforeAll(async () => {
    // T7 contract: skip loudly (never silently pass) when no Postgres.
    try {
      client = new pg.Client({ connectionString: DB_URL });
      await client.connect();
      // Isolate from the public schema: T4/T5 issue bare table names, which
      // resolve through search_path to this unique schema. Search path is
      // re-established inside bootstrapSchema on every schema reset.
      await client.query(`SET search_path TO "${SCHEMA}"`);
    } catch (err) {
      warnPgUnavailable({
        label: "extraction-pg",
        testPath: "tests/integration/extraction-pg.test.ts",
        expectedCommand:
          "npx vitest run tests/integration/extraction-pg.test.ts",
        connectionString: DB_URL,
        error: err,
        requiresVector: false,
      });
      client = undefined;
      return;
    }
    await bootstrapSchema(client);
  });

  afterAll(async () => {
    if (!client) return;
    // Drop the isolated schema so no test rows or schema objects remain in
    // the default `postgres` database. CASCADE removes all five tables.
    await client.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await client.end();
  });

  function requireClient(): pg.Client {
    if (!client) {
      throw new Error(
        `Postgres not reachable at ${redactPgConnectionString(DB_URL)} — see Validation block in beforeAll`
      );
    }
    return client;
  }

  /**
   * Build a fresh spec-1 schema from an empty state. Dropping + recreating the
   * unique schema (rather than the individual unqualified table names) makes
   * the run deterministic without touching the public-schema tables that the
   * parallel schema-p0 worker owns. search_path points only at this schema.
   */
  async function bootstrapSchema(c: pg.Client): Promise<void> {
    // Drop + recreate the isolated schema so the run starts deterministic.
    // Search path is `${SCHEMA}, public` so the pgvector `vector` type -- which
    // lives in the public extension schema -- resolves, while the CREATE TABLE
    // statements target only this suite's schema. We deliberately do NOT issue
    // unqualified DROP TABLE statements here: against a freshly recreated empty
    // schema they would resolve to `public` and wipe the parallel
    // schema-p0.test.ts worker's rows. Dropping the schema clears everything.
    await c.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await c.query(`CREATE SCHEMA "${SCHEMA}"`);
    await c.query(`SET search_path TO "${SCHEMA}", public`);
    await c.query(`
      CREATE TABLE IF NOT EXISTS chunks (
        id uuid PRIMARY KEY,
        content text NOT NULL
      )
    `);
    await upSchemaP0(c, DIM, 2000);
  }

  /** Mint one entity row with a unique canonical_name; returns its id. */
  async function mintEntity(
    c: pg.Client,
    over: Partial<{ canonicalName: string; type: string }> = {}
  ): Promise<string> {
    const id = randomUUID();
    const canonicalName = over.canonicalName ?? `entity-${id}`;
    const type = over.type ?? "concept";
    await c.query(
      `INSERT INTO entities (id, canonical_name, type) VALUES ($1, $2, $3)`,
      [id, canonicalName, type]
    );
    return id;
  }

  // -----------------------------------------------------------------
  // Success Criteria #5/#6: extraction_records pending -> succeeded/failed.
  // -----------------------------------------------------------------
  it("extraction_records status round-trip: pending -> succeeded / failed and listFailed", async () => {
    const c = requireClient();
    await bootstrapSchema(c);

    const okId = randomUUID();
    const batchId = randomUUID();
    await insertRecord(c, {
      id: okId,
      batchId,
      chunkId: null,
      startedAt: new Date().toISOString(),
    });

    // pending: finished_at null, counts default 0.
    let row = (
      await c.query(
        `SELECT status, finished_at, triples_count FROM extraction_records WHERE id = $1`,
        [okId]
      )
    ).rows[0];
    expect(row.status).toBe("pending");
    expect(row.finished_at).toBeNull();
    expect(row.triples_count).toBe(0);

    await markSucceeded(c, okId, { triplesCount: 3, unmappedCount: 1 });

    row = (
      await c.query(
        `SELECT status, finished_at, triples_count FROM extraction_records WHERE id = $1`,
        [okId]
      )
    ).rows[0];
    expect(row.status).toBe("succeeded");
    expect(row.finished_at).not.toBeNull();
    expect(row.triples_count).toBe(3);

    // Second chunk: failed path.
    const failId = randomUUID();
    await insertRecord(c, {
      id: failId,
      batchId,
      chunkId: null,
      startedAt: new Date().toISOString(),
    });
    await markFailed(c, failId, { code: "5xx", msg: "upstream error" });

    const failed = await listFailed(c, { batchId });
    expect(failed).toHaveLength(1);
    expect(failed[0]?.id).toBe(failId);
    expect(failed[0]?.status).toBe("failed");
  });

  // -----------------------------------------------------------------
  // Success Criterion #12: soft merge + chain walk + survivor-delete rollback.
  // -----------------------------------------------------------------
  it("resolveCanonicalId walks the merged_into chain; deleting the survivor NULLs the pointer", async () => {
    const c = requireClient();
    await bootstrapSchema(c);

    const survivorId = await mintEntity(c, {
      canonicalName: "Canonical Corp",
      type: "concept",
    });
    const loserId = randomUUID();
    await c.query(
      `INSERT INTO entities (id, canonical_name, type, merged_into)
         VALUES ($1, $2, $3, $4)`,
      [loserId, "Canonical Corp (old)", "concept", survivorId]
    );

    // Chain walk: loser -> survivor.
    expect(await resolveCanonicalId(c, loserId)).toBe(survivorId);

    // Deleting the survivor must NULL loser.merged_into (ON DELETE SET NULL),
    // preserving the manual-rollback path per #12.
    await c.query(`DELETE FROM entities WHERE id = $1`, [survivorId]);
    const after = (
      await c.query(`SELECT merged_into FROM entities WHERE id = $1`, [loserId])
    ).rows[0];
    expect(after.merged_into).toBeNull();
  });

  // -----------------------------------------------------------------
  // Success Criterion #7: dedup overlap semantics.
  // -----------------------------------------------------------------
  it("dedup: overlapping valid_window merges (confidence=max); non-overlapping creates a second row", async () => {
    const c = requireClient();
    await bootstrapSchema(c);

    const headId = await mintEntity(c, { type: "person" });
    const tailId = await mintEntity(c, { type: "person" });

    const base = {
      headId,
      tailId,
      relationRaw: "works at",
      relationNorm: "works_at",
      sourceChunkId: null,
      evidenceSpan: "Alice works at Acme Corp since January",
    };

    // W1 = [2026-01-01, 2026-02-01).
    const first = await upsertTriple(c, {
      ...base,
      confidence: 0.5,
      validWindow: {
        start: "2026-01-01T00:00:00Z",
        end: "2026-02-01T00:00:00Z",
      },
    });
    expect(first.merged).toBe(false);

    // W2 overlaps W1 ([2026-01-15, 2026-03-01)) -> merge into the first row.
    const second = await upsertTriple(c, {
      ...base,
      confidence: 0.9,
      validWindow: {
        start: "2026-01-15T00:00:00Z",
        end: "2026-03-01T00:00:00Z",
      },
    });
    expect(second.merged).toBe(true);
    expect(second.tripleId).toBe(first.tripleId);

    // Still exactly one row for this dedup key uphill of the merge.
    let count = (
      await c.query(
        `SELECT count(*)::int AS n FROM triples
          WHERE head_id = $1 AND relation_norm = $2 AND tail_id = $3`,
        [headId, base.relationNorm, tailId]
      )
    ).rows[0].n;
    expect(count).toBe(1);

    // Confidence became max(0.5, 0.9) = 0.9.
    const mergedRow = (
      await c.query(`SELECT confidence FROM triples WHERE id = $1`, [
        first.tripleId,
      ])
    ).rows[0];
    expect(mergedRow.confidence).toBeCloseTo(0.9, 5);

    // W3 = [2026-03-01, 2026-04-01) does NOT overlap W1 -> a fresh row.
    const third = await upsertTriple(c, {
      ...base,
      confidence: 0.7,
      validWindow: {
        start: "2026-03-01T00:00:00Z",
        end: "2026-04-01T00:00:00Z",
      },
    });
    expect(third.merged).toBe(false);
    expect(third.tripleId).not.toBe(first.tripleId);

    count = (
      await c.query(
        `SELECT count(*)::int AS n FROM triples
          WHERE head_id = $1 AND relation_norm = $2 AND tail_id = $3`,
        [headId, base.relationNorm, tailId]
      )
    ).rows[0].n;
    expect(count).toBe(2);
  });

  // -----------------------------------------------------------------
  // Spec Integration row: all four tables touched in one flow.
  // -----------------------------------------------------------------
  it("one flow touches all four P0 tables", async () => {
    const c = requireClient();
    await bootstrapSchema(c);

    const entityId = await mintEntity(c, { type: "event" });
    const aliasId = randomUUID();
    await c.query(
      `INSERT INTO entity_aliases (id, entity_id, alias, alias_type)
         VALUES ($1, $2, $3, 'name')`,
      [aliasId, entityId, `alias-${aliasId}`]
    );

    const headId = await mintEntity(c, { type: "person" });
    const tailId = await mintEntity(c, { type: "person" });
    await upsertTriple(c, {
      headId,
      tailId,
      relationRaw: "attends",
      relationNorm: "attends",
      confidence: 1.0,
      sourceChunkId: null,
      evidenceSpan: "Bob attends the Acme summit in January",
      validWindow: {
        start: "2026-01-01T00:00:00Z",
        end: "2026-02-01T00:00:00Z",
      },
    });

    const recordId = randomUUID();
    await insertRecord(c, {
      id: recordId,
      batchId: randomUUID(),
      chunkId: null,
      startedAt: new Date().toISOString(),
    });
    await markSucceeded(c, recordId, { triplesCount: 1, unmappedCount: 0 });

    for (const t of [
      "entities",
      "entity_aliases",
      "triples",
      "extraction_records",
    ] as const) {
      const res = await c.query(`SELECT count(*)::int AS n FROM "${t}"`);
      expect(res.rows[0].n, `${t} should have >= 1 row`).toBeGreaterThanOrEqual(
        1
      );
    }
  });

  // -----------------------------------------------------------------
  // Success Criterion #8 (L0 gate) against real DB rows as candidateSet.
  // -----------------------------------------------------------------
  it("L0 merge gate merges two real rows with the same normalized name and type", async () => {
    const c = requireClient();
    await bootstrapSchema(c);

    // Two real rows with the same normalized name + type. The L0 gate is a
    // pure rule (name+type exact) and never reads description, so the empty
    // description here is safe.
    const candidateId = await mintEntity(c, {
      canonicalName: "Alice Smith",
      type: "person",
    });
    const incomingId = await mintEntity(c, {
      canonicalName: "Alice   Smith",
      type: "person",
    });

    // candidateSet = a real row read back from Postgres (the candidate).
    const res = await c.query(
      `SELECT id, canonical_name, type FROM entities WHERE id = $1`,
      [candidateId]
    );
    const candidates: CandidateEntity[] = res.rows.map((r) => ({
      id: r.id,
      canonicalName: r.canonical_name,
      type: r.type,
      description: "",
    }));

    // incoming loaded from the DB too, so the pipeline reasons over real rows.
    const incomingRow = (
      await c.query(`SELECT canonical_name, type FROM entities WHERE id = $1`, [
        incomingId,
      ])
    ).rows[0];

    const out = await mergeEntitiesWithGating(
      {
        canonicalName: incomingRow.canonical_name,
        type: incomingRow.type,
        description: "",
      },
      candidates,
      { embedder: new FakeEmbedder(DIM), config: DEFAULT_MERGE_CONFIG }
    );

    expect(out.decision).toEqual({
      kind: "merge",
      into: candidateId,
      via: "L0",
      observedCosine: 1.0,
    });
    expect(out.canonicalId).toBe(candidateId);
  });
});
