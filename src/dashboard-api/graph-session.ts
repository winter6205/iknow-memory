/**
 * Neo4j read session factory — injectable seam for graph/backlinks handlers.
 * Cypher strings live in core/graph/projection-reads.ts.
 */
import neo4j from "neo4j-driver";

import type { Neo4jConfig } from "../config.js";
import { GraphUnavailableError } from "../core/graph/types.js";
import type { CypherSession } from "../core/graph/neo4j-ppr.js";
import { errorEnvelope } from "./responses.js";

export type OpenGraphSession = () => Promise<CypherSession> | CypherSession;

export function neo4jUnconfiguredResponse(): {
  status: number;
  body: ReturnType<typeof errorEnvelope>;
} {
  return {
    status: 503,
    body: errorEnvelope(
      "NEO4J_UNAVAILABLE",
      new Error("Neo4j sidecar is not configured")
    ),
  };
}

export function neo4jFailureResponse(err: unknown): {
  status: number;
  body: ReturnType<typeof errorEnvelope>;
} {
  const unavailable = err instanceof GraphUnavailableError;
  return {
    status: unavailable ? 503 : 500,
    body: errorEnvelope(unavailable ? "NEO4J_UNAVAILABLE" : "INTERNAL", err),
  };
}

export async function withGraphSession<T>(
  openSession: OpenGraphSession,
  fn: (session: CypherSession) => Promise<T>
): Promise<T> {
  const session = await openSession();
  try {
    return await fn(session);
  } catch (err) {
    if (err instanceof GraphUnavailableError) throw err;
    throw new GraphUnavailableError("neo4j", err);
  } finally {
    await session.close();
  }
}

export function createNeo4jSessionFactory(
  config: Neo4jConfig
): OpenGraphSession {
  let driver: import("neo4j-driver").Driver | undefined;
  return () => {
    driver ??= neo4j.driver(
      config.uri,
      config.user !== undefined && config.password !== undefined
        ? neo4j.auth.basic(config.user, config.password)
        : undefined
    );
    const session = driver.session({ defaultAccessMode: "READ" });
    return {
      async run(
        cypher: string,
        params: Record<string, unknown>
      ): Promise<Array<Record<string, unknown>>> {
        try {
          const result = await session.run(cypher, params);
          return result.records.map((record) => record.toObject());
        } catch (err) {
          throw new GraphUnavailableError(config.uri, err);
        }
      },
      async close() {
        await session.close();
      },
    };
  };
}
