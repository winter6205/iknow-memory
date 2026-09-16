/**
 * Shared dashboard-api test helpers.
 *
 * Boots the real http.Server on 127.0.0.1:0 (kernel-assigned port) and uses
 * the global fetch to exercise it. No framework, no supertest.
 */
import { afterEach } from "vitest";
import type { Server } from "node:http";

import { FakeEmbedder } from "../../src/core/embedder.js";
import { MemoryBackend } from "../../src/core/storage/memory-backend.js";

import {
  createDashboardServer,
  type DashboardServerDeps,
} from "../../src/dashboard-api/index.js";
import type { StorageReadPort } from "../../src/core/types.js";

const EMPTY_PAGE = { items: [], total: 0, limit: 20, offset: 0 };

/** Full StorageReadPort with optional overrides (partial fakes must still type-check). */
export function stubReadPort(
  overrides: Partial<StorageReadPort> = {}
): StorageReadPort {
  return {
    async counts() {
      return { chunks: 0, entities: 0, invalidations: 0 };
    },
    async listChunks() {
      return EMPTY_PAGE;
    },
    async getChunk() {
      return { ok: false, code: "NOT_FOUND" };
    },
    async listEntities() {
      return EMPTY_PAGE;
    },
    async getEntity() {
      return { ok: false, code: "NOT_FOUND" };
    },
    async listTimeline() {
      return EMPTY_PAGE;
    },
    async listSourceDocs() {
      return EMPTY_PAGE;
    },
    async getSourceDoc() {
      return { ok: false, code: "NOT_FOUND" };
    },
    async getSourceDocById() {
      return { ok: false, code: "NOT_FOUND" };
    },
    ...overrides,
  };
}

export interface ListeningServer {
  server: Server;
  baseUrl: string;
  close: () => Promise<void>;
}

export async function listen(server: Server): Promise<ListeningServer> {
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1");
    const onError = (err: Error) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      const addr = server.address();
      if (addr === null || typeof addr === "string") {
        reject(new Error("dashboard test server: no address"));
        return;
      }
      const baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve({
        server,
        baseUrl,
        close: () =>
          new Promise<void>((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          }),
      });
    };
    server.once("error", onError);
    server.once("listening", onListening);
  });
}

export function memoryDeps(): DashboardServerDeps {
  const storage = new MemoryBackend(8);
  const embedder = new FakeEmbedder(8);
  return {
    storage,
    embedder,
    retrieval: {
      retrieveConfig: {
        preset: "balanced",
        rrfK: 60,
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
      },
    },
    storageMode: "memory",
    version: "test-0.0.0",
  };
}

export async function fetchJson(
  url: string,
  init?: RequestInit
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, init);
  const text = await res.text();
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body };
}

const openServers: ListeningServer[] = [];

afterEach(async () => {
  while (openServers.length > 0) {
    const s = openServers.pop();
    if (s) await s.close();
  }
});

/** Listen + register for the shared afterEach teardown. */
export async function track(server: Server): Promise<ListeningServer> {
  const listening = await listen(server);
  openServers.push(listening);
  return listening;
}

export async function boot(deps = memoryDeps()): Promise<ListeningServer> {
  const server = createDashboardServer(deps);
  const listening = await listen(server);
  openServers.push(listening);
  return listening;
}
