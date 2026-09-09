/**
 * Shared StorageReadPort HTTP mapping for T3 browse/timeline.
 */
import type { RouteHandler } from "../router.js";
import { errorEnvelope } from "../responses.js";
import {
  parseOffset,
  parsePagination,
  readQueryParams,
} from "../query-params.js";
import { GraphragError } from "../../core/errors.js";
import {
  STORAGE_LIST_LIMIT_DEFAULT,
  STORAGE_LIST_LIMIT_MAX,
  type StorageListOptions,
  type StorageReadPort,
  type StorageReadResult,
} from "../../core/types.js";

const READ_PORT_METHODS = [
  "counts",
  "listChunks",
  "getChunk",
  "listEntities",
  "getEntity",
  "listTimeline",
] as const satisfies readonly (keyof StorageReadPort)[];

export function asReadPort(storage: unknown): StorageReadPort {
  if (storage !== null && typeof storage === "object") {
    const obj = storage as Record<string, unknown>;
    if (READ_PORT_METHODS.every((name) => typeof obj[name] === "function")) {
      return storage as StorageReadPort;
    }
  }
  throw new GraphragError(
    "storage does not implement StorageReadPort",
    "STORAGE_ERROR"
  );
}

export function listOptionsFromQuery(query: string): StorageListOptions {
  const params = readQueryParams(query);
  return {
    limit: parsePagination(
      params.get("limit"),
      STORAGE_LIST_LIMIT_DEFAULT,
      STORAGE_LIST_LIMIT_MAX
    ),
    offset: parseOffset(params.get("offset")),
  };
}

export function storageListError(err: unknown): {
  status: number;
  body: ReturnType<typeof errorEnvelope>;
} {
  if (err instanceof GraphragError && err.code === "INVALID_INPUT") {
    return { status: 400, body: errorEnvelope("INVALID_INPUT", err) };
  }
  return { status: 503, body: errorEnvelope("STORAGE_ERROR", err) };
}

export function detailFromRead<T>(
  result: StorageReadResult<T>,
  missing: string
): { status: number; body: unknown } {
  if (result.ok) return { status: 200, body: result.value };
  if (result.code === "INVALID_INPUT") {
    return {
      status: 400,
      body: errorEnvelope("INVALID_INPUT", new Error(missing)),
    };
  }
  return {
    status: 404,
    body: errorEnvelope("NOT_FOUND", new Error(missing)),
  };
}

export function readListHandler(
  list: (opts: StorageListOptions) => Promise<unknown>
): RouteHandler {
  return async (req) => {
    try {
      const page = await list(listOptionsFromQuery(req.query));
      return { status: 200, body: page };
    } catch (err) {
      return storageListError(err);
    }
  };
}

export function readDetailHandler<T>(
  get: (id: string) => Promise<StorageReadResult<T>>,
  missing: string
): RouteHandler {
  return async (req) => {
    try {
      const result = await get(req.params["id"] ?? "");
      return detailFromRead(result, missing);
    } catch (err) {
      return { status: 503, body: errorEnvelope("STORAGE_ERROR", err) };
    }
  };
}
