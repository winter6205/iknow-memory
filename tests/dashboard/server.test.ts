/**
 * dashboard-api server — bind + health + stats + envelope (T2).
 */
import { describe, expect, it } from "vitest";

import { MemoryBackend } from "../../src/core/storage/memory-backend.js";
import { GraphragError } from "../../src/core/errors.js";
import { ConfigError } from "../../src/config.js";

import { boot, fetchJson, memoryDeps, stubReadPort, track } from "./helpers.js";
import {
  createDashboardServer,
  readDashboardConfig,
  DEFAULT_DASHBOARD_HOST,
  DEFAULT_DASHBOARD_PORT,
  type DashboardServerDeps,
} from "../../src/dashboard-api/index.js";

describe("dashboard-api /api/health", () => {
  it("returns ok + storage mode in memory mode", async () => {
    const { baseUrl } = await boot();
    const res = await fetchJson(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "ok",
      storage: "memory",
      version: "test-0.0.0",
    });
  });

  it("reports pgvector mode when configured", async () => {
    const deps = memoryDeps();
    const listening = await boot({ ...deps, storageMode: "pgvector" });
    const res = await fetchJson(`${listening.baseUrl}/api/health`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok", storage: "pgvector" });
  });
});

describe("dashboard-api /api/stats", () => {
  it("returns zeros for an empty memory store via StorageReadPort", async () => {
    const { baseUrl } = await boot();
    const res = await fetchJson(`${baseUrl}/api/stats`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      chunks: 0,
      entities: 0,
      invalidations: 0,
    });
  });

  it("reflects chunk counts from the storage backend", async () => {
    const deps = memoryDeps();
    const storage = deps.storage as MemoryBackend;
    await storage.upsert([
      {
        id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        content: "first",
        embedding: [1, 0, 0, 0, 0, 0, 0, 0],
        source_ref: "test://stats",
        metadata: {},
        valid_from: "2024-01-01T00:00:00.000Z",
        valid_until: null,
        created_at: "2024-01-01T00:00:00.000Z",
      },
      {
        id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        content: "second",
        embedding: [0, 1, 0, 0, 0, 0, 0, 0],
        source_ref: "test://stats",
        metadata: {},
        valid_from: "2024-01-01T00:00:00.000Z",
        valid_until: null,
        created_at: "2024-01-01T00:00:00.000Z",
      },
    ]);
    const { baseUrl } = await boot(deps);
    const res = await fetchJson(`${baseUrl}/api/stats`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      chunks: 2,
      entities: 0,
      invalidations: 0,
    });
  });

  it("returns a 5xx envelope when StorageReadPort.counts throws", async () => {
    const failingStorage = stubReadPort({
      async counts(): Promise<never> {
        throw new GraphragError("postgres unavailable", "STORAGE_ERROR");
      },
    });
    const { baseUrl } = await boot({
      ...memoryDeps(),
      storage: failingStorage as unknown as DashboardServerDeps["storage"],
    });
    const res = await fetchJson(`${baseUrl}/api/stats`);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      error: { code: "STORAGE_ERROR", message: "postgres unavailable" },
    });
  });
});

describe("dashboard-api error envelope", () => {
  it("404 on unknown paths uses the standard envelope shape", async () => {
    const { baseUrl } = await boot();
    const res = await fetchJson(`${baseUrl}/api/nope`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: { code: "NOT_FOUND", message: "no handler for /api/nope" },
    });
  });

  it("405 on wrong method against a known path", async () => {
    const { baseUrl } = await boot();
    const res = await fetchJson(`${baseUrl}/api/health`, {
      method: "POST",
    });
    expect(res.status).toBe(405);
    expect(res.body).toMatchObject({
      error: { code: "METHOD_NOT_ALLOWED" },
    });
  });

  it("does not register a maintenance write route", async () => {
    const { baseUrl } = await boot();
    const res = await fetchJson(`${baseUrl}/api/maintenance`, {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });

  it("error message does not leak pg connection strings", async () => {
    const connStr = "postgresql://user:supersecret@db.example.test:5432/iknow";
    const throwingStorage = stubReadPort({
      async counts(): Promise<never> {
        throw new Error(`connect ECONNREFUSED ${connStr} (node id=node-1)`);
      },
    });
    const { baseUrl } = await boot({
      ...memoryDeps(),
      storage: throwingStorage as unknown as DashboardServerDeps["storage"],
    });
    const res = await fetchJson(`${baseUrl}/api/stats`);
    expect(res.status).toBe(503);
    const body = res.body as { error: { message: string } };
    expect(body.error.message).not.toContain("supersecret");
    expect(body.error.message).not.toContain(connStr);
  });
});

describe("dashboard-api binding", () => {
  it("listens on 127.0.0.1 when the test harness binds the factory server", async () => {
    const deps = memoryDeps();
    const server = createDashboardServer({
      ...deps,
      host: "127.0.0.1",
      port: 0,
    });
    const listening = await track(server);
    expect(listening.baseUrl.startsWith("http://127.0.0.1:")).toBe(true);
    const addr = listening.server.address();
    expect(addr).not.toBeNull();
    expect(typeof addr).toBe("object");
    expect((addr as { address: string }).address).toBe("127.0.0.1");
  });

  it("defaults API host to loopback and port away from the SPA 18868", () => {
    const savedHost = process.env.GRAPHRAG_MEMORY_DASHBOARD_HOST;
    const savedPort = process.env.GRAPHRAG_MEMORY_DASHBOARD_PORT;
    delete process.env.GRAPHRAG_MEMORY_DASHBOARD_HOST;
    delete process.env.GRAPHRAG_MEMORY_DASHBOARD_PORT;
    try {
      const cfg = readDashboardConfig();
      expect(cfg.host).toBe("127.0.0.1");
      expect(cfg.host).toBe(DEFAULT_DASHBOARD_HOST);
      expect(cfg.port).toBe(DEFAULT_DASHBOARD_PORT);
      expect(cfg.port).not.toBe(18868);
    } finally {
      if (savedHost === undefined)
        delete process.env.GRAPHRAG_MEMORY_DASHBOARD_HOST;
      else process.env.GRAPHRAG_MEMORY_DASHBOARD_HOST = savedHost;
      if (savedPort === undefined)
        delete process.env.GRAPHRAG_MEMORY_DASHBOARD_PORT;
      else process.env.GRAPHRAG_MEMORY_DASHBOARD_PORT = savedPort;
    }
  });

  it("rejects a non-loopback host (SC1)", () => {
    const saved = process.env.GRAPHRAG_MEMORY_DASHBOARD_HOST;
    process.env.GRAPHRAG_MEMORY_DASHBOARD_HOST = "0.0.0.0";
    try {
      expect(() => readDashboardConfig()).toThrow(ConfigError);
      expect(() => readDashboardConfig()).toThrow(/127\.0\.0\.1/);
    } finally {
      if (saved === undefined)
        delete process.env.GRAPHRAG_MEMORY_DASHBOARD_HOST;
      else process.env.GRAPHRAG_MEMORY_DASHBOARD_HOST = saved;
    }
  });

  it("rejects API port 18868 (reserved for the SPA)", () => {
    const saved = process.env.GRAPHRAG_MEMORY_DASHBOARD_PORT;
    process.env.GRAPHRAG_MEMORY_DASHBOARD_PORT = "18868";
    try {
      expect(() => readDashboardConfig()).toThrow(ConfigError);
      expect(() => readDashboardConfig()).toThrow(/18868/);
    } finally {
      if (saved === undefined)
        delete process.env.GRAPHRAG_MEMORY_DASHBOARD_PORT;
      else process.env.GRAPHRAG_MEMORY_DASHBOARD_PORT = saved;
    }
  });
});
