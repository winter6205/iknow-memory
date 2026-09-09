/**
 * GET /api/stats — T1 StorageReadPort.counts(), not dashboard-local SQL.
 */
import type { RouteHandler } from "../router.js";
import { errorEnvelope } from "../responses.js";
import type { StorageCounts, StorageReadPort } from "../../core/types.js";

export function statsHandler(storage: StorageReadPort): RouteHandler {
  return async () => {
    try {
      const counts: StorageCounts = await storage.counts();
      return { status: 200, body: counts };
    } catch (err) {
      return { status: 503, body: errorEnvelope("STORAGE_ERROR", err) };
    }
  };
}
