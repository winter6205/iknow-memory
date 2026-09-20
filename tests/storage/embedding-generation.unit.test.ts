/**
 * Unit proof for the embedding-generation ledger (spec: embedding generation
 * rotate, T1).
 *
 * A stateful fake answers the singleton SELECT/INSERT/UPDATE, the
 * catalog-width probe, and the information_schema slot lookup, so the tests
 * assert BOTH the emitted SQL transcript (no DROP anywhere) and the typed
 * results. The live-Postgres half of the contract is in
 * tests/integration/embedding-generation-pg.test.ts.
 */
import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";

import { ConfigError } from "../../src/config.js";
import { GraphragError } from "../../src/core/errors.js";
import { PgvectorBackend } from "../../src/core/storage/pgvector-backend.js";
import {
  guardEmbeddingBoot,
  openRotate,
  readGenerationState,
} from "../../src/core/storage/embedding-generation.js";

interface FakeGenerationRow {
  active_slot: string;
  active_model: string | null;
  active_dimensions: number;
  incoming_slot: string | null;
  incoming_model: string | null;
  incoming_dimensions: number | null;
  rotate_mode: string | null;
  rollback_slot?: string | null;
  rollback_model?: string | null;
  rollback_dimensions?: number | null;
  updated_at: Date;
}

interface FakeDbOptions {
  /** undefined = table exists but has no row; null = never seeded here. */
  singleton?: FakeGenerationRow | null;
  /** format_type() answer for chunks.embedding; undefined = column absent. */
  chunkEmbeddingType?: string;
  /** embedding* column names already present across the rotation tables. */
  existingEmbeddingColumns?: string[];
}

function makeFakeDb(options: FakeDbOptions = {}) {
  const queries: { sql: string; values?: unknown[] }[] = [];
  let singleton = options.singleton ?? null;
  const client = {
    query: vi.fn(async (sql: string, values?: unknown[]) => {
      queries.push({ sql, values });
      if (/SELECT active_slot[\s\S]*FROM embedding_generation/i.test(sql)) {
        return { rows: singleton === null ? [] : [singleton] };
      }
      if (/INSERT INTO embedding_generation/i.test(sql)) {
        if (singleton === null) {
          const [slot, model, dimensions] = (values ?? []) as [
            string,
            string | null,
            number,
          ];
          singleton = {
            active_slot: slot,
            active_model: model,
            active_dimensions: dimensions,
            incoming_slot: null,
            incoming_model: null,
            incoming_dimensions: null,
            rotate_mode: null,
            updated_at: new Date("2026-01-01T00:00:00Z"),
          };
        }
        return { rows: [] };
      }
      if (/UPDATE embedding_generation/i.test(sql)) {
        if (singleton !== null) {
          const [slot, model, dimensions, mode] = (values ?? []) as [
            string,
            string | null,
            number,
            string,
          ];
          singleton = {
            ...singleton,
            incoming_slot: slot,
            incoming_model: model,
            incoming_dimensions: dimensions,
            rotate_mode: mode,
          };
        }
        return { rows: [] };
      }
      if (/format_type\(atttypid, atttypmod\)/i.test(sql)) {
        if (options.chunkEmbeddingType === undefined) return { rows: [] };
        return { rows: [{ column_type: options.chunkEmbeddingType }] };
      }
      if (/information_schema/i.test(sql)) {
        return {
          rows: (options.existingEmbeddingColumns ?? []).map((name) => ({
            column_name: name,
          })),
        };
      }
      return { rows: [] };
    }),
  } as unknown as PoolClient;
  return {
    client,
    queries,
    getSingleton: () => singleton,
  };
}

function transcript(queries: { sql: string }[]): string {
  return queries.map(({ sql }) => sql).join("\n");
}

function activeRow(
  overrides: Partial<FakeGenerationRow> = {}
): FakeGenerationRow {
  return {
    active_slot: "embedding",
    active_model: "m1",
    active_dimensions: 8,
    incoming_slot: null,
    incoming_model: null,
    incoming_dimensions: null,
    rotate_mode: null,
    updated_at: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

describe("guardEmbeddingBoot (generation pointer seed + boot refuse)", () => {
  it("seeds a fresh store from the catalog width and boots", async () => {
    const { client, queries, getSingleton } = makeFakeDb({
      chunkEmbeddingType: "vector(8)",
    });

    const state = await guardEmbeddingBoot(client, {
      model: "m1",
      dimensions: 8,
    });

    expect(state.activeSlot).toBe("embedding");
    expect(state.active.model).toBe("m1");
    expect(state.active.dimensions).toBe(8);
    expect(state.incomingSlot).toBeNull();
    const insert = queries.find(({ sql }) =>
      /INSERT INTO embedding_generation/i.test(sql)
    );
    expect(insert?.values).toEqual(["embedding", "m1", 8]);
    expect(transcript(queries)).not.toMatch(/DROP\s+(COLUMN|INDEX|TABLE)/i);
    expect(getSingleton()).not.toBeNull();
  });

  it("backfills from the catalog width, then refuses a differing desired", async () => {
    // Existing store predating the ledger: chunks.embedding is 8-wide while
    // the operator now asks for 1536. The backfill records the PHYSICAL width
    // as active, so boot must refuse rather than silently accept the change.
    const { client, queries, getSingleton } = makeFakeDb({
      chunkEmbeddingType: "vector(8)",
    });

    await expect(
      guardEmbeddingBoot(client, { model: "m2", dimensions: 1536 })
    ).rejects.toBeInstanceOf(ConfigError);

    const insert = queries.find(({ sql }) =>
      /INSERT INTO embedding_generation/i.test(sql)
    );
    expect(insert?.values).toEqual(["embedding", "m2", 8]);
    expect(getSingleton()?.active_dimensions).toBe(8);
    // The refusal must not touch the live column.
    expect(transcript(queries)).not.toMatch(/DROP\s+(COLUMN|INDEX|TABLE)/i);
    expect(transcript(queries)).not.toMatch(/ADD COLUMN/i);
  });

  it("refuses boot on a model change with no open rotate, naming both pairs", async () => {
    const { client, queries } = makeFakeDb({ singleton: activeRow() });

    const error = await guardEmbeddingBoot(client, {
      model: "m2",
      dimensions: 8,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toContain("desired model=m2 dims=8");
    expect((error as Error).message).toContain("active model=m1 dims=8");
    expect(transcript(queries)).not.toMatch(/DROP\s+(COLUMN|INDEX|TABLE)/i);
    expect(transcript(queries)).not.toMatch(/ALTER TABLE/i);
  });

  it("boots while an open rotate's incoming matches the desired generation", async () => {
    const { client } = makeFakeDb({
      singleton: activeRow({
        incoming_slot: "embedding_g2",
        incoming_model: "m2",
        incoming_dimensions: 8,
        rotate_mode: "dual_write",
      }),
    });

    const state = await guardEmbeddingBoot(client, {
      model: "m2",
      dimensions: 8,
    });

    expect(state.incomingSlot).toBe("embedding_g2");
    expect(state.rotateMode).toBe("dual_write");
  });

  it("refuses when the open rotate's incoming is not the desired generation", async () => {
    const { client } = makeFakeDb({
      singleton: activeRow({
        incoming_slot: "embedding_g2",
        incoming_model: "m2",
        incoming_dimensions: 6,
        rotate_mode: "dual_write",
      }),
    });

    await expect(
      guardEmbeddingBoot(client, { model: "m2", dimensions: 8 })
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it("treats an absent configured model as the NULL active model (no key = no rotate)", async () => {
    const { client } = makeFakeDb({
      singleton: activeRow({ active_model: null }),
    });

    const state = await guardEmbeddingBoot(client, {
      model: undefined,
      dimensions: 8,
    });
    expect(state.active.model).toBeNull();
  });

  it("rejects a singleton row whose rotate_mode left the vocabulary", async () => {
    const { client } = makeFakeDb({
      singleton: activeRow({
        incoming_slot: "embedding_g2",
        rotate_mode: "sideways",
      }),
    });

    const error = await guardEmbeddingBoot(client, {
      model: "m1",
      dimensions: 8,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GraphragError);
    expect(error).toMatchObject({ code: "STORAGE_ERROR" });
  });
});

describe("openRotate (incoming slots + indexes; refuse paths)", () => {
  const desired = { model: "m2", dimensions: 6 };

  it("refuses typed when desired equals active (nothing to rotate)", async () => {
    const { client, queries } = makeFakeDb({ singleton: activeRow() });

    const error = await openRotate(
      client,
      { model: "m1", dimensions: 8 },
      "dual_write",
      2000
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GraphragError);
    expect(error).toMatchObject({ code: "INVALID_INPUT" });
    expect(transcript(queries)).not.toMatch(/ALTER TABLE|CREATE INDEX/i);
  });

  it("refuses typed a concurrent second rotate while an incoming slot is open", async () => {
    const { client, queries } = makeFakeDb({
      singleton: activeRow({
        incoming_slot: "embedding_g2",
        incoming_model: "m9",
        incoming_dimensions: 4,
        rotate_mode: "downtime",
      }),
    });

    const error = await openRotate(client, desired, "dual_write", 2000).catch(
      (caught: unknown) => caught
    );

    expect(error).toBeInstanceOf(GraphragError);
    expect(error).toMatchObject({ code: "INVALID_INPUT" });
    expect(transcript(queries)).not.toMatch(/ALTER TABLE|CREATE INDEX/i);
  });

  it("refuses dimensions over the ANN limit before touching the catalog", async () => {
    const { client, queries } = makeFakeDb({ singleton: activeRow() });

    await expect(
      openRotate(client, { model: "m2", dimensions: 2048 }, "dual_write", 2000)
    ).rejects.toBeInstanceOf(ConfigError);
    expect(transcript(queries)).not.toMatch(/ALTER TABLE|CREATE INDEX/i);
  });

  // Review repair F: `cutover` refuses while a rollback generation awaits
  // its drop; `openRotate` must refuse the same way, or a re-open followed
  // by `drop` would destroy the in-flight incoming alongside the rollback.
  it("refuses typed while a cutover-displaced rollback generation awaits its drop", async () => {
    const { client, queries } = makeFakeDb({
      singleton: activeRow({
        active_slot: "embedding_g2",
        active_model: "m2",
        active_dimensions: 6,
        rollback_slot: "embedding",
        rollback_model: "m1",
        rollback_dimensions: 8,
      }),
    });

    const error = await openRotate(
      client,
      { model: "m3", dimensions: 4 },
      "dual_write",
      2000
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GraphragError);
    expect(error).toMatchObject({ code: "INVALID_INPUT" });
    expect((error as Error).message).toContain("embedding");
    expect((error as Error).message).toMatch(/drop/i);
    expect(transcript(queries)).not.toMatch(/ALTER TABLE|CREATE INDEX/i);
  });

  it("rejects a rotate mode outside the vocabulary (input contract)", async () => {
    const { client, queries } = makeFakeDb({ singleton: activeRow() });

    const error = await openRotate(
      client,
      desired,
      // Deliberate invalid runtime input for the public storage helper.
      "sideways" as "dual_write",
      2000
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GraphragError);
    expect(error).toMatchObject({ code: "INVALID_INPUT" });
    expect(transcript(queries)).not.toMatch(/ALTER TABLE|CREATE INDEX/i);
  });

  it("adds the incoming column + its own cosine HNSW index to all three tables and records incoming_*", async () => {
    const { client, queries, getSingleton } = makeFakeDb({
      singleton: activeRow(),
    });

    const state = await openRotate(client, desired, "dual_write", 2000);

    const text = transcript(queries);
    for (const table of ["chunks", "entities", "community_summaries"]) {
      expect(text).toMatch(
        new RegExp(
          `ALTER TABLE ${table} ADD COLUMN embedding_g2 vector\\(6\\)`,
          "i"
        )
      );
      expect(text).toMatch(
        new RegExp(
          `CREATE INDEX IF NOT EXISTS ${table}_embedding_g2_idx[\\s\\S]*?USING hnsw \\(embedding_g2 vector_cosine_ops\\)`,
          "i"
        )
      );
    }
    expect(text).toMatch(/BEGIN/i);
    expect(text).toMatch(/COMMIT/i);
    expect(text).not.toMatch(/DROP\s+(COLUMN|INDEX|TABLE)/i);
    // entities keeps NO legacy index: only the incoming slot gains one, so
    // no statement may name the bare legacy `embedding` column in HNSW DDL.
    expect(text).not.toMatch(/USING hnsw \(embedding vector_cosine_ops\)/i);

    const update = queries.find(({ sql }) =>
      /UPDATE embedding_generation/i.test(sql)
    );
    expect(update?.values).toEqual(["embedding_g2", "m2", 6, "dual_write"]);
    expect(state.incomingSlot).toBe("embedding_g2");
    expect(state.incoming?.model).toBe("m2");
    expect(state.incoming?.dimensions).toBe(6);
    expect(state.rotateMode).toBe("dual_write");
    expect(getSingleton()?.active_slot).toBe("embedding");
  });

  it("rolls the slot counter when embedding_g2 is already a live column", async () => {
    const { client, queries } = makeFakeDb({
      singleton: activeRow(),
      existingEmbeddingColumns: ["embedding", "embedding_g2"],
    });

    await openRotate(client, desired, "downtime", 2000);

    const text = transcript(queries);
    expect(text).toMatch(
      /ALTER TABLE chunks ADD COLUMN embedding_g3 vector\(6\)/i
    );
    expect(text).toMatch(/CREATE INDEX IF NOT EXISTS chunks_embedding_g3_idx/i);
  });

  it("refuses typed when the singleton row is absent (boot must seed first)", async () => {
    const { client } = makeFakeDb({ singleton: null });

    const error = await openRotate(client, desired, "dual_write", 2000).catch(
      (caught: unknown) => caught
    );

    expect(error).toBeInstanceOf(GraphragError);
    expect(error).toMatchObject({ code: "STORAGE_ERROR" });
  });
});

describe("readGenerationState", () => {
  it("returns null when no singleton row exists", async () => {
    const { client } = makeFakeDb({ singleton: null });
    expect(await readGenerationState(client)).toBeNull();
  });

  it("maps the row to the typed state", async () => {
    const { client } = makeFakeDb({ singleton: activeRow() });
    const state = await readGenerationState(client);
    expect(state).toMatchObject({
      activeSlot: "embedding",
      active: { model: "m1", dimensions: 8 },
      incomingSlot: null,
      incoming: null,
      rotateMode: null,
    });
  });

  it("rejects an incoming slot recorded without dimensions (corrupt row)", async () => {
    const { client } = makeFakeDb({
      singleton: activeRow({
        incoming_slot: "embedding_g2",
        incoming_dimensions: null,
        rotate_mode: null,
      }),
    });

    const error = await readGenerationState(client).catch(
      (caught: unknown) => caught
    );
    expect(error).toBeInstanceOf(GraphragError);
    expect(error).toMatchObject({ code: "STORAGE_ERROR" });
  });
});

describe("PgvectorBackend boot-guard wiring", () => {
  function makeBackend(row: FakeGenerationRow | null): PgvectorBackend {
    const client = makeFakeDb({ singleton: row });
    const backend = new PgvectorBackend(
      "postgres://example.invalid/retrieval",
      8,
      { annMaxDimensions: 2000, embedModel: "m2" }
    );
    (
      backend as unknown as {
        pool: {
          query: (
            sql: string,
            values: unknown[]
          ) => Promise<{ rows: unknown[] }>;
        };
      }
    ).pool = {
      query: async (sql: string, values?: unknown[]) =>
        (
          client.client as unknown as {
            query: (s: string, v?: unknown[]) => Promise<{ rows: unknown[] }>;
          }
        ).query(sql, values),
    };
    return backend;
  }

  function guard(backend: PgvectorBackend): Promise<unknown> {
    return (
      backend as unknown as {
        guardEmbeddingGenerationBoot: () => Promise<unknown>;
      }
    ).guardEmbeddingGenerationBoot();
  }

  it("surfaces the boot refuse as a typed ConfigError from the backend guard", async () => {
    const backend = makeBackend(activeRow());
    await expect(guard(backend)).rejects.toBeInstanceOf(ConfigError);
  });

  it("records the generation state on a passing boot", async () => {
    const backend = makeBackend(activeRow({ active_model: "m2" }));
    const state = await guard(backend);
    expect(state).toMatchObject({ active: { dimensions: 8 } });
    expect(
      (
        backend as unknown as { getGenerationState: () => unknown }
      ).getGenerationState()
    ).toMatchObject({ active: { model: "m2", dimensions: 8 } });
  });
});
