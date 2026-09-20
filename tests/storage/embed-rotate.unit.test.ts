/**
 * Embedding generation rotate T4 — cutover / rollback / drop / fill (unit).
 *
 * A stateful fake ledger answers the singleton SELECT + FOR UPDATE lock,
 * the per-class completeness counts, the fill scans/UPDATEs and records all
 * DDL, so these tests assert BOTH the emitted SQL transcript (row-lock
 * ordering, no DROP where none is allowed, active column never written by
 * fill) AND the resulting ledger row. The live-Postgres half of the story
 * is tests/integration/embedding-generation-pg.test.ts.
 *
 * The final describe pins the downtime read refuse: while a `downtime`
 * rotate is open, all three PgvectorBackend cosine reads throw the typed
 * named failure BEFORE any SELECT leaves the backend.
 */
import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";

import { GraphragError } from "../../src/core/errors.js";
import { PgvectorBackend } from "../../src/core/storage/pgvector-backend.js";
import { readGenerationState } from "../../src/core/storage/embedding-generation.js";
import {
  cutoverRotate,
  dropInactiveSlot,
  fillIncoming,
  rollbackRotate,
} from "../../src/core/storage/embedding-rotate.js";
import type { SlotEmbeddingSource } from "../../src/core/embed-slots.js";
import type { EmbeddingClient } from "../../src/core/embedder.js";
import type {
  EmbeddingGenerationPair,
  EmbeddingGenerationState,
} from "../../src/core/types.js";

interface FakeLedgerRow {
  active_slot: string;
  active_model: string | null;
  active_dimensions: number;
  incoming_slot: string | null;
  incoming_model: string | null;
  incoming_dimensions: number | null;
  rotate_mode: string | null;
  rollback_slot: string | null;
  rollback_model: string | null;
  rollback_dimensions: number | null;
  updated_at: Date;
}

function openRow(over: Partial<FakeLedgerRow> = {}): FakeLedgerRow {
  // A dual-write rotate is OPEN: active m1/8, incoming embedding_g2 m2/8.
  return {
    active_slot: "embedding",
    active_model: "m1",
    active_dimensions: 8,
    incoming_slot: "embedding_g2",
    incoming_model: "m2",
    incoming_dimensions: 8,
    rotate_mode: "dual_write",
    rollback_slot: null,
    rollback_model: null,
    rollback_dimensions: null,
    updated_at: new Date("2026-01-01T00:00:00Z"),
    ...over,
  };
}

function cutOverRow(over: Partial<FakeLedgerRow> = {}): FakeLedgerRow {
  // POST-cutover: the new generation is active, the old one awaits
  // rollback/drop.
  return openRow({
    active_slot: "embedding_g2",
    active_model: "m2",
    incoming_slot: null,
    incoming_model: null,
    incoming_dimensions: null,
    rotate_mode: null,
    rollback_slot: "embedding",
    rollback_model: "m1",
    rollback_dimensions: 8,
    ...over,
  });
}

type TableFillRows = Record<string, unknown>[];

interface FakeRotateDbOptions {
  singleton: FakeLedgerRow | null;
  /** Per-class incoming-missing counts for the cutover completeness check. */
  missing?: Partial<Record<"chunks" | "entities" | "community_summaries", number>>;
  /** Successive scan batches per table (popped one per SELECT). */
  fillBatches?: Partial<
    Record<"chunks" | "entities" | "community_summaries", TableFillRows[]>
  >;
}

function makeRotateDb(options: FakeRotateDbOptions) {
  const queries: { sql: string; values: unknown[] }[] = [];
  let row = options.singleton;
  const batches = {
    chunks: [...(options.fillBatches?.chunks ?? [])],
    entities: [...(options.fillBatches?.entities ?? [])],
    community_summaries: [...(options.fillBatches?.community_summaries ?? [])],
  };
  const fillUpdates: { table: string; id: string; slot: string }[] = [];

  const client = {
    query: vi.fn(async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      if (/^SELECT 1 FROM embedding_generation WHERE id = 1 FOR UPDATE/.test(sql)) {
        return { rows: row === null ? [] : [{ ok: 1 }] };
      }
      if (/SELECT active_slot[\s\S]*FROM embedding_generation/i.test(sql)) {
        return { rows: row === null ? [] : [row] };
      }
      if (/UPDATE embedding_generation/i.test(sql) && row !== null) {
        if (/SET active_slot = incoming_slot/.test(sql)) {
          row = {
            ...row,
            active_slot: row.incoming_slot,
            active_model: row.incoming_model,
            active_dimensions: row.incoming_dimensions,
            rollback_slot: row.active_slot,
            rollback_model: row.active_model,
            rollback_dimensions: row.active_dimensions,
            incoming_slot: null,
            incoming_model: null,
            incoming_dimensions: null,
            rotate_mode: null,
          };
        } else if (/SET active_slot = rollback_slot/.test(sql)) {
          row = {
            ...row,
            active_slot: row.rollback_slot,
            active_model: row.rollback_model,
            active_dimensions: row.rollback_dimensions,
            rollback_slot: row.active_slot,
            rollback_model: row.active_model,
            rollback_dimensions: row.active_dimensions,
          };
        } else if (/SET incoming_slot = NULL/.test(sql)) {
          row = {
            ...row,
            incoming_slot: null,
            incoming_model: null,
            incoming_dimensions: null,
            rotate_mode: null,
            rollback_slot: null,
            rollback_model: null,
            rollback_dimensions: null,
          };
        }
        return { rows: [] };
      }
      const countMatch =
        /^SELECT count\(\*\)::int AS missing FROM (chunks|entities|community_summaries)\b/.exec(sql);
      if (countMatch !== null) {
        const table = countMatch[1] as keyof NonNullable<FakeRotateDbOptions["missing"]>;
        return { rows: [{ missing: options.missing?.[table] ?? 0 }] };
      }
      const scanMatch =
        /^SELECT [\s\S]+ FROM (chunks|entities|community_summaries) WHERE .* IS NULL ORDER BY id LIMIT \$1/.exec(sql);
      if (scanMatch !== null) {
        const table = scanMatch[1] as keyof typeof batches;
        return { rows: batches[table].shift() ?? [] };
      }
      const updateMatch =
        /^UPDATE (chunks|entities|community_summaries) SET (\w+) = \$2::vector WHERE id = \$1 AND \2 IS NULL RETURNING id/.exec(sql);
      if (updateMatch !== null) {
        fillUpdates.push({
          table: updateMatch[1],
          id: String(values[0]),
          slot: updateMatch[2],
        });
        return { rows: [{ id: values[0] }] };
      }
      return { rows: [] };
    }),
  } as unknown as PoolClient;
  return {
    client,
    queries,
    ledgerRow: () => row,
    fillUpdates,
  };
}

function transcript(queries: { sql: string }[]): string {
  return queries.map(({ sql }) => sql).join("\n");
}

function indexOfSql(queries: { sql: string }[], pattern: RegExp): number {
  return queries.findIndex(({ sql }) => pattern.test(sql));
}

function silentLogger() {
  return {
    level: "error" as const,
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

/** Deterministic width-DIM fake embedder. */
function fakeEmbedder(dim: number, seen: string[][]): EmbeddingClient {
  return {
    modelId: `fake${dim}`,
    embed: async (texts: string[]) => {
      seen.push(texts);
      return texts.map(() => new Array<number>(dim).fill(0.25));
    },
  };
}

function fakeSource(args: {
  desiredModel: string;
  dimensions: number;
  seenTexts: string[][];
  secondaryPairs: EmbeddingGenerationPair[];
  secondaryDim?: number;
}): SlotEmbeddingSource {
  return {
    embedder: fakeEmbedder(args.dimensions, args.seenTexts),
    desired: { model: args.desiredModel, dimensions: args.dimensions },
    buildEmbedder: (pair) => {
      args.secondaryPairs.push(pair);
      return fakeEmbedder(args.secondaryDim ?? pair.dimensions, args.seenTexts);
    },
  };
}

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const UUID_C = "33333333-3333-4333-8333-333333333333";

describe("cutoverRotate (completeness gate + one pointer flip)", () => {
  it("refuses typed on the first incomplete class, naming it and the missing count, without touching the ledger", async () => {
    const db = makeRotateDb({
      singleton: openRow(),
      missing: { chunks: 0, entities: 2 },
    });

    const error = await cutoverRotate(db.client).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GraphragError);
    expect(error).toMatchObject({ code: "INVALID_INPUT" });
    expect((error as Error).message).toContain("entities");
    expect((error as Error).message).toContain("2");
    // Chunks are checked first and pass; the refusal names the FIRST miss.
    expect((error as Error).message).not.toContain("chunks");
    const text = transcript(db.queries);
    expect(text).toMatch(/BEGIN/);
    expect(text).toMatch(/ROLLBACK/);
    expect(text).not.toMatch(/UPDATE embedding_generation/);
    expect(text).not.toMatch(/DROP\s+(COLUMN|INDEX|TABLE)/i);
  });

  it("flips active to incoming, records the displaced pair as rollback_*, clears incoming, in ONE txn", async () => {
    const db = makeRotateDb({ singleton: openRow() });

    const state: EmbeddingGenerationState = await cutoverRotate(db.client);

    expect(state.activeSlot).toBe("embedding_g2");
    expect(state.active).toEqual({ model: "m2", dimensions: 8 });
    expect(state.rollbackSlot).toBe("embedding");
    expect(state.rollback).toEqual({ model: "m1", dimensions: 8 });
    expect(state.incomingSlot).toBeNull();
    expect(state.rotateMode).toBeNull();
    const flips = db.queries.filter(({ sql }) =>
      /UPDATE embedding_generation/.test(sql)
    );
    expect(flips).toHaveLength(1);
    const text = transcript(db.queries);
    expect(text).toMatch(/COMMIT/);
    // The one flip covers all three tables — no per-table pointer writes.
    expect(text).not.toMatch(/DROP\s+(COLUMN|INDEX|TABLE)/i);
  });

  it("takes the ledger row lock (FOR UPDATE) before the counts and the flip", async () => {
    const db = makeRotateDb({ singleton: openRow() });
    await cutoverRotate(db.client);
    const begin = indexOfSql(db.queries, /^BEGIN$/);
    const lock = indexOfSql(db.queries, /^SELECT 1 FROM embedding_generation .*FOR UPDATE$/);
    const count = indexOfSql(db.queries, /AS missing FROM chunks/);
    const flip = indexOfSql(db.queries, /UPDATE embedding_generation/);
    const commit = indexOfSql(db.queries, /^COMMIT$/);
    expect(begin).toBeLessThan(lock);
    expect(lock).toBeLessThan(count);
    expect(count).toBeLessThan(flip);
    expect(flip).toBeLessThan(commit);
  });

  it("refuses typed when no rotate is open (nothing to cut over to)", async () => {
    const db = makeRotateDb({
      singleton: openRow({
        incoming_slot: null,
        incoming_model: null,
        incoming_dimensions: null,
        rotate_mode: null,
      }),
    });

    const error = await cutoverRotate(db.client).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GraphragError);
    expect(error).toMatchObject({ code: "INVALID_INPUT" });
    expect(transcript(db.queries)).not.toMatch(/UPDATE embedding_generation/);
  });

  it("refuses typed when a previous generation still awaits its drop (no silent orphaning)", async () => {
    // A new incoming opened while the old rollback slot was never dropped:
    // flipping would overwrite rollback_* and strand the old column.
    const db = makeRotateDb({
      singleton: cutOverRow({
        incoming_slot: "embedding_g3",
        incoming_model: "m3",
        incoming_dimensions: 8,
        rotate_mode: "dual_write",
      }),
    });

    const error = await cutoverRotate(db.client).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GraphragError);
    expect(error).toMatchObject({ code: "INVALID_INPUT" });
    expect((error as Error).message).toContain("embedding");
    expect(transcript(db.queries)).not.toMatch(/UPDATE embedding_generation/);
  });

  it("refuses typed STORAGE_ERROR when the singleton row is absent", async () => {
    const db = makeRotateDb({ singleton: null });
    const error = await cutoverRotate(db.client).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GraphragError);
    expect(error).toMatchObject({ code: "STORAGE_ERROR" });
  });
});

describe("rollbackRotate (post-cutover flip back)", () => {
  it("refuses typed before any cutover (rollback_slot absent)", async () => {
    const db = makeRotateDb({
      singleton: openRow({
        incoming_slot: null,
        incoming_model: null,
        incoming_dimensions: null,
        rotate_mode: null,
      }),
    });

    const error = await rollbackRotate(db.client).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GraphragError);
    expect(error).toMatchObject({ code: "INVALID_INPUT" });
    expect((error as Error).message).toMatch(/nothing to roll back/);
    const text = transcript(db.queries);
    expect(text).not.toMatch(/UPDATE embedding_generation/);
    expect(text).not.toMatch(/DROP\s+(COLUMN|INDEX|TABLE)/i);
  });

  it("flips active back to the rollback slot and keeps the displaced generation tracked", async () => {
    const db = makeRotateDb({ singleton: cutOverRow() });

    const state = await rollbackRotate(db.client);

    expect(state.activeSlot).toBe("embedding");
    expect(state.active).toEqual({ model: "m1", dimensions: 8 });
    // The displaced new generation stays recorded as the inactive slot so a
    // later drop can still find it (no untracked orphan column).
    expect(state.rollbackSlot).toBe("embedding_g2");
    expect(state.rollback).toEqual({ model: "m2", dimensions: 8 });
    expect(state.incomingSlot).toBeNull();
    const flips = db.queries.filter(({ sql }) =>
      /UPDATE embedding_generation/.test(sql)
    );
    expect(flips).toHaveLength(1);
  });

  it("refuses typed while a rotate is open (cut over or drop it first)", async () => {
    const db = makeRotateDb({
      singleton: cutOverRow({
        incoming_slot: "embedding_g3",
        incoming_model: "m3",
        incoming_dimensions: 8,
        rotate_mode: "downtime",
      }),
    });

    const error = await rollbackRotate(db.client).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GraphragError);
    expect(error).toMatchObject({ code: "INVALID_INPUT" });
    expect(transcript(db.queries)).not.toMatch(/UPDATE embedding_generation/);
  });
});

describe("dropInactiveSlot (index + column removal; idempotent no-op)", () => {
  function dropStatements(queries: { sql: string }[]): string[] {
    return queries
      .filter(({ sql }) => /DROP INDEX|DROP COLUMN/.test(sql))
      .map(({ sql }) => sql);
  }

  it("drops the incoming slot mid-rotate (abort) across all three tables and clears the ledger", async () => {
    const db = makeRotateDb({ singleton: openRow() });

    const result = await dropInactiveSlot(db.client);

    expect(result.droppedSlots).toEqual(["embedding_g2"]);
    const text = transcript(db.queries);
    for (const table of ["chunks", "entities", "community_summaries"]) {
      expect(text).toContain(`DROP INDEX IF EXISTS ${table}_embedding_g2_idx`);
      expect(text).toContain(
        `ALTER TABLE ${table} DROP COLUMN IF EXISTS embedding_g2`
      );
    }
    expect(text).toMatch(/UPDATE embedding_generation[\s\S]*SET incoming_slot = NULL/);
    const row = db.ledgerRow();
    expect(row?.incoming_slot).toBeNull();
    expect(row?.rotate_mode).toBeNull();
    expect(row?.active_slot).toBe("embedding");
  });

  it("drops the post-cutover rollback slot, keeps the active one, and a second drop is a DDL-free no-op", async () => {
    const db = makeRotateDb({ singleton: cutOverRow() });

    const first = await dropInactiveSlot(db.client);
    expect(first.droppedSlots).toEqual(["embedding"]);
    const text = transcript(db.queries);
    expect(text).toContain("ALTER TABLE chunks DROP COLUMN IF EXISTS embedding");
    expect(text).not.toMatch(/DROP COLUMN IF EXISTS embedding_g2/);
    expect(db.ledgerRow()?.rollback_slot).toBeNull();
    expect(db.ledgerRow()?.active_slot).toBe("embedding_g2");

    const before = db.queries.length;
    const second = await dropInactiveSlot(db.client);
    expect(second.droppedSlots).toEqual([]);
    expect(dropStatements(db.queries.slice(before))).toHaveLength(0);
    expect(
      db.queries
        .slice(before)
        .filter(({ sql }) => /UPDATE embedding_generation/.test(sql))
    ).toHaveLength(0);
  });

  it("drops BOTH recorded slots when a new rotate opened over an undropped generation", async () => {
    const db = makeRotateDb({
      singleton: cutOverRow({
        incoming_slot: "embedding_g3",
        incoming_model: "m3",
        incoming_dimensions: 8,
        rotate_mode: "downtime",
      }),
    });

    const result = await dropInactiveSlot(db.client);
    expect(result.droppedSlots).toEqual(["embedding_g3", "embedding"]);
    const text = transcript(db.queries);
    expect(text).toMatch(/DROP COLUMN IF EXISTS embedding_g3/i);
    expect(text).toMatch(/DROP COLUMN IF EXISTS embedding\b/i);
  });

  it("refuses typed (corrupt ledger) when a drop target equals the active slot — never drops the live column", async () => {
    const db = makeRotateDb({
      singleton: cutOverRow({ rollback_slot: "embedding_g2" }),
    });

    const error = await dropInactiveSlot(db.client).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GraphragError);
    expect(error).toMatchObject({ code: "STORAGE_ERROR" });
    expect(transcript(db.queries)).not.toMatch(/DROP\s+(COLUMN|INDEX|TABLE)/i);
  });
});

describe("fillIncoming (embed toward the incoming slot from ledger text)", () => {
  it("refuses typed when no rotate is open (nothing to fill toward)", async () => {
    const db = makeRotateDb({
      singleton: openRow({
        incoming_slot: null,
        incoming_model: null,
        incoming_dimensions: null,
        rotate_mode: null,
      }),
    });
    const seenTexts: string[][] = [];
    const source = fakeSource({
      desiredModel: "m1",
      dimensions: 8,
      seenTexts,
      secondaryPairs: [],
    });

    const error = await fillIncoming(db.client, source).catch(
      (caught: unknown) => caught
    );
    expect(error).toBeInstanceOf(GraphragError);
    expect(error).toMatchObject({ code: "INVALID_INPUT" });
    expect(seenTexts).toHaveLength(0);
    expect(transcript(db.queries)).not.toMatch(/^UPDATE /m);
  });

  it("scans only incoming-IS-NULL rows, embeds ledger text with the INCOMING pair, and never writes the active column", async () => {
    const db = makeRotateDb({
      singleton: openRow(),
      fillBatches: {
        chunks: [[{ id: UUID_A, content: "slice one" }]],
        entities: [
          [
            { id: UUID_B, canonical_name: "Alice Smith", description: "works at Acme" },
            { id: UUID_C, canonical_name: "Acme Corp", description: "" },
          ],
        ],
        community_summaries: [[{ id: UUID_A, summary: "cluster summary" }]],
      },
    });
    const seenTexts: string[][] = [];
    const secondaryPairs: EmbeddingGenerationPair[] = [];
    const source = fakeSource({
      desiredModel: "m1",
      dimensions: 8,
      seenTexts,
      secondaryPairs,
    });

    const summary = await fillIncoming(db.client, source);

    expect(summary.perTable.chunks).toEqual({ scanned: 1, filled: 1 });
    expect(summary.perTable.entities).toEqual({ scanned: 2, filled: 2 });
    expect(summary.perTable.community_summaries).toEqual({ scanned: 1, filled: 1 });
    // The secondary embedder is built EXACTLY for the recorded incoming pair.
    expect(secondaryPairs).toEqual([{ model: "m2", dimensions: 8 }]);
    // Ledger text per class: chunk content raw, entity via the assembler,
    // community summary raw.
    expect(seenTexts.flat()).toEqual([
      "slice one",
      "Alice Smith | works at Acme",
      "Acme Corp | ",
      "cluster summary",
    ]);
    // Every write targets the incoming column only, guarded on IS NULL.
    expect(db.fillUpdates).toHaveLength(4);
    for (const update of db.fillUpdates) {
      expect(update.slot).toBe("embedding_g2");
    }
    const text = transcript(db.queries);
    expect(text).not.toMatch(/UPDATE \w+ SET embedding =/);
    expect(text).not.toMatch(/UPDATE \w+ SET embedding WHERE/);
    // Scans restrict to the missing rows only.
    expect(text).toMatch(/FROM chunks WHERE embedding_g2 IS NULL/);
    expect(text).toMatch(/FROM entities WHERE retired = false AND embedding_g2 IS NULL/);
    expect(text).toMatch(/FROM community_summaries WHERE embedding_g2 IS NULL/);
    // A fill run is row-autocommitted: no wrapper transaction around the writes.
    expect(text).not.toMatch(/^BEGIN$/m);
  });

  it("is idempotent: a second run with nothing left scans 0 and fills 0", async () => {
    const db = makeRotateDb({ singleton: openRow(), fillBatches: {} });
    const source = fakeSource({
      desiredModel: "m2",
      dimensions: 8,
      seenTexts: [],
      secondaryPairs: [],
    });

    const summary = await fillIncoming(db.client, source);
    expect(summary.perTable.chunks).toEqual({ scanned: 0, filled: 0 });
    expect(summary.perTable.entities.scanned).toBe(0);
    expect(summary.perTable.community_summaries.scanned).toBe(0);
    expect(db.fillUpdates).toHaveLength(0);
    // env == incoming: the env embedder covers it, no secondary built.
  });

  it("refuses typed EMBEDDING_DIM_MISMATCH before writing when the embedder returns the wrong width", async () => {
    const db = makeRotateDb({
      singleton: openRow(),
      fillBatches: { chunks: [[{ id: UUID_A, content: "slice one" }]] },
    });
    const seenTexts: string[][] = [];
    const source = fakeSource({
      desiredModel: "m1",
      dimensions: 8,
      seenTexts,
      secondaryPairs: [],
      secondaryDim: 6,
    });

    const error = await fillIncoming(db.client, source).catch(
      (caught: unknown) => caught
    );
    expect(error).toBeInstanceOf(GraphragError);
    expect(error).toMatchObject({ code: "EMBEDDING_DIM_MISMATCH" });
    expect(db.fillUpdates).toHaveLength(0);
  });

  it("rejects a non-positive batchSize before issuing any query (input contract)", async () => {
    const db = makeRotateDb({ singleton: openRow() });
    const source = fakeSource({
      desiredModel: "m1",
      dimensions: 8,
      seenTexts: [],
      secondaryPairs: [],
    });

    const error = await fillIncoming(db.client, source, { batchSize: 0 }).catch(
      (caught: unknown) => caught
    );
    expect(error).toBeInstanceOf(GraphragError);
    expect(error).toMatchObject({ code: "INVALID_INPUT" });
    expect(db.queries).toHaveLength(0);
  });
});

describe("readGenerationState — rollback columns", () => {
  it("maps rollback_slot/model/dimensions onto the typed state", async () => {
    const db = makeRotateDb({ singleton: cutOverRow() });
    const state = await readGenerationState(db.client);
    expect(state?.rollbackSlot).toBe("embedding");
    expect(state?.rollback).toEqual({ model: "m1", dimensions: 8 });
  });

  it("rejects a rollback slot recorded without dimensions (corrupt row)", async () => {
    const db = makeRotateDb({
      singleton: cutOverRow({ rollback_dimensions: null }),
    });
    const error = await readGenerationState(db.client).catch(
      (caught: unknown) => caught
    );
    expect(error).toBeInstanceOf(GraphragError);
    expect(error).toMatchObject({ code: "STORAGE_ERROR" });
  });

  it("treats a row without the rollback keys (pre-T4 fake/deployed read) as no rollback", async () => {
    const legacy = { ...openRow() } as Record<string, unknown>;
    delete legacy.rollback_slot;
    delete legacy.rollback_model;
    delete legacy.rollback_dimensions;
    const db = makeRotateDb({ singleton: legacy as unknown as FakeLedgerRow });
    const state = await readGenerationState(db.client);
    expect(state?.rollbackSlot).toBeNull();
    expect(state?.rollback).toBeNull();
  });
});

describe("PgvectorBackend downtime read refuse (T4)", () => {
  interface ReadLedgerRow extends FakeLedgerRow {}

  function makeReadBackend(
    row: ReadLedgerRow,
    dimensions = 8,
    embedModel = "m1"
  ): { backend: PgvectorBackend; queries: { sql: string }[] } {
    const queries: { sql: string }[] = [];
    const pool = {
      query: async (sql: string, values: unknown[] = []) => {
        queries.push({ sql, values });
        if (/SELECT active_slot[\s\S]*FROM embedding_generation/i.test(sql)) {
          return { rows: [row] };
        }
        return { rows: [] };
      },
      connect: async () => {
        throw new Error("unit downtime path must not lease a client");
      },
      end: async () => undefined,
    };
    const backend = new PgvectorBackend(
      "postgres://example.invalid/downtime",
      dimensions,
      2000,
      {},
      embedModel
    );
    (backend as unknown as { pool: typeof pool }).pool = pool;
    return { backend, queries };
  }

  async function booted(backend: PgvectorBackend): Promise<void> {
    await (
      backend as unknown as { guardEmbeddingGenerationBoot(): Promise<unknown> }
    ).guardEmbeddingGenerationBoot();
  }

  function unit8(): number[] {
    return [1, 0, 0, 0, 0, 0, 0, 0];
  }

  it("refuses chunk search, entity seed AND community cosine with one typed named failure, before any SELECT", async () => {
    const { backend, queries } = makeReadBackend(
      openRow({ rotate_mode: "downtime" })
    );
    await booted(backend);
    const before = queries.length;

    for (const read of [
      () => backend.search(unit8(), { limit: 5, validAt: "2026-06-01T00:00:00Z" }),
      () => backend.graphArmSeed.seedEntitiesByEmbedding(unit8(), 5),
      () => backend.communitySummaries.searchCommunitySummaries(unit8(), 5),
    ]) {
      const error = await read().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(GraphragError);
      expect(error).toMatchObject({ code: "STORAGE_ERROR" });
      expect((error as Error).message).toContain(
        "embedding rotate downtime: vector retrieve refused until cutover"
      );
    }
    expect(queries).toHaveLength(before);
  });

  it("leaves dual_write reads untouched (only the downtime mode refuses)", async () => {
    const { backend, queries } = makeReadBackend(openRow());
    await booted(backend);
    const before = queries.length;

    await backend.search(unit8(), { limit: 5, validAt: "2026-06-01T00:00:00Z" });

    expect(queries.length).toBeGreaterThan(before);
    expect(queries[before]!.sql).toContain("FROM chunks");
  });
});
