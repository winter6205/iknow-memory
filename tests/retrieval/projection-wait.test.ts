import { describe, expect, it } from "vitest";
import { assembleRetrievalResult } from "../../src/core/retrieval/index.js";
import { GraphragError } from "../../src/core/errors.js";
import type {
  ProjectionDrainWaiter,
  RetrieveConfig,
} from "../../src/core/retrieval/types.js";
import type { EmbeddingClient } from "../../src/core/embedder.js";
import type {
  ChunkRecord,
  RetrievedChunk,
  SearchOptions,
  StorageBackend,
} from "../../src/core/types.js";
import {
  waitForProjectionDrain,
  type OutboxClient,
} from "../../src/core/storage/projection-outbox.js";

const NOW = "2026-08-28T00:00:00.000Z";

const BASE_CONFIG: RetrieveConfig = {
  preset: "balanced",
  w_vec: 1,
  w_bm25: 1,
  w_graph: 1,
  bm25Enabled: false,
  graphEnabled: false,
  rerankEnabled: false,
  entityLinkTopK: 8,
  candidateCap: 50,
  neighborWidth: 0,
  graphArmFloor: 3,
  waitForDrainEnabled: false,
  waitForDrainTimeoutMs: 10,
};

class FixedEmbedder implements EmbeddingClient {
  async embed(_texts: string[]): Promise<number[][]> {
    return [[1]];
  }
}

class WaitBackend implements StorageBackend {
  waitCalls = 0;
  readonly chunks: RetrievedChunk[] = [
    {
      id: "pre-wait-1",
      content: "first",
      source_ref: "source/1",
      valid_window: [NOW, null],
      score: 1,
    },
    {
      id: "pre-wait-2",
      content: "second",
      source_ref: "source/2",
      valid_window: [NOW, null],
      score: 0.5,
    },
  ];

  async upsert(_chunks: ChunkRecord[]): Promise<string[]> {
    return [];
  }

  async search(
    _embedding: number[],
    _opts: SearchOptions
  ): Promise<RetrievedChunk[]> {
    return this.chunks;
  }

  async close(): Promise<void> {}

  async waitForProjectionDrain(_timeoutMs: number): Promise<void> {
    this.waitCalls += 1;
  }
}

function waiter(
  waitForProjectionDrain: ProjectionDrainWaiter["waitForProjectionDrain"]
): ProjectionDrainWaiter {
  return { waitForProjectionDrain };
}

describe("optional retrieve projection drain wait", () => {
  it("does not wait when the feature is off", async () => {
    let calls = 0;
    const result = await assembleRetrievalResult(
      { query: "q", validAt: NOW, limit: 2 },
      {
        embedder: new FixedEmbedder(),
        storage: new WaitBackend(),
        retrieveConfig: BASE_CONFIG,
        projectionDrain: waiter(async () => {
          calls += 1;
        }),
      }
    );

    expect(result.chunks.map((chunk) => chunk.id)).toEqual([
      "pre-wait-1",
      "pre-wait-2",
    ]);
    expect(result).not.toHaveProperty("degraded");
    expect(calls).toBe(0);
  });

  it("waits successfully when enabled without degrading the ranking", async () => {
    const storage = new WaitBackend();
    const result = await assembleRetrievalResult(
      { query: "q", validAt: NOW, limit: 2 },
      {
        embedder: new FixedEmbedder(),
        storage,
        retrieveConfig: {
          ...BASE_CONFIG,
          waitForDrainEnabled: true,
        },
      }
    );

    expect(result.chunks.map((chunk) => chunk.id)).toEqual([
      "pre-wait-1",
      "pre-wait-2",
    ]);
    expect(result).not.toHaveProperty("degraded");
    expect(storage.waitCalls).toBe(1);
  });

  it("returns the pre-wait ranking and degraded when drain fails", async () => {
    const result = await assembleRetrievalResult(
      { query: "q", validAt: NOW, limit: 2 },
      {
        embedder: new FixedEmbedder(),
        storage: new WaitBackend(),
        retrieveConfig: {
          ...BASE_CONFIG,
          waitForDrainEnabled: true,
        },
        projectionDrain: waiter(async () => {
          throw new Error("projection drain unavailable");
        }),
      }
    );

    expect(result.chunks.map((chunk) => chunk.id)).toEqual([
      "pre-wait-1",
      "pre-wait-2",
    ]);
    expect(result.degraded).toBe(true);
  });

  it("returns the pre-wait ranking and degraded when drain times out", async () => {
    const result = await assembleRetrievalResult(
      { query: "q", validAt: NOW, limit: 2 },
      {
        embedder: new FixedEmbedder(),
        storage: new WaitBackend(),
        retrieveConfig: {
          ...BASE_CONFIG,
          waitForDrainEnabled: true,
          waitForDrainTimeoutMs: 1,
        },
        projectionDrain: waiter(() => new Promise<void>(() => {})),
      }
    );

    expect(result.chunks.map((chunk) => chunk.id)).toEqual([
      "pre-wait-1",
      "pre-wait-2",
    ]);
    expect(result.degraded).toBe(true);
  });
});

describe("projection outbox wait seam", () => {
  it("observes pending rows until the external drain clears them", async () => {
    const counts = [
      { pending: 1, failed: 0 },
      { pending: 0, failed: 0 },
    ];
    const queries: string[] = [];
    const client: OutboxClient = {
      async query(text: string) {
        queries.push(text);
        return {
          rows: Object.entries(counts.shift()!).map(([status, count]) => ({
            status,
            count,
          })),
        };
      },
    };

    await waitForProjectionDrain(client, 100, 0);

    expect(queries).toHaveLength(2);
    expect(queries.every((query) => query.includes("SELECT status"))).toBe(
      true
    );
  });

  it("reports failed intents as a drain error without writing", async () => {
    const queries: string[] = [];
    const client: OutboxClient = {
      async query(text: string) {
        queries.push(text);
        return { rows: [{ status: "failed", count: 1 }] };
      },
    };

    const rejection = waitForProjectionDrain(client, 100);
    await expect(rejection).rejects.toMatchObject({
      name: "GraphragError",
      code: "STORAGE_ERROR",
    });
    await expect(rejection).rejects.toBeInstanceOf(GraphragError);
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain("SELECT status");
  });

  it("reports a pending timeout as a storage error", async () => {
    const client: OutboxClient = {
      async query(text: string) {
        expect(text).toContain("SELECT status");
        return { rows: [{ status: "pending", count: 1 }] };
      },
    };

    await expect(waitForProjectionDrain(client, 0)).rejects.toMatchObject({
      name: "GraphragError",
      code: "STORAGE_ERROR",
    });
  });
});
