/**
 * dashboard-api http.Server factory — health, stats, query, browse, timeline,
 * the T8 thin writes (ingest / extract / invalidate / graph:backfill /
 * graph:drain), and the extract-verify T3 maintenance lane (failed
 * extraction list + promote / discard over the same core runners).
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
  type RouteHandler,
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
import { sourceDetailHandler, sourceListHandler } from "./handlers/sources.js";
import {
  extractWriteHandler,
  graphBackfillWriteHandler,
  graphDrainWriteHandler,
  ingestWriteHandler,
  invalidateWriteHandler,
  type ExtractWriteDeps,
  type GraphBackfillWriteDeps,
  type GraphDrainWriteDeps,
  type IngestWriteDeps,
  type InvalidateWriteDeps,
} from "./handlers/writes.js";
import {
  discardWriteHandler,
  failedListHandler,
  promoteWriteHandler,
  type MaintenanceDeps,
} from "./handlers/maintenance.js";
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
import type {
  EmbedderClientEnv,
  LlmClientEnv,
} from "../core/extraction/clients.js";
import type { ExtractClient, ExtractPool } from "../tools/extract.js";
import type { PrecisionIndexer } from "../core/storage/elasticsearch-precision.js";
import type { Logger } from "../logging.js";
import type { BackfillPool } from "../cli/graph-backfill.js";
import type { DrainPool } from "../cli/graph-drain.js";
import type { GraphWriter } from "../core/graph/types.js";

export interface DashboardRetrievalDeps {
  retrieveConfig: RetrieveConfig;
}

/**
 * Thin-write deps block (operator-console T8). Every member is optional:
 * the dashboard stays an HTTP facade and a misconfigured env returns a
 * typed 503, not a second write implementation. The handler factories in
 * `handlers/writes.ts` mirror these deps onto the matching MCP/CLI
 * runners — the dashboard never re-implements write logic.
 */
export interface DashboardWriteDeps {
  ingest?: Omit<IngestWriteDeps, "embedder" | "storage"> & {
    embedder?: EmbeddingClient;
    storage?: StorageBackend;
  };
  extract?: ExtractWriteDeps;
  invalidate?: Omit<InvalidateWriteDeps, "embedder" | "storage"> & {
    embedder?: EmbeddingClient;
    storage?: StorageBackend;
  };
  graphBackfill?: GraphBackfillWriteDeps;
  graphDrain?: GraphDrainWriteDeps;
  /**
   * extract-verify T3 maintenance lane: the failed-extraction list and the
   * promote / discard actions over `extraction_records`. The chunk→资料
   * back-pointer is read in one batched SQL on the handler's own leased
   * client. Re-extract rides the existing extract thin write, so it needs
   * no deps of its own.
   */
  maintenance?: MaintenanceDeps;
  /** Shared Postgres pool for extract / graph writes. Required by those
   *  endpoints; absent → the handlers answer 503 STORAGE_ERROR. */
  pgPool?: ExtractPool | BackfillPool | DrainPool;
  /** Re-export the pooled-client type for test fakes that need it. */
  extractClient?: ExtractClient;
  /** Logger threaded into the graph backfill/drain runners; absent means
   *  the dashboard-api defaults to a stderr/level=info logger. */
  logger?: Logger;
  /** Neo4j factory for graph write runners; absent → the handlers
   *  answer 503 STORAGE_ERROR ("no Neo4j URI configured"). */
  connectGraph?: () => Promise<GraphWriter>;
  /** Optional ES derived-index writer for the ingest/invalidate mirror. */
  precision?: PrecisionIndexer;
  /** LLM credential block for extract; required by the extract handler. */
  llmEnv?: LlmClientEnv;
  /** Embedding credential block for extract. */
  embedderEnv?: EmbedderClientEnv;
}

export interface DashboardServerDeps {
  storage: StorageBackend;
  embedder: EmbeddingClient;
  retrieval: DashboardRetrievalDeps;
  lexical?: LexicalStorageBackend;
  entityLexical?: EntityLexicalStorage;
  graphRanker?: GraphRanker;
  reranker?: ChunkReranker;
  retrievalIdentity?: {
    retrievalFingerprint: string;
    generationId: string;
    epoch: string;
  };
  storageMode: "memory" | "pgvector";
  version: string;
  /** Injected Neo4j read session; omitted = sidecar unconfigured. */
  openGraphSession?: OpenGraphSession;
  /** Caller-supplied bind hint; factory does not listen or re-read env. */
  host?: string;
  port?: number;
  /**
   * Thin-write deps (operator-console T8). When absent, every thin write
   * answers 503 STORAGE_ERROR (the operator's env cannot run the
   * underlying MCP/CLI runner — same posture as the MCP server itself).
   */
  writes?: DashboardWriteDeps;
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
    ...(deps.retrievalIdentity !== undefined
      ? { retrievalIdentity: deps.retrievalIdentity }
      : {}),
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
      pattern: "/api/sources",
      handler: sourceListHandler(readPort),
    },
    {
      method: "GET",
      pattern: "/api/sources/:id",
      handler: sourceDetailHandler(readPort),
    },
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
    ...(deps.writes !== undefined
      ? buildThinWriteRoutes(deps)
      : missingWriteRoutes()),
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
    // Pre-dispatch path lookup so we only drain the request body when a
    // route actually wants it — GET/HEAD requests don't carry a body and
    // would block forever if we tried to read from the stream here.
    const match = dispatch(routes, { method, path, query, params: {} });
    if (match === undefined) {
      const pathKnown = routes.some(
        (r) => matchPath(r.pattern, path) !== undefined
      );
      const fallback = pathKnown ? methodNotAllowed(path) : notFound(path);
      writeJson(res, jsonResponse(fallback.status, fallback.body));
      return;
    }
    const body = await readRequestBody(req);
    if (!body.ok) {
      writeJson(res, jsonResponse(body.status, body.body));
      return;
    }
    const result = (await match.handler({
      method,
      path,
      query,
      params: match.params,
      body: body.value,
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

/** Maximum POST body size the dashboard-api will accept (1MB). */
const MAX_BODY_BYTES = 1_048_576;

type BodyRead =
  { ok: true; value: unknown } | { ok: false; status: number; body: unknown };

/**
 * Drain the request body and parse it as JSON. Returns `value: undefined`
 * for body-less methods (GET / HEAD / DELETE-with-no-body) so the
 * dispatch path stays a single shape. Over-cap or malformed JSON surfaces
 * as a typed 4xx envelope — the handler never sees a half-read body.
 *
 * This is the only place in dashboard-api that talks to the IncomingMessage
 * stream; handlers consume `req.body` (already parsed) and stay pure.
 */
async function readRequestBody(req: IncomingMessage): Promise<BodyRead> {
  const method = (req.method ?? "GET").toUpperCase();
  // Methods without a body in normal use. DELETE may carry one but the
  // dashboard's write endpoints are POST-only; we still tolerate empty
  // bodies there by returning `undefined` so the parse helper below
  // produces the typed "missing body" envelope.
  if (method === "GET" || method === "HEAD") {
    return { ok: true, value: undefined };
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk as ArrayBufferLike);
    total += buf.length;
    if (total > MAX_BODY_BYTES) {
      return {
        ok: false,
        status: 413,
        body: errorEnvelope(
          "INVALID_INPUT",
          new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`)
        ),
      };
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.trim() === "") {
    return { ok: true, value: undefined };
  }
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (err) {
    return {
      ok: false,
      status: 400,
      body: errorEnvelope(
        "INVALID_INPUT",
        new Error(`request body is not valid JSON: ${(err as Error).message}`)
      ),
    };
  }
}

/**
 * T8 — Build the five POST `/api/writes/*` routes. Each handler factory
 * imports its runner from the same module the MCP tool / CLI uses; tests
 * pin "same runner" by spying on those imports (see
 * `tests/dashboard/writes.test.ts`).
 *
 * Missing deps never abort server start: the handler factory itself
 * returns a typed-503 envelope, so the route stays wired and the chrome
 * can surface the configuration gap. The dashboard is an HTTP facade,
 * not a host — keeping the route shape stable across env states is what
 * lets the SPA controls pin the request contract.
 */
function buildThinWriteRoutes(deps: DashboardServerDeps): Route[] {
  const writes = deps.writes;
  if (writes === undefined) return [];
  const routes: Route[] = [];
  // Ingest — needs storage + embedder (shared with the rest of the
  // dashboard) + optional precision mirror. Same factory as MCP `ingest`.
  if (writes.ingest !== undefined) {
    routes.push({
      method: "POST",
      pattern: "/api/writes/ingest",
      handler: ingestWriteHandler({
        embedder: writes.ingest.embedder ?? deps.embedder,
        storage: writes.ingest.storage ?? deps.storage,
        ...(writes.ingest.precision !== undefined
          ? { precision: writes.ingest.precision }
          : writes.precision !== undefined
            ? { precision: writes.precision }
            : {}),
        ...(writes.ingest.logger !== undefined
          ? { logger: writes.ingest.logger }
          : writes.logger !== undefined
            ? { logger: writes.logger }
            : {}),
      }),
    });
  }
  // Extract — needs LLM/embedder credentials + Postgres pool.
  if (writes.extract !== undefined) {
    routes.push({
      method: "POST",
      pattern: "/api/writes/extract",
      handler: extractWriteHandler(writes.extract),
    });
  }
  // Invalidate — needs storage + embedder.
  if (writes.invalidate !== undefined) {
    routes.push({
      method: "POST",
      pattern: "/api/writes/invalidate",
      handler: invalidateWriteHandler({
        embedder: writes.invalidate.embedder ?? deps.embedder,
        storage: writes.invalidate.storage ?? deps.storage,
        ...(writes.invalidate.precision !== undefined
          ? { precision: writes.invalidate.precision }
          : writes.precision !== undefined
            ? { precision: writes.precision }
            : {}),
      }),
    });
  }
  // Graph backfill / drain — need the shared Postgres pool + Neo4j
  // factory + logger. The handlers return a `{ exit_code }` envelope so
  // the SPA can mirror the CLI exit-code map (0 success / 1 fatal / 2
  // usage / 3 loud skip).
  if (writes.graphBackfill !== undefined) {
    routes.push({
      method: "POST",
      pattern: "/api/writes/graph-backfill",
      handler: graphBackfillWriteHandler(writes.graphBackfill),
    });
  }
  if (writes.graphDrain !== undefined) {
    routes.push({
      method: "POST",
      pattern: "/api/writes/graph-drain",
      handler: graphDrainWriteHandler(writes.graphDrain),
    });
  }
  // Maintenance lane — failed list + promote/discard
  // over the same core runners the CLI drives.
  if (writes.maintenance !== undefined) {
    const maintenanceDeps: MaintenanceDeps = writes.maintenance;
    routes.push({
      method: "GET",
      pattern: "/api/maintenance/failed",
      handler: failedListHandler(maintenanceDeps),
    });
    routes.push({
      method: "POST",
      pattern: "/api/maintenance/promote",
      handler: promoteWriteHandler(maintenanceDeps),
    });
    routes.push({
      method: "POST",
      pattern: "/api/maintenance/discard",
      handler: discardWriteHandler(maintenanceDeps),
    });
  }
  return routes;
}

/**
 * T8 — When no `writes` block is configured, the SPA still expects the
 * route table to be predictable. Register a stub handler that always
 * answers 503 STORAGE_ERROR — the operator's env cannot run any write.
 */
function missingWriteRoutes(): Route[] {
  const stub: RouteHandler = () => ({
    status: 503,
    body: errorEnvelope(
      "STORAGE_ERROR",
      new Error("thin writes are not configured on this dashboard-api instance")
    ),
  });
  return [
    { method: "POST", pattern: "/api/writes/ingest", handler: stub },
    { method: "POST", pattern: "/api/writes/extract", handler: stub },
    { method: "POST", pattern: "/api/writes/invalidate", handler: stub },
    {
      method: "POST",
      pattern: "/api/writes/graph-backfill",
      handler: stub,
    },
    { method: "POST", pattern: "/api/writes/graph-drain", handler: stub },
    { method: "GET", pattern: "/api/maintenance/failed", handler: stub },
    { method: "POST", pattern: "/api/maintenance/promote", handler: stub },
    { method: "POST", pattern: "/api/maintenance/discard", handler: stub },
  ];
}
