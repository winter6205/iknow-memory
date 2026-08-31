/**
 * bm25-pg: real-Postgres integration tests for the BM25 lexical arm (#65).
 *
 * Covers the storage half of the hybrid retrieve contract:
 *   SC5  a query that is a poor semantic neighbour but shares a
 *        distinctive token still retrieves the chunk
 *   SC6  `content_tsv` is maintained on upsert, and `ensureTable`
 *        backfills a `chunks` table that predates the column — no manual
 *        DBA step beyond starting the backend
 *   plus the lexical arm honouring valid_window / filters / limit, an
 *   empty query matching nothing, and the GIN index actually being used
 *   (retrieve must not full-scan to build the index).
 *
 * Schema isolation follows tests/integration/retrieval-pg.test.ts: a
 * unique SCHEMA reached through `search_path` libpq options, dropped on
 * teardown, so this file cannot race a parallel Postgres worker.
 *
 * Per docs/.claude/rules/test.md: when Postgres is unreachable the suite
 * SKIPS LOUDLY with the documented Validation block, never silently passes.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { PgvectorBackend } from "../../src/core/storage/pgvector-backend.js";
import { supportsLexicalSearch } from "../../src/core/storage/backend.js";
import { FakeEmbedder } from "../../src/core/embedder.js";
import type { ChunkRecord } from "../../src/core/types.js";
import { createPgIntegrationHarness } from "./pg-test-harness.js";

const DIM = 32;
const pgHarness = await createPgIntegrationHarness({
  label: "bm25-pg",
  testPath: "tests/integration/bm25-pg.test.ts",
  expectedCommand: "npx vitest run tests/integration/bm25-pg.test.ts",
  schemaPrefix: "bm25_pg",
  defaultConnectionString: "postgresql://postgres@localhost:5432/postgres",
  requiresVector: true,
});
const {
  connectionString: DB_URL,
  schema: SCHEMA,
  schemaConnectionString: SCHEMA_URL,
  describePg,
} = pgHarness;

const embedder = new FakeEmbedder(DIM);

const NOW = new Date();
const NOW_ISO = NOW.toISOString();
const PAST_START = new Date(NOW.getTime() - 2 * 365 * 864e5).toISOString();
const PAST_END = new Date(NOW.getTime() - 365 * 864e5).toISOString();
const COVER_START = new Date(NOW.getTime() - 864e5).toISOString();

/**
 * A token that appears in no other fixture text and carries no semantic
 * neighbourhood for FakeEmbedder — the whole point of SC5 is that lexical
 * matching finds it where vector similarity would not.
 */
const RARE_TOKEN = "zubrowka";

async function chunk(
  content: string,
  over: {
    sourceRef?: string;
    validFrom?: string;
    validUntil?: string | null;
    metadata?: Record<string, unknown>;
  } = {}
): Promise<ChunkRecord> {
  const [embedding] = await embedder.embed([content]);
  return {
    id: randomUUID(),
    content,
    embedding: embedding!,
    source_ref: over.sourceRef ?? "bm25/fixture",
    metadata: over.metadata ?? {},
    valid_from: over.validFrom ?? COVER_START,
    valid_until: over.validUntil ?? null,
    created_at: NOW_ISO,
  };
}

describePg("bm25-pg: Postgres lexical arm (#65)", () => {
  let client: pg.Client | undefined;
  let backend: PgvectorBackend | undefined;

  beforeAll(async () => {
    client = pgHarness.createClient(SCHEMA_URL);
    await client.connect();
    await pgHarness.resetSchema(client);
    await client.query(`SET search_path TO "${SCHEMA}", public`);
    backend = new PgvectorBackend(SCHEMA_URL, DIM, 2000);
  });

  afterAll(async () => {
    if (backend) await backend.close();
    if (client) {
      await pgHarness.dropSchema(client);
      await client.end();
    }
  });

  it("exposes the lexical seam", () => {
    expect(supportsLexicalSearch(backend!)).toBe(true);
  });

  it("SC6: ensureTable creates content_tsv with a GIN index over the simple config", async () => {
    const c = client!;
    // Upserting is what forces lazy init, so the DDL below has run by the
    // time we inspect the catalog.
    await backend!.upsert([await chunk("bootstrap the schema")]);

    const column = await c.query<{ generated: string; type: string }>(
      `SELECT is_generated AS generated, udt_name AS type
         FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'chunks'
          AND column_name = 'content_tsv'`,
      [SCHEMA]
    );
    expect(column.rows[0]?.type).toBe("tsvector");
    expect(column.rows[0]?.generated).toBe("ALWAYS");

    const index = await c.query<{ def: string }>(
      `SELECT indexdef AS def FROM pg_indexes
        WHERE schemaname = $1 AND tablename = 'chunks'
          AND indexdef ILIKE '%content_tsv%'`,
      [SCHEMA]
    );
    expect(index.rows).toHaveLength(1);
    expect(index.rows[0]?.def).toMatch(/USING gin/i);
    // `simple` deliberately, not `english`: no stemmer lock-in, and no
    // language assumption baked into stored data.
    const generation = await c.query<{ expr: string }>(
      `SELECT generation_expression AS expr FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'chunks'
          AND column_name = 'content_tsv'`,
      [SCHEMA]
    );
    expect(generation.rows[0]?.expr).toContain("simple");
  });

  it("SC6: upsert maintains content_tsv without the caller doing anything", async () => {
    const c = client!;
    const fresh = await chunk(`the ${RARE_TOKEN} protocol governs billing`);
    await backend!.upsert([fresh]);

    const row = await c.query<{ tsv: string }>(
      `SELECT content_tsv::text AS tsv FROM chunks WHERE id = $1`,
      [fresh.id]
    );
    expect(row.rows[0]?.tsv).toBeTruthy();
    expect(row.rows[0]?.tsv).toContain(RARE_TOKEN);

    // Re-upserting the same id must refresh the vector, not strand the
    // old text in the index.
    await backend!.upsert([{ ...fresh, content: "entirely different words" }]);
    const updated = await c.query<{ tsv: string }>(
      `SELECT content_tsv::text AS tsv FROM chunks WHERE id = $1`,
      [fresh.id]
    );
    expect(updated.rows[0]?.tsv).not.toContain(RARE_TOKEN);
    expect(updated.rows[0]?.tsv).toContain("entirely");
  });

  it("SC5: a lexically-matching query retrieves a chunk vector search would miss", async () => {
    const target = await chunk(
      `Incident review: the ${RARE_TOKEN} subsystem paged twice overnight.`
    );
    const distractors = await Promise.all([
      chunk("Quarterly revenue grew across every product line."),
      chunk("The onboarding guide explains how to request laptop access."),
      chunk("Weather delayed the datacentre migration by a week."),
    ]);
    await backend!.upsert([target, ...distractors]);

    const hits = await backend!.searchLexical(
      `what happened with ${RARE_TOKEN} last night`,
      { limit: 5, validAt: NOW_ISO }
    );
    expect(hits.map((h) => h.id)).toContain(target.id);
    expect(hits[0]?.id).toBe(target.id);
    expect(hits[0]?.score).toBeGreaterThan(0);
    expect(hits[0]?.content).toContain(RARE_TOKEN);
    expect(hits[0]?.valid_window[0]).toBeTruthy();
  });

  it("matches on any query term rather than requiring all of them", async () => {
    // AND semantics would drop this: only one word of the query appears
    // in the chunk, which is the normal case for a natural-language query
    // against a short chunk.
    const hits = await backend!.searchLexical(
      `${RARE_TOKEN} kubernetes migration retrospective`,
      { limit: 5, validAt: NOW_ISO }
    );
    expect(hits.length).toBeGreaterThan(0);
  });

  it("returns [] for a query with no lexemes instead of matching everything", async () => {
    expect(
      await backend!.searchLexical("   ", { limit: 10, validAt: NOW_ISO })
    ).toEqual([]);
    expect(
      await backend!.searchLexical("", { limit: 10, validAt: NOW_ISO })
    ).toEqual([]);
  });

  it("returns [] when no chunk shares a token with the query", async () => {
    expect(
      await backend!.searchLexical("xyzzyplughplover", {
        limit: 10,
        validAt: NOW_ISO,
      })
    ).toEqual([]);
  });

  it("honours the valid_window filter", async () => {
    const expired = await chunk(`archived ${RARE_TOKEN} runbook`, {
      validFrom: PAST_START,
      validUntil: PAST_END,
    });
    await backend!.upsert([expired]);

    const now = await backend!.searchLexical(RARE_TOKEN, {
      limit: 10,
      validAt: NOW_ISO,
    });
    expect(now.map((h) => h.id)).not.toContain(expired.id);

    const backThen = await backend!.searchLexical(RARE_TOKEN, {
      limit: 10,
      validAt: new Date(NOW.getTime() - 400 * 864e5).toISOString(),
    });
    expect(backThen.map((h) => h.id)).toContain(expired.id);
  });

  it("honours source_ref and metadata exact-match filters", async () => {
    const tagged = await chunk(`${RARE_TOKEN} appears in the tagged chunk`, {
      sourceRef: "bm25/tagged",
      metadata: { team: "platform" },
    });
    await backend!.upsert([tagged]);

    const bySource = await backend!.searchLexical(RARE_TOKEN, {
      limit: 10,
      validAt: NOW_ISO,
      filters: { source_ref: "bm25/tagged" },
    });
    expect(bySource.map((h) => h.id)).toEqual([tagged.id]);

    const byMetadata = await backend!.searchLexical(RARE_TOKEN, {
      limit: 10,
      validAt: NOW_ISO,
      filters: { "metadata.team": "platform" },
    });
    expect(byMetadata.map((h) => h.id)).toEqual([tagged.id]);

    const missing = await backend!.searchLexical(RARE_TOKEN, {
      limit: 10,
      validAt: NOW_ISO,
      filters: { source_ref: "bm25/no-such-source" },
    });
    expect(missing).toEqual([]);
  });

  it("truncates to the requested limit", async () => {
    await backend!.upsert(
      await Promise.all([
        chunk(`${RARE_TOKEN} one`),
        chunk(`${RARE_TOKEN} two`),
        chunk(`${RARE_TOKEN} three`),
      ])
    );
    const hits = await backend!.searchLexical(RARE_TOKEN, {
      limit: 2,
      validAt: NOW_ISO,
    });
    expect(hits).toHaveLength(2);
  });

  it("reads the GIN index instead of re-tokenizing the table at query time", async () => {
    const c = client!;
    // Small fixture tables make a sequential scan genuinely cheaper, so
    // the planner would pick one regardless of the index. Disabling it
    // asks the narrower question this criterion cares about: is there an
    // index the lexical predicate CAN use?
    await c.query("SET enable_seqscan = off");
    try {
      const plan = await c.query<{ "QUERY PLAN": string }>(
        `EXPLAIN SELECT id FROM chunks
          WHERE content_tsv @@ plainto_tsquery('simple', $1)`,
        [RARE_TOKEN]
      );
      const text = plan.rows.map((r) => r["QUERY PLAN"]).join("\n");
      expect(text).toMatch(/Bitmap Index Scan on chunks_content_tsv/i);
      expect(text).not.toMatch(/to_tsvector/);
    } finally {
      await c.query("SET enable_seqscan = on");
    }
  });

  it("SC6: ensureTable backfills a chunks table that predates content_tsv", async () => {
    // A separate schema standing in for an existing deployment: the table
    // is created the way the pre-BM25 backend created it, rows are
    // written, and only then does a new backend start up.
    const legacySchema = `${SCHEMA}_legacy`;
    const legacyUrl =
      DB_URL +
      (DB_URL.includes("?") ? "&" : "?") +
      `options=-c%20search_path%3D${legacySchema},public`;
    const c = pgHarness.createClient(legacyUrl);
    await c.connect();
    let legacyBackend: PgvectorBackend | undefined;
    try {
      await c.query(`DROP SCHEMA IF EXISTS "${legacySchema}" CASCADE`);
      await c.query(`CREATE SCHEMA "${legacySchema}"`);
      await c.query(`SET search_path TO "${legacySchema}", public`);
      await c.query("CREATE EXTENSION IF NOT EXISTS vector");
      await c.query(`
        CREATE TABLE chunks (
          id uuid PRIMARY KEY,
          content text NOT NULL,
          embedding vector(${DIM}) NOT NULL,
          valid_from timestamptz NOT NULL,
          valid_until timestamptz NULL,
          source_ref text NOT NULL,
          metadata jsonb NOT NULL,
          created_at timestamptz NOT NULL
        )
      `);
      const legacyRow = await chunk(
        `legacy row mentioning ${RARE_TOKEN} before the column existed`
      );
      const [vec] = await embedder.embed([legacyRow.content]);
      await c.query(
        `INSERT INTO chunks (id, content, embedding, valid_from, valid_until,
                             source_ref, metadata, created_at)
         VALUES ($1, $2, $3::vector, $4, NULL, $5, '{}'::jsonb, now())`,
        [
          legacyRow.id,
          legacyRow.content,
          `[${vec!.join(",")}]`,
          COVER_START,
          legacyRow.source_ref,
        ]
      );

      legacyBackend = new PgvectorBackend(legacyUrl, DIM, 2000);
      // Starting the backend is the only migration step an operator runs.
      const hits = await legacyBackend.searchLexical(RARE_TOKEN, {
        limit: 10,
        validAt: NOW_ISO,
      });
      expect(hits.map((h) => h.id)).toEqual([legacyRow.id]);
    } finally {
      if (legacyBackend) await legacyBackend.close();
      await c.query(`DROP SCHEMA IF EXISTS "${legacySchema}" CASCADE`);
      await c.end();
    }
  });
});
