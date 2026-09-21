/**
 * extract-gray-judge-pg: real-Postgres coverage for the merge gray-zone
 * three-level judge (specs/merge-gray-zone-judge.md).
 *
 * Drives the production `processBatch` against live Postgres with an
 * injected `mergeJudge`, so the verdicts settle on real rows:
 *   - `merge`  → the fuzzy incoming entity is materialized as a loser whose
 *                `merged_into` points at the survivor (same write as the
 *                cosine-triggered L3 merge).
 *   - `reject` → both entities stay live, no pointer.
 *   - `human`  → both entities stay live AND a separate failed
 *                `extraction_records` row with MERGE_GRAY_HOLD is listable
 *                through `listFailed()` on the maintenance lane, while the
 *                chunk's own record still succeeds.
 *
 * The loud-skip fixture mirrors extract-supersede-pg.test.ts (unique schema
 * per file, full bootstrap, skip + Validation block when Postgres is
 * unreachable).
 */
import { randomUUID } from "node:crypto";
import pgclient from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { upSchemaBootstrap } from "../../src/core/storage/schema-bootstrap.js";
import { FakeLLMClient } from "../../src/core/extraction/llm-client.js";
import type { ExtractionResponse } from "../../src/core/extraction/types.js";
import type { EmbeddingClient } from "../../src/core/embedder.js";
import {
  processBatch,
  selectChunksByIds,
} from "../../src/core/extraction/pipeline.js";
import {
  listFailed,
  MERGE_GRAY_HOLD_CODE,
} from "../../src/core/extraction/records.js";
import type {
  GrayZoneJudge,
  GrayZoneJudgeInput,
  GrayZoneVerdict,
} from "../../src/core/entities/types.js";
import { warnPgUnavailable } from "./pg-test-harness.js";

const DIM = 64;
const BASE_DB_URL = "postgresql://postgres@localhost/postgres";
const SCHEMA = `extract_gray_judge_${randomUUID().slice(0, 8)}`;
const NOW = "2026-09-05T00:00:00.000Z";
const ANN_MAX_DIMENSIONS_VAR = "GRAPHRAG_MEMORY_PGVECTOR_ANN_MAX_DIMENSIONS";

const SHARED_DESC = "Alice Smith works at Acme Corp on the billing platform";
const SPAN = "Alice Smith works at Acme Corp";

function silentLogger() {
  return {
    level: "error" as const,
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

/** Distinct texts → orthogonal basis vectors; equal texts → cosine 1. */
class OrthogonalEmbedder implements EmbeddingClient {
  private readonly slots = new Map<string, number>();
  constructor(private readonly dimensions: number) {}
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      if (!this.slots.has(text)) this.slots.set(text, this.slots.size);
      const vector = new Array<number>(this.dimensions).fill(0);
      vector[this.slots.get(text)! % this.dimensions] = 1;
      return vector;
    });
  }
}

function aliceOutput(): ExtractionResponse {
  return {
    kind: "ok",
    outputs: [
      {
        head: "Alice Smith",
        headType: "person",
        relationRaw: "works at",
        relationNorm: "RELATED_TO",
        tail: "Acme Corp",
        tailType: "organization",
        description: SHARED_DESC,
        evidenceSpan: SPAN,
        confidence: 0.9,
      },
    ],
  };
}

/** Same description: L2 clears (cosine 1), L3 name+desc sits at 0 → gray. */
function aliciaOutput(): ExtractionResponse {
  return {
    kind: "ok",
    outputs: [
      {
        head: "Alicia Smith",
        headType: "person",
        relationRaw: "works at",
        relationNorm: "RELATED_TO",
        tail: "Widget Co",
        tailType: "organization",
        description: SHARED_DESC,
        evidenceSpan: SPAN,
        confidence: 0.9,
      },
    ],
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
    label: "extract-gray-judge-pg",
    testPath: "tests/integration/extract-gray-judge-pg.test.ts",
    expectedCommand:
      "npx vitest run tests/integration/extract-gray-judge-pg.test.ts",
    connectionString: BASE_DB_URL,
    error: err,
    requiresVector: false,
  });
}
const describePg = PG_AVAILABLE ? describe : describe.skip;

describePg(
  "extract-gray-judge-pg: gray-zone judge verdicts against live Postgres",
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
      if (process.env[ANN_MAX_DIMENSIONS_VAR] === "2000") {
        delete process.env[ANN_MAX_DIMENSIONS_VAR];
      }
    });

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

    /** Run both chunks through the production pipeline with the verdict. */
    async function runJudgePass(verdict: GrayZoneVerdict): Promise<{
      inputs: GrayZoneJudgeInput[];
      succeeded: number;
    }> {
      const c = admin!;
      await resetSchema(c);
      const chunk1 = await seedChunk(
        c,
        "Alice Smith works at Acme Corp on the billing platform."
      );
      const chunk2 = await seedChunk(
        c,
        `Reported by Alicia: ${SPAN} on the billing platform.`
      );
      const inputs: GrayZoneJudgeInput[] = [];
      const mergeJudge: GrayZoneJudge = async (input) => {
        inputs.push(input);
        return verdict;
      };
      const pool = new pgclient.Pool({
        connectionString: `${BASE_DB_URL}?options=-c%20search_path%3D${SCHEMA}%2Cpublic`,
      });
      const client = await pool.connect();
      try {
        const chunks = await selectChunksByIds(client, [chunk1, chunk2]);
        const summary = await processBatch(
          {
            llm: new FakeLLMClient({ queue: [aliceOutput(), aliciaOutput()] }),
            embedder: new OrthogonalEmbedder(DIM),
            logger: silentLogger(),
            now: () => NOW,
            mergeJudge,
          },
          client,
          chunks
        );
        return { inputs, succeeded: summary.succeeded };
      } finally {
        client.release();
        await pool.end();
      }
    }

    async function readPerson(
      name: string
    ): Promise<{ id: string; merged_into: string | null } | undefined> {
      const { rows } = await admin!.query<{ id: string; merged_into: string | null }>(
        `SELECT id, merged_into FROM entities WHERE canonical_name = $1`,
        [name]
      );
      return rows[0];
    }

    it("judge sees the gray pair with both sides and the observed cosine", async () => {
      const { inputs } = await runJudgePass("merge");
      expect(inputs.length).toBeGreaterThanOrEqual(1);
      const gray = inputs.find((i) => i.incoming.name === "Alicia Smith");
      expect(gray).toBeDefined();
      expect(gray!.candidate.name).toBe("Alice Smith");
      expect(gray!.incoming.type).toBe("person");
      expect(gray!.observedCosine).toBeLessThan(0.5);
    });

    it("merge verdict materializes the loser with merged_into on the survivor", async () => {
      await runJudgePass("merge");
      const alice = await readPerson("Alice Smith");
      const alicia = await readPerson("Alicia Smith");
      expect(alicia?.merged_into).toBe(alice?.id);
      expect(alice?.merged_into).toBeNull();
    });

    it("reject verdict leaves both entities live with no merged_into", async () => {
      const { succeeded } = await runJudgePass("reject");
      expect(succeeded).toBe(2);
      const alice = await readPerson("Alice Smith");
      const alicia = await readPerson("Alicia Smith");
      expect(alice).toBeDefined();
      expect(alicia).toBeDefined();
      expect(alicia?.merged_into).toBeNull();
    });

    it("human verdict leaves both live and puts a MERGE_GRAY_HOLD record on the lane", async () => {
      const { succeeded } = await runJudgePass("human");
      // The chunk still succeeds; only the hold record is failed.
      expect(succeeded).toBe(2);
      const alicia = await readPerson("Alicia Smith");
      const alice = await readPerson("Alice Smith");
      expect(alicia?.merged_into).toBeNull();
      expect(alice?.merged_into).toBeNull();

      const pool = new pgclient.Pool({
        connectionString: `${BASE_DB_URL}?options=-c%20search_path%3D${SCHEMA}%2Cpublic`,
      });
      try {
        const lane = await listFailed(pool);
        const hold = lane.find(
          (r) => r.error_code === MERGE_GRAY_HOLD_CODE
        );
        expect(hold).toBeDefined();
        expect(hold!.error_msg).toContain("Alicia Smith");
        expect(hold!.error_msg).toContain(alice!.id);
        // The chunk's own record is succeeded, not held failed.
        const { rows } = await pool.query(
          `SELECT status FROM extraction_records
            WHERE error_code = $1 OR status = 'succeeded'`,
          [MERGE_GRAY_HOLD_CODE]
        );
        expect(rows.filter((r) => r.status === "succeeded").length).toBe(2);
      } finally {
        await pool.end();
      }
    });

    it("reject verdict leaves the lane empty of hold records", async () => {
      await runJudgePass("reject");
      const pool = new pgclient.Pool({
        connectionString: `${BASE_DB_URL}?options=-c%20search_path%3D${SCHEMA}%2Cpublic`,
      });
      try {
        const lane = await listFailed(pool);
        expect(
          lane.some((r) => r.error_code === MERGE_GRAY_HOLD_CODE)
        ).toBe(false);
      } finally {
        await pool.end();
      }
    });
  }
);
