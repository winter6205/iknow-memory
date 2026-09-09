/**
 * dashboard-api GET /api/timeline (T3) — valid_window + invalidation events.
 *
 * Memory empty ledger is 200 + empty page (route registered). Non-empty
 * uses MemoryBackend + reserved invalidation metadata. Neo4j is not required.
 */
import { describe, expect, it } from "vitest";

import { MemoryBackend } from "../../src/core/storage/memory-backend.js";

import { boot, fetchJson, memoryDeps, stubReadPort } from "./helpers.js";
import type { DashboardServerDeps } from "../../src/dashboard-api/index.js";

const UUID_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const UUID_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

async function seedTimeline(deps: DashboardServerDeps): Promise<void> {
  const storage = deps.storage as MemoryBackend;
  await storage.upsert([
    {
      id: UUID_A,
      content: "open",
      embedding: [1, 0, 0, 0, 0, 0, 0, 0],
      source_ref: "test://a",
      metadata: {
        __iknow_content_invalidations: [
          {
            chunk_id: UUID_A,
            invalidated_at: "2024-06-01T00:00:00.000Z",
            triggered_by: "operator:x",
          },
        ],
      },
      valid_from: "2024-01-01T00:00:00.000Z",
      valid_until: null,
      created_at: "2024-01-01T00:00:00.000Z",
    },
    {
      id: UUID_B,
      content: "closed",
      embedding: [0, 1, 0, 0, 0, 0, 0, 0],
      source_ref: "test://b",
      metadata: {},
      valid_from: "2024-02-01T00:00:00.000Z",
      valid_until: "2024-12-31T00:00:00.000Z",
      created_at: "2024-02-01T00:00:00.000Z",
    },
  ]);
}

describe("dashboard-api /api/timeline", () => {
  it("registers the route in memory mode and returns an empty page", async () => {
    const { baseUrl } = await boot();
    const res = await fetchJson(`${baseUrl}/api/timeline`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      items: [],
      total: 0,
      limit: 20,
      offset: 0,
    });
  });

  it("merges chunk windows and invalidation events, sorted by time", async () => {
    const deps = memoryDeps();
    await seedTimeline(deps);
    const { baseUrl } = await boot(deps);
    const res = await fetchJson(`${baseUrl}/api/timeline`);
    expect(res.status).toBe(200);
    const body = res.body as {
      items: Array<{ kind: string; at: string; chunk_id: string }>;
      limit: number;
      offset: number;
      total: number;
    };
    expect(body.limit).toBe(20);
    expect(body.offset).toBe(0);
    expect(body.total).toBe(4);
    expect(body.items.map((i) => [i.kind, i.at])).toEqual([
      ["chunk_valid_from", "2024-01-01T00:00:00.000Z"],
      ["chunk_valid_from", "2024-02-01T00:00:00.000Z"],
      ["invalidation", "2024-06-01T00:00:00.000Z"],
      ["chunk_valid_until", "2024-12-31T00:00:00.000Z"],
    ]);
    expect(body.items[2]).toMatchObject({
      chunk_id: UUID_A,
      triggered_by: "operator:x",
      source_ref: "test://a",
    });
  });

  it("paginates across the merged event list", async () => {
    const deps = memoryDeps();
    await seedTimeline(deps);
    const { baseUrl } = await boot(deps);
    const res = await fetchJson(`${baseUrl}/api/timeline?limit=2&offset=1`);
    expect(res.status).toBe(200);
    const body = res.body as {
      items: Array<{ kind: string }>;
      limit: number;
      offset: number;
    };
    expect(body.limit).toBe(2);
    expect(body.offset).toBe(1);
    expect(body.items.map((i) => i.kind)).toEqual([
      "chunk_valid_from",
      "invalidation",
    ]);
  });

  it("rejects a negative offset with 400 INVALID_INPUT", async () => {
    const { baseUrl } = await boot();
    const res = await fetchJson(`${baseUrl}/api/timeline?offset=-2`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: "INVALID_INPUT" } });
  });

  it("maps a StorageReadPort failure to 503 STORAGE_ERROR", async () => {
    const storage = stubReadPort({
      async listTimeline(): Promise<never> {
        throw new Error("boom");
      },
    });
    const { baseUrl } = await boot({
      ...memoryDeps(),
      storage: storage as unknown as DashboardServerDeps["storage"],
    });
    const res = await fetchJson(`${baseUrl}/api/timeline`);
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: { code: "STORAGE_ERROR" } });
  });
});
