/**
 * GET /api/sources and GET /api/sources/:id — 资料 list/detail via
 * StorageReadPort (operator-console T6). The list returns summaries only
 * (no content body — on-demand open); the detail returns the full body.
 */
import type { RouteHandler } from "../router.js";
import type { StorageReadPort } from "../../core/types.js";
import { readDetailHandler, readListHandler } from "./read-port.js";

export function sourceListHandler(storage: StorageReadPort): RouteHandler {
  return readListHandler((opts) => storage.listSourceDocs(opts));
}

export function sourceDetailHandler(storage: StorageReadPort): RouteHandler {
  return readDetailHandler(
    (id) => storage.getSourceDocById(id),
    "source document not found"
  );
}
