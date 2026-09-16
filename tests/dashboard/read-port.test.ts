/**
 * StorageReadPort runtime guard — every method must be present.
 */
import { describe, expect, it } from "vitest";

import { GraphragError } from "../../src/core/errors.js";
import { asReadPort } from "../../src/dashboard-api/handlers/read-port.js";
import type { StorageReadPort } from "../../src/core/types.js";

function fullPort(): StorageReadPort {
  return {
    async counts() {
      return { chunks: 0, entities: 0, invalidations: 0 };
    },
    async listChunks() {
      return { items: [], total: 0, limit: 20, offset: 0 };
    },
    async getChunk() {
      return { ok: false, code: "NOT_FOUND" };
    },
    async listEntities() {
      return { items: [], total: 0, limit: 20, offset: 0 };
    },
    async getEntity() {
      return { ok: false, code: "NOT_FOUND" };
    },
    async listTimeline() {
      return { items: [], total: 0, limit: 20, offset: 0 };
    },
    async listSourceDocs() {
      return { items: [], total: 0, limit: 20, offset: 0 };
    },
    async getSourceDoc() {
      return { ok: false, code: "NOT_FOUND" };
    },
    async getSourceDocById() {
      return { ok: false, code: "NOT_FOUND" };
    },
  };
}

describe("asReadPort", () => {
  it("rejects a partial object that only implements counts", () => {
    expect(() => asReadPort({ async counts() {} })).toThrow(GraphragError);
    expect(() => asReadPort({ async counts() {} })).toThrow(
      /does not implement StorageReadPort/
    );
  });

  it("accepts an object that implements every StorageReadPort method", () => {
    const port = fullPort();
    expect(asReadPort(port)).toBe(port);
  });

  it("rejects a port that is missing getSourceDocById", () => {
    const incomplete = { ...fullPort() } as Record<string, unknown>;
    delete incomplete.getSourceDocById;
    expect(() => asReadPort(incomplete)).toThrow(
      /does not implement StorageReadPort/
    );
  });
});
