/**
 * retrieve-search-mode-pg: SC9 LIVE evidence for the `filters.search_mode`
 * wire (specs/search-mode-lexical-sql-tokens.md SC9 — "a real round trip
 * against a booted server on real PG + ES … proves over the wire that
 * `lexical` reaches the child→parent 抽图窗 arm and returns the PARENT body,
 * that `sql` returns the thrown `real_db_not_wired` message naming `sql`,
 * that a missing key is answered by `graph`").
 *
 * Hermetic green cannot close a wire-contract change, so this file is the
 * server-side mirror of `tests/retrieval/search-mode.test.ts` and
 * `tests/defensive/search-mode-defensive.test.ts`: every call goes through
 * the SAME handler the MCP server registers (`createRetrieveHandler`, wired
 * by the production `buildRetrieveDeps`, so the ES precision layer reaches
 * the arms through the real `lexicalAdapterFromPrecision` shape) against a
 * real Postgres ledger and a real Elasticsearch cluster. Nothing below the
 * query embedding is faked; the query embedder is a fixed-vector client
 * because the 档 routing, not the embedding model, is what SC9 names.
 *
 * Gating follows the two conventions this repo already documents:
 *   - Postgres: `createPgIntegrationHarness` (unique throwaway schema,
 *     loud-skip locally, hard failure when `CI=true`).
 *   - Elasticsearch: the shared `tests/integration/es-test-harness.ts`
 *     probe (the one `bm25-pg.test.ts` consumes too) — a GET against
 *     `GRAPHRAG_MEMORY_ES_URL` / `GRAPHRAG_MEMORY_NODE`, the project
 *     `Validation:` block on a miss, and a throw in CI so a missing service
 *     can never exit 0 through `describe.skip`.
 * A skip is therefore always *named* (which dependency was unreachable and
 * the exact command to re-run), never a silent green.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  DEFAULT_ELASTICSEARCH_REQUEST_TIMEOUT_MS,
  ELASTICSEARCH_NODE_VAR,
  ELASTICSEARCH_URL_VAR,
} from "../../src/config.js";
import { buildRetrieveDeps } from "../../src/index.js";
import { assembleRetrievalResult } from "../../src/core/retrieval/index.js";
import { modeAParentWindowArm } from "../../src/core/retrieval/mode-a-arm.js";
import {
  INVALID_SEARCH_MODE_REASON,
  REAL_DB_NOT_WIRED_REASON,
  SEARCH_MODE_ARMS,
  SEARCH_MODE_WIRE_COPY,
  SEARCH_MODES,
} from "../../src/core/retrieval/search-mode.js";
import type { RetrieveConfig } from "../../src/core/retrieval/types.js";
import { GraphragError } from "../../src/core/errors.js";
import type { EmbeddingClient } from "../../src/core/embedder.js";
import { ElasticsearchPrecisionLayer } from "../../src/core/storage/elasticsearch-precision.js";
import { PgvectorBackend } from "../../src/core/storage/pgvector-backend.js";
import type { ChunkRecord, SourceDocRecord } from "../../src/core/types.js";
import { createRetrieveHandler } from "../../src/tools/retrieve.js";
import type { ToolResult } from "../../src/tools/registry.js";
import { createPgIntegrationHarness } from "./pg-test-harness.js";
import { probeElasticsearch } from "./es-test-harness.js";

const TEST_PATH = "tests/integration/retrieve-search-mode-pg.test.ts";
const EXPECTED_COMMAND = `npx vitest run ${TEST_PATH}`;
const DEFAULT_ES_URL = "http://localhost:9200";
/** Test-only indices: never the operator's `iknow-memory-chunks` corpus. */
const CHUNK_INDEX = "iknow-memory-test-search-mode-chunks";
const ENTITY_INDEX = "iknow-memory-test-search-mode-entities";

const DIM = 8;

// ---------------------------------------------------------------------------
// Environment gate (Postgres + Elasticsearch both required)
// ---------------------------------------------------------------------------

const pgHarness = await createPgIntegrationHarness({
  label: "retrieve-search-mode-pg",
  testPath: TEST_PATH,
  expectedCommand: EXPECTED_COMMAND,
  schemaPrefix: "retrieve_search_mode",
  defaultConnectionString: "postgresql://postgres@localhost:5432/postgres",
  requiresVector: true,
});
const {
  schemaConnectionString: SCHEMA_URL,
  createClient,
  resetSchema,
  dropSchema,
  describePg,
} = pgHarness;

const ES_URL =
  process.env[ELASTICSEARCH_URL_VAR] ??
  process.env[ELASTICSEARCH_NODE_VAR] ??
  DEFAULT_ES_URL;
const esProbe = await probeElasticsearch(ES_URL);
if (!esProbe.available) {
  const safeError =
    esProbe.error instanceof Error
      ? esProbe.error.message
      : String(esProbe.error);
  console.warn(
    `\n[retrieve-search-mode-pg] Elasticsearch unavailable at ${esProbe.url}: ${safeError}\n`
  );
  console.warn(
    "Validation:\n" +
      `- Not run: ${TEST_PATH}\n` +
      `- Expected command: ${EXPECTED_COMMAND}\n` +
      `- Blocking issue: cannot connect to Elasticsearch at ${esProbe.url}\n` +
      `- Set ${ELASTICSEARCH_URL_VAR} (or ${ELASTICSEARCH_NODE_VAR}) to a reachable ` +
      `Elasticsearch 8.x endpoint with the analysis-ik plugin installed; ` +
      `Postgres readiness is reported by the retrieve-search-mode-pg harness line above.\n`
  );
  if (process.env.CI === "true") {
    throw new Error(
      `Elasticsearch unreachable at ${esProbe.url} in CI; loud-skip is local-only`
    );
  }
}

/**
 * Both services must answer: the `lexical` 档 needs ES for its child ranking
 * and Postgres for the parent 抽图窗 row, so a half-live fixture would prove
 * nothing about the arm. `describePg` is already `describe.skip` (with its own
 * named Validation block printed) when Postgres was unreachable.
 */
const describeLive =
  esProbe.available && describePg === describe ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const NOW = new Date();
const VALID_FROM = new Date(NOW.getTime() - 86_400_000).toISOString();
const CREATED_AT = VALID_FROM;

/** One distinct English token per corpus slice: IK keeps it as one term. */
const LEXICAL_QUERY = "quantumwindow";
const PARENT_BODY =
  "PARENT WINDOW BODY: the quantumwindow extract window that holds the citable body and its wider context.";
const CHILD_ZERO = "quantumwindow child slice zero";
const CHILD_ONE = "quantumwindow child slice one";

const SOURCE_DOC: SourceDocRecord = {
  id: randomUUID(),
  source_ref: `live-search-mode/${randomUUID()}`,
  title: null,
  content: PARENT_BODY,
  created_at: CREATED_AT,
};
const CHILD_IDS = [randomUUID(), randomUUID()] as const;

/**
 * Fixed query vector, so the `graph` 档's real-Postgres cosine ordering is
 * pinned by the fixture instead of by a hash: child zero is the nearest, the
 * others orthogonal. Only the query side is deterministic — the recall arms
 * themselves run against live PG and ES.
 */
function unit(axis: number): number[] {
  return new Array<number>(DIM).fill(0).map((_, i) => (i === axis ? 1 : 0));
}

const QUERY_VECTOR = unit(0);
const embedder: EmbeddingClient = {
  available: true,
  embed: async (texts: string[]) => texts.map(() => QUERY_VECTOR),
};

/**
 * Production-shaped retrieval config: only the vector arm runs, so the
 * `graph` default path is observable as pure ledger recall and the
 * parent/child contrast below is attributed to the 档 switch alone.
 */
const CFG: RetrieveConfig = {
  preset: "balanced",
  w_vec: 1,
  w_bm25: 1,
  w_graph: 1,
  bm25Enabled: false,
  graphEnabled: false,
  rerankEnabled: false,
  // The live ES entity index of this suite is empty by design; leaving the
  // optional arms on would report a capability that the fixture never wrote.
  nodeEmbeddingEnabled: false,
  communitySummaryEnabled: false,
  entityLinkTopK: 8,
  candidateCap: 50,
  neighborWidth: 0,
  graphArmFloor: 3,
};

interface ParentWindowMeta {
  kind: "parent-window";
  sourceDocId: string;
  children: Array<{ chunkId: string; ordinal: number | null; score: number }>;
}

interface WireBody {
  chunks: Array<{
    id: string;
    content: string;
    source_ref: string;
    valid_window: [string, string | null];
    score: number;
    metadata?: unknown;
  }>;
  degraded?: boolean;
  degraded_reasons?: string[];
}

function parseBody(result: ToolResult): WireBody {
  const part = result.content[0];
  if (part === undefined || part.type !== "text") {
    throw new Error("expected text content in ToolResult");
  }
  return JSON.parse(part.text) as WireBody;
}

function childRecord(ordinal: number, content: string): ChunkRecord {
  return {
    id: CHILD_IDS[ordinal],
    content,
    embedding: unit(ordinal),
    source_ref: SOURCE_DOC.source_ref,
    metadata: {},
    valid_from: VALID_FROM,
    valid_until: null,
    created_at: CREATED_AT,
    source_doc_id: SOURCE_DOC.id,
    ordinal,
  };
}

describeLive(
  "retrieve search_mode over live Postgres + Elasticsearch (SC9)",
  () => {
    let backend: PgvectorBackend | undefined;
    let esLayer: ElasticsearchPrecisionLayer | undefined;
    let admin: ReturnType<typeof createClient> | undefined;

    beforeAll(async () => {
      admin = createClient(SCHEMA_URL);
      await admin.connect();
      await resetSchema(admin);
      backend = new PgvectorBackend(SCHEMA_URL, DIM, {
        annMaxDimensions: 2000,
      });
      await backend.initialize();
      // The 资料 row first: the chunks back-pointer column has a real FK, and
      // the parent body is what the arm must cite.
      await backend.upsertSourceDoc(SOURCE_DOC);
      await backend.upsert([
        childRecord(0, CHILD_ZERO),
        childRecord(1, CHILD_ONE),
      ]);

      esLayer = new ElasticsearchPrecisionLayer({
        node: ES_URL,
        // The local test cluster runs without auth; the fields stay explicit so
        // the config object is the same shape loadEnv() hands the server.
        username: undefined,
        password: undefined,
        apiKey: undefined,
        chunkIndex: CHUNK_INDEX,
        entityIndex: ENTITY_INDEX,
        requestTimeoutMs: DEFAULT_ELASTICSEARCH_REQUEST_TIMEOUT_MS,
      });
      await esLayer.deleteChunkIndex();
      await esLayer.deleteEntityIndex();
      // Derived index carries the CHILD text only — parent-blind by design
      // (ADR-0060), which is what makes the parent body a Postgres read and
      // not an ES echo.
      await esLayer.indexChunks([
        childRecord(0, CHILD_ZERO),
        childRecord(1, CHILD_ONE),
      ]);
    }, 60_000);

    afterAll(async () => {
      if (esLayer !== undefined) {
        try {
          await esLayer.deleteChunkIndex();
          await esLayer.deleteEntityIndex();
        } finally {
          await esLayer.close();
        }
      }
      if (backend !== undefined) await backend.close();
      if (admin !== undefined) {
        await dropSchema(admin);
        await admin.end();
      }
    });

    /** The production deps builder, so no seam is hand-stubbed here. */
    function handlerFor(): ReturnType<typeof createRetrieveHandler> {
      // `buildRetrieveDeps` is what `createServer` calls, so the lexical seam
      // arrives through the same precision-layer adapter as in production.
      const deps = buildRetrieveDeps(
        {
          embedder,
          storage: backend!,
          ...(esLayer !== undefined ? { precision: esLayer } : {}),
          retrieval: CFG,
        },
        false
      );
      return createRetrieveHandler(deps);
    }

    it("search_mode=lexical cites the parent 抽图窗 body, per the SEARCH_MODE_ARMS row", async () => {
      // The arm table is the contract under test: the `lexical` token must
      // route to the child→parent arm (search-mode.ts), and the live answer
      // must show that arm's shape, not the ranking layer's.
      expect(Object.keys(SEARCH_MODE_ARMS).sort()).toEqual(
        [...SEARCH_MODES].sort()
      );
      expect(SEARCH_MODE_ARMS.lexical).toBe(modeAParentWindowArm);

      const body = parseBody(
        await handlerFor()({
          query: LEXICAL_QUERY,
          filters: { search_mode: "lexical" },
          limit: 5,
        })
      );

      // Both children match the token and collapse to their one parent
      // (ADR-0060: the extract unit enters the answer, not its search keys).
      expect(body.chunks).toHaveLength(1);
      const hit = body.chunks[0]!;
      expect(hit.id).toBe(SOURCE_DOC.id);
      expect(hit.content).toBe(PARENT_BODY);
      expect(hit.source_ref).toBe(SOURCE_DOC.source_ref);
      // Never a child-only text masquerading as a parent.
      expect(hit.content).not.toContain("child slice");
      expect(hit.valid_window).toHaveLength(2);
      expect(hit.valid_window[1]).toBeNull();
      expect(hit.score).toBeGreaterThan(0);

      const metadata = hit.metadata as ParentWindowMeta;
      expect(metadata.kind).toBe("parent-window");
      expect(metadata.sourceDocId).toBe(SOURCE_DOC.id);
      expect(metadata.children.map((child) => child.chunkId).sort()).toEqual(
        [...CHILD_IDS].sort()
      );
      expect(metadata.children.map((child) => child.ordinal).sort()).toEqual([
        0, 1,
      ]);
      // A child hit found and a parent resolved: healthy, not degraded.
      expect(body).not.toHaveProperty("degraded");
    });

    it("search_mode=sql throws the typed real_db_not_wired refusal naming sql", async () => {
      const thrown = await handlerFor()({
        query: LEXICAL_QUERY,
        filters: { search_mode: "sql" },
      }).then(
        () => undefined,
        (err: unknown) => err
      );
      expect(thrown).toBeInstanceOf(GraphragError);
      const error = thrown as GraphragError;
      expect(error.code).toBe("INVALID_INPUT");
      expect(error.message).toContain(REAL_DB_NOT_WIRED_REASON);
      expect(error.message).toContain("search_mode=sql");
      // The refusal is a routing-time one: no SQL ran, so no chunk body —
      // the envelope is never reached on this path.
      expect(error.message).not.toContain(CHILD_ZERO);
    });

    it("omitted search_mode is answered by the graph arm on the same live corpus", async () => {
      expect(SEARCH_MODE_ARMS.graph).toBe(assembleRetrievalResult);
      const handler = handlerFor();
      const omitted = parseBody(await handler({ query: LEXICAL_QUERY }));
      const explicit = parseBody(
        await handler({
          query: LEXICAL_QUERY,
          filters: { search_mode: "graph" },
        })
      );
      // Omission IS the default route: byte-identical answers, …
      expect(omitted).toEqual(explicit);
      // … and that route is the graph arm, i.e. ledger vector recall over the
      // CHILD rows — not the lexical arm's parent 抽图窗 cite.
      expect(omitted.chunks.map((chunk) => chunk.id)).toContain(CHILD_IDS[0]);
      expect(omitted.chunks[0]!.id).toBe(CHILD_IDS[0]);
      expect(omitted.chunks.map((chunk) => chunk.id)).not.toContain(
        SOURCE_DOC.id
      );
      expect(omitted.chunks[0]!.content).toBe(CHILD_ZERO);
    });

    it("every retired letter is a typed invalid_search_mode refusal", async () => {
      // A/B/C/D left the closed set with the zero-coexistence ruling: they are
      // refusals, never silent alias routes into an arm.
      const handler = handlerFor();
      for (const letter of ["A", "B", "C", "D"] as const) {
        expect(SEARCH_MODES as readonly string[]).not.toContain(letter);
        const thrown = await handler({
          query: LEXICAL_QUERY,
          filters: { search_mode: letter },
        }).then(
          () => undefined,
          (err: unknown) => err
        );
        expect(thrown, `search_mode=${letter} must be refused`).toBeInstanceOf(
          GraphragError
        );
        const error = thrown as GraphragError;
        expect(error.code).toBe("INVALID_INPUT");
        expect(error.message).toContain(INVALID_SEARCH_MODE_REASON);
        // The refusal teaches the closed set in the same operator-visible
        // sentence the tool description advertises.
        expect(error.message).toContain(SEARCH_MODE_WIRE_COPY);
        expect(error.message).toContain(`"${letter}"`);
      }
    });
  }
);
