import { describe, expect, it } from "vitest";
import { createRetrieveHandler } from "../../src/tools/retrieve.js";
import type { EmbeddingClient } from "../../src/core/embedder.js";
import type {
  ChunkRecord,
  RetrievedChunk,
  SearchOptions,
  StorageBackend,
} from "../../src/core/types.js";
import type { RetrieveConfig } from "../../src/core/retrieval/types.js";
import type { ToolResult } from "../../src/tools/registry.js";

const CFG: RetrieveConfig = {
  preset: "balanced",
  w_vec: 1,
  w_bm25: 1,
  w_graph: 1,
  bm25Enabled: false,
  graphEnabled: false,
  rerankEnabled: false,
  entityLinkTopK: 8,
  candidateCap: 50,
  neighborWidth: 1,
  graphArmFloor: 3,
};

const CHUNKS: ChunkRecord[] = [
  chunk("left", "2024-01-01T00:00:00.000Z"),
  chunk("middle", "2024-01-01T00:01:00.000Z"),
  chunk("right", "2024-01-01T00:02:00.000Z"),
];

class NeighborChunkBackend implements StorageBackend {
  readonly events: string[] = [];
  neighborError: Error | undefined;
  readonly neighborCalls: Array<{
    ids: readonly string[];
    width: number;
  }> = [];

  async upsert(_chunks: ChunkRecord[]): Promise<string[]> {
    return [];
  }

  async search(
    _embedding: number[],
    opts: SearchOptions
  ): Promise<RetrievedChunk[]> {
    return [toRetrieved(CHUNKS[1]!)].slice(0, opts.limit);
  }

  async chunksByChunkIds(
    ids: readonly string[],
    _validAt: string,
    width: number
  ): Promise<RetrievedChunk[]> {
    this.events.push("neighbors");
    this.neighborCalls.push({ ids, width });
    if (this.neighborError !== undefined) throw this.neighborError;
    const selected = new Set(ids);
    const rows: RetrievedChunk[] = [];
    for (const target of CHUNKS) {
      if (!selected.has(target.id)) continue;
      const position = CHUNKS.indexOf(target);
      for (
        let i = Math.max(0, position - width);
        i <= Math.min(CHUNKS.length - 1, position + width);
        i += 1
      ) {
        rows.push(toRetrieved(CHUNKS[i]!));
      }
    }
    return rows;
  }

  async close(): Promise<void> {}
}

class FixedEmbedder implements EmbeddingClient {
  async embed(_texts: string[]): Promise<number[][]> {
    return [[1]];
  }
}

function chunk(id: string, createdAt: string): ChunkRecord {
  return {
    id,
    content: id,
    embedding: [1],
    source_ref: "source/document",
    metadata: {},
    valid_from: "2024-01-01T00:00:00.000Z",
    valid_until: null,
    created_at: createdAt,
  };
}

function toRetrieved(row: ChunkRecord): RetrievedChunk {
  return {
    id: row.id,
    content: row.content,
    source_ref: row.source_ref,
    valid_window: [row.valid_from, row.valid_until],
    score: 1,
  };
}

function parseBody(result: ToolResult): { chunks: RetrievedChunk[] } {
  const text = result.content[0]?.text;
  if (typeof text !== "string") throw new Error("expected text content");
  return JSON.parse(text) as { chunks: RetrievedChunk[] };
}

describe("neighbor chunk evidence", () => {
  it("expands a middle hit to both same-source neighbors", async () => {
    const storage = new NeighborChunkBackend();
    const handler = createRetrieveHandler({
      embedder: new FixedEmbedder(),
      storage,
      retrieveConfig: { ...CFG, rerankEnabled: true },
      reranker: {
        async permute(_query, candidates) {
          storage.events.push("rerank");
          return candidates.map((candidate) => candidate.id);
        },
      },
    });

    const body = parseBody(await handler({ query: "middle", limit: 3 }));

    expect(body.chunks.map((item) => item.id)).toEqual([
      "middle",
      "left",
      "right",
    ]);
    expect(body.chunks.map((item) => item.valid_window)).toEqual([
      ["2024-01-01T00:00:00.000Z", null],
      ["2024-01-01T00:00:00.000Z", null],
      ["2024-01-01T00:00:00.000Z", null],
    ]);
    expect(storage.neighborCalls).toEqual([{ ids: ["middle"], width: 1 }]);
    expect(storage.events).toEqual(["rerank", "neighbors"]);
  });

  it("keeps ranked output identical and does not read neighbors when width is zero", async () => {
    const storage = new NeighborChunkBackend();
    const handler = createRetrieveHandler({
      embedder: new FixedEmbedder(),
      storage,
      retrieveConfig: CFG,
    });

    const body = parseBody(
      await handler({ query: "middle", limit: 3, preset: "conservative" })
    );

    expect(body.chunks.map((item) => item.id)).toEqual(["middle"]);
    expect(storage.neighborCalls).toEqual([]);
  });

  it("keeps ranked output and marks degraded when the neighbor read fails", async () => {
    const storage = new NeighborChunkBackend();
    storage.neighborError = new Error("postgres unavailable");
    const handler = createRetrieveHandler({
      embedder: new FixedEmbedder(),
      storage,
      retrieveConfig: CFG,
    });

    const body = parseBody(await handler({ query: "middle", limit: 3 }));

    expect(body.chunks.map((item) => item.id)).toEqual(["middle"]);
    expect(body).toHaveProperty("degraded", true);
  });
});
