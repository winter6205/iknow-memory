/**
 * es-precision: real-Elasticsearch integration tests for the BM25 lexical arm
 * (specs/es-precision-layer.md).
 *
 * This file replaces the archived `bm25-pg` suite. The production lexical
 * carrier moved off Postgres (see `docs/archive/pg-lexical-removal.md`); the
 * integration coverage now drives the Elasticsearch precision layer against
 * a real cluster with the analysis-ik plugin installed (see
 * `docs/runbooks/es-precision-layer.md`).
 *
 * Per docs/.claude/rules/test.md: when Elasticsearch is unreachable the suite
 * SKIPS LOUDLY with the documented Validation block, never silently passes.
 * The probe mirrors the Postgres harness: a lightweight HEAD against the
 * configured ES_URL is enough to confirm reachability; analyzer correctness
 * is proven by the unit tests in tests/storage/elasticsearch-precision.unit.test.ts.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ElasticsearchPrecisionLayer } from "../../src/core/storage/elasticsearch-precision.js";
import type { ChunkRecord } from "../../src/core/types.js";

const ES_URL_ENV = "GRAPHRAG_MEMORY_ES_URL";
const ES_NODE_ENV = "GRAPHRAG_MEMORY_ES_NODE";
const DEFAULT_ES_URL = "http://localhost:9200";
const TEST_PATH = "tests/integration/bm25-pg.test.ts";
const EXPECTED_COMMAND = `npx vitest run ${TEST_PATH}`;
const CHUNK_INDEX = "iknow-memory-test-chunks";
const ENTITY_INDEX = "iknow-memory-test-entities";

interface EsProbeResult {
  available: boolean;
  url: string;
  error?: unknown;
}

async function probeElasticsearch(url: string): Promise<EsProbeResult> {
  try {
    const response = await fetch(url, { method: "GET" });
    if (!response.ok) {
      return {
        available: false,
        url,
        error: new Error(`HTTP ${response.status} ${response.statusText}`),
      };
    }
    return { available: true, url };
  } catch (caught: unknown) {
    return {
      available: false,
      url,
      error: caught instanceof Error ? caught : new Error(String(caught)),
    };
  }
}

function warnEsUnavailable(probe: EsProbeResult): void {
  const safeError =
    probe.error instanceof Error ? probe.error.message : String(probe.error);
  console.warn(
    `\n[es-precision] Elasticsearch unavailable at ${probe.url}: ${safeError}\n`
  );
  console.warn(
    "Validation:\n" +
      `- Not run: ${TEST_PATH}\n` +
      `- Expected command: ${EXPECTED_COMMAND}\n` +
      `- Blocking issue: cannot connect to Elasticsearch at ${probe.url}\n` +
      `- Set ${ES_URL_ENV} (or ${ES_NODE_ENV}) to a reachable Elasticsearch 8.x endpoint with the analysis-ik plugin installed.\n`
  );
}

const ES_URL =
  process.env[ES_URL_ENV] ?? process.env[ES_NODE_ENV] ?? DEFAULT_ES_URL;
const probe = await probeElasticsearch(ES_URL);
if (!probe.available) warnEsUnavailable(probe);
const describeEs = probe.available ? describe : describe.skip;

const NOW = "2026-01-01T00:00:00.000Z";

/** A Chinese-heavy fixture: ES's IK analyzer should split this into > 1 term. */
const ZH_QUERY = "中文分词检索";
const ZH_CHUNK_CONTENT =
  "Elasticsearch 精度层接入了 IK 中文分词器，能够对连续中文文本做词典切词。";
const EN_CHUNK_CONTENT =
  "Okapi BM25 ranks documents by term frequency and document length.";

function makeChunk(content: string, sourceRef: string): ChunkRecord {
  return {
    id: randomUUID(),
    content,
    embedding: [0.1, 0.2, 0.3],
    source_ref: sourceRef,
    metadata: {},
    valid_from: NOW,
    valid_until: null,
    created_at: NOW,
  };
}

describeEs("es-precision: Elasticsearch precision layer", () => {
  let layer: ElasticsearchPrecisionLayer | undefined;

  beforeAll(async () => {
    layer = new ElasticsearchPrecisionLayer({
      node: ES_URL,
      chunkIndex: CHUNK_INDEX,
      entityIndex: ENTITY_INDEX,
    });
    // Wipe the test indexes before each run so the assertions see only
    // freshly-indexed documents. A failed recreate leaves the cluster in
    // a clean state for the next probe.
    try {
      await layer.deleteChunkIndex();
    } catch {
      // The index may not exist yet; ensureIndex below will create it.
    }
  });

  afterAll(async () => {
    if (layer === undefined) return;
    try {
      await layer.deleteChunkIndex();
    } finally {
      await layer.close();
    }
  });

  it("indexes Chinese chunks and retrieves them on a Chinese query", async () => {
    const target = makeChunk(ZH_CHUNK_CONTENT, "es/zh/target");
    const distractor = makeChunk(EN_CHUNK_CONTENT, "es/en/distractor");
    await layer!.indexChunks([target, distractor]);

    const hits = await layer!.searchLexical(ZH_QUERY, {
      limit: 5,
      validAt: NOW,
    });

    expect(hits.length).toBeGreaterThan(0);
    expect(hits.map((h) => h.id)).toContain(target.id);
    expect(hits[0]?.id).toBe(target.id);
  });

  it("returns [] for a query with no tokens after analysis", async () => {
    const hits = await layer!.searchLexical("   ", {
      limit: 5,
      validAt: NOW,
    });
    expect(hits).toEqual([]);
  });

  it("changing k1 re-creates the index and produces a different ordering", async () => {
    // k1/b are INDEX-TIME parameters on the ES backend (BM25 similarity
    // settings baked into the index; there is no per-request BM25 override
    // in Elasticsearch). Changing k1 therefore means: construct a layer
    // with the new value, rebuild the index (delete + re-index the corpus),
    // and compare orderings across the two indexes.
    const corpus = [
      makeChunk(
        "Okapi BM25 ranks documents by term frequency and document length.",
        "es/bm25/a"
      ),
      makeChunk(
        "BM25 is the scoring function Elasticsearch uses by default for text fields.",
        "es/bm25/b"
      ),
      makeChunk(
        "Okapi BM25 Okapi BM25 Okapi BM25 term frequency saturation is k1.",
        "es/bm25/c"
      ),
    ];
    const query = "Okapi BM25 term";
    const searchOpts = { limit: 5, validAt: NOW };

    // Baseline: default k1 = 1.2.
    await layer!.indexChunks(corpus);
    const defaultK1 = await layer!.searchLexical(query, searchOpts);
    expect(defaultK1.length).toBeGreaterThan(0);

    // Low-saturation k1: rebuild the whole index under the new setting.
    await layer!.deleteChunkIndex();
    const lowK1Layer = new ElasticsearchPrecisionLayer(
      {
        node: ES_URL,
        chunkIndex: CHUNK_INDEX,
        entityIndex: ENTITY_INDEX,
      },
      { k1: 0.3, b: 0.75 }
    );
    try {
      await lowK1Layer.indexChunks(corpus);
      const lowK1 = await lowK1Layer.searchLexical(query, searchOpts);

      expect(lowK1.length).toBeGreaterThan(0);
      // With term-frequency saturation that low vs the default, the rank
      // ordering of the corpus is expected to shift — we only require the
      // two rankings to differ in some position (RRF fuses on rank, not on
      // score).
      const rankA = JSON.stringify(defaultK1.map((h) => h.id));
      const rankB = JSON.stringify(lowK1.map((h) => h.id));
      expect(rankA).not.toBe(rankB);
    } finally {
      await lowK1Layer.close();
    }
  });

  it("phrase switch produces a different ranking than phrase-off", async () => {
    const phraseTarget = makeChunk(
      "graph priority ranks seed entities before chunks.",
      "es/phrase/target"
    );
    const bagOfWords = makeChunk(
      "graphs prioritize seed entities and chunks in different orders.",
      "es/phrase/distractor"
    );
    await layer!.indexChunks([phraseTarget, bagOfWords]);

    const phraseOn = await layer!.searchLexical("seed entities before chunks", {
      limit: 5,
      validAt: NOW,
      precision: { phrase: true },
    });
    const phraseOff = await layer!.searchLexical(
      "seed entities before chunks",
      {
        limit: 5,
        validAt: NOW,
        precision: { phrase: false },
      }
    );

    expect(phraseOn.length).toBeGreaterThan(0);
    expect(phraseOff.length).toBeGreaterThan(0);
    expect(JSON.stringify(phraseOn.map((h) => h.id))).not.toBe(
      JSON.stringify(phraseOff.map((h) => h.id))
    );
  });
});
