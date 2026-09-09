/**
 * GET /api/entities and GET /api/entities/:id — StorageReadPort.
 * Memory mode is an empty ledger (200 list / typed miss), not a missing route.
 */
import type { RouteHandler } from "../router.js";
import type { StorageReadPort } from "../../core/types.js";
import { readDetailHandler, readListHandler } from "./read-port.js";

export function entityListHandler(storage: StorageReadPort): RouteHandler {
  return readListHandler((opts) => storage.listEntities(opts));
}

export function entityDetailHandler(storage: StorageReadPort): RouteHandler {
  return readDetailHandler((id) => storage.getEntity(id), "entity not found");
}
