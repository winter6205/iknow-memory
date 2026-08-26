/**
 * retrieval-pg: real-Postgres integration tests for the P0 graph-arm retrieval
 * pipeline (spec-3 p0-integration T6).
 *
 * Reuses spec-2 schema isolation: a unique SCHEMA reached via search_path
 * libpq options, dropped on teardown. Both the fixture client and the shared
 * PgvectorBackend pool use the same SCHEMA-scoped URL, so unqualified table
 * names resolve here and cannot race the parallel schema-p0 worker.
 *
 * Coverage: #8 single-hop end-to-end, #13 soft-merge survivor-only, #17
 * latency probe. Cases: JOIN path; triples.valid_window excludes past triple;
 * chunks.valid_window excludes past chunk; arm count == direct SQL; retired
 * entity's triple unreachable; empty schema -> { chunks: [] } degraded; direct
 * graphArmSeed survivor-only + two-sided valid_window; latency probe recorded
 * to /tmp/retrieval-pg-latency.json.
 *
 * Case 9 is the p0-wiring-closure T8 closure probe (SC4): a fresh schema runs
 * the whole live path — ingest three chunks through the ingest tool, extract
 * them through the CLI with a FakeLLMClient + FakeEmbedder, then retrieve at
 * the LOCKED default `CFG` and require graph-arm-contributed chunks and NO
 * `degraded` key. The three triples share one head entity, so one-hop from
 * that seed reaches three distinct chunks and `graphArmFloor: 3` is cleared
 * on merit — the probe carries no config override. It is the end-to-end check
 * that T1's entity embeddings, T2's vetted `relation_norm` and T7's concurrent
 * arms actually fire together; ADR-0001 holds throughout (Postgres only, no
 * Neo4j).
 *
 * The isolated chunks fixture adds a GENERATED valid_window column so the
 * production one-hop SQL (c.valid_window @> $validAt) runs against real PG;
 * PgvectorBackend ensureTable() CREATEs IF NOT EXISTS (no-op), so no src
 * change. When Postgres is unreachable the suite is describe.skipped loudly
 * with the project Validation block (never a silent pass).
 */
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { upSchemaP0 } from "../../src/core/storage/schema-p0.js";
import { PgvectorBackend } from "../../src/core/storage/pgvector-backend.js";
import { assembleRetrievalResult } from "../../src/core/retrieval/index.js";
import type { RetrieveConfig } from "../../src/core/retrieval/types.js";
import { FakeEmbedder } from "../../src/core/embedder.js";
import { computeEntityEmbeddingText } from "../../src/core/entities/embedding.js";
import { createIngestHandler } from "../../src/tools/ingest.js";
import { runCli, type CliDeps } from "../../src/cli/extract.js";
import { FakeLLMClient } from "../../src/core/extraction/llm-client.js";

const DIM = 1536;
const DB_URL =
  process.env.GRAPHRAG_MEMORY_DB_URL ??
  "postgresql://postgres@localhost:5432/postgres";
const SCHEMA = `retrieval_pg_${randomUUID().slice(0, 8).replace(/-/g, "")}`;
const SCHEMA_URL =
  DB_URL +
  (DB_URL.includes("?") ? "&" : "?") +
  `options=-c%20search_path%3D${SCHEMA},public`;

/** Default RetrieveConfig (locked by T5 + spec glossary): w=1/1, topK=8, cap=50, floor=3. */
const CFG: RetrieveConfig = {
  w_vec: 1,
  w_bm25: 1,
  w_graph: 1,
  bm25Enabled: false,
  graphEnabled: false,
  entityLinkTopK: 8,
  candidateCap: 50,
  graphArmFloor: 3,
};

const embedder = new FakeEmbedder(DIM);

/** Temporal anchors relative to "now" so windows always valid / always past. */
const NOW = new Date();
const NOW_ISO = NOW.toISOString();
const PAST_START = new Date(NOW.getTime() - 2 * 365 * 864e5).toISOString();
const PAST_END = new Date(NOW.getTime() - 1 * 365 * 864e5).toISOString();
const COVER_START = new Date(NOW.getTime() - 864e5).toISOString();
const COVER_END = new Date(NOW.getTime() + 365 * 864e5).toISOString();

function vecLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}
async function embedVec(text: string): Promise<number[]> {
  return (await embedder.embed([text]))[0]!;
}

// Loud skip when Postgres is unreachable (describe.skip + Validation block).
let PG_AVAILABLE = false;
try {
  const probe = new pg.Client({ connectionString: DB_URL });
  await probe.connect();
  await probe.query("SELECT 1");
  await probe.end();
  PG_AVAILABLE = true;
} catch (err) {
  console.warn(
    `\n[retrieval-pg] Postgres unreachable at ${DB_URL}: ${(err as Error).message}\n`
  );
  console.warn(
    "Validation:\n" +
      "- Not run: tests/integration/retrieval-pg.test.ts\n" +
      "- Expected command: npx vitest run tests/integration/retrieval-pg.test.ts\n" +
      `- Blocking issue: cannot connect to Postgres at ${DB_URL}\n`
  );
}
const describePg = PG_AVAILABLE ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/**
 * Drop + recreate the unique schema. Pre-creates `chunks` with a GENERATED
 * `valid_window` so the production one-hop SQL runs against real PG; the
 * backend's `CREATE TABLE IF NOT EXISTS` then no-ops.
 */
async function resetSchema(c: pg.Client): Promise<void> {
  await c.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await c.query(`CREATE SCHEMA "${SCHEMA}"`);
  await c.query(`SET search_path TO "${SCHEMA}", public`);
  await c.query(`
    CREATE TABLE IF NOT EXISTS chunks (
      id uuid PRIMARY KEY,
      content text NOT NULL,
      embedding vector(${DIM}) NOT NULL,
      valid_from timestamptz NOT NULL,
      valid_until timestamptz NULL,
      source_ref text NOT NULL,
      metadata jsonb NOT NULL,
      created_at timestamptz NOT NULL,
      valid_window tstzrange GENERATED ALWAYS AS (
        tstzrange(valid_from, valid_until, '[)')
      ) STORED
    )
  `);
  await upSchemaP0(c, DIM);
}

async function seedChunk(
  c: pg.Client,
  over: {
    content?: string;
    validFrom?: string;
    validUntil?: string | null;
  } = {}
): Promise<string> {
  const id = randomUUID();
  const content = over.content ?? `chunk-${id}`;
  const vec = await embedVec(content);
  await c.query(
    `INSERT INTO chunks (id, content, embedding, valid_from, valid_until,
                          source_ref, metadata, created_at)
     VALUES ($1, $2, $3::vector, $4, $5, $6, '{}', now())`,
    [
      id,
      content,
      vecLiteral(vec),
      over.validFrom ?? COVER_START,
      over.validUntil ?? null,
      `src/${id}`,
    ]
  );
  return id;
}

async function seedEntity(
  c: pg.Client,
  over: { name?: string; desc?: string } = {}
): Promise<string> {
  const id = randomUUID();
  const name = over.name ?? `entity-${id}`;
  const desc = over.desc ?? "desc";
  const vec = await embedVec(computeEntityEmbeddingText(name, desc));
  await c.query(
    `INSERT INTO entities (id, canonical_name, type, embedding)
     VALUES ($1, $2, 'concept', $3::vector)`,
    [id, name, vecLiteral(vec)]
  );
  return id;
}

async function seedTriple(
  c: pg.Client,
  over: {
    head: string;
    tail: string;
    chunkId: string;
    start?: string;
    end?: string | null;
  }
): Promise<void> {
  await c.query(
    `INSERT INTO triples (id, head_id, tail_id, relation_raw, relation_norm,
                          confidence, source_chunk_id, valid_window)
     VALUES ($1, $2, $3, 'rel', 'rel', 1.0, $4, tstzrange($5, $6, '[)'))`,
    [
      randomUUID(),
      over.head,
      over.tail,
      over.chunkId,
      over.start ?? COVER_START,
      over.end ?? null,
    ]
  );
}

async function bulkEntities(c: pg.Client, n: number): Promise<string[]> {
  const ids: string[] = [];
  const buf: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const id = randomUUID();
    ids.push(id);
    const name = `entity-${i}`;
    const vec = vecLiteral(
      await embedVec(computeEntityEmbeddingText(name, "latency"))
    );
    buf.push(`('${id}','${name}','concept','${vec}'::vector)`);
  }
  await c.query(
    `INSERT INTO entities (id, canonical_name, type, embedding) VALUES ${buf.join(",")}`
  );
  return ids;
}

async function bulkChunks(c: pg.Client, n: number): Promise<string[]> {
  const ids: string[] = [];
  let rows: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const id = randomUUID();
    ids.push(id);
    const vec = vecLiteral(await embedVec(`bulk-chunk-${i}`));
    rows.push(
      `('${id}','bulk-${i}','${vec}'::vector,'${COVER_START}'::timestamptz,NULL,'src/${i}','{}'::jsonb,now())`
    );
    if (rows.length >= 200) {
      await c.query(
        `INSERT INTO chunks (id, content, embedding, valid_from, valid_until, source_ref, metadata, created_at) VALUES ${rows.join(",")}`
      );
      rows = [];
    }
  }
  if (rows.length > 0) {
    await c.query(
      `INSERT INTO chunks (id, content, embedding, valid_from, valid_until, source_ref, metadata, created_at) VALUES ${rows.join(",")}`
    );
  }
  return ids;
}

async function bulkTriples(
  c: pg.Client,
  entityIds: string[],
  chunkIds: string[],
  n: number
): Promise<void> {
  const rows: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const head = entityIds[i % entityIds.length]!;
    const tail = entityIds[(i * 7 + 1) % entityIds.length]!;
    const chunk = chunkIds[i % chunkIds.length]!;
    rows.push(
      `('${randomUUID()}','${head}','${tail}','rel','rel',1.0,'${chunk}',tstzrange('${COVER_START}','${COVER_END}','[)'))`
    );
  }
  await c.query(
    `INSERT INTO triples (id, head_id, tail_id, relation_raw, relation_norm, confidence, source_chunk_id, valid_window) VALUES ${rows.join(",")}`
  );
}

// ---------------------------------------------------------------------------
// SC4 closure-probe fixtures (specs/p0-wiring-closure.md Success Criterion 4)
// ---------------------------------------------------------------------------

/** A source_ref no ingested chunk carries — suppresses the vector arm. */
const SC4_ABSENT_SOURCE_REF = "sc4/no-such-source";

/** The two entities every probe triple hangs off — head is the one-hop seed. */
const SC4_HEAD = "Alice Smith";
const SC4_TAIL = "Acme Corp";

/**
 * SC4 closure-probe corpus: one chunk + one FakeLLMClient output each.
 *
 * `graphArmFloor` counts one-hop CHUNKS, so a one-chunk corpus can only clear
 * the locked default floor of 3 with a config override. The corpus is sized
 * to the floor instead: all three triples hang off the same head entity, so
 * one-hop from that seed reaches three distinct chunks and the probe runs at
 * the locked default `CFG` with no override.
 *
 * Three rows survive because the dedup key is
 * `(head_id, relation_norm, tail_id)` and the three `relationNorm` values are
 * distinct. Distinct TAILS would not do it: `FakeEmbedder` puts every pair of
 * texts near cosine 0.75, far above the L3 merge threshold, so a second
 * `system` entity always merges into the first.
 *
 * Every text is short enough that `chunkText` emits exactly one chunk, and
 * every `relationNorm` is in ALLOWED, so T2's cascade keeps the claim as-is.
 * Head/tail types stay person/system, as in the single-chunk probe.
 */
const SC4_CORPUS = [
  {
    text: "Alice Smith works at Acme Corp on the billing platform.",
    description: "Alice Smith works at Acme Corp on the billing platform",
    relationRaw: "works at",
    relationNorm: "member_of",
  },
  {
    text: "Alice Smith owns a founding stake in Acme Corp.",
    description: "Alice Smith owns a founding stake in Acme Corp",
    relationRaw: "owns",
    relationNorm: "owns",
  },
  {
    text: "Alice Smith uses the Acme Corp deployment pipeline daily.",
    description: "Alice Smith uses the Acme Corp deployment pipeline daily",
    relationRaw: "uses",
    relationNorm: "uses",
  },
].map((entry, i) => ({
  text: entry.text,
  sourceRef: `sc4/closure-probe-${i}`,
  output: {
    head: SC4_HEAD,
    headType: "person",
    relationRaw: entry.relationRaw,
    relationNorm: entry.relationNorm,
    tail: SC4_TAIL,
    tailType: "system",
    description: entry.description,
    evidenceSpan: entry.description,
    confidence: 0.9,
  },
}));

/**
 * The #6 Q1 embedding text of the head entity the CLI run creates. The head
 * is inserted from the FIRST output's description and the later two L0-merge
 * into it (A8 first-write-wins), so that description is the head's SSOT.
 */
const SC4_QUERY = computeEntityEmbeddingText(
  SC4_HEAD,
  SC4_CORPUS[0]!.output.description
);

function silentLogger() {
  return {
    level: "error" as const,
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

/** Read the `chunk_ids` payload back out of the ingest tool's text result. */
function chunkIdsOf(result: { content: unknown }): string[] {
  const text = (result.content as Array<{ type: string; text?: string }>)
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
  return (JSON.parse(text) as { chunk_ids: string[] }).chunk_ids;
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((x, y) => x - y);
  const idx = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1);
  return sorted[idx] ?? 0;
}

// ---------------------------------------------------------------------------
// Functional suite + latency probe share a single client/backend pair.
// ---------------------------------------------------------------------------
describePg("retrieval-pg: real Postgres graph-arm retrieval (T6)", () => {
  let client: pg.Client | undefined;
  let backend: PgvectorBackend | undefined;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: SCHEMA_URL });
    await client.connect();
    await resetSchema(client);
    backend = new PgvectorBackend(SCHEMA_URL, DIM);
  });

  afterAll(async () => {
    if (backend) await backend.close();
    if (client) {
      await client.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
      await client.end();
    }
  });

  /**
   * The write half of the SC4 pipeline: the extraction CLI over the isolated
   * schema. Real extraction refuses to run keyless (CR High #1), so the run
   * goes through `runCli` with an injected FakeLLMClient and a real `pg.Pool`
   * — the documented env-injection fallback from tests/cli/extract.test.ts.
   * `now` is pinned to COVER_START so the triple's `valid_window` opens before
   * the `validAt` the retrieve half asks for.
   */
  async function runExtractCli(): Promise<number> {
    const pool = new pg.Pool({ connectionString: SCHEMA_URL });
    const deps: CliDeps = {
      pool,
      llm: new FakeLLMClient({
        queue: SC4_CORPUS.map((entry) => ({
          kind: "ok" as const,
          outputs: [entry.output],
        })),
      }),
      embedder,
      dims: DIM,
      logger: silentLogger(),
      now: () => COVER_START,
    };
    try {
      return await runCli(["--batch-size", String(SC4_CORPUS.length)], deps);
    } finally {
      await pool.end();
    }
  }

  /** Real ingest path: chunk -> embed -> upsert through the ingest tool. */
  async function ingestOneChunk(
    content: string,
    sourceRef: string
  ): Promise<string[]> {
    const ingest = createIngestHandler({ embedder, storage: backend! });
    return chunkIdsOf(
      await ingest({ content, source_ref: sourceRef, valid_from: COVER_START })
    );
  }

  it("1. graph arm returns a chunk via seed entity -> one-hop triple", async () => {
    const c = client!;
    await resetSchema(c);
    const chunkId = await seedChunk(c, {});
    const chunkId2 = await seedChunk(c, {});
    const chunkId3 = await seedChunk(c, {});
    const head = await seedEntity(c, { name: "Alice", desc: "works at Acme" });
    const tail = await seedEntity(c, { name: "Bob", desc: "engineer" });
    const e3 = await seedEntity(c, { name: "Carol", desc: "designer" });
    // 3 one-hop rows reach the floor (graphArmFloor default 3) so the graph
    // arm is NOT degraded and its hits flow into the fused envelope.
    await seedTriple(c, { head, tail, chunkId });
    await seedTriple(c, { head, tail: e3, chunkId: chunkId2 });
    await seedTriple(c, { head: tail, tail: e3, chunkId: chunkId3 });
    const out = await assembleRetrievalResult(
      {
        query: computeEntityEmbeddingText("Alice", "works at Acme"),
        validAt: NOW_ISO,
        limit: 10,
      },
      { embedder, storage: backend!, graphConfig: CFG, debug: true }
    );
    expect(out.chunks.some((ch) => ch.id === chunkId)).toBe(true);
    expect(out.debug?.graphHits).toBeGreaterThanOrEqual(1);
  });

  it("2. excludes a chunk whose triple valid_window does not contain now", async () => {
    const c = client!;
    await resetSchema(c);
    const chunkId = await seedChunk(c, {});
    const e1 = await seedEntity(c, { name: "Alice", desc: "works at Acme" });
    const e2 = await seedEntity(c, { name: "Bob", desc: "engineer" });
    const e3 = await seedEntity(c, { name: "Carol", desc: "designer" });
    await seedTriple(c, {
      head: e1,
      tail: e2,
      chunkId,
      start: PAST_START,
      end: PAST_END,
    });
    const out = await assembleRetrievalResult(
      {
        query: computeEntityEmbeddingText("Alice", "works at Acme"),
        validAt: NOW_ISO,
        limit: 10,
      },
      { embedder, storage: backend!, graphConfig: CFG, debug: true }
    );
    // The past-only triple is filtered out -> 0 one-hop rows. The graph arm
    // is below floor (0 < 3) and the arm is not added to the RRF fuse, but
    // vector-only chunks still flow through.
    expect(out.debug?.graphBelowFloor).toBe(true);
    expect(out.debug?.graphHits).toBe(0); // triple filtered out
  });

  it("3. excludes a chunk whose valid_window does not contain now", async () => {
    const c = client!;
    await resetSchema(c);
    const chunkId = await seedChunk(c, {
      validFrom: PAST_START,
      validUntil: PAST_END,
    });
    const e1 = await seedEntity(c, { name: "Alice", desc: "works at Acme" });
    const e2 = await seedEntity(c, { name: "Bob", desc: "engineer" });
    const e3 = await seedEntity(c, { name: "Carol", desc: "designer" });
    await seedTriple(c, { head: e1, tail: e2, chunkId });
    const out = await assembleRetrievalResult(
      {
        query: computeEntityEmbeddingText("Alice", "works at Acme"),
        validAt: NOW_ISO,
        limit: 10,
      },
      { embedder, storage: backend!, graphConfig: CFG, debug: true }
    );
    expect(out.debug?.graphBelowFloor).toBe(true);
    expect(out.debug?.graphHits).toBe(0);
  });

  it("4. graph-arm chunk count equals a direct single-hop SQL count", async () => {
    const c = client!;
    await resetSchema(c);
    const chunkA = await seedChunk(c, {});
    const chunkB = await seedChunk(c, {});
    const chunkC = await seedChunk(c, {});
    const e1 = await seedEntity(c, { name: "Alice", desc: "works at Acme" });
    const e2 = await seedEntity(c, { name: "Bob", desc: "engineer" });
    const e3 = await seedEntity(c, { name: "Carol", desc: "designer" });
    // 3 one-hop rows reach the floor (3) so the graph arm is active and
    // graphHits reflects the full direct SQL result.
    await seedTriple(c, { head: e1, tail: e2, chunkId: chunkA });
    await seedTriple(c, { head: e1, tail: e3, chunkId: chunkB });
    await seedTriple(c, { head: e2, tail: e3, chunkId: chunkC });
    const seeds = await backend!.graphArmSeed!.seedEntitiesByEmbedding(
      await embedVec(computeEntityEmbeddingText("Alice", "works at Acme")),
      5
    );
    const direct = await backend!.graphArmSeed!.chunksByOneHopFromEntities(
      seeds.map((s) => s.id),
      NOW_ISO,
      20
    );
    const out = await assembleRetrievalResult(
      {
        query: computeEntityEmbeddingText("Alice", "works at Acme"),
        validAt: NOW_ISO,
        limit: 10,
      },
      { embedder, storage: backend!, graphConfig: CFG, debug: true }
    );
    expect(direct.length).toBeGreaterThanOrEqual(3); // JOIN path returns 3 rows
    expect(out.debug?.graphHits).toBe(direct.length); // arm == direct SQL
  });

  it("5. soft-merge survivor-only: a retired/merged entity's triple is ignored", async () => {
    const c = client!;
    await resetSchema(c);
    const chunkA = await seedChunk(c, {});
    const a = await seedEntity(c, { name: "Alice", desc: "works at Acme" });
    const b = await seedEntity(c, { name: "Alice", desc: "works at Acme" });
    const x = await seedEntity(c, { name: "Xavier", desc: "retired" });
    const e3 = await seedEntity(c, { name: "Carol", desc: "designer" });
    // Merge A -> B (A retired) and X -> e3 (X retired). The triple's only
    // endpoints are A and X — both retired — so it is reachable only via the
    // retired entities, never via a survivor seed.
    await c.query(
      `UPDATE entities SET retired = true, merged_into = $2 WHERE id = $1`,
      [a, b]
    );
    await c.query(
      `UPDATE entities SET retired = true, merged_into = $2 WHERE id = $1`,
      [x, e3]
    );
    await seedTriple(c, { head: a, tail: x, chunkId: chunkA });
    const seeds = await backend!.graphArmSeed!.seedEntitiesByEmbedding(
      await embedVec(computeEntityEmbeddingText("Alice", "works at Acme")),
      5
    );
    expect(seeds.some((s) => s.id === a)).toBe(false); // retired excluded
    expect(seeds.some((s) => s.id === b)).toBe(true); // survivor kept
    const direct = await backend!.graphArmSeed!.chunksByOneHopFromEntities(
      seeds.map((s) => s.id),
      NOW_ISO,
      20
    );
    expect(direct.map((r) => r.id)).not.toContain(chunkA); // A's triple unreachable from survivors
  });

  it("7. empty P0 schema returns { chunks: [] } degraded without throwing", async () => {
    const c = client!;
    await resetSchema(c);
    const out = await assembleRetrievalResult(
      { query: "anything", validAt: NOW_ISO, limit: 10 },
      { embedder, storage: backend!, graphConfig: CFG, debug: true }
    );
    expect(out.chunks).toEqual([]);
    expect(out.degraded).toBe(true); // no survivor seeds -> below floor
  });

  it("8. graphArmSeed: survivor-only seeds + two-sided valid_window one-hop", async () => {
    const c = client!;
    await resetSchema(c);
    const live = await seedChunk(c, {});
    const past = await seedChunk(c, {
      validFrom: PAST_START,
      validUntil: PAST_END,
    });
    const e1 = await seedEntity(c, { name: "Alice", desc: "works at Acme" });
    const e2 = await seedEntity(c, { name: "Bob", desc: "engineer" });
    const e3 = await seedEntity(c, { name: "Carol", desc: "designer" });
    await c.query(
      `UPDATE entities SET retired = true, merged_into = $2 WHERE id = $1`,
      [e2, e1]
    );
    await seedTriple(c, { head: e1, tail: e3, chunkId: live });
    await seedTriple(c, { head: e1, tail: e3, chunkId: past });
    const seeds = await backend!.graphArmSeed!.seedEntitiesByEmbedding(
      await embedVec(computeEntityEmbeddingText("Alice", "works at Acme")),
      10
    );
    expect(seeds.some((s) => s.id === e2)).toBe(false); // retired excluded
    expect(seeds.some((s) => s.id === e1)).toBe(true);
    const rows = await backend!.graphArmSeed!.chunksByOneHopFromEntities(
      seeds.map((s) => s.id),
      NOW_ISO,
      20
    );
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(live);
    expect(ids).not.toContain(past); // past chunk's valid_window excludes now
  });

  it("9. SC4: fresh PG -> ingest the probe corpus -> CLI extract -> graph arm clears the default floor without degraded", async () => {
    const c = client!;
    await resetSchema(c);

    const chunkIds: string[] = [];
    for (const entry of SC4_CORPUS) {
      const ids = await ingestOneChunk(entry.text, entry.sourceRef);
      expect(ids).toHaveLength(1);
      chunkIds.push(ids[0]!);
    }
    // The corpus is sized to the locked floor, so the probe below proves the
    // graph arm clears `graphArmFloor: 3` rather than a lowered override.
    expect(chunkIds).toHaveLength(CFG.graphArmFloor);
    expect(await runExtractCli()).toBe(0);

    const validAt = new Date().toISOString();
    const seeds = await backend!.graphArmSeed!.seedEntitiesByEmbedding(
      await embedVec(SC4_QUERY),
      CFG.entityLinkTopK
    );
    const graphChunkIds = (
      await backend!.graphArmSeed!.chunksByOneHopFromEntities(
        seeds.map((s) => s.id),
        validAt,
        CFG.candidateCap
      )
    ).map((r) => r.id);
    // One-hop from the shared head entity reaches every ingested chunk.
    for (const id of chunkIds) expect(graphChunkIds).toContain(id);

    const out = await assembleRetrievalResult(
      { query: SC4_QUERY, validAt, limit: 10 },
      { embedder, storage: backend!, graphConfig: CFG, debug: true }
    );
    expect(out.debug?.graphBelowFloor).toBe(false);
    expect(out.debug?.graphHits as number).toBeGreaterThanOrEqual(
      CFG.graphArmFloor
    );
    expect(Object.hasOwn(out, "degraded")).toBe(false);
    expect(out.chunks.some((ch) => graphChunkIds.includes(ch.id))).toBe(true);

    // Provenance: prove the graph arm is what put the chunks in the envelope.
    // `filters` reaches the vector arm ONLY (the graph arm does its own seed /
    // one-hop filtering), so an absent source_ref empties the vector arm and
    // every surviving chunk is a graph-arm contribution.
    const graphOnly = await assembleRetrievalResult(
      {
        query: SC4_QUERY,
        validAt,
        limit: 10,
        filters: { source_ref: SC4_ABSENT_SOURCE_REF },
      },
      { embedder, storage: backend!, graphConfig: CFG, debug: true }
    );
    expect(graphOnly.debug?.vectorHits).toBe(0);
    expect(Object.hasOwn(graphOnly, "degraded")).toBe(false);
    expect([...graphOnly.chunks.map((ch) => ch.id)].sort()).toEqual(
      [...chunkIds].sort()
    );
  });

  // Latency probe (Success Criterion #17) — soft-record, no assert (CI noise).
  it("6. latency probe records graph-arm vs vector-only p95 to /tmp/retrieval-pg-latency.json", async () => {
    const c = client!;
    await resetSchema(c);
    const entityIds = await bulkEntities(c, 100);
    const chunkIds = await bulkChunks(c, 1000);
    await bulkTriples(c, entityIds, chunkIds, 500);
    const query = computeEntityEmbeddingText("entity-0", "latency");
    const N = 10;
    const graphTimes: number[] = [];
    for (let i = 0; i < N; i += 1) {
      const t0 = performance.now();
      await assembleRetrievalResult(
        { query, validAt: NOW_ISO, limit: 10 },
        { embedder, storage: backend!, graphConfig: CFG, debug: true }
      );
      graphTimes.push(performance.now() - t0);
    }
    const vecTimes: number[] = [];
    for (let i = 0; i < N; i += 1) {
      const t0 = performance.now();
      await assembleRetrievalResult(
        { query, validAt: NOW_ISO, limit: 10 },
        { embedder, storage: backend!, debug: true }
      );
      vecTimes.push(performance.now() - t0);
    }
    const graphP95 = percentile(graphTimes, 0.95);
    const vecP95 = percentile(vecTimes, 0.95);
    const summary = {
      schema: SCHEMA,
      n: N,
      entities: 100,
      triples: 500,
      chunks: 1000,
      graphP95Ms: graphP95,
      vectorP95Ms: vecP95,
      ratio: graphP95 / vecP95,
      at: NOW_ISO,
    };
    writeFileSync(
      "/tmp/retrieval-pg-latency.json",
      JSON.stringify(summary, null, 2)
    );
    console.log(
      `[retrieval-pg-latency] p95 graph=${graphP95.toFixed(1)}ms ` +
        `vector=${vecP95.toFixed(1)}ms ratio=${(graphP95 / vecP95).toFixed(2)}`
    );
  }, 120000);
});
