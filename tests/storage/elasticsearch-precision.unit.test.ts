import { describe, expect, it, vi } from "vitest";

import {
  ElasticsearchPrecisionLayer,
  type ElasticsearchClientLike,
} from "../../src/core/storage/elasticsearch-precision.js";
import type { ChunkRecord } from "../../src/core/types.js";
import { FakeEsCluster } from "./es-fake-cluster.js";

const NOW = "2026-01-01T00:00:00.000Z";

function fakeClient(): ElasticsearchClientLike {
  return {
    indices: {
      exists: vi.fn(async () => false),
      create: vi.fn(async () => ({})),
      analyze: vi.fn(async () => ({
        tokens: [{ token: "����" }, { token: "�ִ�" }],
      })),
      delete: vi.fn(async () => ({})),
      getAlias: vi.fn(async () => ({})),
      updateAliases: vi.fn(async () => ({ acknowledged: true })),
    },
    bulk: vi.fn(async () => ({ errors: false, items: [] })),
    search: vi.fn(async () => ({
      hits: {
        hits: [
          {
            _id: "chunk-1",
            _score: 2.5,
            _source: {
              id: "chunk-1",
              content: "���ķִʽ��",
              source_ref: "doc-1",
              valid_from: NOW,
              valid_until: null,
            },
          },
        ],
      },
    })),
    deleteByQuery: vi.fn(async () => ({ deleted: 1 })),
    close: vi.fn(async () => {}),
  };
}

/**
 * Build a fake client whose `updateByQuery` returns a configurable response
 * or rejects with a supplied error. Other operations remain identical to
 * `fakeClient`.
 */
function fakeClientWithInvalidation(
  behavior: { kind: "ok" } | { kind: "fail"; error: unknown }
): ElasticsearchClientLike {
  const base = fakeClient();
  if (behavior.kind === "fail") {
    base.updateByQuery = vi.fn(async () => {
      throw behavior.error;
    });
  } else {
    base.updateByQuery = vi.fn(async () => ({ updated: 1 }));
  }
  return base;
}

function chunk(): ChunkRecord {
  return {
    id: "chunk-1",
    content: "���ķִʽ��",
    embedding: [1],
    source_ref: "doc-1",
    metadata: { topic: "����" },
    valid_from: NOW,
    valid_until: null,
    created_at: NOW,
  };
}

/**
 * The third derived index: community REPORT text, whose `level` is the
 * queryable column the retrieve-side read cap filters on.
 */
function summaryLayer(
  client: ElasticsearchClientLike,
  options: { k1?: number; b?: number } = {}
): ElasticsearchPrecisionLayer {
  return new ElasticsearchPrecisionLayer(
    {
      node: "http://localhost:9200",
      chunkIndex: "chunks",
      entityIndex: "entities",
      summaryIndex: "summaries",
    },
    { k1: options.k1 ?? 1.4, b: options.b ?? 0.65, client }
  );
}

function summaryRow(id = "ledger-uuid-7", communityId = "7") {
  return {
    id,
    community_id: communityId,
    content: "community report text",
    level: 3,
  };
}

describe("ElasticsearchPrecisionLayer", () => {
  it("creates IK/BM25 mappings and indexes chunk documents", async () => {
    const client = fakeClient();
    const layer = new ElasticsearchPrecisionLayer(
      {
        node: "http://localhost:9200",
        chunkIndex: "chunks",
        entityIndex: "entities",
      },
      { k1: 1.4, b: 0.65, client }
    );

    await layer.indexChunks([chunk()]);

    expect(client.indices.create).toHaveBeenCalledTimes(1);
    const create = client.indices.create.mock.calls[0]?.[0] as {
      index: string;
      settings: Record<string, unknown>;
      mappings: Record<string, unknown>;
    };
    expect(create.index).toBe("chunks");
    expect(JSON.stringify(create)).toContain("ik_max_word");
    expect(JSON.stringify(create)).toContain("ik_smart");
    expect(JSON.stringify(create)).toContain('"k1":1.4');
    expect(JSON.stringify(create)).toContain('"b":0.65');

    expect(client.bulk).toHaveBeenCalledTimes(1);
    const bulk = client.bulk.mock.calls[0]?.[0] as {
      index: string;
      operations: unknown[];
    };
    expect(bulk.index).toBe("chunks");
    expect(bulk.operations).toContainEqual({
      index: { _index: "chunks", _id: "chunk-1" },
    });
    expect(bulk.operations).toContainEqual(
      expect.objectContaining({ content: "���ķִʽ��" })
    );
  });

  it("uses phrase and field boosts in the lexical query and maps hits", async () => {
    const client = fakeClient();
    const layer = new ElasticsearchPrecisionLayer(
      {
        node: "http://localhost:9200",
        chunkIndex: "chunks",
        entityIndex: "entities",
      },
      { client }
    );

    const hits = await layer.searchLexical("���� �ִ�", {
      limit: 5,
      validAt: NOW,
      filters: { "metadata.topic": "����" },
      precision: {
        k1: 1.2,
        b: 0.75,
        cjkSegmentation: true,
        phrase: true,
        fieldBoost: true,
        fieldBoosts: { content: 2, source_ref: 1, "metadata.*": 1 },
      },
    });

    expect(hits).toEqual([
      {
        id: "chunk-1",
        content: "���ķִʽ��",
        source_ref: "doc-1",
        valid_window: [NOW, null],
        score: 2.5,
      },
    ]);
    const request = client.search.mock.calls[0]?.[0] as {
      index: string;
      query: unknown;
    };
    expect(request.index).toBe("chunks");
    const query = JSON.stringify(request.query);
    expect(query).toContain("match_phrase");
    expect(query).toContain("metadata.topic");
    expect(query).toContain("content^");
    // k1/b are INDEX-TIME parameters on the ES backend (BM25 similarity
    // settings from createIndexIfMissing). The query body must NOT carry
    // them — there is deliberately no fake query-time channel. Only the
    // MemoryBackend test double consumes query-time k1/b (in-memory BM25).
    expect(query).not.toContain("k1");
    expect(query).not.toContain('"b"');
  });

  it("omits the match_phrase shoulder when phrase is off", async () => {
    const client = fakeClient();
    const layer = new ElasticsearchPrecisionLayer(
      {
        node: "http://localhost:9200",
        chunkIndex: "chunks",
        entityIndex: "entities",
      },
      { client }
    );

    await layer.searchLexical("中文 分词", {
      limit: 5,
      validAt: NOW,
      precision: { phrase: false },
    });

    const request = client.search.mock.calls[0]?.[0] as {
      index: string;
      query: unknown;
    };
    const query = JSON.stringify(request.query);
    // Paired with the `phrase: true` case above: the switch must be
    // observable in both directions, or a regression that hard-wires
    // phrase off would still pass every test.
    expect(query).not.toContain("match_phrase");
    expect(query).toContain("multi_match");
  });

  it("searches metadata fields leniently against numeric mappings", async () => {
    const client = fakeClient();
    const layer = new ElasticsearchPrecisionLayer(
      {
        node: "http://localhost:9200",
        chunkIndex: "chunks",
        entityIndex: "entities",
      },
      { client }
    );

    await layer.searchLexical("中文 分词", { limit: 5, validAt: NOW });

    // Pins the fix in buildPrecisionChunkQuery: lenient must sit on the
    // chunk multi_match, not on any other clause of the request.
    const request = client.search.mock.calls[0]?.[0] as {
      query: {
        bool: {
          must: Array<{ bool: { should: Array<Record<string, unknown>> } }>;
        };
      };
    };
    const should = request.query.bool.must[0]!.bool.should;
    const multiMatch = should[0]!.multi_match as {
      lenient?: boolean;
      fields?: unknown;
    };
    expect(multiMatch.fields).toEqual(
      expect.arrayContaining(["metadata.*"])
    );
    expect(multiMatch.lenient).toBe(true);
    const matchPhrase = (should[1]!.match_phrase as {
      content: { lenient?: boolean };
    }).content;
    expect(matchPhrase.lenient).toBeUndefined();
  });

  it("ignores query-time k1/b entirely (index-time-only semantics)", async () => {
    const client = fakeClient();
    const layer = new ElasticsearchPrecisionLayer(
      {
        node: "http://localhost:9200",
        chunkIndex: "chunks",
        entityIndex: "entities",
      },
      { client }
    );

    await layer.searchLexical("中文 分词", {
      limit: 5,
      validAt: NOW,
      precision: { k1: 0.3, b: 0.9 },
    });

    // The request built under k1=0.3/b=0.9 must be byte-identical to the
    // request built with no k1/b at all — proving the values were not
    // smuggled into the query body.
    const withK1 = JSON.stringify(client.search.mock.calls[0]?.[0]);
    client.search.mockClear();
    await layer.searchLexical("中文 分词", { limit: 5, validAt: NOW });
    const withoutK1 = JSON.stringify(client.search.mock.calls[0]?.[0]);
    expect(withK1).toBe(withoutK1);
  });

  it("analyzes text through the query analyzer", async () => {
    const client = fakeClient();
    const layer = new ElasticsearchPrecisionLayer(
      {
        node: "http://localhost:9200",
        chunkIndex: "chunks",
        entityIndex: "entities",
      },
      { client }
    );

    await expect(layer.analyze("���������ı�")).resolves.toEqual([
      "����",
      "�ִ�",
    ]);
    expect(client.indices.analyze).toHaveBeenCalledWith(
      expect.objectContaining({ analyzer: "ik_query" })
    );
  });

  it("indexes aliases and searches canonical entities", async () => {
    const client = fakeClient();
    const layer = new ElasticsearchPrecisionLayer(
      {
        node: "http://localhost:9200",
        chunkIndex: "chunks",
        entityIndex: "entities",
      },
      { client }
    );
    client.search = vi.fn(async ({ index }: { index?: unknown }) =>
      index === "entities"
        ? {
            hits: {
              hits: [
                {
                  _id: "entity-1",
                  _score: 3,
                  _source: {
                    id: "entity-1",
                    canonical_name: "������ѧ",
                  },
                },
              ],
            },
          }
        : {
            hits: {
              hits: [
                {
                  _id: "chunk-1",
                  _score: 2.5,
                  _source: {
                    id: "chunk-1",
                    content: "���ķִʽ��",
                    source_ref: "doc-1",
                    valid_from: NOW,
                    valid_until: null,
                  },
                },
              ],
            },
          }
    );

    await layer.indexEntities([
      {
        id: "entity-1",
        canonical_name: "������ѧ",
        aliases: ["����"],
        type: "system",
      },
    ]);
    const entities = await layer.searchEntities("����", 3);

    expect(entities).toEqual([
      { id: "entity-1", canonical_name: "������ѧ", score: 3 },
    ]);
    expect(client.indices.create).toHaveBeenCalledTimes(1);
    const bulkCalls = client.bulk.mock.calls;
    expect(bulkCalls[0]?.[0]).toEqual(
      expect.objectContaining({ index: "entities" })
    );
    expect(JSON.stringify(bulkCalls[0]?.[0])).toContain("����");
  });
  // plans/entity-type-and-filter.md T3: the entity lexical seed is half of
  // the neo4j arm's seed fusion, so it must honor the typed entity filter
  // too — as a term clause, never as a chunk exact-match filter.
  it("entityType restricts entity search with a term filter", async () => {
    const client = fakeClient();
    const layer = new ElasticsearchPrecisionLayer(
      {
        node: "http://localhost:9200",
        chunkIndex: "chunks",
        entityIndex: "entities",
      },
      { client }
    );
    const searchRequests: Record<string, unknown>[] = [];
    client.search = vi.fn(async (req: Record<string, unknown>) => {
      searchRequests.push(req);
      return { hits: { hits: [] } };
    });

    await layer.searchEntities("alice", 3, {}, "person");
    const filtered = searchRequests[0] as {
      query: { bool: { filter: unknown[] } };
    };
    expect(filtered.query.bool.filter).toContainEqual({
      term: { type: "person" },
    });

    await layer.searchEntities("alice", 3);
    const unfiltered = searchRequests[1] as {
      query: { bool: { filter: unknown[] } };
    };
    expect(unfiltered.query.bool.filter).not.toContainEqual({
      term: { type: expect.anything() },
    });
  });
});

/**
 * T5 entity-lifecycle: an L3 merge in the extract CLI materialises a
 * loser row the ledger keeps only as audit. The precision layer must
 * drop the corresponding entity-index document so a lexical seed query
 * never resolves to a row whose only purpose is the `merged_into` edge.
 */
describe("ElasticsearchPrecisionLayer.deleteEntities", () => {
  it("is a no-op when the id list is empty", async () => {
    const client = fakeClient();
    const layer = new ElasticsearchPrecisionLayer(
      {
        node: "http://localhost:9200",
        chunkIndex: "chunks",
        entityIndex: "entities",
      },
      { client }
    );

    await layer.deleteEntities([]);

    expect(client.deleteByQuery).not.toHaveBeenCalled();
  });

  it("issues a delete_by_query scoped to the entity index and the given ids", async () => {
    const client = fakeClient();
    const layer = new ElasticsearchPrecisionLayer(
      {
        node: "http://localhost:9200",
        chunkIndex: "chunks",
        entityIndex: "entities",
      },
      { client }
    );

    await layer.deleteEntities(["loser-1", "loser-2"]);

    expect(client.deleteByQuery).toHaveBeenCalledTimes(1);
    const request = client.deleteByQuery!.mock.calls[0]?.[0] as {
      index: string;
      query: { ids: { values: string[] } };
      refresh: boolean;
      conflicts: string;
    };
    expect(request.index).toBe("entities");
    expect(request.refresh).toBe(true);
    expect(request.conflicts).toBe("proceed");
    expect(request.query.ids.values).toEqual(["loser-1", "loser-2"]);
  });

  it("surfaces a configured-but-failing ES call as PrecisionLayerError", async () => {
    const client = fakeClient();
    client.deleteByQuery = vi.fn(async () => {
      throw new Error("entity index not found");
    });
    const layer = new ElasticsearchPrecisionLayer(
      {
        node: "http://localhost:9200",
        chunkIndex: "chunks",
        entityIndex: "entities",
      },
      { client }
    );

    await expect(layer.deleteEntities(["loser-1"])).rejects.toMatchObject({
      name: "PrecisionLayerError",
    });
  });
});

describe("ElasticsearchPrecisionLayer.invalidateSourceRef", () => {
  // The precision layer's invalidate is a derived-index mirror of the
  // authoritative Postgres close. Tests assert the request body the
  // adapter sends and the fail-fast contract used by the caller (the
  // `invalidate` tool) for fail-open: a thrown PrecisionLayerError is
  // what the tool catches and turns into a degraded response.
  it("issues an update_by_query that targets the chunk index by source_ref", async () => {
    const client = fakeClientWithInvalidation({ kind: "ok" });
    const layer = new ElasticsearchPrecisionLayer(
      {
        node: "http://localhost:9200",
        chunkIndex: "chunks",
        entityIndex: "entities",
      },
      { client }
    );

    await layer.invalidateSourceRef("docs/x.md", "2026-09-03T00:00:00.000Z");

    expect(client.updateByQuery).toHaveBeenCalledTimes(1);
    const request = client.updateByQuery!.mock.calls[0]?.[0] as {
      index: string;
      query: unknown;
      script: { source: string; params: Record<string, unknown> };
      refresh: boolean;
    };
    expect(request.index).toBe("chunks");
    expect(request.refresh).toBe(true);
    expect(request.query).toEqual({ term: { source_ref: "docs/x.md" } });
    expect(request.script.params).toEqual({
      invalidated_at: "2026-09-03T00:00:00.000Z",
    });
    expect(request.script.source).toContain("ctx._source.valid_until");
  });

  it("throws a typed PrecisionLayerError when updateByQuery rejects", async () => {
    const cause = new Error("connection refused");
    const client = fakeClientWithInvalidation({ kind: "fail", error: cause });
    const layer = new ElasticsearchPrecisionLayer(
      {
        node: "http://localhost:9200",
        chunkIndex: "chunks",
        entityIndex: "entities",
      },
      { client }
    );

    await expect(
      layer.invalidateSourceRef("docs/x.md", "2026-09-03T00:00:00.000Z")
    ).rejects.toMatchObject({
      name: "PrecisionLayerError",
      code: "STORAGE_ERROR",
      message: expect.stringContaining("connection refused"),
    });
  });

  it("throws when the client lacks the updateByQuery operation", async () => {
    const client = fakeClient();
    // fakeClient() does not attach updateByQuery; the layer must surface
    // a typed error instead of calling a missing method.
    const layer = new ElasticsearchPrecisionLayer(
      {
        node: "http://localhost:9200",
        chunkIndex: "chunks",
        entityIndex: "entities",
      },
      { client }
    );

    await expect(
      layer.invalidateSourceRef("docs/x.md", "2026-09-03T00:00:00.000Z")
    ).rejects.toMatchObject({
      name: "PrecisionLayerError",
      message: expect.stringContaining("does not support source invalidation"),
    });
  });
});

/**
 * The production summary-index WRITE side: the only place a summary index is
 * ever created, because a read must never assume a derived index into
 * existence (that assumption is what would turn an unbuilt index into a
 * silently empty answer instead of a not-ready fact).
 */
describe("ElasticsearchPrecisionLayer.indexCommunitySummaries", () => {
  it("creates the summary index with IK analyzers and a queryable level, then bulk-indexes the reports", async () => {
    const client = fakeClient();
    const layer = summaryLayer(client);

    await layer.indexCommunitySummaries([
      summaryRow(),
      summaryRow("ledger-uuid-8", "8"),
    ]);

    expect(client.indices.create).toHaveBeenCalledTimes(1);
    const create = client.indices.create.mock.calls[0]?.[0] as {
      index: string;
      settings: Record<string, unknown>;
      mappings: { properties: Record<string, Record<string, unknown>> };
    };
    expect(create.index).toMatch(/^summaries-gen-\d$/);
    expect(JSON.stringify(create)).toContain("ik_max_word");
    expect(JSON.stringify(create)).toContain("ik_smart");
    expect(JSON.stringify(create)).toContain('"k1":1.4');
    expect(JSON.stringify(create)).toContain('"b":0.65');
    expect(create.mappings.properties.content).toEqual({
      type: "text",
      analyzer: "ik_index",
      search_analyzer: "ik_query",
      similarity: "iknow_bm25",
    });
    // The read cap filters on level, so it must be a numeric field.
    expect(create.mappings.properties.level).toEqual({ type: "integer" });
    expect(create.mappings.properties.id).toEqual({ type: "keyword" });
    expect(create.mappings.properties.community_id).toEqual({
      type: "keyword",
    });

    // The whole generation goes to the slot that was just created — never to
    // the name readers aim at, which is what keeps it unpublished until the
    // alias swap.
    expect(client.bulk).toHaveBeenCalledTimes(1);
    const bulk = client.bulk.mock.calls[0]?.[0] as {
      index: string;
      operations: unknown[];
    };
    expect(bulk.index).toBe(create.index);
    expect(bulk.operations).toEqual([
      { index: { _index: create.index, _id: "7" } },
      {
        id: "ledger-uuid-7",
        community_id: "7",
        content: "community report text",
        level: 3,
      },
      { index: { _index: create.index, _id: "8" } },
      {
        id: "ledger-uuid-8",
        community_id: "8",
        content: "community report text",
        level: 3,
      },
    ]);
  });

  it("fills the slot the live alias does not point at and repoints the alias", async () => {
    const client = fakeClient();
    client.indices.exists = vi.fn(
      async (request: Record<string, unknown>) => request.index === "summaries"
    );
    client.indices.getAlias = vi.fn(async () => ({
      "summaries-gen-1": { aliases: { summaries: {} } },
    }));
    const layer = summaryLayer(client);

    await layer.indexCommunitySummaries([summaryRow()]);

    expect(client.indices.create).toHaveBeenCalledTimes(1);
    expect(
      (client.indices.create.mock.calls[0]?.[0] as { index: string }).index
    ).toBe("summaries-gen-0");
    const swap = client.indices.updateAliases.mock.calls[0]?.[0] as {
      actions: unknown[];
    };
    // One atomic body: the previous generation stops being readable exactly
    // when the new one starts.
    expect(swap.actions).toEqual([
      { remove: { index: "*", alias: "summaries" } },
      { add: { index: "summaries-gen-0", alias: "summaries" } },
    ]);
  });

  it("retires a pre-alias physical index of the alias name in the same swap", async () => {
    const client = fakeClient();
    client.indices.exists = vi.fn(async () => true);
    const layer = summaryLayer(client);

    await layer.indexCommunitySummaries([summaryRow()]);

    const swap = client.indices.updateAliases.mock.calls[0]?.[0] as {
      actions: unknown[];
    };
    // An index and an alias cannot share a name, so the old build's index has
    // to go in the same call that publishes the slot.
    expect(swap.actions).toEqual([
      { remove_index: { index: "summaries" } },
      { add: { index: "summaries-gen-0", alias: "summaries" } },
    ]);
  });

  it("rebuilds the generation slot from scratch on every projection", async () => {
    const client = fakeClient();
    const layer = summaryLayer(client);

    await layer.indexCommunitySummaries([summaryRow()]);
    await layer.indexCommunitySummaries([summaryRow("ledger-uuid-8", "8")]);

    // Readiness memoization cannot skip a generation build: a slot that is
    // reused starts empty, or the previous generation would still be readable.
    expect(client.indices.create).toHaveBeenCalledTimes(2);
    expect(client.bulk).toHaveBeenCalledTimes(2);
  });

  it("short-circuits an empty row list without touching ES at all", async () => {
    const client = fakeClient();
    const layer = summaryLayer(client);

    await layer.indexCommunitySummaries([]);

    expect(client.indices.exists).not.toHaveBeenCalled();
    expect(client.indices.create).not.toHaveBeenCalled();
    expect(client.bulk).not.toHaveBeenCalled();
  });

  it("is the only path that creates the summary index; every read and lifecycle call leaves it alone", async () => {
    const client = fakeClientWithInvalidation({ kind: "ok" });
    const layer = summaryLayer(client);

    await layer.searchLexical("query text", { limit: 5, validAt: NOW });
    await layer.searchEntities("query text", 5);
    await layer.analyze("query text");
    await layer.invalidateSourceRef("docs/x.md", NOW);
    await layer.deleteEntities(["loser-1"]);
    await layer.deleteChunkIndex();
    await layer.deleteEntityIndex();
    await layer.indexChunks([chunk()]);
    await layer.indexEntities([
      { id: "entity-1", canonical_name: "n", aliases: [], type: "person" },
    ]);

    const created: string[] = [];
    const inspected: string[] = [];
    for (const call of client.indices.create.mock.calls) {
      created.push((call[0] as { index: string }).index);
    }
    for (const call of client.indices.exists.mock.calls) {
      inspected.push((call[0] as { index: string }).index);
    }
    // `chunks` may legitimately be created twice (the two delete calls clear
    // the readiness memo); what must never appear is the summary index.
    expect(new Set(created)).toEqual(new Set(["chunks", "entities"]));
    expect(inspected).not.toContain("summaries");

    await layer.indexCommunitySummaries([summaryRow()]);
    expect(client.indices.create.mock.calls.some(
      (call) => /^summaries-gen-\d$/.test((call[0] as { index: string }).index)
    )).toBe(true);
  });

  it("surfaces a failing summary bulk as a typed PrecisionLayerError", async () => {
    const client = fakeClient();
    client.bulk = vi.fn(async () => {
      throw new Error("summary bulk exploded");
    });
    const layer = summaryLayer(client);

    await expect(layer.indexCommunitySummaries([summaryRow()])).rejects.toMatchObject({
      name: "PrecisionLayerError",
      code: "STORAGE_ERROR",
      message: expect.stringContaining("summaries"),
    });
  });

  it("surfaces a summary index that cannot be created as a typed PrecisionLayerError", async () => {
    const client = fakeClient();
    client.indices.create = vi.fn(async () => {
      throw new Error("resource_already_exists");
    });
    const layer = summaryLayer(client);

    await expect(layer.indexCommunitySummaries([summaryRow()])).rejects.toMatchObject({
      name: "PrecisionLayerError",
      message: expect.stringMatching(/summary index "summaries-gen-\d"/),
    });
  });
});

/**
 * Issue #272: the write path must REPLACE the published generation, not upsert
 * into it. A community that dropped out of the generation stops being readable,
 * and a write that dies midway must leave readers on the previous COMPLETE
 * generation — never a half-old/half-new mix, which is what a per-community
 * upsert into the live index allows.
 */
describe("ElasticsearchPrecisionLayer summary generation replacement", () => {
  // Bulk batching is 1_000 documents per request, so a generation above that
  // size is written in several bulks: exactly the window where a midway
  // failure used to publish a partial generation.
  const OVER_TWO_BATCHES = Array.from({ length: 1_001 }, (_, i) => `c${i}`);

  function generation(communityIds: readonly string[]) {
    return communityIds.map((communityId) => ({
      id: `ledger-${communityId}`,
      community_id: communityId,
      content: "community report text",
      level: 1,
    }));
  }

  it("retires a community's document when it is absent from the new generation", async () => {
    const cluster = new FakeEsCluster();
    const layer = summaryLayer(cluster.client());

    await layer.indexCommunitySummaries(generation(["7", "99"]));
    expect(cluster.liveCommunityIds("summaries")).toEqual(["7", "99"]);

    await layer.indexCommunitySummaries(generation(["7"]));

    expect(cluster.liveCommunityIds("summaries")).toEqual(["7"]);
    // The read seam targets the same name readers do, so what is stored live
    // and what a report search answers can never drift apart.
    await expect(
      layer.searchCommunitySummariesLexical("community report", 5, 3)
    ).resolves.toEqual([
      {
        id: "ledger-7",
        communityId: "7",
        summary: "community report text",
        level: 1,
        score: 1,
      },
    ]);
  });

  it("keeps the previous complete generation readable when a bulk dies midway", async () => {
    const cluster = new FakeEsCluster();
    const layer = summaryLayer(cluster.client());
    await layer.indexCommunitySummaries(generation(OVER_TWO_BATCHES));
    // Two bulks published the first generation; of the next projection the
    // third bulk lands and the fourth dies.
    cluster.failNthBulk = 4;

    await expect(
      layer.indexCommunitySummaries(
        generation(OVER_TWO_BATCHES.map((id) => `fresh-${id}`))
      )
    ).rejects.toMatchObject({ name: "PrecisionLayerError" });

    // Readers still resolve exactly the old generation: none of the fresh
    // communities — which share no id with it — leaked into the live set.
    const readable = cluster.liveCommunityIds("summaries");
    expect(readable.filter((id) => id.startsWith("fresh-"))).toEqual([]);
    expect(readable).toHaveLength(OVER_TWO_BATCHES.length);
    expect(cluster.orphanIndices("summaries")).toEqual([]);
  });

  it("keeps the previous complete generation readable when the alias swap fails", async () => {
    const cluster = new FakeEsCluster();
    const layer = summaryLayer(cluster.client());
    await layer.indexCommunitySummaries(generation(["7", "8"]));
    cluster.failNextAliasUpdate = true;

    await expect(
      layer.indexCommunitySummaries(generation(["fresh"]))
    ).rejects.toMatchObject({ name: "PrecisionLayerError" });

    expect(cluster.liveCommunityIds("summaries")).toEqual(["7", "8"]);
    expect(cluster.orphanIndices("summaries")).toEqual([]);
  });

  it("leaves reads typed not-ready once the index is cleared", async () => {
    const cluster = new FakeEsCluster();
    const layer = summaryLayer(cluster.client());

    await layer.indexCommunitySummaries(generation(["7"]));
    await layer.deleteSummaryIndex();

    expect(cluster.indexNames()).toEqual([]);
    await expect(
      layer.searchCommunitySummariesLexical("community report", 5, 3)
    ).rejects.toMatchObject({
      message: expect.stringContaining("community_summary_index_failure"),
    });
  });
});

describe("ElasticsearchPrecisionLayer.deleteSummaryIndex", () => {
  it("removes every generation slot and the alias name itself, no-op when absent", async () => {
    const client = fakeClient();
    const layer = summaryLayer(client);

    await layer.deleteSummaryIndex();
    expect(client.indices.delete).not.toHaveBeenCalled();

    client.indices.exists = vi.fn(async () => true);
    await layer.deleteSummaryIndex();
    expect(
      client.indices.delete.mock.calls.map(
        (call) => (call[0] as { index: string }).index
      )
    ).toEqual(["summaries-gen-0", "summaries-gen-1", "summaries"]);
  });

  it("re-creates the index on the next write after a delete (readiness memo cleared)", async () => {
    const client = fakeClient();
    const layer = summaryLayer(client);

    await layer.indexCommunitySummaries([summaryRow()]);
    await layer.deleteSummaryIndex();
    await layer.indexCommunitySummaries([summaryRow()]);

    expect(client.indices.create).toHaveBeenCalledTimes(2);
  });
});

/**
 * The PRODUCTION global report-TEXT read seam. A read must never assume the
 * derived summary index into existence: an absent index is a not-ready fact
 * (typed with the community_summary_index_failure token), while an erroring
 * cluster is a transient arm failure (a plain PrecisionLayerError, no token).
 */
describe("ElasticsearchPrecisionLayer.searchCommunitySummariesLexical", () => {
  function summaryHit(
    overrides: Partial<{
      id: string;
      community_id: string;
      content: string;
      level: number;
    }> = {}
  ) {
    return {
      _id: "7",
      _score: 1.5,
      _source: {
        id: "ledger-uuid-7",
        community_id: "7",
        content: "community report text",
        level: 2,
        ...overrides,
      },
    };
  }

  /** A client whose summary index EXISTS and returns the given hits. */
  function presentClient(
    hits: unknown[],
    searchBehavior?: (req: Record<string, unknown>) => Promise<unknown>
  ): ElasticsearchClientLike {
    const client = fakeClient();
    client.indices.exists = vi.fn(async () => true);
    client.search =
      searchBehavior ??
      vi.fn(async () => ({ hits: { hits } }));
    return client;
  }

  it("maps a present-index hit to a CommunitySummaryRow keyed by ledger identity", async () => {
    const client = presentClient([summaryHit()]);
    const layer = summaryLayer(client);

    const rows = await layer.searchCommunitySummariesLexical("报告", 5, 2);

    expect(rows).toEqual([
      {
        id: "ledger-uuid-7",
        communityId: "7",
        summary: "community report text",
        level: 2,
        score: 1.5,
      },
    ]);
  });

  it("applies the level cap IN THE QUERY and honors limit as size, using the IK query analyzer", async () => {
    const client = presentClient([]);
    const layer = summaryLayer(client);

    await layer.searchCommunitySummariesLexical("报告 text", 3, 2);

    const request = client.search.mock.calls[0]?.[0] as {
      index: string;
      size: number;
      _source: string[];
      query: Record<string, unknown>;
    };
    expect(request.index).toBe("summaries");
    expect(request.size).toBe(3);
    expect(request._source).toEqual(["id", "community_id", "content", "level"]);
    const query = JSON.stringify(request.query);
    // The cap is a filter clause, so an over-grain report never re-enters
    // ranking regardless of its score.
    expect(query).toContain('"range":{"level":{"lte":2}}');
    expect(query).toContain("multi_match");
    expect(query).toContain("ik_query");
  });

  it("legitimately returns [] when the index exists but nothing matches", async () => {
    const client = presentClient([]);
    const layer = summaryLayer(client);

    await expect(
      layer.searchCommunitySummariesLexical("报告", 5, 2)
    ).resolves.toEqual([]);
  });

  it("short-circuits an empty query or a non-positive limit without touching ES", async () => {
    const client = fakeClient();
    const layer = summaryLayer(client);

    await expect(
      layer.searchCommunitySummariesLexical("   ", 5, 2)
    ).resolves.toEqual([]);
    await expect(
      layer.searchCommunitySummariesLexical("报告", 0, 2)
    ).resolves.toEqual([]);
    await expect(
      layer.searchCommunitySummariesLexical("报告", -3, 2)
    ).resolves.toEqual([]);

    expect(client.indices.exists).not.toHaveBeenCalled();
    expect(client.search).not.toHaveBeenCalled();
  });

  it("fails CLOSED (typed not-ready) when the summary index is absent, never a healthy empty", async () => {
    const client = fakeClient(); // indices.exists -> false by default
    const layer = summaryLayer(client);

    await expect(
      layer.searchCommunitySummariesLexical("报告", 5, 2)
    ).rejects.toMatchObject({
      name: "PrecisionLayerError",
      code: "STORAGE_ERROR",
      message: expect.stringContaining("community_summary_index_failure"),
    });
    // A not-ready read must never assume the index into existence.
    expect(client.indices.create).not.toHaveBeenCalled();
    expect(client.search).not.toHaveBeenCalled();
  });

  it("surfaces an erroring cluster (search) as a transient PrecisionLayerError, WITHOUT the not-ready token", async () => {
    const client = presentClient([], vi.fn(async () => {
      throw new Error("cluster down");
    }));
    const layer = summaryLayer(client);

    await expect(
      layer.searchCommunitySummariesLexical("报告", 5, 2)
    ).rejects.toMatchObject({
      name: "PrecisionLayerError",
      code: "STORAGE_ERROR",
      message: expect.stringContaining("cluster down"),
    });
    // Distinct from the refusal path: a transient failure carries NO token.
    const err = await layer
      .searchCommunitySummariesLexical("报告", 5, 2)
      .catch((e: unknown) => e as Error);
    expect((err as Error).message).not.toContain(
      "community_summary_index_failure"
    );
  });

  it("surfaces an availability probe that throws as a transient error, WITHOUT the token", async () => {
    const client = fakeClient();
    client.indices.exists = vi.fn(async () => {
      throw new Error("connection refused");
    });
    const layer = summaryLayer(client);

    const err = await layer
      .searchCommunitySummariesLexical("报告", 5, 2)
      .catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as { name?: string }).name).toBe("PrecisionLayerError");
    expect((err as Error).message).toContain("availability check failed");
    expect((err as Error).message).not.toContain(
      "community_summary_index_failure"
    );
    expect(client.indices.create).not.toHaveBeenCalled();
  });

  it("keeps concurrent reads independent: no shared buffer, no index creation", async () => {
    const client = fakeClient();
    let existsCalls = 0;
    client.indices.exists = vi.fn(async () => {
      existsCalls += 1;
      return true;
    });
    client.search = vi.fn(
      async (req: Record<string, unknown>) => {
        const size = typeof req.size === "number" ? req.size : 0;
        return {
          hits: {
            hits: Array.from({ length: size }, (_, i) =>
              summaryHit({ id: `ledger-${i}`, community_id: String(i) })
            ),
          },
        };
      }
    );
    const layer = summaryLayer(client);

    const [a, b] = await Promise.all([
      layer.searchCommunitySummariesLexical("first report", 2, 2),
      layer.searchCommunitySummariesLexical("second report", 3, 2),
    ]);

    // Each read re-probes presence (the readiness memo is the WRITE path's,
    // never populated or consumed by a read), and neither created an index.
    expect(existsCalls).toBe(2);
    expect(client.indices.create).not.toHaveBeenCalled();
    expect(a).toHaveLength(2);
    expect(b).toHaveLength(3);
    expect(a.map((r) => r.id)).toEqual(["ledger-0", "ledger-1"]);
  });
});
