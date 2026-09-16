/**
 * Pins Entity backlink projection: inbound + outbound, sequential session.run.
 */
import { describe, expect, it } from "vitest";
import type { CypherSession } from "../../../src/core/graph/neo4j-ppr.js";
import {
  BACKLINK_EDGES_CYPHER,
  OUTLINK_EDGES_CYPHER,
  readEntityBacklinks,
} from "../../../src/core/graph/projection-reads.js";

const ENT_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_ID = "22222222-2222-2222-2222-222222222222";

function isOutboundCypher(cypher: string): boolean {
  return /\{\s*id:\s*\$id\s*\}\s*\)\s*-\[/.test(cypher);
}

function isInboundCypher(cypher: string): boolean {
  return (
    cypher.includes("RELATION") &&
    cypher.includes("$id") &&
    !isOutboundCypher(cypher)
  );
}

describe("OUTLINK_EDGES_CYPHER", () => {
  it("matches this entity pointing at other Entity nodes via RELATION", () => {
    expect(OUTLINK_EDGES_CYPHER).toMatch(
      /\(a:Entity \{id: \$id\}\)-\[r:RELATION\]->\(b:Entity\)/
    );
    expect(OUTLINK_EDGES_CYPHER).not.toMatch(/\(b:Entity \{id: \$id\}\)/);
  });
});

describe("BACKLINK_EDGES_CYPHER", () => {
  it("stays inbound-only: other entities pointing at this entity", () => {
    expect(BACKLINK_EDGES_CYPHER).toMatch(
      /\(a:Entity\)-\[r:RELATION\]->\(b:Entity \{id: \$id\}\)/
    );
  });
});

describe("readEntityBacklinks", () => {
  it("returns outbound GraphProjectionEdge rows after a sequential outbound query", async () => {
    const cyphers: string[] = [];
    let inFlight = 0;
    let maxConcurrent = 0;
    const session: CypherSession = {
      async run(cypher: string) {
        inFlight += 1;
        if (inFlight > maxConcurrent) maxConcurrent = inFlight;
        if (inFlight > 1) throw new Error("session already has work in flight");
        cyphers.push(cypher);
        await Promise.resolve();
        inFlight -= 1;
        if (cypher.includes("RELATION") && isOutboundCypher(cypher)) {
          return [
            {
              from: ENT_ID,
              to: OTHER_ID,
              type: "works_for",
              to_name: "Acme",
              to_type: "system",
            },
          ];
        }
        if (isInboundCypher(cypher)) {
          return [
            {
              from: OTHER_ID,
              to: ENT_ID,
              type: "delegates_to",
              from_name: "Acme",
              from_type: "system",
            },
          ];
        }
        return [{ id: ENT_ID, name: "Alice", type: "person" }];
      },
      async close() {
        return;
      },
    };

    const result = await readEntityBacklinks(session, ENT_ID);
    expect(result.found).toBe(true);
    if (!result.found) return;
    const edgeCore = ({
      from,
      to,
      type,
    }: {
      from: string;
      to: string;
      type: string;
    }) => ({ from, to, type });
    expect(result.entity).toEqual({
      id: ENT_ID,
      name: "Alice",
      type: "person",
    });
    expect(result.inbound.map(edgeCore)).toEqual([
      { from: OTHER_ID, to: ENT_ID, type: "delegates_to" },
    ]);
    expect(result.outbound.map(edgeCore)).toEqual([
      { from: ENT_ID, to: OTHER_ID, type: "works_for" },
    ]);
    expect(cyphers.some(isInboundCypher)).toBe(true);
    expect(cyphers.some(isOutboundCypher)).toBe(true);
    expect(maxConcurrent).toBe(1);
    expect(cyphers).toHaveLength(3);
  });
});
