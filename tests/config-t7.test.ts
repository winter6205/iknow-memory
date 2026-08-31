import { describe, expect, it } from "vitest";

import { ConfigError, loadEnv } from "../src/config.js";

const BATCH_LIMIT_VAR = "GRAPHRAG_MEMORY_INGEST_BATCH_LIMIT";
const POOL_MAX_VAR = "GRAPHRAG_MEMORY_PGVECTOR_POOL_MAX";
const WAIT_TIMEOUT_VAR = "GRAPHRAG_MEMORY_PGVECTOR_CONNECTION_WAIT_TIMEOUT_MS";

const ENV_KEYS = [
  "GRAPHRAG_MEMORY_STORAGE",
  "GRAPHRAG_MEMORY_DB_URL",
  "GRAPHRAG_MEMORY_EMBED_DIMENSIONS",
  "GRAPHRAG_MEMORY_PGVECTOR_ANN_MAX_DIMENSIONS",
  "GRAPHRAG_MEMORY_EMBED_BASE_URL",
  "GRAPHRAG_MEMORY_EMBED_MODEL",
  "GRAPHRAG_MEMORY_EMBED_API_KEY",
  "GRAPHRAG_MEMORY_EMBED_API_KEY_ENV",
  "GRAPHRAG_MEMORY_VECTOR_API_KEY",
  "GRAPHRAG_MEMORY_ANTHROPIC_API_KEY",
  "NINE_ROUTER_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  BATCH_LIMIT_VAR,
  POOL_MAX_VAR,
  WAIT_TIMEOUT_VAR,
  "GRAPHRAG_MEMORY_RETRIEVAL_RRF_K",
  "GRAPHRAG_MEMORY_RETRIEVAL_W_VEC",
  "GRAPHRAG_MEMORY_RETRIEVAL_W_BM25",
  "GRAPHRAG_MEMORY_RETRIEVAL_W_GRAPH",
] as const;

function withEnv(
  patch: Record<string, string | undefined>,
  fn: () => void
): void {
  const saved = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  process.env["GRAPHRAG_MEMORY_EMBED_DIMENSIONS"] = "32";
  process.env["GRAPHRAG_MEMORY_PGVECTOR_ANN_MAX_DIMENSIONS"] = "2000";
  process.env["GRAPHRAG_MEMORY_RETRIEVAL_RRF_K"] = "60";
  process.env["GRAPHRAG_MEMORY_RETRIEVAL_W_VEC"] = "0.7";
  process.env["GRAPHRAG_MEMORY_RETRIEVAL_W_BM25"] = "0.15";
  process.env["GRAPHRAG_MEMORY_RETRIEVAL_W_GRAPH"] = "0.15";
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

interface T7Env {
  ingestBatchLimit: number;
  pgvectorPoolMax: number;
  pgvectorConnectionWaitTimeoutMs: number;
}

function t7Env(): T7Env {
  return loadEnv() as unknown as T7Env;
}

describe("T7 batch and pool configuration", () => {
  it("uses finite positive defaults when T7 configuration is absent", () => {
    withEnv({}, () => {
      const env = t7Env();

      expect(env.ingestBatchLimit).toBeGreaterThan(0);
      expect(Number.isFinite(env.ingestBatchLimit)).toBe(true);
      expect(env.pgvectorPoolMax).toBeGreaterThan(0);
      expect(Number.isFinite(env.pgvectorPoolMax)).toBe(true);
      expect(env.pgvectorConnectionWaitTimeoutMs).toBeGreaterThan(0);
      expect(Number.isFinite(env.pgvectorConnectionWaitTimeoutMs)).toBe(true);
    });
  });

  it("reads the configured batch limit and pool parameters", () => {
    withEnv(
      {
        [BATCH_LIMIT_VAR]: "7",
        [POOL_MAX_VAR]: "3",
        [WAIT_TIMEOUT_VAR]: "2500",
      },
      () => {
        const env = t7Env();

        expect(env.ingestBatchLimit).toBe(7);
        expect(env.pgvectorPoolMax).toBe(3);
        expect(env.pgvectorConnectionWaitTimeoutMs).toBe(2500);
      }
    );
  });

  for (const [label, value] of [
    ["missing", ""],
    ["zero", "0"],
    ["negative", "-1"],
    ["non-numeric", "not-a-number"],
    ["non-finite", "Infinity"],
  ] as const) {
    it(`rejects a ${label} batch limit with ConfigError`, () => {
      withEnv({ [BATCH_LIMIT_VAR]: value }, () => {
        expect(() => loadEnv()).toThrow(ConfigError);
        expect(() => loadEnv()).toThrow(
          new RegExp(BATCH_LIMIT_VAR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        );
      });
    });
  }

  for (const [label, value] of [
    ["missing", ""],
    ["zero", "0"],
    ["negative", "-1"],
    ["non-numeric", "not-a-number"],
    ["non-finite", "Infinity"],
  ] as const) {
    it(`rejects an illegal pool cap (${label}) with ConfigError`, () => {
      withEnv({ [POOL_MAX_VAR]: value }, () => {
        expect(() => loadEnv()).toThrow(ConfigError);
        expect(() => loadEnv()).toThrow(
          new RegExp(POOL_MAX_VAR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        );
      });
    });
  }

  it("rejects a non-positive connection wait timeout with ConfigError", () => {
    withEnv({ [WAIT_TIMEOUT_VAR]: "0" }, () => {
      expect(() => loadEnv()).toThrow(ConfigError);
      expect(() => loadEnv()).toThrow(WAIT_TIMEOUT_VAR);
    });
  });
});
