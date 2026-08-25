/**
 * extract-persist-pg: real-Postgres coverage for the T1 write-side slice of
 * `specs/p0-wiring-closure.md` (G1 + G4 + G6).
 *
 *   SC3 — after a FakeLLMClient + FakeEmbedder CLI run, no live entity has a
 *         NULL embedding and `seedEntitiesByEmbedding` returns >= 1 row, so the
 *         graph arm has seeds instead of always degrading.
 *   SC6 — created entities carry `metadata->>'description'` equal to the
 *         extraction output's description, and the L2 gate rejects on two
 *         descriptions read back through the production `loadEntities` loader.
 *   SC9 — creation writes the `name` alias row, a differing-surface L3 merge
 *         writes a `variant` row, and re-inserting an identical
 *         `(entity_id, alias)` pair neither throws nor duplicates.
 *
 * Harness follows tests/cli/extract.test.ts: a unique schema inside the default
 * `postgres` database, reached by the CLI through the libpq
 * `options=-c search_path=<schema>,public` startup string, so the parallel
 * schema-p0 worker cannot race this suite's rows. Per
 * docs/.claude/rules/test.md the suite SKIPS LOUDLY when Postgres is
 * unreachable — a top-level probe flips it to `describe.skip` and prints the
 * documented Validation block, the same shape
 * tests/integration/retrieval-pg.test.ts uses. It never silently passes, and
 * it never reports an unreachable database as a test failure.
 *
 * Real extraction refuses to run keyless (CR High #1), so every write here goes
 * through `runCli` with an injected FakeLLMClient and a real `pg.Pool` — the
 * documented env-injection fallback from tests/cli/extract.test.ts.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadEntities, runCli, type CliDeps } from "../../src/cli/extract.js";
import { FakeLLMClient } from "../../src/core/extraction/llm-client.js";
import { FakeEmbedder, type EmbeddingClient } from "../../src/core/embedder.js";
import { mergeEntitiesWithGating } from "../../src/core/entities/merge.js";
import { PgvectorBackend } from "../../src/core/storage/pgvector-backend.js";
import { upSchemaP0 } from "../../src/core/storage/schema-p0.js";
import type { ExtractionResponse } from "../../src/core/extraction/types.js";

/**
 * Wide enough that two FakeEmbedder vectors for unrelated descriptions land
 * far below the 0.30 L2 floor (cosine concentrates around 0 as N grows).
 */
const DIM = 256;
const BASE_DB_URL = "postgresql://postgres@localhost/postgres";
const SCHEMA = `extract_persist_${randomUUID().slice(0, 8)}`;

/** Per-connection search_path targeting SCHEMA via the libpq `options=` string. */
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

interface Output {
  head: string;
  headType: string;
  relationRaw: string;
  relationNorm: string;
  tail: string;
  tailType: string;
  description: string;
  evidenceSpan: string;
  confidence: number;
}

/** One extraction output; head/tail/description are what the assertions read. */
function output(over: Partial<Output> = {}): Output {
  return {
    head: "Alice Smith",
    headType: "person",
    relationRaw: "works at",
    relationNorm: "MEMBER_OF",
    tail: "Acme Corp",
    tailType: "system",
    description: "Alice Smith works at Acme Corp on the billing platform",
    evidenceSpan: "Alice Smith works at Acme Corp",
    confidence: 0.9,
    ...over,
  };
}

/**
 * Every text embeds to the same vector, so L2 clears its floor and L3 sees
 * cosine 1.0 — a deterministic L3 merge.
 */
class ConstantEmbedder implements EmbeddingClient {
  constructor(private readonly dimensions: number) {}
  async embed(texts: string[]): Promise<number[][]> {
    const unit = new Array<number>(this.dimensions).fill(
      1 / Math.sqrt(this.dimensions)
    );
    return texts.map(() => [...unit]);
  }
}

/**
 * Distinct texts embed to distinct basis vectors, so cosine is 1 for equal
 * texts and 0 otherwise — a deterministic L2 rejection. FakeEmbedder cannot
 * drive this gate: its derived vectors sit around cosine 0.75 for any pair of
 * texts, well above the 0.30 floor.
 */
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

// Loud skip when Postgres is unreachable (describe.skip + Validation block).
let PG_AVAILABLE = false;
try {
  const probe = new pg.Client({ connectionString: BASE_DB_URL });
  await probe.connect();
  await probe.query("SELECT 1");
  await probe.end();
  PG_AVAILABLE = true;
} catch (err) {
  console.warn(
    `\n[extract-persist-pg] Postgres unreachable at ${BASE_DB_URL}: ${(err as Error).message}\n`
  );
  console.warn(
    "Validation:\n" +
      "- Not run: tests/integration/extract-persist-pg.test.ts\n" +
      "- Expected command: npx vitest run tests/integration/extract-persist-pg.test.ts\n" +
      `- Blocking issue: cannot connect to Postgres at ${BASE_DB_URL}\n`
  );
}
const describePg = PG_AVAILABLE ? describe : describe.skip;

describePg("extract-persist-pg: embedding + description + aliases (T1)", () => {
  let client: pg.Client | undefined;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: BASE_DB_URL });
    await client.connect();
    // Install pgvector into `public` (the default search_path here) so the
    // per-test schema's `vector(N)` columns resolve through it.
    await client.query("CREATE EXTENSION IF NOT EXISTS vector");
    await resetSchema(client);
  });

  afterAll(async () => {
    if (!client) return;
    await client.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await client.end();
  });

  /**
   * Recreate the isolated schema. `chunks` carries the full pgvector shape so
   * PgvectorBackend's own idempotent CREATE TABLE IF NOT EXISTS is a no-op
   * against it (SC3 reads seeds through that backend).
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
        valid_from timestamptz NOT NULL DEFAULT now(),
        valid_until timestamptz NULL,
        source_ref text NOT NULL DEFAULT '',
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await upSchemaP0(c, DIM);
  }

  /** Seed `contents.length` chunks in a deterministic created_at order. */
  async function seedChunks(
    c: pg.Client,
    contents: string[]
  ): Promise<string[]> {
    const zeroVec = `[${new Array(DIM).fill(0).join(",")}]`;
    const ids: string[] = [];
    for (let i = 0; i < contents.length; i += 1) {
      const id = randomUUID();
      await c.query(
        `INSERT INTO chunks (id, content, embedding, created_at)
           VALUES ($1, $2, $3, $4)`,
        [id, contents[i], zeroVec, `2026-01-0${i + 1}T00:00:00Z`]
      );
      ids.push(id);
    }
    return ids;
  }

  /** Run the CLI write path against the isolated schema; returns the exit code. */
  async function runExtraction(
    queue: ExtractionResponse[],
    embedder: EmbeddingClient
  ): Promise<number> {
    const pool = new pg.Pool({ connectionString: schemaDbUrl() });
    const deps: CliDeps = {
      pool,
      llm: new FakeLLMClient({ queue }),
      embedder,
      dims: DIM,
      logger: silentLogger(),
      now: () => "2026-08-25T00:00:00.000Z",
    };
    try {
      return await runCli(["--batch-size", String(queue.length)], deps);
    } finally {
      await pool.end();
    }
  }

  // -----------------------------------------------------------------
  // SC3: no live entity carries a NULL embedding, and the graph arm's
  // seed query returns at least one row.
  // -----------------------------------------------------------------
  it("SC3: a CLI run leaves zero NULL embeddings and seedEntitiesByEmbedding returns >= 1 row", async () => {
    const c = client!;
    await resetSchema(c);
    await seedChunks(c, ["Alice Smith works at Acme Corp."]);

    const code = await runExtraction(
      [{ kind: "ok", outputs: [output()] }],
      new FakeEmbedder(DIM)
    );
    expect(code).toBe(0);

    const nulls = await c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM entities
        WHERE retired = false AND embedding IS NULL`
    );
    expect(Number(nulls.rows[0]?.n ?? "-1")).toBe(0);

    const total = await c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM entities`
    );
    expect(Number(total.rows[0]?.n ?? "0")).toBe(2); // head + tail

    const backend = new PgvectorBackend(schemaDbUrl(), DIM);
    try {
      const [probe] = await new FakeEmbedder(DIM).embed(["Alice Smith"]);
      const seeds = await backend.graphArmSeed.seedEntitiesByEmbedding(
        probe!,
        10
      );
      expect(seeds.length).toBeGreaterThanOrEqual(1);
      expect(seeds.map((s) => s.canonical_name)).toContain("Alice Smith");
    } finally {
      await backend.close();
    }
  });

  // -----------------------------------------------------------------
  // SC6 (first half): the extraction output's description reaches
  // entities.metadata->>'description' — no DDL change, JSONB key only.
  // -----------------------------------------------------------------
  it("SC6: created entities carry metadata->>'description' equal to the extraction output", async () => {
    const c = client!;
    await resetSchema(c);
    await seedChunks(c, ["Alice Smith works at Acme Corp."]);
    const out = output();

    const code = await runExtraction(
      [{ kind: "ok", outputs: [out] }],
      new FakeEmbedder(DIM)
    );
    expect(code).toBe(0);

    const rows = await c.query<{ canonical_name: string; description: string }>(
      `SELECT canonical_name, metadata->>'description' AS description
         FROM entities ORDER BY canonical_name`
    );
    expect(rows.rows).toEqual([
      { canonical_name: out.tail, description: out.description },
      { canonical_name: out.head, description: out.description },
    ]);
  });

  // -----------------------------------------------------------------
  // SC6 (second half): the L2 description-cosine floor fires on
  // descriptions read back by the production loader, not on in-memory
  // strings — the gate is live on the real read path.
  // -----------------------------------------------------------------
  it("SC6: the L2 gate rejects on descriptions loaded from the database", async () => {
    const c = client!;
    await resetSchema(c);
    await seedChunks(c, ["Alice at Acme.", "Bob at Globex."]);

    const code = await runExtraction(
      [
        { kind: "ok", outputs: [output()] },
        {
          kind: "ok",
          outputs: [
            output({
              head: "Bob Jones",
              tail: "Globex Ltd",
              description:
                "Bob Jones coordinates warehouse logistics for Globex Ltd",
            }),
          ],
        },
      ],
      new OrthogonalEmbedder(DIM)
    );
    expect(code).toBe(0);

    // The production loader is the only source of both descriptions here.
    const live = await loadEntities(c);
    const alice = live.find((e) => e.canonicalName === "Alice Smith");
    const bob = live.find((e) => e.canonicalName === "Bob Jones");
    expect(alice?.description).toBe(output().description);
    expect(bob?.description).toBe(
      "Bob Jones coordinates warehouse logistics for Globex Ltd"
    );
    expect(alice?.embedding).toHaveLength(DIM);

    const outcome = await mergeEntitiesWithGating(
      {
        canonicalName: bob!.canonicalName,
        type: bob!.type,
        description: bob!.description,
      },
      [alice!],
      { embedder: new OrthogonalEmbedder(DIM) }
    );

    expect(outcome.decision).toMatchObject({
      kind: "reject",
      level: "L2",
      reason: "desc-below-floor",
    });
    expect(outcome.canonicalId).toBe(alice!.id);
  });

  // -----------------------------------------------------------------
  // SC6 invariant: the two ends of one output are mutually exclusive
  // merge candidates. Both ends carry the SAME description, so without
  // the exclusion the L3 name+description cosine folds the tail into the
  // head and the triple degenerates into a self-loop.
  // -----------------------------------------------------------------
  it("SC6: a same-type tail sharing the head's description never yields head_id = tail_id", async () => {
    const c = client!;
    await resetSchema(c);
    await seedChunks(c, ["Alice Smith mentors Alicia Smith."]);

    // ConstantEmbedder merges any two same-type candidates through L3, so
    // only the candidate-set exclusion can keep the two ends apart.
    const code = await runExtraction(
      [
        {
          kind: "ok",
          outputs: [
            output({
              head: "Alice Smith",
              headType: "person",
              tail: "Alicia Smith",
              tailType: "person",
              relationRaw: "mentors",
              relationNorm: "knows",
              description:
                "Alice Smith mentors Alicia Smith on the billing platform",
            }),
          ],
        },
      ],
      new ConstantEmbedder(DIM)
    );
    expect(code).toBe(0);

    const people = await c.query<{ canonical_name: string }>(
      `SELECT canonical_name FROM entities
        WHERE type = 'person' ORDER BY canonical_name`
    );
    expect(people.rows.map((r) => r.canonical_name)).toEqual([
      "Alice Smith",
      "Alicia Smith",
    ]);

    const selfLoops = await c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM triples WHERE head_id = tail_id`
    );
    expect(Number(selfLoops.rows[0]?.n ?? "-1")).toBe(0);

    const triples = await c.query<{ head: string; tail: string }>(
      `SELECT h.canonical_name AS head, t.canonical_name AS tail
         FROM triples r
         JOIN entities h ON h.id = r.head_id
         JOIN entities t ON t.id = r.tail_id`
    );
    expect(triples.rows).toEqual([
      { head: "Alice Smith", tail: "Alicia Smith" },
    ]);
  });

  // -----------------------------------------------------------------
  // SC9: name alias at creation, variant alias on a differing-surface L3
  // merge, and an identical (entity_id, alias) re-insert that neither
  // throws nor duplicates.
  // -----------------------------------------------------------------
  it("SC9: creation writes a name alias, an L3 merge writes a variant, and a repeat insert is a no-op", async () => {
    const c = client!;
    await resetSchema(c);
    await seedChunks(c, ["Alice at Acme.", "Alicia at Acme.", "Alicia again."]);

    // Chunk 1 creates "Alice Smith"; chunks 2 and 3 present a differing
    // surface form that the constant embedder merges through L3 twice — the
    // second one is the duplicate `(entity_id, alias)` probe.
    const variant = output({ head: "Alicia Smith" });
    const code = await runExtraction(
      [
        { kind: "ok", outputs: [output()] },
        { kind: "ok", outputs: [variant] },
        { kind: "ok", outputs: [variant] },
      ],
      new ConstantEmbedder(DIM)
    );
    expect(code).toBe(0);

    // The L3 merge means no second person row was created.
    const people = await c.query<{ canonical_name: string }>(
      `SELECT canonical_name FROM entities WHERE type = 'person'`
    );
    expect(people.rows.map((r) => r.canonical_name)).toEqual(["Alice Smith"]);

    const aliases = await c.query<{ alias: string; alias_type: string }>(
      `SELECT a.alias, a.alias_type FROM entity_aliases a
         JOIN entities e ON e.id = a.entity_id
        WHERE e.canonical_name = 'Alice Smith'
        ORDER BY a.alias`
    );
    expect(aliases.rows).toEqual([
      { alias: "Alice Smith", alias_type: "name" },
      { alias: "Alicia Smith", alias_type: "variant" },
    ]);
  });
});
