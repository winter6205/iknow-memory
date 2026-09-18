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
  "listSourceDocs",
  "getSourceDoc",
  "getSourceDocById",
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

/**
 * Closed pattern for every detail-route id. All ids are `randomUUID()`
 * products stored in PG `uuid` columns, so anything outside 8-4-4-4-12
 * hex is not a lookup miss — it is a malformed (possibly traversal-shaped,
 * CWE-22) request, because the router decodeURIComponent()s `:id` before
 * dispatch and `%2F` therefore arrives as a real `/`. Case is allowed:
 * PG uuid text is case-insensitive.
 */
const DETAIL_ID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function isDetailId(id: string): boolean {
  return DETAIL_ID_PATTERN.test(id);
}

export function readDetailHandler<T>(
  get: (id: string) => Promise<StorageReadResult<T>>,
  missing: string
): RouteHandler {
  return async (req) => {
    const id = req.params["id"] ?? "";
    // Validate at the boundary BEFORE touching the read port; the reply is
    // the same envelope the storage INVALID_INPUT path already produced,
    // so the wire stays byte-compatible.
    if (!isDetailId(id)) {
      return detailFromRead({ ok: false, code: "INVALID_INPUT" }, missing);
    }
    try {
      const result = await get(id);
      return detailFromRead(result, missing);
    } catch (err) {
      return { status: 503, body: errorEnvelope("STORAGE_ERROR", err) };
    }
  };
}
