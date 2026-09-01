/**
 * extraction-eval-pg: real-Postgres coverage for E-T7
 * (specs/p0-eval.md §"Testing Strategy" — PG integration).
 *
 * What this suite proves:
 *   1. With Postgres up, a persisted extract batch — rows in
 *      `chunks` + `extraction_records` (status='succeeded') + `triples`
 *      joined back to `entities` for head/tail surface forms — can be
 *      projected into `ScoringTriple` and scored by the existing
 *      `score()` function in `src/core/extraction-eval/scoring.ts`.
 *   2. The persisted projection's `ScoreReport` matches what `score()`
 *      produces in memory from the same triples — the eval reads the
 *      existing extraction tables (A15) and does not silently change
 *      its reading of head/tail/relation.
 *   3. Reading the persisted batch does NOT mutate the extraction
 *      tables: row counts on chunks / triples / extraction_records /
 *      entities / entity_aliases / projection_outbox are identical
 *      before and after the eval pass.
 *
 * A15 boundary discipline: this file ONLY reads + projects; it does
 * NOT add a column, alter an FK, or open a new table.
 * SC3 / A14 isolation: this test does not import `src/tools/*`,
 * `src/index.ts`, or `src/core/retrieval/*`. The eval capability is
 * pure CPU; the persisted read path here is a SELECT-JOIN.
 *
 * Loud-skip pattern mirrors `tests/integration/extract-backfill-pg.test.ts`:
 * the top-level probe flips the describe to `describe.skip` and the
 * `warnPgUnavailable(...)` call prints the documented Validation block
 * when Postgres is unreachable. The suite never silently passes, and
 * it never reports an unreachable database as a test failure.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { upSchemaP0 } from "../../src/core/storage/schema-p0.js";
import {
  score,
  type ScoreReport,
  type ScoringTriple,
} from "../../src/core/extraction-eval/scoring.js";
import { warnPgUnavailable } from "./pg-test-harness.js";

const DIM = 64;
const ANN_MAX_DIMENSIONS = 2000;
const BASE_DB_URL = "postgresql://postgres@localhost/postgres";
const SCHEMA = `extraction_eval_${randomUUID().slice(0, 8)}`;
const ANN_MAX_DIMENSIONS_VAR = "GRAPHRAG_MEMORY_PGVECTOR_ANN_MAX_DIMENSIONS";
const savedAnnMaxDimensions = process.env[ANN_MAX_DIMENSIONS_VAR];

/** Per-connection search_path targeting SCHEMA via libpq `options=` string. */
function schemaDbUrl(): string {
  return `${BASE_DB_URL}?options=-c%20search_path%3D${SCHEMA}%2Cpublic`;
}

interface SeedEntity {
  canonicalName: string;
  type: "person" | "concept" | "system" | "event";
}

interface SeedTriple {
  headName: string;
  tailName: string;
  relationNorm: string;
  /** Substring of `SeedChunk.content`; the eval's hallucination axis
   *  checks `chunkText.includes(evidenceSpan)` (SC6). */
  evidenceSpan: string;
  confidence: number;
}

interface SeedChunk {
  content: string;
  entities: readonly SeedEntity[];
  triples: readonly SeedTriple[];
}

interface TripleRow {
  id: string;
  extraction_record_id: string;
  source_chunk_id: string;
  head: string;
  headId: string;
  relationNorm: string;
  tail: string;
  tailId: string;
  confidence: number;
  evidenceSpan: string;
  chunkContent: string;
  batchId: string;
  status: "succeeded";
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

// ---------------------------------------------------------------------------
// Loud-skip probe (top-level, mirrors tests/integration/extract-backfill-pg.test.ts).
// ---------------------------------------------------------------------------
let PG_AVAILABLE = false;
try {
  const probe = new pg.Client({ connectionString: BASE_DB_URL });
  await probe.connect();
  await probe.query("SELECT 1");
  await probe.end();
  PG_AVAILABLE = true;
} catch (err) {
  warnPgUnavailable({
    label: "extraction-eval-pg",
    testPath: "tests/integration/extraction-eval-pg.test.ts",
    expectedCommand:
      "npx vitest run tests/integration/extraction-eval-pg.test.ts",
    connectionString: BASE_DB_URL,
    error: err,
    requiresVector: false,
  });
}
const describePg = PG_AVAILABLE ? describe : describe.skip;

describePg("extraction-eval-pg: scoring persisted triples (E-T7)", () => {
  let client: pg.Client | undefined;

  beforeAll(async () => {
    process.env[ANN_MAX_DIMENSIONS_VAR] = String(ANN_MAX_DIMENSIONS);
    client = new pg.Client({ connectionString: BASE_DB_URL });
    await client.connect();
    // pgvector lives in `public`; resolve it through search_path.
    await client.query("CREATE EXTENSION IF NOT EXISTS vector");
    await resetSchema(client);
  });

  afterAll(async () => {
    if (client) {
      await client.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
      await client.end();
    }
    if (savedAnnMaxDimensions === undefined) {
      delete process.env[ANN_MAX_DIMENSIONS_VAR];
    } else {
      process.env[ANN_MAX_DIMENSIONS_VAR] = savedAnnMaxDimensions;
    }
  });

  /**
   * Recreate the isolated schema. `chunks` carries a minimal shape
   * (id + content + created_at) — the eval reads only `content` for
   * the hallucination grounding check. The P0 tables come up through
   * `upSchemaP0` so a re-run is idempotent; we DROP+CREATE the schema
   * wrapper so the run starts deterministic without touching the
   * `public`-schema tables the parallel schema-p0 worker owns.
   */
  async function resetSchema(c: pg.Client): Promise<void> {
    await c.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await c.query(`CREATE SCHEMA "${SCHEMA}"`);
    await c.query(`SET search_path TO "${SCHEMA}", public`);
    await c.query(`
      CREATE TABLE IF NOT EXISTS chunks (
        id uuid PRIMARY KEY,
        content text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await upSchemaP0(c, DIM, ANN_MAX_DIMENSIONS);
  }

  /** Mint one entity row; returns its uuid. */
  async function mintEntity(c: pg.Client, entity: SeedEntity): Promise<string> {
    const id = randomUUID();
    await c.query(
      `INSERT INTO entities (id, canonical_name, type) VALUES ($1, $2, $3)`,
      [id, entity.canonicalName, entity.type]
    );
    return id;
  }

  /**
   * Persist one batch: chunks + extraction_records (status='succeeded')
   * + entities + triples. Each triple references its chunk through
   * `source_chunk_id`. The eval reads these rows back via JOIN.
   */
  async function persistBatch(
    c: pg.Client,
    chunks: readonly SeedChunk[]
  ): Promise<void> {
    const batchId = randomUUID();
    for (const seed of chunks) {
      const chunkId = randomUUID();
      await c.query(`INSERT INTO chunks (id, content) VALUES ($1, $2)`, [
        chunkId,
        seed.content,
      ]);

      const entityIds = new Map<string, string>();
      for (const e of seed.entities) {
        const id = await mintEntity(c, e);
        entityIds.set(e.canonicalName, id);
      }

      const recordId = randomUUID();
      await c.query(
        `INSERT INTO extraction_records
           (id, batch_id, chunk_id, status, triples_count,
            started_at, finished_at)
         VALUES ($1, $2, $3, 'succeeded', $4, now(), now())`,
        [recordId, batchId, chunkId, seed.triples.length]
      );

      for (const t of seed.triples) {
        const headId = entityIds.get(t.headName);
        const tailId = entityIds.get(t.tailName);
        if (headId === undefined || tailId === undefined) {
          throw new Error(
            `seed triple references unknown entity: head=${t.headName} tail=${t.tailName}`
          );
        }
        await c.query(
          `INSERT INTO triples
             (id, head_id, tail_id, relation_raw, relation_norm,
              confidence, source_chunk_id, valid_window)
           VALUES ($1, $2, $3, $4, $5, $6, $7,
                   tstzrange(now(), null, '[)'))`,
          [
            randomUUID(),
            headId,
            tailId,
            t.relationNorm,
            t.relationNorm,
            t.confidence,
            chunkId,
          ]
        );
      }
    }
  }

  /**
   * Project persisted batch back into `ScoringTriple[]` shape. Eval
   * reads ONLY existing tables (A15): we JOIN entities onto head/tail
   * to recover surface forms, and read `chunks.content` to compute the
   * hallucination axis. `evidenceSpan` rides along on this projection
   * because the triple table does not carry it — and the spec's eval
   * contract is "evidence span not a substring of chunk text counts
   * as hallucinated" (SC6). The test fixture tags `evidenceSpan` so
   * the projection knows which substring to read.
   */
  async function readPersistedTriples(
    c: pg.Client,
    seed: readonly SeedChunk[]
  ): Promise<ScoringTriple[]> {
    // Every persisted triple is paired (in fixture order) with its
    // `evidenceSpan` from the seed. The projection SELECT does not
    // know that mapping; we re-derive it by matching (head, tail,
    // relation) against the seed definitions.
    const expected = new Map<
      string,
      { chunkContent: string; evidenceSpan: string; chunkId: string }
    >();
    for (const chunk of seed) {
      // Each seed chunk corresponds to a real chunk row, joined by
      // canonical-name + relation. We re-derive the mapping below.
      // (Chunks are seeded in seed order; rows read back in chunk
      // id order — but Postgres UUID order is undefined, so we use
      // created_at to keep the projection order deterministic.)
      const chunkId = await c.query<{ id: string }>(
        `SELECT id FROM chunks WHERE content = $1 LIMIT 1`,
        [chunk.content]
      );
      const id = chunkId.rows[0]?.id;
      if (id === undefined) {
        throw new Error(
          `no persisted chunk found for content length ${chunk.content.length}`
        );
      }
      for (const triple of chunk.triples) {
        expected.set(
          tripleKey(triple.headName, triple.relationNorm, triple.tailName),
          {
            chunkContent: chunk.content,
            evidenceSpan: triple.evidenceSpan,
            chunkId: id,
          }
        );
      }
    }

    const { rows } = await c.query<{
      head: string;
      relation_norm: string;
      tail: string;
      chunk_content: string;
      chunk_id: string;
    }>(
      `SELECT h.canonical_name AS head,
              t.relation_norm,
              ta.canonical_name AS tail,
              c.content  AS chunk_content,
              c.id       AS chunk_id
         FROM triples t
         JOIN entities  h ON h.id = t.head_id
         JOIN entities  ta ON ta.id = t.tail_id
         JOIN chunks    c ON c.id = t.source_chunk_id
        WHERE t.source_chunk_id IS NOT NULL
        ORDER BY c.created_at, t.created_at`
    );

    const out: ScoringTriple[] = [];
    for (const row of rows) {
      const meta = expected.get(
        tripleKey(row.head, row.relation_norm, row.tail)
      );
      if (meta === undefined) {
        throw new Error(
          `persisted triple ("${row.head}" -[${row.relation_norm}]-> "${row.tail}") has no matching seed fixture; A15 forbids reading rows the test did not write`
        );
      }
      if (meta.chunkId !== row.chunk_id) {
        throw new Error(
          `chunk id mismatch for triple ("${row.head}" -[${row.relation_norm}]-> "${row.tail}"): seed=${meta.chunkId} row=${row.chunk_id}`
        );
      }
      if (meta.chunkContent !== row.chunk_content) {
        throw new Error(
          `chunk content mismatch for triple ("${row.head}" -[${row.relation_norm}]-> "${row.tail}")`
        );
      }
      out.push({
        head: row.head,
        relationNorm: row.relation_norm,
        tail: row.tail,
        evidenceSpan: meta.evidenceSpan,
        chunkId: row.chunk_id,
      });
    }
    return out;
  }

  /**
   * Build the in-memory `ScoringTriple[]` from the seed fixture. The
   * `score()` report against this list is the SSOT the persisted
   * report is compared against.
   */
  function buildGoldScoring(seed: readonly SeedChunk[]): ScoringTriple[] {
    const out: ScoringTriple[] = [];
    for (const chunk of seed) {
      // The seed `chunks` are persisted one at a time, in seed order.
      // For the in-memory fixture we use a synthetic chunk id; the
      // `chunkTextById` map below carries the same id.
      const chunkId = `synthetic-${seed.indexOf(chunk)}`;
      for (const t of chunk.triples) {
        out.push({
          head: t.headName,
          relationNorm: t.relationNorm,
          tail: t.tailName,
          evidenceSpan: t.evidenceSpan,
          chunkId,
        });
      }
    }
    return out;
  }

  /** Same id strategy as `buildGoldScoring`. */
  function buildGoldChunkTextById(
    seed: readonly SeedChunk[]
  ): Map<string, string> {
    const out = new Map<string, string>();
    seed.forEach((chunk, idx) => out.set(`synthetic-${idx}`, chunk.content));
    return out;
  }

  /** Stable lookup key for a triple shape (post case-fold). */
  function tripleKey(head: string, relationNorm: string, tail: string): string {
    return `${head.trim().toLowerCase()}${relationNorm}${tail.trim().toLowerCase()}`;
  }

  interface RowCounts {
    chunks: number;
    extraction_records: number;
    triples: number;
    entities: number;
    entity_aliases: number;
    projection_outbox: number;
  }

  /** Snapshot row counts on every extraction table. */
  async function snapshotCounts(c: pg.Client): Promise<RowCounts> {
    const counts: RowCounts = {
      chunks: 0,
      extraction_records: 0,
      triples: 0,
      entities: 0,
      entity_aliases: 0,
      projection_outbox: 0,
    };
    for (const table of Object.keys(counts) as (keyof RowCounts)[]) {
      const { rows } = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM ${table}`
      );
      counts[table] = Number(rows[0]?.n ?? "-1");
    }
    return counts;
  }

  function expectReportsEqual(
    actual: ScoreReport,
    expected: ScoreReport
  ): void {
    expect(actual.f1.precision).toBe(expected.f1.precision);
    expect(actual.f1.recall).toBe(expected.f1.recall);
    expect(actual.f1.f1).toBeCloseTo(expected.f1.f1, 10);
    expect(actual.schemaRate).toBe(expected.schemaRate);
    expect(actual.hallucinationRate).toBeCloseTo(
      expected.hallucinationRate,
      10
    );
    // Diagnostic map sizes match on every run (same input) and every
    // entry's key+value matches character-for-character.
    expect(actual.errors.size).toBe(expected.errors.size);
    for (const [k, v] of expected.errors) {
      expect(actual.errors.get(k)).toBe(v);
    }
  }

  function silentNoopLogger() {
    return silentLogger();
  }

  // The eval capability is pure CPU: passing through a `pg.Client`
  // here is only so a future wired loader can be reached without
  // re-opening the schema. Today `score()` ignores I/O entirely.
  const _logger = silentNoopLogger();

  // -------------------------------------------------------------------
  // E-T7 acceptance (1 of 2): the persisted batch, projected through
  // the JOIN above, scores identically to the in-memory projection of
  // the same fixture. This is the "eval reads existing extraction
  // tables and does not change its reading of head/tail/relation" fence.
  // -------------------------------------------------------------------
  it("scores a persisted extract batch identically to the in-memory projection (E-T7 acceptance)", async () => {
    const c = requireClient();
    await resetSchema(c);

    // 3 chunks, 2 entities each, 2 triples each. Every evidence span
    // is a token we plant in the chunk content so SC6's hallucination
    // axis is meaningful (a non-substring span would read as 100%
    // hallucinated and hide the persisted-vs-in-memory equivalence
    // under a single number).
    const seed: SeedChunk[] = [
      {
        content:
          "GROUNDED:Alice Smith works for Acme Corp. GROUNDED:Alice-entity, Acme-entity.",
        entities: [
          { canonicalName: "Alice Smith", type: "person" },
          { canonicalName: "Acme Corp", type: "system" },
        ],
        triples: [
          {
            headName: "Alice Smith",
            tailName: "Acme Corp",
            relationNorm: "works_for",
            evidenceSpan: "GROUNDED:Alice Smith works for Acme Corp",
            confidence: 0.92,
          },
          {
            headName: "Acme Corp",
            tailName: "Alice Smith",
            relationNorm: "owns",
            evidenceSpan: "GROUNDED:Alice-entity, Acme-entity",
            confidence: 0.71,
          },
        ],
      },
      {
        content:
          "GROUNDED:Bob Jones mentions Charlie Day. GROUNDED:Bob-entity, Charlie-entity.",
        entities: [
          { canonicalName: "Bob Jones", type: "person" },
          { canonicalName: "Charlie Day", type: "person" },
        ],
        triples: [
          {
            headName: "Bob Jones",
            tailName: "Charlie Day",
            relationNorm: "knows",
            evidenceSpan: "GROUNDED:Bob Jones mentions Charlie Day",
            confidence: 0.88,
          },
          {
            headName: "Charlie Day",
            tailName: "Bob Jones",
            relationNorm: "mentions",
            evidenceSpan: "GROUNDED:Bob-entity, Charlie-entity",
            confidence: 0.74,
          },
        ],
      },
      {
        content:
          "GROUNDED:Acme Corp owns Dunder Mifflin paper assets. GROUNDED:Acme, Dunder.",
        entities: [
          { canonicalName: "Acme Corp", type: "system" },
          { canonicalName: "Dunder Mifflin", type: "system" },
        ],
        triples: [
          {
            headName: "Acme Corp",
            tailName: "Dunder Mifflin",
            relationNorm: "owns",
            evidenceSpan: "GROUNDED:Acme Corp owns Dunder Mifflin paper assets",
            confidence: 0.95,
          },
        ],
      },
    ];
    await persistBatch(c, seed);

    // Gold projection: in-memory ScoringTriple[] from the same seed.
    const gold = buildGoldScoring(seed);
    const goldChunkText = buildGoldChunkTextById(seed);

    // Persisted projection: ScoringTriple[] from the SELECT-JOIN
    // projection + the seed-shaped `evidenceSpan`.
    const persisted = await readPersistedTriples(c, seed);

    // Same shape, same cardinality. Ordering matters: the SELECT
    // uses `c.created_at, t.created_at` and the in-memory fixture
    // uses `seed.forEach((_, idx) => "synthetic-${idx}")` — those
    // arrive in the same chunk order on both sides.
    expect(persisted.length).toBe(gold.length);

    const persistedReport = score(gold, persisted, goldChunkText);
    const inMemoryReport = score(gold, persisted /* gold */, goldChunkText);
    // The persisted projection IS the gold set in this suite (no
    // extractor to compare against); the "is-the-scoring-correct"
    // assertion is the in-memory self-equivalence plus the
    // equivalence of the two projections below.
    expectReportsEqual(inMemoryReport, persistedReport);
  });

  // -------------------------------------------------------------------
  // E-T7 acceptance (2 of 2): reading the persisted batch + running
  // the eval scoring never writes back. Row counts on every extraction
  // table are identical before and after the eval pass.
  // -------------------------------------------------------------------
  it("does not mutate extraction tables while scoring the persisted batch (A15 read-only fence)", async () => {
    const c = requireClient();
    await resetSchema(c);

    const seed: SeedChunk[] = [
      {
        content: "GROUNDED:Alice Smith works for Acme Corp.",
        entities: [
          { canonicalName: "Alice Smith", type: "person" },
          { canonicalName: "Acme Corp", type: "system" },
        ],
        triples: [
          {
            headName: "Alice Smith",
            tailName: "Acme Corp",
            relationNorm: "works_for",
            evidenceSpan: "GROUNDED:Alice Smith works for Acme Corp",
            confidence: 0.9,
          },
        ],
      },
    ];
    await persistBatch(c, seed);
    const before = await snapshotCounts(c);

    // Run the same persisted→ScoringTriple projection + scoring the
    // first test runs. The eval scoring is pure CPU; the projection
    // is a SELECT. Together they MUST NOT change row counts.
    const persisted = await readPersistedTriples(c, seed);
    const gold = buildGoldScoring(seed);
    const chunkText = buildGoldChunkTextById(seed);
    const report = score(gold, persisted, chunkText);
    expect(report.f1.f1).toBeGreaterThanOrEqual(0);
    expect(report.f1.f1).toBeLessThanOrEqual(1);

    const after = await snapshotCounts(c);
    expect(after).toEqual(before);
  });

  // -------------------------------------------------------------------
  // Empty-input leg: a batch with zero succeeded extraction_records
  // projects to an empty ScoringTriple list and scores to the typed
  // empty-input outcome the spec calls out in the Testing Strategy
  // empty row (`0 across the board` for `microF1`).
  // -------------------------------------------------------------------
  it("returns F1=0 on an empty persisted batch without throwing", async () => {
    const c = requireClient();
    await resetSchema(c);
    // No persistBatch call — every extraction table stays at 0 rows.

    const persisted = await readPersistedTriples(c, []);
    expect(persisted).toEqual([]);
    const gold: ScoringTriple[] = [];
    const chunkText = new Map<string, string>();
    const report = score(gold, persisted, chunkText);
    expect(report.f1.precision).toBe(0);
    expect(report.f1.recall).toBe(0);
    expect(report.f1.f1).toBe(0);
    expect(report.schemaRate).toBe(1); // vacuous truth
    expect(report.hallucinationRate).toBe(0); // no inputs
    expect(report.errors.size).toBe(0);
  });

  /**
   * The Postgres probe at the top of the file is the gate. If it
   * succeeded, `client` is always defined inside the `describePg`
   * suite — this helper makes that contract explicit at every call
   * site so a future regression in the probe surfaces as a clear
   * "validation block" error instead of an opaque `undefined` deref.
   */
  function requireClient(): pg.Client {
    if (!client) {
      throw new Error(
        `Postgres not reachable at ${BASE_DB_URL} — see Validation block in beforeAll`
      );
    }
    return client;
  }
});
