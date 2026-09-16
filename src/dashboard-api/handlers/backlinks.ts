/**
 * GET /api/entities/:id/backlinks — inbound + outbound Neo4j neighbors.
 */
import type { RouteHandler } from "../router.js";
import { errorEnvelope } from "../responses.js";
import {
  neo4jFailureResponse,
  neo4jUnconfiguredResponse,
  withGraphSession,
  type OpenGraphSession,
} from "../graph-session.js";
import {
  inboundNeighbor,
  outboundNeighbor,
  readEntityBacklinks,
} from "../../core/graph/projection-reads.js";

export function backlinksHandler(
  openSession: OpenGraphSession | undefined
): RouteHandler {
  return async (req) => {
    if (openSession === undefined) return neo4jUnconfiguredResponse();
    const id = req.params["id"] ?? "";
    try {
      const result = await withGraphSession(openSession, (session) =>
        readEntityBacklinks(session, id)
      );
      if (!result.found) {
        return {
          status: 404,
          body: errorEnvelope("NOT_FOUND", new Error(`entity ${id} not found`)),
        };
      }
      return {
        status: 200,
        body: {
          entity: result.entity,
          inbound: result.inbound.map(inboundNeighbor),
          outbound: result.outbound.map(outboundNeighbor),
        },
      };
    } catch (err) {
      return neo4jFailureResponse(err);
    }
  };
}
