/**
 * GET /api/graph — Neo4j read projection. Missing sidecar ≠ empty graph.
 */
import type { RouteHandler } from "../router.js";
import {
  neo4jFailureResponse,
  neo4jUnconfiguredResponse,
  withGraphSession,
  type OpenGraphSession,
} from "../graph-session.js";
import { readGraphProjection } from "../../core/graph/projection-reads.js";

export function graphHandler(
  openSession: OpenGraphSession | undefined
): RouteHandler {
  return async () => {
    if (openSession === undefined) return neo4jUnconfiguredResponse();
    try {
      const body = await withGraphSession(openSession, (session) =>
        readGraphProjection(session)
      );
      return { status: 200, body };
    } catch (err) {
      return neo4jFailureResponse(err);
    }
  };
}
