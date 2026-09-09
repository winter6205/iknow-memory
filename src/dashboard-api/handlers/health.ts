/**
 * GET /api/health — liveness + configured storage mode.
 */
import type { RouteHandler } from "../router.js";

export interface HealthDeps {
  storageMode: "memory" | "pgvector";
  version: string;
}

export function healthHandler(deps: HealthDeps): RouteHandler {
  return () => ({
    status: 200,
    body: {
      status: "ok",
      storage: deps.storageMode,
      version: deps.version,
    },
  });
}
