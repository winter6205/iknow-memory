/**
 * GET /api/timeline — StorageReadPort.listTimeline (valid_window + invalidations).
 */
import type { RouteHandler } from "../router.js";
import type { StorageReadPort } from "../../core/types.js";
import { readListHandler } from "./read-port.js";

export function timelineHandler(storage: StorageReadPort): RouteHandler {
  return readListHandler((opts) => storage.listTimeline(opts));
}
