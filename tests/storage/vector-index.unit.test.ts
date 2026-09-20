import { describe, expect, it } from "vitest";

import {
  CHUNK_VECTOR_INDEX_NAME,
  PgvectorBackend,
} from "../../src/core/storage/pgvector-backend.js";
import { ConfigError } from "../../src/config.js";
import { GraphragError } from "../../src/core/errors.js";

interface FakePgClient {
  query: (sql: string, values: unknown[]) => Promise<{ rows: unknown[] }>;
  release: () => void;
}

interface FakePgPool {
  query: (sql: string, values: unknown[]) => Promise<{ rows: unknown[] }>;
  connect: () => Promise<FakePgClient>;
  end: () => Promise<void>;
}

function makeBackend(
  dimensions: number,
  annMaxDimensions: number,
  failIndexBuild = false
): { backend: PgvectorBackend; queries: string[] } {
  const queries: string[] = [];
  const client: FakePgClient = {
    query: async (sql) => {
      queries.push(sql);
      if (failIndexBuild && sql.includes(CHUNK_VECTOR_INDEX_NAME)) {
        throw new Error("HNSW build failed");
      }
      if (sql.includes("FROM pg_indexes")) {
        return { rows: [{ indexname: CHUNK_VECTOR_INDEX_NAME }] };
      }
      return { rows: [] };
    },
    release: () => undefined,
  };
  const pool: FakePgPool = {
    query: async () => ({ rows: [] }),
    connect: async () => client,
    end: async () => undefined,
  };
  const backend = new PgvectorBackend(
    "postgres://example.invalid/retrieval",
    dimensions,
    { annMaxDimensions }
  );
  (backend as unknown as { pool: FakePgPool }).pool = pool;
  return { backend, queries };
}

async function ensureTable(backend: PgvectorBackend): Promise<void> {
  await (
    backend as unknown as { ensureTable: () => Promise<void> }
  ).ensureTable();
}

describe("PgvectorBackend chunk vector index bootstrap", () => {
  it("emits one HNSW DDL statement and verifies one catalog entry", async () => {
    const { backend, queries } = makeBackend(1536, 2000);

    await ensureTable(backend);

    expect(
      queries.filter((sql) => sql.includes(CHUNK_VECTOR_INDEX_NAME))
    ).toHaveLength(2);
    expect(
      queries.some(
        (sql) =>
          /CREATE INDEX IF NOT EXISTS chunks_embedding_idx/i.test(sql) &&
          /USING hnsw/i.test(sql) &&
          /vector_cosine_ops/i.test(sql)
      )
    ).toBe(true);
    expect(queries.some((sql) => /FROM pg_indexes/i.test(sql))).toBe(true);
  });

  it("rejects configured dimensions above the configured ANN limit", async () => {
    const { backend, queries } = makeBackend(2048, 2000);

    await expect(ensureTable(backend)).rejects.toBeInstanceOf(ConfigError);
    await expect(ensureTable(backend)).rejects.toMatchObject({
      message: expect.stringContaining("2000"),
    });
    expect(queries).toHaveLength(0);
  });

  for (const [label, annMaxDimensions] of [
    ["zero", 0],
    ["negative", -1],
    ["non-finite NaN", Number.NaN],
    ["non-finite Infinity", Number.POSITIVE_INFINITY],
  ] as const) {
    it(`rejects a ${label} ANN limit before opening a connection`, async () => {
      const { backend, queries } = makeBackend(1536, annMaxDimensions);

      await expect(ensureTable(backend)).rejects.toBeInstanceOf(ConfigError);
      expect(queries).toHaveLength(0);
    });
  }

  it("surfaces an unbuildable index as a non-empty typed storage error", async () => {
    const { backend } = makeBackend(1536, 2000, true);

    const error = await ensureTable(backend).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GraphragError);
    expect(error).toMatchObject({ code: "STORAGE_ERROR" });
    expect((error as Error).message).toContain("HNSW build failed");
  });
});
