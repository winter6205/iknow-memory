/**
 * MemoryBackend's BM25 lexical arm.
 *
 * Same contract as `ElasticsearchPrecisionLayer.searchLexical` — a query
 * string in, ranked `RetrievedChunk[]` out, honouring valid_window /
 * filters / limit — so hybrid retrieval can be exercised in unit tests
 * without a running precision-layer cluster (SC10). Scores are NOT
 * expected to match the ES precision layer: this side computes real
 * Okapi BM25 (k1=1.2, b=0.75) and RRF only ever consumes rank order.
 *
 * Ranking assertions here are about relative order, not absolute values,
 * so they stay meaningful if the smoothing constants are ever retuned.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  MemoryBackend,
  tokenize,
} from "../../src/core/storage/memory-backend.js";
import { supportsLexicalSearch } from "../../src/core/storage/backend.js";
import type { ChunkRecord } from "../../src/core/types.js";

const DIM = 4;
const NOW = "2024-06-01T00:00:00Z";

function makeChunk(patch: Partial<ChunkRecord> & { id: string }): ChunkRecord {
  return {
    id: patch.id,
    content: patch.content ?? `content of ${patch.id}`,
    embedding: patch.embedding ?? new Array<number>(DIM).fill(0.5),
    source_ref: patch.source_ref ?? "src/default",
    metadata: patch.metadata ?? {},
    valid_from: patch.valid_from ?? "2024-01-01T00:00:00Z",
    valid_until: patch.valid_until ?? null,
    created_at: patch.created_at ?? "2024-01-01T00:00:00Z",
  };
}

describe("MemoryBackend — lexical (BM25) arm", () => {
  let backend: MemoryBackend;

  beforeEach(() => {
    backend = new MemoryBackend(DIM);
  });

  it("advertises the lexical seam", () => {
    expect(supportsLexicalSearch(backend)).toBe(true);
  });

  it("finds a chunk by a term the query shares with it", async () => {
    await backend.upsert([
      makeChunk({ id: "a", content: "the zubrowka protocol governs billing" }),
      makeChunk({ id: "b", content: "quarterly revenue grew again" }),
    ]);
    const hits = await backend.searchLexical("zubrowka", {
      limit: 10,
      validAt: NOW,
    });
    expect(hits.map((h) => h.id)).toEqual(["a"]);
    expect(hits[0]?.score).toBeGreaterThan(0);
    expect(hits[0]?.content).toContain("zubrowka");
    expect(hits[0]?.valid_window).toEqual(["2024-01-01T00:00:00Z", null]);
    expect(hits[0]?.source_ref).toBe("src/default");
  });

  it("matches on any query term rather than requiring all of them", async () => {
    await backend.upsert([
      makeChunk({ id: "a", content: "zubrowka incident report" }),
    ]);
    const hits = await backend.searchLexical(
      "what happened during the zubrowka outage in production",
      { limit: 10, validAt: NOW }
    );
    expect(hits.map((h) => h.id)).toEqual(["a"]);
  });

  it("is case-insensitive and splits on punctuation", async () => {
    await backend.upsert([
      makeChunk({
        id: "a",
        content: "Rollback/Restore: the ZUBROWKA runbook.",
      }),
    ]);
    const hits = await backend.searchLexical("zubrowka restore", {
      limit: 10,
      validAt: NOW,
    });
    expect(hits.map((h) => h.id)).toEqual(["a"]);
  });

  it("segments continuous Chinese text into multiple lexical terms", () => {
    expect(tokenize("连续中文文本的分词结果").length).toBeGreaterThanOrEqual(2);
  });

  it("keeps mixed Chinese and English searchable", async () => {
    await backend.upsert([
      makeChunk({ id: "mixed", content: "部署 Elasticsearch 集群" }),
    ]);
    const hits = await backend.searchLexical("Elasticsearch 集群", {
      limit: 10,
      validAt: NOW,
    });
    expect(hits.map((hit) => hit.id)).toEqual(["mixed"]);
  });

  it("handles a single Chinese character and punctuation-only input", async () => {
    await backend.upsert([makeChunk({ id: "single", content: "甲" })]);
    expect(
      await backend.searchLexical("甲", { limit: 10, validAt: NOW })
    ).toHaveLength(1);
    expect(
      await backend.searchLexical("！？。", { limit: 10, validAt: NOW })
    ).toEqual([]);
  });

  it("ranks a rare term above a term that appears in every chunk", async () => {
    await backend.upsert([
      makeChunk({ id: "common-1", content: "deployment notes for the system" }),
      makeChunk({
        id: "common-2",
        content: "deployment notes for the network",
      }),
      makeChunk({
        id: "common-3",
        content: "deployment notes for the database",
      }),
      makeChunk({ id: "rare", content: "deployment blocked by zubrowka" }),
    ]);
    // "deployment" is in every chunk so it carries almost no signal;
    // "zubrowka" is in one. IDF must put the rare match first.
    const hits = await backend.searchLexical("deployment zubrowka", {
      limit: 10,
      validAt: NOW,
    });
    expect(hits[0]?.id).toBe("rare");
  });

  it("ranks a short chunk above a long one with the same term count", async () => {
    await backend.upsert([
      makeChunk({ id: "short", content: "zubrowka" }),
      makeChunk({
        id: "long",
        content: `zubrowka ${"filler words about unrelated topics ".repeat(20)}`,
      }),
    ]);
    // Length normalization (the b term): one hit in a short chunk is
    // stronger evidence than one hit buried in a long one.
    const hits = await backend.searchLexical("zubrowka", {
      limit: 10,
      validAt: NOW,
    });
    expect(hits.map((h) => h.id)).toEqual(["short", "long"]);
  });

  it("ranks repeated occurrences above a single one", async () => {
    await backend.upsert([
      makeChunk({ id: "once", content: "zubrowka appears here alpha beta" }),
      makeChunk({ id: "twice", content: "zubrowka zubrowka here alpha beta" }),
    ]);
    const hits = await backend.searchLexical("zubrowka", {
      limit: 10,
      validAt: NOW,
    });
    expect(hits.map((h) => h.id)).toEqual(["twice", "once"]);
  });

  it("returns [] for a query with no usable terms", async () => {
    await backend.upsert([makeChunk({ id: "a", content: "some content" })]);
    expect(
      await backend.searchLexical("", { limit: 10, validAt: NOW })
    ).toEqual([]);
    expect(
      await backend.searchLexical("   ", { limit: 10, validAt: NOW })
    ).toEqual([]);
    expect(
      await backend.searchLexical("!!! ---", { limit: 10, validAt: NOW })
    ).toEqual([]);
  });

  it("returns [] when nothing shares a term with the query", async () => {
    await backend.upsert([makeChunk({ id: "a", content: "some content" })]);
    expect(
      await backend.searchLexical("xyzzyplugh", { limit: 10, validAt: NOW })
    ).toEqual([]);
  });

  it("returns [] against an empty store", async () => {
    expect(
      await backend.searchLexical("anything", { limit: 10, validAt: NOW })
    ).toEqual([]);
  });

  it("excludes chunks outside the valid window", async () => {
    await backend.upsert([
      makeChunk({
        id: "expired",
        content: "zubrowka archived runbook",
        valid_from: "2023-01-01T00:00:00Z",
        valid_until: "2023-06-01T00:00:00Z",
      }),
      makeChunk({
        id: "future",
        content: "zubrowka planned runbook",
        valid_from: "2030-01-01T00:00:00Z",
      }),
      makeChunk({ id: "live", content: "zubrowka current runbook" }),
    ]);
    const hits = await backend.searchLexical("zubrowka", {
      limit: 10,
      validAt: NOW,
    });
    expect(hits.map((h) => h.id)).toEqual(["live"]);
  });

  it("applies source_ref and metadata exact-match filters", async () => {
    await backend.upsert([
      makeChunk({
        id: "a",
        content: "zubrowka one",
        source_ref: "src/a",
        metadata: { team: "platform" },
      }),
      makeChunk({
        id: "b",
        content: "zubrowka two",
        source_ref: "src/b",
        metadata: { team: "billing" },
      }),
    ]);
    expect(
      (
        await backend.searchLexical("zubrowka", {
          limit: 10,
          validAt: NOW,
          filters: { source_ref: "src/a" },
        })
      ).map((h) => h.id)
    ).toEqual(["a"]);
    expect(
      (
        await backend.searchLexical("zubrowka", {
          limit: 10,
          validAt: NOW,
          filters: { "metadata.team": "billing" },
        })
      ).map((h) => h.id)
    ).toEqual(["b"]);
    expect(
      await backend.searchLexical("zubrowka", {
        limit: 10,
        validAt: NOW,
        filters: { source_ref: "src/nope" },
      })
    ).toEqual([]);
  });

  it("truncates to the requested limit", async () => {
    await backend.upsert([
      makeChunk({ id: "a", content: "zubrowka a" }),
      makeChunk({ id: "b", content: "zubrowka b" }),
      makeChunk({ id: "c", content: "zubrowka c" }),
    ]);
    expect(
      await backend.searchLexical("zubrowka", { limit: 2, validAt: NOW })
    ).toHaveLength(2);
    expect(
      await backend.searchLexical("zubrowka", { limit: 0, validAt: NOW })
    ).toEqual([]);
  });

  it("re-indexes on re-upsert so stale text stops matching", async () => {
    await backend.upsert([
      makeChunk({ id: "a", content: "zubrowka original" }),
    ]);
    await backend.upsert([
      makeChunk({ id: "a", content: "entirely replaced" }),
    ]);

    expect(
      await backend.searchLexical("zubrowka", { limit: 10, validAt: NOW })
    ).toEqual([]);
    expect(
      (
        await backend.searchLexical("replaced", { limit: 10, validAt: NOW })
      ).map((h) => h.id)
    ).toEqual(["a"]);
  });

  it("drops the lexical index on close", async () => {
    await backend.upsert([makeChunk({ id: "a", content: "zubrowka" })]);
    await backend.close();
    expect(
      await backend.searchLexical("zubrowka", { limit: 10, validAt: NOW })
    ).toEqual([]);
  });

  it("rejects an invalid validAt the same way vector search does", async () => {
    await backend.upsert([makeChunk({ id: "a", content: "zubrowka" })]);
    await expect(
      backend.searchLexical("zubrowka", { limit: 10, validAt: "not-a-date" })
    ).rejects.toThrow(/validAt/);
  });
});
