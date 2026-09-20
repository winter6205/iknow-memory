/**
 * embed-rotate CLI unit tests (embedding generation rotate T4).
 *
 * The CLI is a thin shell over the storage helpers, so these tests pin the
 * dispatch/exit-code contract with a fake ledger client:
 *   0 success (incl. drop's documented no-op)
 *   1 typed refusal (GraphragError) and ConfigError
 *   2 usage error (unknown subcommand / flag, --mode missing, downtime
 *     without --accept-downtime)
 * plus `status` printing the ledger JSON through the injected out seam.
 */
import { describe, expect, it, vi } from "vitest";

import {
  runCli,
  type EmbedRotateDeps,
} from "../../src/cli/embed-rotate.js";
import type { SlotEmbeddingSource } from "../../src/core/embed-slots.js";
import { FakeEmbedder } from "../../src/core/embedder.js";

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

function openRow(): FakeLedgerRow {
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
  };
}

// IDLE: no rotate open, nothing awaiting rollback/drop — the starting point
// `open` and the no-op `drop` need.
function idleRow(): FakeLedgerRow {
  return {
    ...openRow(),
    incoming_slot: null,
    incoming_model: null,
    incoming_dimensions: null,
    rotate_mode: null,
  };
}

function makeDeps(over: {
  singleton?: FakeLedgerRow | null;
  missing?: Partial<Record<"chunks" | "entities" | "community_summaries", number>>;
} = {}): {
  deps: EmbedRotateDeps;
  queries: { sql: string }[];
  out: string[];
} {
  let row = over.singleton ?? openRow();
  const queries: { sql: string }[] = [];
  const out: string[] = [];
  const source: SlotEmbeddingSource = {
    embedder: new FakeEmbedder(8),
    desired: { model: "m1", dimensions: 8 },
    buildEmbedder: () => new FakeEmbedder(8),
  };
  const deps: EmbedRotateDeps = {
    client: {
      query: async (sql: string, values: unknown[] = []) => {
        queries.push({ sql });
        if (
          /^SELECT 1 FROM embedding_generation WHERE id = 1 FOR UPDATE/.test(sql)
        ) {
          return { rows: row === null ? [] : [{ ok: 1 }] };
        }
        if (/SELECT active_slot[\s\S]*FROM embedding_generation/.test(sql)) {
          return { rows: row === null ? [] : [row] };
        }
        if (/UPDATE embedding_generation/.test(sql) && row !== null) {
          if (/SET active_slot = incoming_slot/.test(sql)) {
            row = {
              ...row,
              active_slot: row.incoming_slot as string,
              active_model: row.incoming_model,
              active_dimensions: row.incoming_dimensions as number,
              rollback_slot: row.active_slot,
              rollback_model: row.active_model,
              rollback_dimensions: row.active_dimensions,
              incoming_slot: null,
              incoming_model: null,
              incoming_dimensions: null,
              rotate_mode: null,
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
        const count =
          /^SELECT count\(\*\)::int AS missing FROM (chunks|entities|community_summaries)\b/.exec(sql);
        if (count !== null) {
          const table = count[1] as "chunks" | "entities" | "community_summaries";
          return { rows: [{ missing: over.missing?.[table] ?? 0 }] };
        }
        return { rows: [] };
      },
    },
    desired: { model: "m2", dimensions: 8 },
    source,
    annMaxDimensions: 2000,
    logger: {
      level: "error",
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    out: (line) => out.push(line),
  };
  return { deps, queries, out };
}

function stderrLines(): { stop: () => void; written: () => string } {
  let buffer = "";
  const spy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      buffer += chunk.toString();
      return true;
    });
  return {
    stop: () => spy.mockRestore(),
    written: () => buffer,
  };
}

describe("embed-rotate CLI dispatch + exit codes", () => {
  it("unknown subcommand is a usage error (exit 2) with the usage line", async () => {
    const { deps } = makeDeps();
    const err = stderrLines();
    const code = await runCli(["shuffle"], deps);
    const text = err.written();
    err.stop();
    expect(code).toBe(2);
    expect(text).toContain("usage:");
    expect(text).toContain('unknown subcommand: "shuffle"');
  });

  it("unknown flag is a usage error (exit 2)", async () => {
    const { deps } = makeDeps();
    const err = stderrLines();
    const code = await runCli(["fill", "--batch", "10"], deps);
    err.stop();
    expect(code).toBe(2);
  });

  it("open without --mode is a usage error (exit 2) and never touches the ledger", async () => {
    const { deps, queries } = makeDeps();
    const err = stderrLines();
    const code = await runCli(["open"], deps);
    err.stop();
    expect(code).toBe(2);
    expect(queries).toHaveLength(0);
  });

  it("open --mode downtime without --accept-downtime refuses (exit 2) before any DDL", async () => {
    const { deps, queries } = makeDeps();
    const err = stderrLines();
    const code = await runCli(["open", "--mode", "downtime"], deps);
    const text = err.written();
    err.stop();
    expect(code).toBe(2);
    expect(text).toContain("--accept-downtime");
    expect(queries).toHaveLength(0);
  });

  it("open --mode downtime --accept-downtime runs the rotate and exits 0", async () => {
    // Needs an IDLE singleton: openRotate refuses while a rotate is open.
    const { deps, queries } = makeDeps({ singleton: idleRow() });
    const code = await runCli(
      ["open", "--mode", "downtime", "--accept-downtime"],
      deps
    );
    expect(code).toBe(0);
    const text = queries.map(({ sql }) => sql).join("\n");
    // The fake answers the information_schema probe with no columns, so the
    // first free slot name is embedding_g2.
    expect(text).toMatch(/ALTER TABLE chunks ADD COLUMN embedding_g2/i);
  });

  it("open --mode sideways is a usage error (exit 2)", async () => {
    const { deps } = makeDeps();
    const err = stderrLines();
    const code = await runCli(["open", "--mode", "sideways"], deps);
    err.stop();
    expect(code).toBe(2);
  });

  it("cutover maps the typed incomplete refusal to exit 1 with the named class on stderr", async () => {
    const { deps } = makeDeps({ missing: { entities: 4 } });
    const err = stderrLines();
    const code = await runCli(["cutover"], deps);
    const text = err.written();
    err.stop();
    expect(code).toBe(1);
    expect(text).toContain("cutover refused");
    expect(text).toContain("entities");
  });

  it("cutover success flips the ledger and exits 0", async () => {
    const { deps } = makeDeps();
    const code = await runCli(["cutover"], deps);
    expect(code).toBe(0);
  });

  it("drop with nothing recorded is a no-op with exit 0 and no DDL", async () => {
    const { deps, queries } = makeDeps({ singleton: idleRow() });
    const code = await runCli(["drop"], deps);
    expect(code).toBe(0);
    expect(
      queries.filter(({ sql }) => /DROP INDEX|DROP COLUMN/.test(sql))
    ).toHaveLength(0);
  });

  it("status prints the ledger JSON through the out seam", async () => {
    const { deps, out } = makeDeps();
    const code = await runCli(["status"], deps);
    expect(code).toBe(0);
    expect(out).toHaveLength(1);
    const parsed = JSON.parse(out[0] as string) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      activeSlot: "embedding",
      incomingSlot: "embedding_g2",
      rollbackSlot: null,
    });
  });

  it("--flags on non-open subcommands are usage errors (no silently dropped flags)", async () => {
    const { deps, queries } = makeDeps();
    const err = stderrLines();
    const code = await runCli(["cutover", "--mode", "dual_write"], deps);
    err.stop();
    expect(code).toBe(2);
    expect(queries).toHaveLength(0);
  });
});
