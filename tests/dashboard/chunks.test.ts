/**
 * dashboard-api chunk/entity list + detail (T3).
 *
 * Data via StorageReadPort only. Memory empty ledger is 200 + empty pages,
 * not 404 (PR 187 skipped these routes in memory mode). Unknown id is typed.
 * Neo4j is not required.
 */
import { describe, expect, it } from "vitest";

import { MemoryBackend } from "../../src/core/storage/memory-backend.js";
import { GraphragError } from "../../src/core/errors.js";
import type { StorageEntityView } from "../../src/core/types.js";

import { boot, fetchJson, memoryDeps, stubReadPort } from "./helpers.js";
import type { DashboardServerDeps } from "../../src/dashboard-api/index.js";

const UUID_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const UUID_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const UUID_C = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const ENT_A = "11111111-1111-1111-1111-111111111111";
const ENT_B = "22222222-2222-2222-2222-222222222222";

async function upsertTwoChunks(deps: DashboardServerDeps): Promise<void> {
  const storage = deps.storage as MemoryBackend;
  await storage.upsert([
    {
      id: UUID_A,
      content: "alpha",
      embedding: [1, 0, 0, 0, 0, 0, 0, 0],
      source_ref: "test://a",
      metadata: {},
      valid_from: "2024-01-01T00:00:00.000Z",
      valid_until: null,
      created_at: "2024-01-01T00:00:00.000Z",
    },
    {
      id: UUID_B,
      content: "beta",
      embedding: [0, 1, 0, 0, 0, 0, 0, 0],
      source_ref: "test://b",
      metadata: {},
      valid_from: "2024-01-02T00:00:00.000Z",
      valid_until: null,
      created_at: "2024-01-02T00:00:00.000Z",
    },
  ]);
}

const ENTITY_ROWS: StorageEntityView[] = [
  {
    id: ENT_A,
    canonical_name: "Alice",
    type: "person",
    retired: false,
    aliases: ["Alice A."],
  },
  {
    id: ENT_B,
    canonical_name: "Acme",
    type: "system",
    retired: false,
    aliases: [],
  },
];

function entityReadPort(
  entities: StorageEntityView[]
): DashboardServerDeps["storage"] {
  return stubReadPort({
    async listEntities(opts?: { limit?: number; offset?: number }) {
      const limit = opts?.limit ?? 20;
      const offset = opts?.offset ?? 0;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new GraphragError("bad limit", "INVALID_INPUT");
      }
      return {
        items: entities.slice(offset, offset + limit),
        total: entities.length,
        limit,
        offset,
      };
    },
    async getEntity(id: string) {
      if (typeof id !== "string" || id.trim() === "") {
        return { ok: false as const, code: "INVALID_INPUT" as const };
      }
      const value = entities.find((e) => e.id === id);
      return value === undefined
        ? { ok: false as const, code: "NOT_FOUND" as const }
        : { ok: true as const, value };
    },
  }) as DashboardServerDeps["storage"];
}

describe("dashboard-api /api/chunks (memory empty)", () => {
  it("registers the list route and returns an empty page, not 404", async () => {
    const { baseUrl } = await boot();
    const res = await fetchJson(`${baseUrl}/api/chunks`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      items: [],
      total: 0,
      limit: 20,
      offset: 0,
    });
  });

  it("returns 404 NOT_FOUND for an unknown chunk id", async () => {
    const { baseUrl } = await boot();
    const res = await fetchJson(`${baseUrl}/api/chunks/${UUID_C}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: { code: "NOT_FOUND" } });
    const body = res.body as { error: { message: string } };
    expect(body.error.message).not.toMatch(/no handler/);
  });
});

describe("dashboard-api /api/chunks (memory non-empty)", () => {
  it("lists chunks with applied limit/offset echoed", async () => {
    const deps = memoryDeps();
    await upsertTwoChunks(deps);
    const { baseUrl } = await boot(deps);
    const res = await fetchJson(`${baseUrl}/api/chunks?limit=1&offset=1`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      items: [{ id: UUID_B, content: "beta" }],
      limit: 1,
      offset: 1,
      total: 2,
    });
  });

  it("returns chunk detail for a known id", async () => {
    const deps = memoryDeps();
    await upsertTwoChunks(deps);
    const { baseUrl } = await boot(deps);
    const res = await fetchJson(`${baseUrl}/api/chunks/${UUID_A}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: UUID_A, content: "alpha" });
  });

  it("returns an empty items array when offset is past the end", async () => {
    const { baseUrl } = await boot();
    const res = await fetchJson(`${baseUrl}/api/chunks?offset=500`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ items: [], total: 0, offset: 500 });
  });

  it.each(["-1", "abc", "1001"])(
    "rejects limit=%s with 400 INVALID_INPUT",
    async (limit) => {
      const { baseUrl } = await boot();
      const res = await fetchJson(`${baseUrl}/api/chunks?limit=${limit}`);
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: { code: "INVALID_INPUT" } });
    }
  );

  it("rejects a negative offset with 400 INVALID_INPUT", async () => {
    const { baseUrl } = await boot();
    const res = await fetchJson(`${baseUrl}/api/chunks?offset=-3`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: "INVALID_INPUT" } });
  });
});

describe("dashboard-api /api/entities", () => {
  it("registers the list route in memory mode as an empty page", async () => {
    const { baseUrl } = await boot();
    const res = await fetchJson(`${baseUrl}/api/entities`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      items: [],
      total: 0,
      limit: 20,
      offset: 0,
    });
  });

  it("returns 404 NOT_FOUND for an unknown entity id in memory mode", async () => {
    const { baseUrl } = await boot();
    const res = await fetchJson(`${baseUrl}/api/entities/${ENT_B}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: { code: "NOT_FOUND" } });
    const body = res.body as { error: { message: string } };
    expect(body.error.message).not.toMatch(/no handler/);
  });

  it("lists entities from StorageReadPort when the port is non-empty", async () => {
    const { baseUrl } = await boot({
      ...memoryDeps(),
      storage: entityReadPort(ENTITY_ROWS),
    });
    const res = await fetchJson(`${baseUrl}/api/entities?limit=1&offset=1`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      items: [{ id: ENT_B, canonical_name: "Acme" }],
      limit: 1,
      offset: 1,
      total: 2,
    });
  });

  it("returns entity detail for a known id on StorageReadPort", async () => {
    const { baseUrl } = await boot({
      ...memoryDeps(),
      storage: entityReadPort(ENTITY_ROWS),
    });
    const res = await fetchJson(`${baseUrl}/api/entities/${ENT_A}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: ENT_A, canonical_name: "Alice" });
  });

  it("rejects limit=1001 with 400 INVALID_INPUT", async () => {
    const { baseUrl } = await boot();
    const res = await fetchJson(`${baseUrl}/api/entities?limit=1001`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: "INVALID_INPUT" } });
  });
});
