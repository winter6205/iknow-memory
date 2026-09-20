/**
 * Embedding generation rotate T3 — vector READS bound to the ACTIVE slot.
 *
 * While a rotate is open (or the pointer moved anywhere), every cosine read
 * — chunk search, entity seed, community-summary search — must name ONLY
 * the ledger's active physical column: mixing two generations in one
 * `ORDER BY <=>` compares vectors from different cosine spaces and is
 * forbidden outright. A pre-ledger store (no boot state) keeps today's
 * legacy column; a post-cutover pointer flips all three reads together; a
 * corrupt slot identifier refuses BEFORE any SELECT leaves the backend.
 *
 * The query-vector width check follows the same rule: it validates against
 * the ACTIVE generation's width, not the env width (during a dimension
 * rotate the env describes the incoming generation).
 */
import { describe, expect, it } from "vitest";

import { PgvectorBackend } from "../../src/core/storage/pgvector-backend.js";
import { GraphragError } from "../../src/core/errors.js";
import type { SearchOptions } from "../../src/core/types.js";

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
  dimensions = 8,
  embedModel = "m2"
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
      throw new Error("unit read-binding path must not lease a client");
    },
    end: async () => undefined,
  };
  const backend = new PgvectorBackend(
    "postgres://example.invalid/retrieval",
    dimensions,
    { annMaxDimensions: 2000, embedModel }
  );
  (backend as unknown as { pool: typeof pool }).pool = pool;
  return { backend, queries };
}

/**
 * Run the SAME boot guard initialize() runs, so the backend caches the
 * ledger state exactly like a production read process (T3 reads resolve
 * the slot from that cached state — not from a fresh per-query read).
 */
async function booted(backend: PgvectorBackend): Promise<void> {
  await (
    backend as unknown as { guardEmbeddingGenerationBoot(): Promise<unknown> }
  ).guardEmbeddingGenerationBoot();
}

const SEARCH_OPTS: SearchOptions = {
  limit: 10,
  validAt: "2026-06-01T00:00:00Z",
};

function unit8(): number[] {
  return [1, 0, 0, 0, 0, 0, 0, 0];
}

function chunkSelects(queries: RecordedQuery[]): RecordedQuery[] {
  return queries.filter(
    (q) => /^\s*SELECT/.test(q.sql) && q.sql.includes("FROM chunks")
  );
}

function entitySelects(queries: RecordedQuery[]): RecordedQuery[] {
  return queries.filter(
    (q) => /^\s*SELECT/.test(q.sql) && q.sql.includes("FROM entities")
  );
}

function communitySelects(queries: RecordedQuery[]): RecordedQuery[] {
  return queries.filter(
    (q) => /^\s*SELECT/.test(q.sql) && q.sql.includes("community_summaries")
  );
}

describe("PgvectorBackend reads — active slot while a rotate is open (T3)", () => {
  it("chunk cosine names the ACTIVE legacy column, never the incoming one", async () => {
    const { backend, queries } = makeBackend(ledgerRow());
    await booted(backend);

    await backend.search(unit8(), SEARCH_OPTS);

    const selects = chunkSelects(queries);
    expect(selects).toHaveLength(1);
    expect(selects[0]!.sql).toContain("embedding <=> $1::vector");
    // No mixed-generation ORDER BY: the incoming slot may not appear at all.
    expect(selects[0]!.sql).not.toContain("embedding_g2");
  });

  it("entity seed cosine names the ACTIVE column only", async () => {
    const { backend, queries } = makeBackend(ledgerRow());
    await booted(backend);

    await backend.graphArmSeed.seedEntitiesByEmbedding(unit8(), 5);

    const selects = entitySelects(queries);
    expect(selects).toHaveLength(1);
    expect(selects[0]!.sql).toContain("1 - (embedding <=> $1::vector)");
    expect(selects[0]!.sql).toContain("WHERE embedding IS NOT NULL");
    expect(selects[0]!.sql).not.toContain("embedding_g2");
  });

  it("community-summary cosine names the ACTIVE column only", async () => {
    const { backend, queries } = makeBackend(ledgerRow());
    await booted(backend);

    await backend.communitySummaries.searchCommunitySummaries(unit8(), 5);

    const selects = communitySelects(queries);
    expect(selects).toHaveLength(1);
    expect(selects[0]!.sql).toContain("1 - (embedding <=> $1::vector)");
    expect(selects[0]!.sql).toContain("WHERE embedding IS NOT NULL");
    expect(selects[0]!.sql).not.toContain("embedding_g2");
  });
});

describe("PgvectorBackend reads — post-cutover pointer", () => {
  const cutOver = () =>
    ledgerRow({
      active_slot: "embedding_g2",
      active_model: "m2",
      incoming_slot: null,
      incoming_model: null,
      incoming_dimensions: null,
      rotate_mode: null,
    });

  it("all three cosine reads flip to the generated slot together", async () => {
    const { backend, queries } = makeBackend(cutOver());
    await booted(backend);

    await backend.search(unit8(), SEARCH_OPTS);
    await backend.graphArmSeed.seedEntitiesByEmbedding(unit8(), 5);
    await backend.communitySummaries.searchCommunitySummaries(unit8(), 5);

    const sqls = [
      chunkSelects(queries)[0]!.sql,
      entitySelects(queries)[0]!.sql,
      communitySelects(queries)[0]!.sql,
    ];
    expect(sqls.length).toBe(3);
    for (const sql of sqls) {
      expect(sql).toContain("embedding_g2 <=> $1::vector");
      // The legacy column must be gone from the read entirely — a query
      // referencing both slots is mixed-generation cosine (forbidden).
      expect(sql).not.toContain("embedding <=> $1::vector");
      expect(sql).not.toContain("WHERE embedding IS NOT NULL");
    }
  });
});

describe("PgvectorBackend reads — slot resolution guardrails", () => {
  it("a pre-ledger store (no boot state) keeps the legacy column", async () => {
    // No booted() call: the cached generation stays unset, exactly like a
    // store whose ledger row has not been read yet.
    const { backend, queries } = makeBackend(ledgerRow());

    await backend.search(unit8(), SEARCH_OPTS);

    expect(chunkSelects(queries)[0]!.sql).toContain("embedding <=> $1::vector");
  });

  it("refuses a corrupt active slot BEFORE issuing any read SQL", async () => {
    const { backend, queries } = makeBackend(
      ledgerRow({
        active_slot: "embedding; DROP TABLE chunks",
        active_model: "m2",
      })
    );
    await booted(backend);
    const before = queries.length;

    const err = await backend
      .search(unit8(), SEARCH_OPTS)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GraphragError);
    expect((err as GraphragError).code).toBe("STORAGE_ERROR");

    const seed = await backend.graphArmSeed
      .seedEntitiesByEmbedding(unit8(), 5)
      .catch((e: unknown) => e);
    expect(seed).toBeInstanceOf(GraphragError);

    const community = await backend.communitySummaries
      .searchCommunitySummaries(unit8(), 5)
      .catch((e: unknown) => e);
    expect(community).toBeInstanceOf(GraphragError);

    // Nothing beyond the boot guard's ledger reads reached the pool.
    expect(queries).toHaveLength(before);
  });

  it("validates the query vector against the ACTIVE width, not the env width", async () => {
    // env == incoming (4 dims); the ACTIVE generation is 8 wide, so an
    // 8-wide active-pair query vector must search and a 4-wide one must
    // be the typed mismatch.
    const { backend, queries } = makeBackend(
      ledgerRow({ active_dimensions: 8, incoming_dimensions: 4 }),
      4,
      "m2"
    );
    await booted(backend);

    await backend.search(unit8(), SEARCH_OPTS);
    expect(chunkSelects(queries)).toHaveLength(1);
    expect(chunkSelects(queries)[0]!.sql).toContain("embedding <=> $1::vector");

    const err = await backend
      .search([1, 2, 3, 4], SEARCH_OPTS)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GraphragError);
    expect((err as GraphragError).code).toBe("EMBEDDING_DIM_MISMATCH");
  });
});
