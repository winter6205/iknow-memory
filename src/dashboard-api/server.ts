/**
 * dashboard-api http.Server factory — health, stats, query, browse, timeline.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { ServerResponse } from "node:http";

import {
  dispatch,
  matchPath,
  methodNotAllowed,
  notFound,
  type ResponseDescriptor,
  type Route,
} from "./router.js";
import { errorEnvelope, jsonResponse } from "./responses.js";
import { healthHandler } from "./handlers/health.js";
import { statsHandler } from "./handlers/stats.js";
import { queryHandler, type QueryDeps } from "./handlers/query.js";
import { chunkDetailHandler, chunkListHandler } from "./handlers/chunks.js";
import { entityDetailHandler, entityListHandler } from "./handlers/entities.js";
import { timelineHandler } from "./handlers/timeline.js";
import { graphHandler } from "./handlers/graph.js";
import { backlinksHandler } from "./handlers/backlinks.js";
import { asReadPort } from "./handlers/read-port.js";
import type { OpenGraphSession } from "./graph-session.js";
import type { EmbeddingClient } from "../core/embedder.js";
import type { StorageBackend } from "../core/types.js";
import type { LexicalStorageBackend } from "../core/storage/backend.js";
import type {
  ChunkReranker,
  EntityLexicalStorage,
  GraphRanker,
  RetrieveConfig,
} from "../core/retrieval/types.js";

export interface DashboardRetrievalDeps {
  retrieveConfig: RetrieveConfig;
}

export interface DashboardServerDeps {
  storage: StorageBackend;
  embedder: EmbeddingClient;
  retrieval: DashboardRetrievalDeps;
  lexical?: LexicalStorageBackend;
  entityLexical?: EntityLexicalStorage;
  graphRanker?: GraphRanker;
  reranker?: ChunkReranker;
  storageMode: "memory" | "pgvector";
  version: string;
  /** Injected Neo4j read session; omitted = sidecar unconfigured. */
  openGraphSession?: OpenGraphSession;
  /** Caller-supplied bind hint; factory does not listen or re-read env. */
  host?: string;
  port?: number;
}

export function createDashboardServer(deps: DashboardServerDeps): Server {
  const queryDeps: QueryDeps = {
    embedder: deps.embedder,
    storage: deps.storage,
    ...(deps.lexical !== undefined ? { lexical: deps.lexical } : {}),
    ...(deps.entityLexical !== undefined
      ? { entityLexical: deps.entityLexical }
      : {}),
    retrieval: deps.retrieval.retrieveConfig,
    ...(deps.graphRanker !== undefined
      ? { graphRanker: deps.graphRanker }
      : {}),
    ...(deps.reranker !== undefined ? { reranker: deps.reranker } : {}),
  };
  const readPort = asReadPort(deps.storage);
  const routes: Route[] = [
    { method: "GET", pattern: "/api/health", handler: healthHandler(deps) },
    {
      method: "GET",
      pattern: "/api/stats",
      handler: statsHandler(readPort),
    },
    { method: "GET", pattern: "/api/query", handler: queryHandler(queryDeps) },
    {
      method: "GET",
      pattern: "/api/chunks",
      handler: chunkListHandler(readPort),
    },
    {
      method: "GET",
      pattern: "/api/chunks/:id",
      handler: chunkDetailHandler(readPort),
    },
    {
      method: "GET",
      pattern: "/api/entities",
      handler: entityListHandler(readPort),
    },
    {
      method: "GET",
      pattern: "/api/entities/:id",
      handler: entityDetailHandler(readPort),
    },
    {
      method: "GET",
      pattern: "/api/entities/:id/backlinks",
      handler: backlinksHandler(deps.openGraphSession),
    },
    {
      method: "GET",
      pattern: "/api/timeline",
      handler: timelineHandler(readPort),
    },
    {
      method: "GET",
      pattern: "/api/graph",
      handler: graphHandler(deps.openGraphSession),
    },
  ];

  return createServer((req, res) => {
    void handle(req, res, routes);
  });
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  routes: readonly Route[]
): Promise<void> {
  try {
    const method = (req.method ?? "GET").toUpperCase();
    const url = req.url ?? "/";
    const path = parsePath(url);
    const query = parseQuery(url);
    const match = dispatch(routes, { method, path, query, params: {} });
    if (match === undefined) {
      const pathKnown = routes.some(
        (r) => matchPath(r.pattern, path) !== undefined
      );
      const fallback = pathKnown ? methodNotAllowed(path) : notFound(path);
      writeJson(res, jsonResponse(fallback.status, fallback.body));
      return;
    }
    const result = (await match.handler({
      method,
      path,
      query,
      params: match.params,
    })) as ResponseDescriptor;
    writeJson(res, {
      status: result.status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        ...(result.headers ?? {}),
      },
      body: JSON.stringify(result.body),
    });
  } catch (err) {
    writeJson(res, jsonResponse(500, errorEnvelope("INTERNAL", err)));
  }
}

function writeJson(
  res: ServerResponse,
  out: { status: number; headers: Record<string, string>; body: string }
): void {
  res.statusCode = out.status;
  for (const [k, v] of Object.entries(out.headers)) res.setHeader(k, v);
  res.end(out.body);
}

function parsePath(url: string): string {
  const q = url.indexOf("?");
  return q === -1 ? url : url.slice(0, q);
}

function parseQuery(url: string): string {
  const q = url.indexOf("?");
  return q === -1 ? "" : url.slice(q + 1);
}
