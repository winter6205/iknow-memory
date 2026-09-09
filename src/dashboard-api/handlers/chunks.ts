/**
 * GET /api/chunks and GET /api/chunks/:id — StorageReadPort, not dashboard SQL.
 */
import type { RouteHandler } from "../router.js";
import type { StorageReadPort } from "../../core/types.js";
import { readDetailHandler, readListHandler } from "./read-port.js";

export function chunkListHandler(storage: StorageReadPort): RouteHandler {
  return readListHandler((opts) => storage.listChunks(opts));
}

export function chunkDetailHandler(storage: StorageReadPort): RouteHandler {
  return readDetailHandler((id) => storage.getChunk(id), "chunk not found");
}
