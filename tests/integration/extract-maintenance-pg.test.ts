/**
 * extract-maintenance-pg: real-Postgres proof of the maintenance lane
 * (the repo's live-path acceptance for the SQL guards the review added:
 * `FOR UPDATE` on the record row, the `discarded_at` filters, and the
 * jsonb `proposed_payload` replay).
 *
 * Contract pinned here:
 *   - promote of a judge-sealed failure replays the held proposal through
 *     the SAME persist + outbox code the batch uses: real triples and real
 *     projection intents appear, and `listFailed()` drops the record.
 *   - discard touches no graph and excludes the row from `listFailed()`.
 *   - promote of a discarded record, or of one with no payload, is a typed
 *     refusal with zero writes — Postgres-side, not simulated.
 *
 * Harness follows tests/integration/extract-outbox-pg.test.ts: a unique
 * schema reached through `SET search_path`, and a loud skip with the
 * documented Validation block when Postgres is unreachable — never a
 * silent pass.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  discardRecord,
  promoteRecord,
  PromotionRefusedError,
} from "../../src/core/extraction/actions.js";
import { FakeEmbedder } from "../../src/core/embedder.js";
import { GraphragError } from "../../src/core/errors.js";
import {
  insertRecord,
  listFailed,
  markFailed,
  markFailedWithProposal,
} from "../../src/core/extraction/records.js";
import { upSchemaBootstrap } from "../../src/core/storage/schema-bootstrap.js";
import type { Logger } from "../../src/logging.js";
import type { ExtractionOutput } from "../../src/core/extraction/types.js";
import { warnPgUnavailable } from "./pg-test-harness.js";

const DIM = 32;
const BASE_DB_URL = "postgresql://postgres@localhost/postgres";
const SCHEMA = `extract_maint_${randomUUID().slice(0, 8)}`;

function silentLogger(): Logger {
  return {
    level: "error",
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

const PROPOSED: ExtractionOutput = {
  head: "Alice Smith",
  headType: "person",
  relationRaw: "works at",
  relationNorm: "MEMBER_OF",
  tail: "Acme Corp",
  tailType: "organization",
  description: "Alice Smith works at Acme Corp on the billing platform",
  evidenceSpan: "Alice Smith works at Acme Corp",
  confidence: 0.9,
};

const VERDICTS = [
  { index: 0, grounded: false, reason: "tail not stated in the chunk" },
];

let PG_AVAILABLE = false;
try {
  const probe = new pg.Client({ connectionString: BASE_DB_URL });
  await probe.connect();
  await probe.query("SELECT 1");
  await probe.end();
  PG_AVAILABLE = true;
} catch (err) {
  warnPgUnavailable({
    label: "extract-maintenance-pg",
    testPath: "tests/integration/extract-maintenance-pg.test.ts",
    expectedCommand:
      "npx vitest run tests/integration/extract-maintenance-pg.test.ts",
    connectionString: BASE_DB_URL,
    error: err,
    requiresVector: false,
  });
}
const describePg = PG_AVAILABLE ? describe : describe.skip;

describePg("extract-maintenance-pg: promote/discard on real Postgres", () => {
  let client: pg.Client | undefined;

  const persistDeps = () => ({
    embedder: new FakeEmbedder(DIM),
    logger: silentLogger(),
  });

  async function resetSchema(c: pg.Client): Promise<void> {
    await c.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await c.query(`CREATE SCHEMA "${SCHEMA}"`);
    await c.query(`SET search_path TO "${SCHEMA}", public`);
    await c.query("CREATE EXTENSION IF NOT EXISTS vector");
    await c.query(`
      CREATE TABLE IF NOT EXISTS chunks (
        id uuid PRIMARY KEY,
        content text NOT NULL,
        embedding vector(${DIM}) NOT NULL,
        source_ref text NOT NULL DEFAULT '',
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await upSchemaBootstrap(c, DIM, 2000);
  }

  async function seedChunk(c: pg.Client): Promise<string> {
    const id = randomUUID();
    const zeroVec = `[${new Array(DIM).fill(0).join(",")}]`;
    await c.query(
      `INSERT INTO chunks (id, content, embedding) VALUES ($1, $2, $3)`,
      [id, "Alice Smith works at Acme Corp.", zeroVec]
    );
    return id;
  }

  async function sealJudgeFailure(
    c: pg.Client,
    chunkId: string
  ): Promise<string> {
    const recordId = randomUUID();
    await insertRecord(c, {
      id: recordId,
      batchId: randomUUID(),
      chunkId,
      startedAt: "2026-08-26T00:00:00.000Z",
    });
    // The jsonb write path the promote guard reads back.
    await markFailedWithProposal(
      c,
      recordId,
      { code: "JUDGE_REJECTED", msg: "judge rejected 1 of 1 triples" },
      { triples: [PROPOSED], verdicts: VERDICTS }
    );
    return recordId;
  }

  async function count(c: pg.Client, table: string): Promise<number> {
    const res = await c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${table}`
    );
    return Number(res.rows[0]!.n);
  }

  beforeAll(async () => {
    client = new pg.Client({ connectionString: BASE_DB_URL });
    await client.connect();
    await resetSchema(client);
  });

  afterAll(async () => {
    if (client) {
      await client.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
      await client.end();
    }
  });

  it("promote replays the held proposal into real triples + outbox and leaves the failed lane", async () => {
    const c = client!;
    const chunkId = await seedChunk(c);
    const recordId = await sealJudgeFailure(c, chunkId);
    expect((await listFailed(c)).map((r) => r.id)).toEqual([recordId]);

    await promoteRecord(persistDeps(), c, recordId);

    expect(await count(c, "triples")).toBe(1);
    expect(await count(c, "entities")).toBe(2);
    // The intents ride the same transaction the replay committed.
    const intents = await c.query<{ subject_kind: string }>(
      `SELECT subject_kind FROM projection_outbox`
    );
    expect(intents.rows).toHaveLength(3);
    // The record retired to succeeded and dropped out of the lane.
    const rec = await c.query<{ status: string; triples_count: number }>(
      `SELECT status, triples_count FROM extraction_records WHERE id = $1`,
      [recordId]
    );
    expect(rec.rows[0]).toMatchObject({ status: "succeeded", triples_count: 1 });
    expect(await listFailed(c)).toEqual([]);
  });

  it("discard stamps the row out of the lane and leaves the graph untouched", async () => {
    const c = client!;
    const chunkId = await seedChunk(c);
    const recordId = await sealJudgeFailure(c, chunkId);
    const triplesBefore = await count(c, "triples");
    const outboxBefore = await count(c, "projection_outbox");

    await discardRecord(c, recordId);

    expect(await count(c, "triples")).toBe(triplesBefore);
    expect(await count(c, "projection_outbox")).toBe(outboxBefore);
    // Excluded from the lane, but the row itself is not deleted.
    expect((await listFailed(c)).map((r) => r.id)).not.toContain(recordId);
    const still = await c.query(
      `SELECT discarded_at FROM extraction_records WHERE id = $1`,
      [recordId]
    );
    expect(still.rows[0]?.discarded_at).not.toBeNull();
  });

  it("promote of a discarded record is a typed refusal with zero writes", async () => {
    const c = client!;
    const chunkId = await seedChunk(c);
    const recordId = await sealJudgeFailure(c, chunkId);
    await discardRecord(c, recordId);
    const triplesBefore = await count(c, "triples");

    const err = await promoteRecord(persistDeps(), c, recordId).catch(
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(PromotionRefusedError);
    expect((err as GraphragError).code).toBe("INVALID_INPUT");
    expect((err as Error).message).toMatch(/discarded/);
    expect(await count(c, "triples")).toBe(triplesBefore);
  });

  it("promote of a failed record without a jsonb payload is a typed refusal", async () => {
    const c = client!;
    const chunkId = await seedChunk(c);
    const recordId = randomUUID();
    await insertRecord(c, {
      id: recordId,
      batchId: randomUUID(),
      chunkId,
      startedAt: "2026-08-26T00:00:00.000Z",
    });
    await markFailed(c, recordId, { code: "5xx", msg: "upstream 500" });
    const triplesBefore = await count(c, "triples");

    const err = await promoteRecord(persistDeps(), c, recordId).catch(
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(PromotionRefusedError);
    expect((err as Error).message).toMatch(/proposed_payload/);
    expect(await count(c, "triples")).toBe(triplesBefore);
  });
});
