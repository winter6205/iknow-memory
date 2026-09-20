/**
 * Embedding generation rotate T2 — PgvectorBackend chunk dual-write unit tests.
 *
 * While a rotate is OPEN in `dual_write` mode the backend owns the physical
 * column names, so every chunks upsert must write BOTH slot columns in one
 * INSERT (row-atomic): a secondary vector that is missing or wrong-width
 * refuses the whole batch BEFORE any round-trip — never a half-written row.
 */
import { describe, expect, it } from "vitest";

import { PgvectorBackend } from "../../src/core/storage/pgvector-backend.js";
import { GraphragError } from "../../src/core/errors.js";
import type {
  ChunkRecord,
  EmbeddingGenerationState,
} from "../../src/core/types.js";

interface GenerationLedgerRow {
  active_slot: string;
  active_model: string | null;
  active_dimensions: number;
  incoming_slot: string | null;
  incoming_model: string | null;
  incoming_dimensions: number | null;
  rotate_mode: string | null;
  updated_at: Date;
}

function ledgerRow(
  overrides: Partial<GenerationLedgerRow> = {}
): GenerationLedgerRow {
  return {
    active_slot: "embedding",
    active_model: "m1",
    active_dimensions: 8,
    incoming_slot: "embedding_g2",
    incoming_model: "m2",
    incoming_dimensions: 8,
    rotate_mode: "dual_write",
    updated_at: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

interface RecordedQuery {
  sql: string;
  values: unknown[];
}

function makeBackend(
  row: GenerationLedgerRow | null,
  dimensions = 8
): { backend: PgvectorBackend; queries: RecordedQuery[] } {
  const queries: RecordedQuery[] = [];
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      if (sql.includes("FROM embedding_generation")) {
        return { rows: row === null ? [] : [row] };
      }
      return { rows: [] };
    },
    connect: async () => {
      throw new Error("unit dual-write path must not lease a client");
    },
    end: async () => undefined,
  };
  const backend = new PgvectorBackend(
    "postgres://example.invalid/retrieval",
    dimensions,
    { annMaxDimensions: 2000, embedModel: "m2" }
  );
  (backend as unknown as { pool: typeof pool }).pool = pool;
  return { backend, queries };
}

function chunkRecord(overrides: Partial<ChunkRecord> = {}): ChunkRecord {
  return {
    id: "c1",
    content: "hello world",
    embedding: [1, 2, 3, 4, 5, 6, 7, 8],
    valid_from: "2026-01-01T00:00:00Z",
    valid_until: null,
    source_ref: "docs/x.md",
    metadata: {},
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function insertQueries(queries: RecordedQuery[]): RecordedQuery[] {
  return queries.filter((q) => /^INSERT INTO chunks/i.test(q.sql.trim()));
}

describe("PgvectorBackend.upsert — dual-write while a rotate is open", () => {
  it("writes BOTH slot columns in one row-atomic INSERT with the two vectors", async () => {
    const { backend, queries } = makeBackend(ledgerRow());

    await backend.upsert([
      chunkRecord({
        embedding: [1, 1, 1, 1, 1, 1, 1, 1],
        incoming_embedding: [2, 2, 2, 2, 2, 2, 2, 2],
      }),
    ]);

    const inserts = insertQueries(queries);
    expect(inserts).toHaveLength(1);
    const { sql, values } = inserts[0]!;
    // Both physical columns named in the column list and the conflict SET.
    expect(/content, embedding, embedding_g2, valid_from/.test(sql)).toBe(true);
    expect(sql).toContain("embedding_g2");
    expect(sql).toContain("embedding_g2 = EXCLUDED.embedding_g2");
    // The two vectors are distinct literals present in the values.
    const literals = values.filter(
      (v): v is string => typeof v === "string" && v.startsWith("[")
    );
    expect(literals).toContain("[1,1,1,1,1,1,1,1]");
    expect(literals).toContain("[2,2,2,2,2,2,2,2]");
  });

  it("refuses a chunk missing the incoming vector BEFORE any INSERT", async () => {
    const { backend, queries } = makeBackend(ledgerRow());

    const err = await backend
      .upsert([chunkRecord({ id: "bad", embedding: [1, 2, 3, 4, 5, 6, 7, 8] })])
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GraphragError);
    expect((err as GraphragError).code).toBe("EMBEDDING_FAILED");
    expect(insertQueries(queries)).toHaveLength(0);
  });

  it("refuses a wrong-width incoming vector BEFORE any INSERT", async () => {
    const { backend, queries } = makeBackend(ledgerRow());

    const err = await backend
      .upsert([
        chunkRecord({
          embedding: [1, 2, 3, 4, 5, 6, 7, 8],
          incoming_embedding: [1, 2, 3],
        }),
      ])
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GraphragError);
    expect((err as GraphragError).code).toBe("EMBEDDING_FAILED");
    expect(insertQueries(queries)).toHaveLength(0);
  });

  it("validates the active vector against the LEDGER width, not env (cross-width rotate)", async () => {
    // env == incoming (4 dims would be wrong here); active generation is 8.
    const { backend, queries } = makeBackend(
      ledgerRow({ active_dimensions: 8, incoming_dimensions: 4 }),
      4
    );

    await backend.upsert([
      chunkRecord({
        embedding: [1, 2, 3, 4, 5, 6, 7, 8],
        incoming_embedding: [9, 10, 11, 12],
      }),
    ]);

    const inserts = insertQueries(queries);
    expect(inserts).toHaveLength(1);
    const literals = inserts[0]!.values.filter(
      (v): v is string => typeof v === "string" && v.startsWith("[")
    );
    expect(literals).toContain("[1,2,3,4,5,6,7,8]");
    expect(literals).toContain("[9,10,11,12]");
  });

  it("reports EMBEDDING_DIM_MISMATCH for a wrong-width active vector", async () => {
    const { backend, queries } = makeBackend(ledgerRow());

    const err = await backend
      .upsert([
        chunkRecord({
          embedding: [1, 2, 3],
          incoming_embedding: [1, 2, 3, 4, 5, 6, 7, 8],
        }),
      ])
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GraphragError);
    expect((err as GraphragError).code).toBe("EMBEDDING_DIM_MISMATCH");
    expect(insertQueries(queries)).toHaveLength(0);
  });

  it("refreshes the cached generation state from the fresh read", async () => {
    const { backend } = makeBackend(ledgerRow());
    expect(backend.getGenerationState()).toBeUndefined();

    await backend.upsert([
      chunkRecord({ incoming_embedding: [2, 2, 2, 2, 2, 2, 2, 2] }),
    ]);

    expect(backend.getGenerationState()?.incomingSlot).toBe("embedding_g2");
  });
});

describe("PgvectorBackend.upsert — unchanged behavior without an open rotate", () => {
  it("no ledger row at all keeps today's single-column SQL", async () => {
    const { backend, queries } = makeBackend(null);

    await backend.upsert([chunkRecord()]);

    const inserts = insertQueries(queries);
    expect(inserts).toHaveLength(1);
    const { sql, values } = inserts[0]!;
    expect(sql).toContain("content, embedding, valid_from");
    expect(sql).not.toContain("embedding_g2");
    expect(values).toHaveLength(10);
    // Content-invalidation CASE logic survives the slot refactor.
    expect(sql).toContain("chunks.metadata ? ");
  });

  it("rotate closed (incoming_slot NULL) writes only the active column", async () => {
    const { backend, queries } = makeBackend(
      ledgerRow({
        incoming_slot: null,
        incoming_model: null,
        incoming_dimensions: null,
        rotate_mode: null,
      })
    );

    await backend.upsert([chunkRecord()]);

    const inserts = insertQueries(queries);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.sql).not.toContain("embedding_g2");
    expect(inserts[0]!.values).toHaveLength(10);
  });

  it("downtime-mode rotate does not dual-write at the backend", async () => {
    const { backend, queries } = makeBackend(
      ledgerRow({ rotate_mode: "downtime" })
    );

    await backend.upsert([chunkRecord()]);

    const inserts = insertQueries(queries);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.sql).not.toContain("embedding_g2");
  });

  it("post-cutover ledger pointing at a generated slot uses that column", async () => {
    const { backend, queries } = makeBackend(
      ledgerRow({
        active_slot: "embedding_g2",
        active_model: "m2",
        incoming_slot: null,
        incoming_model: null,
        incoming_dimensions: null,
        rotate_mode: null,
      })
    );

    await backend.upsert([chunkRecord()]);

    const inserts = insertQueries(queries);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.sql).toContain("content, embedding_g2, valid_from");
    expect(inserts[0]!.sql).not.toMatch(/content, embedding, valid_from/);
  });

  it("refuses an identifier outside the validated slot family", async () => {
    const { backend, queries } = makeBackend(
      ledgerRow({ active_slot: "embedding; DROP TABLE chunks" })
    );

    const err = await backend.upsert([chunkRecord()]).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GraphragError);
    expect((err as GraphragError).code).toBe("STORAGE_ERROR");
    expect(insertQueries(queries)).toHaveLength(0);
  });
});

// ─── Review repair E: the caller-bound generation is the SSOT ─────────────

/** Open dual-write state, mirroring `ledgerRow()` above. */
function openGeneration(): EmbeddingGenerationState {
  return {
    activeSlot: "embedding",
    active: { model: "m1", dimensions: 8 },
    incomingSlot: "embedding_g2",
    incoming: { model: "m2", dimensions: 8 },
    rotateMode: "dual_write",
    rollbackSlot: null,
    rollback: null,
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  };
}

describe("PgvectorBackend.upsert — caller-bound generation (review repair E)", () => {
  it("dual-writes the PROVIDED state and never re-reads the ledger", async () => {
    // The fake DB answers NO ledger row at all: a fresh re-read would
    // single-column write. The provided open-rotate state must drive the
    // dual-write instead, and must be the ONLY state consulted.
    const { backend, queries } = makeBackend(null);

    await backend.upsert(
      [chunkRecord({ incoming_embedding: [2, 2, 2, 2, 2, 2, 2, 2] })],
      { generation: openGeneration() }
    );

    expect(
      queries.filter((q) => /FROM embedding_generation/.test(q.sql))
    ).toHaveLength(0);
    const inserts = insertQueries(queries);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.sql).toContain("embedding_g2 = EXCLUDED.embedding_g2");
  });

  it("validates the incoming vector against the PROVIDED state before ANY round-trip", async () => {
    // Same store (fake says no ledger row) + a chunk lacking the incoming
    // vector: the bound open rotate must refuse it without touching the DB.
    const { backend, queries } = makeBackend(null);

    const err = await backend
      .upsert([chunkRecord()], { generation: openGeneration() })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GraphragError);
    expect((err as GraphragError).code).toBe("EMBEDDING_FAILED");
    expect(queries).toHaveLength(0);
  });

  it("an explicit null generation means no ledger — single-column SQL, no re-read", async () => {
    // The fake DB now claims a rotate is OPEN; the caller's explicit null
    // still wins: no re-read, no dual-write.
    const { backend, queries } = makeBackend(ledgerRow());

    await backend.upsert([chunkRecord()], { generation: null });

    expect(
      queries.filter((q) => /FROM embedding_generation/.test(q.sql))
    ).toHaveLength(0);
    expect(insertQueries(queries)[0]!.sql).not.toContain("embedding_g2");
  });

  it("an empty options object keeps today's fresh re-read", async () => {
    const { backend, queries } = makeBackend(ledgerRow());

    await backend.upsert(
      [chunkRecord({ incoming_embedding: [2, 2, 2, 2, 2, 2, 2, 2] })],
      {}
    );

    expect(
      queries.filter((q) => /FROM embedding_generation/.test(q.sql)).length
    ).toBeGreaterThan(0);
    expect(insertQueries(queries)[0]!.sql).toContain("embedding_g2");
  });
});
