/**
 * neo4j-ppr-arm: the graph arm end to end against a real Postgres AND a real
 * Neo4j (specs/neo4j-graph-arm.md SC5 — "retrieve with graph enabled includes
 * graph-arm contribution into RRF (observable via debug/arm hits or ranking
 * change vs graph-disabled). Loud-skip without Neo4j").
 *
 * Nothing is faked below the query embedding: the ledger rows go into
 * Postgres, the projection CLI copies them into Neo4j, GDS runs the
 * Personalized PageRank, and the chunks come back through
 * `triples.source_chunk_id`. That is the whole T4 path.
 *
 * The fixture is built so the graph's contribution is unmistakable:
 *
 *   ledger      alice --works_for--> acme --makes--> widget
 *   provenance  t1 -> c-alice          t2 -> c-widget
 *   embeddings  c-alice cos 1.0 > c-mid cos 0.9 > c-widget cos 0.8
 *
 * The query embedding is nearest to `alice`, so the vector arm ranks
 * c-widget LAST and the seed query finds `alice` alone. Only a multi-hop
 * traversal reaches `widget`, and only its provenance link brings c-widget
 * back — so with the arm on, c-widget must overtake c-mid. With the arm off
 * the same call must leave the plain vector order alone. That difference is
 * the criterion.
 *
 * To run it:
 *   docker run -d --rm -p 7687:7687 -e NEO4J_AUTH=none neo4j:5   # with GDS
 *   GRAPHRAG_MEMORY_EMBED_DIMENSIONS=8 \
 *     GRAPHRAG_MEMORY_NEO4J_URI=bolt://localhost:7687 \
 *     npx vitest run tests/integration/neo4j-ppr-arm.test.ts
 */
import { randomUUID } from "node:crypto";
import neo4j, { type Driver } from "neo4j-driver";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  runCli as runBackfillCli,
  type BackfillDeps,
  type BackfillPool,
} from "../../src/cli/graph-backfill.js";
import { NEO4J_URI_VAR, loadEnv, type Neo4jConfig } from "../../src/config.js";
import { connectNeo4j } from "../../src/core/graph/neo4j-writer.js";
import { createNeo4jPprRanker } from "../../src/core/graph/neo4j-ppr.js";
import { assembleRetrievalResult } from "../../src/core/retrieval/index.js";
import type { RetrieveConfig } from "../../src/core/retrieval/types.js";
import { PgvectorBackend } from "../../src/core/storage/pgvector-backend.js";
import type { EmbeddingClient } from "../../src/core/embedder.js";

const DIM = 8;
const BASE_DB_URL =
  process.env["GRAPHRAG_MEMORY_DB_URL"] ??
  "postgresql://postgres@localhost:5432/postgres";
const SCHEMA = `neo4j_ppr_${randomUUID().slice(0, 8).replace(/-/g, "")}`;
const SCHEMA_URL =
  BASE_DB_URL +
  (BASE_DB_URL.includes("?") ? "&" : "?") +
  `options=-c%20search_path%3D${SCHEMA},public`;

/**
 * Production weights, one seed. `entityLinkTopK: 1` pins the anchor to
 * `alice` so the traversal — not the seed query — is what reaches `widget`.
 * BM25 is off so the fused order is pure vector + graph arithmetic; the
 * three-arm case below turns it back on.
 */
const CFG: RetrieveConfig = {
  w_vec: 0.7,
  w_bm25: 0.15,
  w_graph: 0.15,
  bm25Enabled: false,
  graphEnabled: true,
  rerankEnabled: false,
  entityLinkTopK: 1,
  candidateCap: 50,
  graphArmFloor: 3,
};

/** Query vector, and the chunk/entity vectors laid out around it. */
const QUERY_VECTOR = unit([1, 0, 0, 0, 0, 0, 0, 0]);

function unit(v: number[]): number[] {
  const norm = Math.hypot(...v);
  return v.map((x) => x / norm);
}

function vecLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}

/** Every query embeds to the same vector — the arms are what differ here. */
const embedder: EmbeddingClient = {
  embed: async (texts: string[]) => texts.map(() => QUERY_VECTOR),
};

const ALICE = randomUUID();
const ACME = randomUUID();
const WIDGET = randomUUID();
const C_ALICE = randomUUID();
const C_MID = randomUUID();
const C_WIDGET = randomUUID();
const T1 = randomUUID();
const T2 = randomUUID();

function silentLogger() {
  return {
    level: "error" as const,
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

function skipLoudly(reason: string): void {
  console.warn(`\n[neo4j-ppr-arm] ${reason}\n`);
  console.warn(
    "Validation:\n" +
      "- Not run: tests/integration/neo4j-ppr-arm.test.ts\n" +
      `- Expected command: GRAPHRAG_MEMORY_EMBED_DIMENSIONS=8 ${NEO4J_URI_VAR}=bolt://localhost:7687 npx vitest run tests/integration/neo4j-ppr-arm.test.ts\n` +
      `- Blocking issue: ${reason}\n`
  );
}

let SETTINGS: Neo4jConfig | undefined;
let READY = false;
try {
  SETTINGS = loadEnv().neo4j;
  if (SETTINGS === undefined) {
    skipLoudly(`${NEO4J_URI_VAR} is not set — no graph to rank`);
  } else {
    const probe = probeDriver(SETTINGS);
    await probe.verifyConnectivity();
    await probe.close();
    const pgProbe = new pg.Client({ connectionString: BASE_DB_URL });
    await pgProbe.connect();
    await pgProbe.end();
    READY = true;
  }
} catch (err) {
  skipLoudly(
    SETTINGS === undefined
      ? `the environment does not load: ${(err as Error).message}`
      : `cannot reach Neo4j at ${SETTINGS.uri} or Postgres at ${BASE_DB_URL}: ${(err as Error).message}`
  );
}
const describeGraph = READY ? describe : describe.skip;

function probeDriver(settings: Neo4jConfig): Driver {
  const auth =
    settings.user !== undefined && settings.password !== undefined
      ? neo4j.auth.basic(settings.user, settings.password)
      : undefined;
  return neo4j.driver(settings.uri, auth);
}

describeGraph(
  "neo4j-ppr-arm: graph recall over a live projection (SC5)",
  () => {
    let client: pg.Client;
    let backend: PgvectorBackend;
    let ranker: ReturnType<typeof createNeo4jPprRanker>;

    beforeAll(async () => {
      client = new pg.Client({ connectionString: BASE_DB_URL });
      await client.connect();
      await client.query("CREATE EXTENSION IF NOT EXISTS vector");
      await client.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
      await client.query(`CREATE SCHEMA "${SCHEMA}"`);
      await client.query(`SET search_path TO "${SCHEMA}", public`);

      // The backend owns the DDL (chunks + P0 tables); one search call is
      // enough to trigger its lazy bootstrap inside our schema.
      backend = new PgvectorBackend(SCHEMA_URL, DIM);
      await backend.search(QUERY_VECTOR, {
        limit: 1,
        validAt: new Date().toISOString(),
      });

      await seedLedger();
      expect(await backfill()).toBe(0);
      ranker = createNeo4jPprRanker(SETTINGS!);
    });

    afterAll(async () => {
      await ranker?.close();
      await backend?.close();
      await dropProjectedEntities();
      await client.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
      await client.end();
    });

    /** Chunks, entities and the two triples that link them. */
    async function seedLedger(): Promise<void> {
      const chunks: Array<[string, string, number[]]> = [
        [
          C_ALICE,
          "alice runs the billing rotation",
          unit([1, 0, 0, 0, 0, 0, 0, 0]),
        ],
        [
          C_MID,
          "an unrelated middling note",
          unit([0.9, 0.4359, 0, 0, 0, 0, 0, 0]),
        ],
        [
          C_WIDGET,
          "widget release checklist",
          unit([0.8, 0.6, 0, 0, 0, 0, 0, 0]),
        ],
      ];
      for (const [id, content, vector] of chunks) {
        await client.query(
          `INSERT INTO chunks (id, content, embedding, valid_from, valid_until,
                             source_ref, metadata, created_at)
         VALUES ($1, $2, $3::vector, now() - interval '1 day', NULL,
                 $4, '{}', now())`,
          [id, content, vecLiteral(vector), `src/${id}`]
        );
      }

      const entities: Array<[string, string, string, number[]]> = [
        [ALICE, "Alice Smith", "person", unit([1, 0, 0, 0, 0, 0, 0, 0])],
        [ACME, "Acme Corp", "system", unit([0, 1, 0, 0, 0, 0, 0, 0])],
        [WIDGET, "Widget", "concept", unit([0, 0, 1, 0, 0, 0, 0, 0])],
      ];
      for (const [id, name, type, vector] of entities) {
        await client.query(
          `INSERT INTO entities (id, canonical_name, type, embedding)
         VALUES ($1, $2, $3, $4::vector)`,
          [id, name, type, vecLiteral(vector)]
        );
      }

      const triples: Array<[string, string, string, string, string]> = [
        [T1, ALICE, ACME, "works_for", C_ALICE],
        [T2, ACME, WIDGET, "makes", C_WIDGET],
      ];
      for (const [id, head, tail, relation, chunkId] of triples) {
        await client.query(
          `INSERT INTO triples (id, head_id, tail_id, relation_raw, relation_norm,
                              confidence, source_chunk_id, valid_window)
         VALUES ($1, $2, $3, $4, $4, 0.9, $5,
                 tstzrange(now() - interval '1 day', NULL, '[)'))`,
          [id, head, tail, relation, chunkId]
        );
      }
    }

    /** Project the ledger into Neo4j with the real T2 CLI. */
    async function backfill(): Promise<number> {
      const pool = new pg.Pool({ connectionString: SCHEMA_URL });
      const deps: BackfillDeps = {
        pool: pool as unknown as BackfillPool,
        logger: silentLogger(),
        connectGraph: () => connectNeo4j(SETTINGS!),
      };
      try {
        return await runBackfillCli([], deps);
      } finally {
        await pool.end();
      }
    }

    /** Remove only this run's nodes; the database may hold other fixtures. */
    async function dropProjectedEntities(): Promise<void> {
      const driver = probeDriver(SETTINGS!);
      const session = driver.session();
      try {
        await session.executeWrite((tx) =>
          tx.run(`MATCH (e:Entity) WHERE e.id IN $ids DETACH DELETE e`, {
            ids: [ALICE, ACME, WIDGET],
          })
        );
      } finally {
        await session.close();
        await driver.close();
      }
    }

    async function retrieve(
      config: RetrieveConfig,
      over: { ranker?: { rankEntities: never } } = {}
    ) {
      return assembleRetrievalResult(
        {
          query: "who ships the widget",
          validAt: new Date().toISOString(),
          limit: 10,
        },
        {
          embedder,
          storage: backend,
          retrieveConfig: config,
          graphRanker: over.ranker ?? ranker,
          debug: true,
        }
      );
    }

    it("reorders the fused list versus the same call with the arm disabled", async () => {
      const off = await retrieve({ ...CFG, graphEnabled: false });
      // Plain cosine order: the graph-linked chunk is last, and the arm was
      // never attempted, so nothing reports on it.
      expect(off.chunks.map((c) => c.id)).toEqual([C_ALICE, C_MID, C_WIDGET]);
      expect(Object.hasOwn(off, "degraded")).toBe(false);
      expect(Object.hasOwn(off.debug ?? {}, "graphHits")).toBe(false);

      const on = await retrieve(CFG);
      // PPR reached `widget` two hops from the only seed. Graph priority
      // puts both graph-mapped chunks in front, and the chunk the vector
      // arm liked better fills the one slot they leave.
      expect(
        on.chunks
          .slice(0, 2)
          .map((c) => c.id)
          .sort()
      ).toEqual([C_ALICE, C_WIDGET].sort());
      expect(on.chunks[2]?.id).toBe(C_MID);
      expect(on.debug?.graphHits).toBe(2);
      expect(Object.hasOwn(on, "degraded")).toBe(false);
    });

    it("reaches a chunk through a two-hop path the seed never named", async () => {
      const on = await retrieve(CFG);
      const widget = on.chunks.find((c) => c.id === C_WIDGET)!;
      const mid = on.chunks.find((c) => c.id === C_MID)!;
      // c-widget leads on the graph segment; c-mid only reaches the list
      // as remainder fill, at its plain vector RRF score w_vec/(k+2).
      expect(widget.score).toBeGreaterThan(mid.score);
      expect(mid.score).toBeCloseTo(0.7 / 62, 12);
    });

    it("runs all three production arms together on the default weights", async () => {
      const on = await retrieve({ ...CFG, bm25Enabled: true });
      expect(on.debug?.vectorHits).toBe(3);
      expect(on.debug?.bm25Hits).toBeGreaterThanOrEqual(0);
      expect(on.debug?.graphHits).toBe(2);
      expect(Object.hasOwn(on, "degraded")).toBe(false);
    });

    it("fails open with degraded: true when the configured sidecar is down (SC8)", async () => {
      // Configured (a URI exists) but unreachable — the other half of SC7's
      // rule, proven against the real driver rather than a thrown fake.
      const dead = createNeo4jPprRanker({
        uri: "bolt://127.0.0.1:7699",
        user: undefined,
        password: undefined,
      });
      try {
        const out = await retrieve(CFG, {
          ranker: dead as unknown as { rankEntities: never },
        });
        expect(out.degraded).toBe(true);
        expect(out.chunks.map((c) => c.id)).toEqual([C_ALICE, C_MID, C_WIDGET]);
        expect(out.debug?.graphFailureReason).toContain("7699");
      } finally {
        await dead.close();
      }
    });
  }
);
