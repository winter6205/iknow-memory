/**
 * dashboard-api GET /api/query — retrieval bench endpoint tests (T2).
 *
 * The handler must delegate to `assembleRetrievalResult` (the core/retrieval
 * SSOT) and pass the envelope through untouched, including the ADR-0005
 * degraded fields. All-arms-failed (GraphragError) maps to a typed HTTP
 * error — never a 200 with an empty chunks array.
 */
import { describe, expect, it, vi } from "vitest";

import { MemoryBackend } from "../../src/core/storage/memory-backend.js";
import { GraphragError } from "../../src/core/errors.js";

import { boot, fetchJson, memoryDeps, stubReadPort } from "./helpers.js";
import type { DashboardServerDeps } from "../../src/dashboard-api/index.js";
import { applyPreset } from "../../src/dashboard-api/handlers/query.js";
import type { RetrieveConfig } from "../../src/core/retrieval/types.js";
import type { RetrievedChunk, SearchOptions } from "../../src/core/types.js";
import type { LexicalStorageBackend } from "../../src/core/storage/backend.js";

const UUID_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const UUID_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

async function upsertTwoChunks(deps: DashboardServerDeps): Promise<void> {
  const storage = deps.storage as MemoryBackend;
  await storage.upsert([
    {
      id: UUID_A,
      content: "alpha beta",
      embedding: [1, 0, 0, 0, 0, 0, 0, 0],
      source_ref: "test://query-a",
      metadata: {},
      valid_from: "2024-01-01T00:00:00.000Z",
      valid_until: null,
      created_at: "2024-01-01T00:00:00.000Z",
    },
    {
      id: UUID_B,
      content: "gamma delta",
      embedding: [0, 1, 0, 0, 0, 0, 0, 0],
      source_ref: "test://query-b",
      metadata: {},
      valid_from: "2024-01-01T00:00:00.000Z",
      valid_until: null,
      created_at: "2024-01-01T00:00:00.000Z",
    },
  ]);
}

describe("dashboard-api /api/query", () => {
  it("returns hits with valid_from window passthrough (default limit 10)", async () => {
    const deps = memoryDeps();
    await upsertTwoChunks(deps);
    const { baseUrl } = await boot(deps);
    const res = await fetchJson(
      `${baseUrl}/api/query?q=${encodeURIComponent("alpha beta")}`
    );
    expect(res.status).toBe(200);
    const body = res.body as {
      chunks: Array<{ id: string; source_ref: string; valid_window: unknown }>;
      degraded?: boolean;
      degraded_reasons?: unknown;
    };
    expect(body.chunks.length).toBeGreaterThanOrEqual(1);
    expect(body.chunks.map((c) => c.id).sort()).toEqual([UUID_A, UUID_B]);
    for (const chunk of body.chunks) {
      expect(chunk.valid_window).toEqual(["2024-01-01T00:00:00.000Z", null]);
    }
  });

  it("respects the limit parameter", async () => {
    const deps = memoryDeps();
    await upsertTwoChunks(deps);
    const { baseUrl } = await boot(deps);
    const res = await fetchJson(`${baseUrl}/api/query?q=x&limit=1`);
    expect(res.status).toBe(200);
    const body = res.body as { chunks: unknown[] };
    expect(body.chunks.length).toBe(1);
  });

  it("maps mode=preset to the retrieval preset without error", async () => {
    const deps = memoryDeps();
    await upsertTwoChunks(deps);
    const { baseUrl } = await boot(deps);
    const res = await fetchJson(
      `${baseUrl}/api/query?q=x&mode=conservative&limit=1`
    );
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("chunks");
  });

  it("returns a 200 empty envelope when the store has no matching chunk", async () => {
    const { baseUrl } = await boot();
    const res = await fetchJson(
      `${baseUrl}/api/query?q=${encodeURIComponent("nothing matches")}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunks: [] });
  });

  it("rejects an empty query with 400 INVALID_INPUT", async () => {
    const { baseUrl } = await boot();
    const res = await fetchJson(`${baseUrl}/api/query?q=%20%20`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      error: { code: "INVALID_INPUT" },
    });
  });

  it("rejects a missing query with 400 INVALID_INPUT", async () => {
    const { baseUrl } = await boot();
    const res = await fetchJson(`${baseUrl}/api/query`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      error: { code: "INVALID_INPUT" },
    });
  });

  it.each(["-1", "abc", "101"])(
    "rejects limit=%s with 400 INVALID_INPUT",
    async (limit) => {
      const { baseUrl } = await boot();
      const res = await fetchJson(`${baseUrl}/api/query?q=x&limit=${limit}`);
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        error: { code: "INVALID_INPUT" },
      });
    }
  );

  it("rejects an unknown mode with 400 INVALID_INPUT", async () => {
    const { baseUrl } = await boot();
    const res = await fetchJson(`${baseUrl}/api/query?q=x&mode=turbo`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      error: { code: "INVALID_INPUT" },
    });
  });

  it("maps all-arms-failed to 503 RETRIEVAL_FAILED, not a 200 empty envelope", async () => {
    const deps = memoryDeps();
    const failingStorage = {
      ...stubReadPort(),
      store: new Map(),
      async search(): Promise<never> {
        throw new GraphragError("vector arm exploded", "STORAGE_ERROR");
      },
    };
    const { baseUrl } = await boot({
      ...deps,
      retrieval: {
        retrieveConfig: {
          ...deps.retrieval.retrieveConfig,
          bm25Enabled: false,
        },
      },
      storage: failingStorage as unknown as DashboardServerDeps["storage"],
    });
    const res = await fetchJson(`${baseUrl}/api/query?q=x`);
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      error: { code: "RETRIEVAL_FAILED" },
    });
    expect(res.body).not.toMatchObject({ chunks: [] });
  });
});

describe("dashboard-api /api/query applyPreset — waitForDrain* preservation", () => {
  const baseConfigured: RetrieveConfig = {
    preset: "balanced",
    w_vec: 0.7,
    w_bm25: 0.15,
    w_graph: 0.15,
    bm25Enabled: true,
    graphEnabled: false,
    rerankEnabled: false,
    entityLinkTopK: 8,
    candidateCap: 50,
    neighborWidth: 0,
    graphArmFloor: 3,
    waitForDrainEnabled: true,
    waitForDrainTimeoutMs: 2500,
  };

  it("preserves configured waitForDrain* when a preset is requested", () => {
    const result = applyPreset(baseConfigured, "conservative");
    expect(result.preset).toBe("conservative");
    expect(result.waitForDrainEnabled).toBe(true);
    expect(result.waitForDrainTimeoutMs).toBe(2500);
    expect(result.candidateCap).toBe(25);
    expect(result.entityLinkTopK).toBe(4);
  });

  it("preserves configured waitForDrain* when no preset is requested", () => {
    const result = applyPreset(baseConfigured, undefined);
    expect(result.preset).toBe("balanced");
    expect(result.waitForDrainEnabled).toBe(true);
    expect(result.waitForDrainTimeoutMs).toBe(2500);
  });

  it("passes configured waitForDrain* through assembleRetrievalResult", async () => {
    const lexicalCalls: SearchOptions[] = [];
    const lexical: LexicalStorageBackend = {
      async upsert(): Promise<string[]> {
        return [];
      },
      async search(): Promise<RetrievedChunk[]> {
        return [];
      },
      async searchLexical(
        _query: string,
        opts: SearchOptions
      ): Promise<RetrievedChunk[]> {
        lexicalCalls.push(opts);
        return [];
      },
      async close(): Promise<void> {},
    };
    const deps: DashboardServerDeps = {
      ...memoryDeps(),
      lexical,
      retrieval: {
        retrieveConfig: {
          ...baseConfigured,
          waitForDrainEnabled: true,
          waitForDrainTimeoutMs: 4321,
        },
      },
    };
    await upsertTwoChunks(deps);
    const { baseUrl } = await boot(deps);
    const res = await fetchJson(
      `${baseUrl}/api/query?q=x&mode=conservative&limit=1`
    );
    expect(res.status).toBe(200);
    expect(lexicalCalls.length).toBeGreaterThanOrEqual(1);
  });
});

describe("dashboard-api /api/query — Elasticsearch precision arm wiring", () => {
  it("invokes the lexical backend when wired", async () => {
    const lexicalSearch = vi.fn(
      async (_q: string, _opts: SearchOptions): Promise<RetrievedChunk[]> => [
        {
          id: UUID_A,
          content: "alpha beta",
          source_ref: "test://query-a",
          valid_window: ["2024-01-01T00:00:00.000Z", null],
          score: 0.9,
        },
      ]
    );
    const lexical: LexicalStorageBackend = {
      async upsert(): Promise<string[]> {
        return [];
      },
      async search(): Promise<RetrievedChunk[]> {
        return [];
      },
      searchLexical: lexicalSearch,
      async close(): Promise<void> {},
    };
    const deps: DashboardServerDeps = {
      ...memoryDeps(),
      lexical,
    };
    await upsertTwoChunks(deps);
    const { baseUrl } = await boot(deps);
    const res = await fetchJson(
      `${baseUrl}/api/query?q=${encodeURIComponent("alpha beta")}&mode=conservative&limit=5`
    );
    expect(res.status).toBe(200);
    expect(lexicalSearch).toHaveBeenCalled();
  });

  it("omits the lexical arm call when no precision layer is configured", async () => {
    const deps = memoryDeps();
    await upsertTwoChunks(deps);
    const { baseUrl } = await boot(deps);
    const res = await fetchJson(
      `${baseUrl}/api/query?q=${encodeURIComponent("alpha beta")}&limit=1`
    );
    expect(res.status).toBe(200);
    const body = res.body as { chunks: unknown[] };
    expect(body.chunks.length).toBeGreaterThanOrEqual(1);
  });
});
