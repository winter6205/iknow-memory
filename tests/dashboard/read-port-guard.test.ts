/**
 * Detail-id boundary guard (L3 security remediation, CWE-22).
 *
 * The router decodeURIComponent()s each `:id` segment before dispatch, so
 * encoded separators (`%2F`) reach the handler. The detail boundary must
 * reject anything outside the closed UUID shape with 400 INVALID_INPUT —
 * the exact envelope the storage INVALID_INPUT path already produced —
 * WITHOUT invoking a storage getter or opening a graph session.
 */
import { describe, expect, it, vi } from "vitest";

import type { CypherSession } from "../../src/core/graph/neo4j-ppr.js";
import { boot, fetchJson, memoryDeps, stubReadPort } from "./helpers.js";
import type { DashboardServerDeps } from "../../src/dashboard-api/index.js";

/** Decodes to `../../etc/passwd` inside one path segment. */
const TRAVERSAL = "..%2F..%2Fetc%2Fpasswd";
/** UUID-shaped prefix plus one trailing char: 37 chars, never a legal id. */
const TOO_LONG = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaax";
const UUID_UPPER = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";

/** A detail response is only valid if it is the pre-existing envelope, byte for byte. */
const INVALID_INPUT_SOURCE = {
  error: { code: "INVALID_INPUT", message: "source document not found" },
};

describe("dashboard-api detail-id guard (storage reads)", () => {
  it("rejects a traversal-shaped source id before touching the read port", async () => {
    const port = stubReadPort();
    const getSourceDocById = vi.fn(port.getSourceDocById);
    const { baseUrl } = await boot({
      ...memoryDeps(),
      storage: stubReadPort({ getSourceDocById }) as unknown as DashboardServerDeps["storage"],
    });
    const res = await fetchJson(`${baseUrl}/api/sources/${TRAVERSAL}`);
    expect(res.status).toBe(400);
    expect(res.body).toEqual(INVALID_INPUT_SOURCE);
    expect(getSourceDocById).not.toHaveBeenCalled();
  });

  it("rejects a 37-char id that only looks UUID-shaped", async () => {
    const port = stubReadPort();
    const getSourceDocById = vi.fn(port.getSourceDocById);
    const { baseUrl } = await boot({
      ...memoryDeps(),
      storage: stubReadPort({ getSourceDocById }) as unknown as DashboardServerDeps["storage"],
    });
    const res = await fetchJson(`${baseUrl}/api/sources/${TOO_LONG}`);
    expect(res.status).toBe(400);
    expect(res.body).toEqual(INVALID_INPUT_SOURCE);
    expect(getSourceDocById).not.toHaveBeenCalled();
  });

  it("applies the same guard on the entity detail route", async () => {
    const port = stubReadPort();
    const getEntity = vi.fn(port.getEntity);
    const { baseUrl } = await boot({
      ...memoryDeps(),
      storage: stubReadPort({ getEntity }) as unknown as DashboardServerDeps["storage"],
    });
    const res = await fetchJson(`${baseUrl}/api/entities/${TRAVERSAL}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: "INVALID_INPUT" } });
    expect(getEntity).not.toHaveBeenCalled();
  });

  it("lets a case-variant UUID through to the read port unchanged", async () => {
    // Postgres normalizes uuid text case-insensitively, so uppercase ids
    // are legal requests; the guard must not turn them into 400s.
    const port = stubReadPort();
    const getSourceDocById = vi.fn(port.getSourceDocById);
    const { baseUrl } = await boot({
      ...memoryDeps(),
      storage: stubReadPort({ getSourceDocById }) as unknown as DashboardServerDeps["storage"],
    });
    const res = await fetchJson(`${baseUrl}/api/sources/${UUID_UPPER}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(getSourceDocById).toHaveBeenCalledWith(UUID_UPPER);
  });
});

describe("dashboard-api detail-id guard (backlinks)", () => {
  interface FakeCounts {
    opens: number;
    runs: number;
  }

  function countingGraphDeps(counts: FakeCounts): DashboardServerDeps {
    const session: CypherSession = {
      async run() {
        counts.runs += 1;
        return [];
      },
      async close() {
        return;
      },
    };
    return {
      ...memoryDeps(),
      openGraphSession: () => {
        counts.opens += 1;
        return session;
      },
    };
  }

  it("rejects a traversal-shaped id without opening a graph session", async () => {
    const counts: FakeCounts = { opens: 0, runs: 0 };
    const { baseUrl } = await boot(countingGraphDeps(counts));
    const res = await fetchJson(
      `${baseUrl}/api/entities/${TRAVERSAL}/backlinks`
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: "INVALID_INPUT" } });
    expect(counts.opens).toBe(0);
    expect(counts.runs).toBe(0);
  });

  it("rejects a 37-char id without opening a graph session", async () => {
    const counts: FakeCounts = { opens: 0, runs: 0 };
    const { baseUrl } = await boot(countingGraphDeps(counts));
    const res = await fetchJson(
      `${baseUrl}/api/entities/${TOO_LONG}/backlinks`
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: "INVALID_INPUT" } });
    expect(counts.opens).toBe(0);
  });

  it("keeps the unconfigured-sidecar check ahead of the id guard", async () => {
    // Precedence pin: with no sidecar configured the wire answer stays 503
    // NEO4J_UNAVAILABLE even for an invalid id (graph.test.ts pins this
    // posture for valid ids; the guard must not reorder it).
    const { baseUrl } = await boot();
    const res = await fetchJson(
      `${baseUrl}/api/entities/${TRAVERSAL}/backlinks`
    );
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: { code: "NEO4J_UNAVAILABLE" } });
  });
});
