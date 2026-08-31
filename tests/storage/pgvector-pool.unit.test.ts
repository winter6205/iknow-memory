import { describe, expect, it } from "vitest";

import { ConfigError } from "../../src/config.js";
import { PgvectorBackend } from "../../src/core/storage/pgvector-backend.js";

type PoolOptions = {
  max?: number;
  connectionWaitTimeoutMs?: number;
};

const Backend = PgvectorBackend as unknown as new (
  dbUrl: string,
  dimensions: number,
  annMaxDimensions: number,
  poolOptions?: PoolOptions
) => PgvectorBackend;

function makeBackend(options?: PoolOptions): PgvectorBackend {
  return new Backend("postgres://example.invalid/retrieval", 32, 2000, options);
}

describe("PgvectorBackend connection pool parameters", () => {
  it("exposes the configured cap and an independent zero wait-timeout counter", () => {
    const backend = makeBackend({
      max: 3,
      connectionWaitTimeoutMs: 250,
    });
    const stats = (
      backend as unknown as {
        getPoolStats: () => {
          configuredMax: number;
          connectionWaitTimeoutMs: number;
          observedConcurrentConnections: number;
          peakConcurrentConnections: number;
          connectionWaitTimeouts: number;
        };
      }
    ).getPoolStats();

    expect(stats).toEqual({
      configuredMax: 3,
      connectionWaitTimeoutMs: 250,
      observedConcurrentConnections: 0,
      peakConcurrentConnections: 0,
      connectionWaitTimeouts: 0,
    });
  });

  for (const [label, max] of [
    ["zero", 0],
    ["negative", -1],
    ["non-finite", Number.POSITIVE_INFINITY],
    ["non-integer", 1.5],
  ] as const) {
    it(`rejects an illegal pool cap (${label}) with ConfigError`, () => {
      expect(() => makeBackend({ max })).toThrow(ConfigError);
    });
  }

  it("rejects an illegal connection wait timeout with ConfigError", () => {
    expect(() => makeBackend({ connectionWaitTimeoutMs: 0 })).toThrow(
      ConfigError
    );
  });

  it("counts a connection wait timeout as an independent typed failure", async () => {
    const backend = makeBackend({ connectionWaitTimeoutMs: 1 });
    const pendingPool = {
      connect: () =>
        new Promise<{ release: () => void }>((resolve) => {
          setTimeout(() => resolve({ release: () => undefined }), 10);
        }),
    };
    const connectWithTimeout = (
      backend as unknown as {
        connectWithTimeout: (pool: unknown) => Promise<unknown>;
      }
    ).connectWithTimeout;

    const error = await connectWithTimeout
      .call(backend, pendingPool)
      .catch((caught: unknown) => caught);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(error).toMatchObject({
      name: "ConnectionWaitTimeoutError",
    });
    expect(backend.getPoolStats().connectionWaitTimeouts).toBe(1);
  });
});
