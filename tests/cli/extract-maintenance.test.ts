/**
 * CLI surface for the extract-verify T2 review lane: `--promote UUID` and
 * `--discard UUID` (unit level, fake pool — the same harness shape as
 * `tests/cli/extract.unit.test.ts`, kept in its own file).
 *
 * Pinned contracts:
 *   - UUID validation (usage error, exit 2) and mutual exclusion with every
 *     other mode flag (the modes list) and with --dry-run / --method /
 *     --source-ref / --batch-id (named usage errors);
 *   - --discard: report-lane exit 0/1, the only write is the discarded_at
 *     stamp — graph (triples / entities / projection_outbox) is untouched;
 *   - --promote: the replay runs through the shared persist + outbox
 *     functions in one transaction (BEGIN → triples → outbox →
 *     succeeded → COMMIT), the extractor is never dialed (keyless fake with
 *     an empty queue proves it);
 *   - typed refusals map to exit 1 (reportFatal), not 2.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  parseArgs,
  runCli,
  isRealExtraction,
  persistsEmbeddings,
  type CliClient,
  type CliDeps,
  type CliPool,
} from "../../src/cli/extract.js";
import { FakeLLMClient } from "../../src/core/extraction/llm-client.js";
import { FakeEmbedder } from "../../src/core/embedder.js";
import type { ExtractionOutput } from "../../src/core/extraction/types.js";

const ANN_MAX_DIMENSIONS_VAR = "GRAPHRAG_MEMORY_PGVECTOR_ANN_MAX_DIMENSIONS";
const savedAnnMaxDimensions = process.env[ANN_MAX_DIMENSIONS_VAR];

beforeAll(() => {
  process.env[ANN_MAX_DIMENSIONS_VAR] = "2000";
});

afterAll(() => {
  if (savedAnnMaxDimensions === undefined)
    delete process.env[ANN_MAX_DIMENSIONS_VAR];
  else process.env[ANN_MAX_DIMENSIONS_VAR] = savedAnnMaxDimensions;
});

const REC = "11111111-1111-4111-8111-111111111111";
const REC2 = "22222222-2222-4222-8222-222222222222";
const CHUNK = "33333333-3333-4333-8333-333333333333";
const BATCH = "44444444-4444-4444-8444-444444444444";

const PROPOSED: ExtractionOutput = {
  head: "Alice",
  headType: "person",
  relationRaw: "works at",
  relationNorm: "RELATED_TO",
  tail: "Acme Corp",
  tailType: "organization",
  description: "Alice works at Acme Corp",
  evidenceSpan: "Alice works at Acme Corp",
  confidence: 0.9,
};

class FakeClient implements CliClient {
  queries: string[] = [];
  valuesList: unknown[][] = [];
  rowsOverride?: (text: string) => unknown[];
  async query(text: string, values?: unknown[]) {
    this.queries.push(text);
    this.valuesList.push(values ?? []);
    const rows = this.rowsOverride ? this.rowsOverride(text) : [];
    return { rows };
  }
  release(): void {}
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

function makeDeps(client: FakeClient): CliDeps {
  const pool: CliPool = {
    async connect() {
      return client;
    },
    async end() {},
  };
  return {
    pool,
    // An exhausted queue throws: every maintenance action must never dial
    // the extractor (the operator's "yes" replays the stored proposal).
    llm: new FakeLLMClient({ queue: [] }),
    embedder: new FakeEmbedder(8),
    dims: 8,
    logger: silentLogger(),
    now: () => "2026-08-08T00:00:00.000Z",
  };
}

/** Serve the record-by-id / chunk lookups; everything else reads empty. */
function serveRows(
  client: FakeClient,
  rows: {
    promoteRecord?: Record<string, unknown> | null;
    discardRecord?: Record<string, unknown> | null;
    chunk?: { id: string; content: string } | null;
  }
): void {
  client.rowsOverride = (text) => {
    if (/FROM extraction_records WHERE id = \$1 FOR UPDATE/.test(text)) {
      return rows.promoteRecord ? [rows.promoteRecord] : [];
    }
    if (
      /SELECT id, status, discarded_at FROM extraction_records WHERE id = \$1/.test(
        text
      )
    ) {
      return rows.discardRecord ? [rows.discardRecord] : [];
    }
    if (/FROM chunks c WHERE/.test(text)) {
      return rows.chunk ? [rows.chunk] : [];
    }
    return [];
  };
}

function failedWithPayload() {
  return {
    id: REC,
    batch_id: BATCH,
    chunk_id: CHUNK,
    status: "failed",
    error_code: "JUDGE_REJECTED",
    error_msg: "judge rejected 1 of 1 triples",
    discarded_at: null,
    proposed_payload: {
      triples: [PROPOSED],
      verdicts: [{ index: 0, grounded: false, reason: "tail not stated" }],
    },
  };
}

// ─── parsing ─────────────────────────────────────────────────────────────

describe("parseArgs --promote / --discard", () => {
  it("accepts a UUID operand on each", () => {
    expect(parseArgs(["--promote", REC])).toEqual({
      ok: true,
      flags: expect.objectContaining({ promote: REC, discard: null }),
    });
    expect(parseArgs(["--discard", REC2])).toEqual({
      ok: true,
      flags: expect.objectContaining({ discard: REC2, promote: null }),
    });
  });

  it("a non-UUID or missing operand is the named usage error", () => {
    expect(parseArgs(["--promote", "not-a-uuid"])).toEqual({
      ok: false,
      error: "--promote requires a UUID",
    });
    expect(parseArgs(["--promote"])).toEqual({
      ok: false,
      error: "--promote requires a UUID",
    });
    expect(parseArgs(["--discard", "not-a-uuid"])).toEqual({
      ok: false,
      error: "--discard requires a UUID",
    });
    expect(parseArgs(["--discard"])).toEqual({
      ok: false,
      error: "--discard requires a UUID",
    });
  });
});

describe("review actions are exclusive modes (usage error, exit 2)", () => {
  const PAIRS: Array<[string[], string]> = [
    [["--list-failed", "--promote", REC], "--list-failed and --promote are mutually exclusive"],
    [["--list-unmapped", "--discard", REC], "--list-unmapped and --discard are mutually exclusive"],
    [["--promote", REC, "--discard", REC2], "--promote and --discard are mutually exclusive"],
    [["--discard", REC, "--backfill-embeddings"], "--discard and --backfill-embeddings are mutually exclusive"],
    [["--dry-run", "--promote", REC], "--dry-run and --promote are mutually exclusive"],
    [["--dry-run", "--discard", REC], "--dry-run and --discard are mutually exclusive"],
    [["--promote", REC, "--method", "fast"], "--method is only valid for extraction runs, not with --promote"],
    [["--discard", REC, "--source-ref", "doc-1"], "--source-ref is only valid for extraction runs, not with --discard"],
    [["--promote", REC, "--batch-id", BATCH], "--batch-id is only valid with --list-failed"],
  ];

  it("each refused combination names itself", () => {
    for (const [argv, error] of PAIRS) {
      expect(parseArgs(argv)).toEqual({ ok: false, error });
    }
  });

  it("runCli exits 2 and opens no connection work", async () => {
    for (const [argv] of PAIRS) {
      const client = new FakeClient();
      expect(await runCli(argv, makeDeps(client))).toBe(2);
      expect(client.queries).toEqual([]);
    }
  });
});

// ─── --discard ───────────────────────────────────────────────────────────

describe("runCli --discard", () => {
  it("stamps discarded_at and writes nothing else (graph untouched)", async () => {
    const client = new FakeClient();
    serveRows(client, {
      discardRecord: { id: REC, status: "failed", discarded_at: null },
    });

    expect(await runCli(["--discard", REC], makeDeps(client))).toBe(0);
    const stamps = client.queries.filter((q) => q.includes("SET discarded_at"));
    expect(stamps).toHaveLength(1);
    expect(client.valuesList[client.queries.indexOf(stamps[0]!)]).toEqual([
      REC,
    ]);
    expect(
      client.queries.some((q) =>
        /INSERT INTO (triples|entities|projection_outbox)/.test(q)
      )
    ).toBe(false);
    expect(client.queries.some((q) => q.includes("SET status"))).toBe(false);
  });

  it("an already-discarded record exits 0 without a second write", async () => {
    const client = new FakeClient();
    serveRows(client, {
      discardRecord: {
        id: REC,
        status: "failed",
        discarded_at: "2026-08-01T00:00:00Z",
      },
    });

    expect(await runCli(["--discard", REC], makeDeps(client))).toBe(0);
    expect(
      client.queries.some((q) => q.includes("SET discarded_at"))
    ).toBe(false);
  });

  it("a non-failed record is a typed refusal mapped to exit 1", async () => {
    const client = new FakeClient();
    serveRows(client, {
      discardRecord: { id: REC, status: "succeeded", discarded_at: null },
    });

    expect(await runCli(["--discard", REC], makeDeps(client))).toBe(1);
    expect(
      client.queries.some((q) => q.includes("SET discarded_at"))
    ).toBe(false);
  });

  it("an unknown record id is exit 1 with no writes", async () => {
    const client = new FakeClient();
    serveRows(client, {});

    expect(await runCli(["--discard", REC], makeDeps(client))).toBe(1);
    expect(
      client.queries.filter((q) => /^\s*(INSERT|UPDATE|DELETE)/i.test(q))
    ).toEqual([]);
  });
});

// ─── --promote ───────────────────────────────────────────────────────────

describe("runCli --promote", () => {
  it("replays the held proposal through the shared persist + outbox in one transaction", async () => {
    const client = new FakeClient();
    serveRows(client, {
      promoteRecord: failedWithPayload(),
      chunk: { id: CHUNK, content: "Alice works at Acme Corp." },
    });

    expect(await runCli(["--promote", REC], makeDeps(client))).toBe(0);
    const at = (frag: string) =>
      client.queries.findIndex((q) => q.includes(frag));
    // The replay's COMMIT is the LAST one: the schema bootstrap commits its
    // own DDL transaction before the action's BEGIN.
    const atLast = (frag: string) =>
      client.queries.reduceRight(
        (acc, q, idx) => (acc >= 0 ? acc : q.includes(frag) ? idx : -1),
        -1
      );
    expect(at("BEGIN")).toBeGreaterThanOrEqual(0);
    expect(at("BEGIN")).toBeLessThan(at("INSERT INTO triples"));
    expect(at("INSERT INTO triples")).toBeLessThan(
      at("INSERT INTO projection_outbox")
    );
    expect(at("INSERT INTO projection_outbox")).toBeLessThan(
      at("SET status = 'succeeded'")
    );
    expect(at("SET status = 'succeeded'")).toBeLessThan(atLast("COMMIT"));
    expect(client.queries.some((q) => q.trim() === "ROLLBACK")).toBe(false);
  });

  it("a succeeded record is a typed refusal: exit 1, ROLLBACK, zero graph writes", async () => {
    const client = new FakeClient();
    serveRows(client, {
      promoteRecord: {
        ...failedWithPayload(),
        status: "succeeded",
        proposed_payload: null,
      },
      chunk: { id: CHUNK, content: "Alice works at Acme Corp." },
    });

    expect(await runCli(["--promote", REC], makeDeps(client))).toBe(1);
    expect(
      client.queries.some((q) =>
        /INSERT INTO (triples|entities|projection_outbox)/.test(q)
      )
    ).toBe(false);
    expect(client.queries.some((q) => q.trim() === "ROLLBACK")).toBe(true);
  });

  it("a record without proposed_payload is refused: exit 1, zero writes", async () => {
    const client = new FakeClient();
    serveRows(client, {
      promoteRecord: { ...failedWithPayload(), proposed_payload: null },
    });

    expect(await runCli(["--promote", REC], makeDeps(client))).toBe(1);
    expect(
      client.queries.filter((q) =>
        /^\s*(INSERT INTO (triples|entities|projection_outbox)|UPDATE extraction_records)/i.test(
          q
        )
      )
    ).toEqual([]);
  });

  it("an unknown record id is exit 1 before any ledger read", async () => {
    const client = new FakeClient();
    serveRows(client, {});

    expect(await runCli(["--promote", REC], makeDeps(client))).toBe(1);
    expect(
      client.queries.filter((q) => q.includes("FROM chunks"))
    ).toEqual([]);
  });
});

// ─── credential guards ───────────────────────────────────────────────────

describe("credential guards on the review lane", () => {
  function flagsOf(argv: string[]) {
    const parsed = parseArgs(argv);
    if (!parsed.ok) throw new Error(`parse failed: ${parsed.error}`);
    return parsed.flags;
  }

  it("neither action dials the extractor", () => {
    expect(isRealExtraction(flagsOf(["--promote", REC]))).toBe(false);
    expect(isRealExtraction(flagsOf(["--discard", REC]))).toBe(false);
  });

  it("promote persists embeddings (real embedder required); discard does not", () => {
    expect(persistsEmbeddings(flagsOf(["--promote", REC]))).toBe(true);
    expect(persistsEmbeddings(flagsOf(["--discard", REC]))).toBe(false);
  });
});
