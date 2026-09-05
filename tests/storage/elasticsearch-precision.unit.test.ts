import { describe, expect, it, vi } from "vitest";

import {
  ElasticsearchPrecisionLayer,
  type ElasticsearchClientLike,
} from "../../src/core/storage/elasticsearch-precision.js";
import type { ChunkRecord } from "../../src/core/types.js";

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
