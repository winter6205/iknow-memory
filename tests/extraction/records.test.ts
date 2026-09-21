import { describe, it, expect } from "vitest";
import {
  insertRecord,
  markSucceeded,
  markFailed,
  markFailedWithProposal,
  listFailed,
  SELF_LOOP_REJECTED_CODE,
  MERGE_GRAY_HOLD_CODE,
  type Queryable,
} from "../../src/core/extraction/records.js";
import {
  discardRecord,
  promoteRecord,
} from "../../src/core/extraction/actions.js";
import { processBatch } from "../../src/core/extraction/pipeline.js";
import { FakeLLMClient } from "../../src/core/extraction/llm-client.js";
import { FakeEmbedder } from "../../src/core/embedder.js";
import { GraphragError } from "../../src/core/errors.js";
import type {
  ExtractionOutput,
  JudgeInput,
} from "../../src/core/extraction/types.js";
import type { Logger } from "../../src/logging.js";

interface StoredRecord {
  id: string;
  batch_id: string;
  chunk_id: string | null;
  status: string;
  error_code: string | null;
  error_msg: string | null;
  triples_count: number;
  unmapped_count: number;
  started_at: string;
  finished_at: string | null;
  created_at: string;
  proposed_payload: unknown;
  discarded_at: string | null;
}

function makeFakeClient(
  ledger: { chunks?: Array<{ id: string; content: string }> } = {}
): {
  client: Queryable;
  rows: StoredRecord[];
  calls: Array<{ text: string; values: unknown[] }>;
} {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const rows: StoredRecord[] = [];
  const chunkRows = ledger.chunks ?? [];
  let createdSeq = 0;
  return {
    rows,
    calls,
    client: {
      async query(text: string, values: unknown[]): Promise<{ rows: any[] }> {
        calls.push({ text, values });
        if (text.includes("INSERT INTO extraction_records")) {
          const [id, batch_id, chunk_id, started_at] = values as [
            string,
            string,
            string | null,
            string,
          ];
          rows.push({
            id,
            batch_id,
            chunk_id,
            status: "pending",
            error_code: null,
            error_msg: null,
            triples_count: 0,
            unmapped_count: 0,
            started_at,
            finished_at: null,
            created_at: `2026-01-0${++createdSeq}T00:00:00Z`,
            proposed_payload: null,
            discarded_at: null,
          });
          return { rows: [] };
        }
        if (
          text.includes("UPDATE extraction_records") &&
          text.includes("status = 'succeeded'")
        ) {
          const [id, triples_count, unmapped_count] = values as [
            string,
            number,
            number,
          ];
          const row = rows.find((r) => r.id === id);
          if (row) {
            row.status = "succeeded";
            row.finished_at = "2026-01-01T01:00:00Z";
            row.triples_count = triples_count;
            row.unmapped_count = unmapped_count;
          }
          return { rows: [] };
        }
        if (
          text.includes("UPDATE extraction_records") &&
          text.includes("status = 'failed'")
        ) {
          const [id, error_code, error_msg, proposed_payload] = values as [
            string,
            string,
            string,
            unknown?,
          ];
          const row = rows.find((r) => r.id === id);
          if (row) {
            row.status = "failed";
            row.finished_at = "2026-01-01T01:00:00Z";
            row.error_code = error_code;
            row.error_msg = error_msg;
            if (proposed_payload !== undefined) {
              row.proposed_payload = JSON.parse(proposed_payload as string);
            }
          }
          return { rows: [] };
        }
        if (
          text.includes("UPDATE extraction_records") &&
          text.includes("SET discarded_at")
        ) {
          const [id] = values as [string];
          const row = rows.find((r) => r.id === id);
          if (row && row.discarded_at === null) {
            row.discarded_at = "2026-02-01T00:00:00Z";
          }
          return { rows: [] };
        }
        if (
          text.includes("FROM extraction_records WHERE id = $1 FOR UPDATE")
        ) {
          const [id] = values as [string];
          return { rows: rows.filter((r) => r.id === id) };
        }
        if (
          text.includes(
            "SELECT id, status, discarded_at FROM extraction_records WHERE id = $1"
          )
        ) {
          const [id] = values as [string];
          const row = rows.find((r) => r.id === id);
          return {
            rows: row
              ? [
                  {
                    id: row.id,
                    status: row.status,
                    discarded_at: row.discarded_at,
                  },
                ]
              : [],
          };
        }
        if (text.includes("SELECT * FROM extraction_records")) {
          const params = (values as unknown[]).slice();
          const batchId = params[0] as string | undefined;
          const filtered = rows
            .filter((r) => r.status === "failed")
            // SC5: SELF_LOOP_REJECTED is a permanent reject — listFailed()
            // hides it so operators only see transient failures that need a
            // re-extract.
            .filter((r) => r.error_code !== "SELF_LOOP_REJECTED")
            // A discarded record left the review lane; the row stays readable.
            .filter((r) => r.discarded_at === null)
            .filter((r) => (batchId ? r.batch_id === batchId : true))
            .sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
          return { rows: filtered };
        }
        // Every SQL the promote / re-extract legs fire is enumerated
        // explicitly: the ledger statements above, the persist-half reads
        // and writes below, and the bare transaction control statements.
        // Anything else must throw — a catch-all here would silently
        // absorb new or misplaced SQL and weaken the contract tests.
        // The method-conflict SELECT names both source_documents and
        // chunks, so answer it before the chunk lookup.
        if (text.includes("FROM source_documents")) return { rows: [] };
        if (text.includes("FROM chunks c WHERE")) {
          const [id] = values as [string];
          return { rows: chunkRows.filter((c) => c.id === id) };
        }
        if (text.includes("FROM embedding_generation")) return { rows: [] };
        if (text.includes("FROM entities WHERE retired = false")) {
          return { rows: [] };
        }
        if (text.includes("INSERT INTO entities")) return { rows: [] };
        if (text.includes("INSERT INTO entity_aliases")) return { rows: [] };
        if (text.includes("FROM triples")) return { rows: [] };
        if (text.includes("INSERT INTO triples")) return { rows: [] };
        if (text.includes("UPDATE triples")) return { rows: [] };
        if (text.includes("INSERT INTO projection_outbox")) {
          return { rows: [] };
        }
        if (text.includes("UPDATE community_index_state")) {
          return { rows: [] };
        }
        if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(text.trim())) {
          return { rows: [] };
        }
        throw new Error(`unexpected query: ${text}`);
      },
    },
  };
}

describe("extraction_records", () => {
  it("insertRecord writes status='pending'", async () => {
    const f = makeFakeClient();
    await insertRecord(f.client, {
      id: "r1",
      batchId: "b1",
      chunkId: "chunk-1",
      startedAt: "2026-01-01T00:00:00Z",
    });
    expect(f.rows).toHaveLength(1);
    expect(f.rows[0]?.status).toBe("pending");
    expect(f.rows[0]?.finished_at).toBeNull();
  });

  it("markSucceeded sets status='succeeded', finished_at, and counts", async () => {
    const f = makeFakeClient();
    await insertRecord(f.client, {
      id: "r1",
      batchId: "b1",
      chunkId: "chunk-1",
      startedAt: "2026-01-01T00:00:00Z",
    });
    await markSucceeded(f.client, "r1", { triplesCount: 3, unmappedCount: 1 });
    const row = f.rows[0];
    expect(row?.status).toBe("succeeded");
    expect(row?.finished_at).not.toBeNull();
    expect(row?.triples_count).toBe(3);
    expect(row?.unmapped_count).toBe(1);
  });

  it("markFailed sets status='failed' and records error code/msg", async () => {
    const f = makeFakeClient();
    await insertRecord(f.client, {
      id: "r1",
      batchId: "b1",
      chunkId: "chunk-1",
      startedAt: "2026-01-01T00:00:00Z",
    });
    await markFailed(f.client, "r1", { code: "5xx", msg: "upstream 500" });
    const row = f.rows[0];
    expect(row?.status).toBe("failed");
    expect(row?.finished_at).not.toBeNull();
    expect(row?.error_code).toBe("5xx");
    expect(row?.error_msg).toBe("upstream 500");
  });

  it("listFailed returns only failed rows, ordered by created_at", async () => {
    const f = makeFakeClient();
    // Mix: one succeeded, two failed.
    await insertRecord(f.client, {
      id: "r1",
      batchId: "b1",
      chunkId: "chunk-1",
      startedAt: "2026-01-01T00:00:00Z",
    });
    await markSucceeded(f.client, "r1", { triplesCount: 2, unmappedCount: 0 });
    await insertRecord(f.client, {
      id: "r2",
      batchId: "b1",
      chunkId: "chunk-2",
      startedAt: "2026-01-01T00:00:00Z",
    });
    await markFailed(f.client, "r2", { code: "5xx", msg: "boom" });
    await insertRecord(f.client, {
      id: "r3",
      batchId: "b1",
      chunkId: "chunk-3",
      startedAt: "2026-01-01T00:00:00Z",
    });
    await markFailed(f.client, "r3", { code: "4xx", msg: "bad" });
    const failed = await listFailed(f.client);
    expect(failed.map((r) => r.id)).toEqual(["r2", "r3"]);
  });

  it("listFailed filters by batchId when given", async () => {
    const f = makeFakeClient();
    await insertRecord(f.client, {
      id: "r1",
      batchId: "b1",
      chunkId: "chunk-1",
      startedAt: "2026-01-01T00:00:00Z",
    });
    await markFailed(f.client, "r1", { code: "5xx", msg: "boom" });
    await insertRecord(f.client, {
      id: "r2",
      batchId: "b2",
      chunkId: "chunk-2",
      startedAt: "2026-01-01T00:00:00Z",
    });
    await markFailed(f.client, "r2", { code: "5xx", msg: "boom" });
    const b1 = await listFailed(f.client, { batchId: "b1" });
    const b2 = await listFailed(f.client, { batchId: "b2" });
    expect(b1.map((r) => r.id)).toEqual(["r1"]);
    expect(b2.map((r) => r.id)).toEqual(["r2"]);
  });

  it("listFailed hides SELF_LOOP_REJECTED rows (SC5)", async () => {
    const f = makeFakeClient();
    await insertRecord(f.client, {
      id: "r1",
      batchId: "b1",
      chunkId: "chunk-1",
      startedAt: "2026-01-01T00:00:00Z",
    });
    await markFailed(f.client, "r1", { code: "5xx", msg: "boom" });
    await insertRecord(f.client, {
      id: "r2",
      batchId: "b1",
      chunkId: "chunk-2",
      startedAt: "2026-01-01T00:00:00Z",
    });
    // SC5: SELF_LOOP_REJECTED is a permanent reject — there is no
    // re-extract path for it, so listing it as "must re-extract" would be
    // misleading. listFailed() hides it by error_code.
    await markFailed(f.client, "r2", {
      code: "SELF_LOOP_REJECTED",
      msg: "all outputs were self-loops",
    });
    const failed = await listFailed(f.client);
    expect(failed.map((r) => r.id)).toEqual(["r1"]);
    // The WHERE clause carries the exclusion so the DB applies the filter,
    // not the caller.
    const listCall = f.calls.find((c) =>
      c.text.includes("SELECT * FROM extraction_records")
    );
    expect(listCall?.text).toContain("SELF_LOOP_REJECTED");
  });

  it("listFailed keeps MERGE_GRAY_HOLD rows visible (maintenance lane)", async () => {
    const f = makeFakeClient();
    await insertRecord(f.client, {
      id: "r1",
      batchId: "b1",
      chunkId: "chunk-1",
      startedAt: "2026-01-01T00:00:00Z",
    });
    // A human-held gray pair is advanceable by the operator (promote /
    // re-extract), so — unlike SELF_LOOP_REJECTED — it must stay listed.
    await markFailed(f.client, "r1", {
      code: MERGE_GRAY_HOLD_CODE,
      msg: "merge gray-zone hold",
    });
    const failed = await listFailed(f.client);
    expect(failed.map((r) => r.id)).toEqual(["r1"]);
  });

  it("batch_id aggregation: two records in the same batch are both retrievable", async () => {
    const f = makeFakeClient();
    await insertRecord(f.client, {
      id: "r1",
      batchId: "shared-batch",
      chunkId: "chunk-1",
      startedAt: "2026-01-01T00:00:00Z",
    });
    await markSucceeded(f.client, "r1", { triplesCount: 5, unmappedCount: 0 });
    await insertRecord(f.client, {
      id: "r2",
      batchId: "shared-batch",
      chunkId: "chunk-2",
      startedAt: "2026-01-01T00:00:00Z",
    });
    await markFailed(f.client, "r2", { code: "5xx", msg: "boom" });
    const all = await listFailed(f.client, { batchId: "shared-batch" });
    expect(all).toHaveLength(1);
    expect(all[0]?.id).toBe("r2");
    // Both rows exist in the table under the same batch_id.
    expect(f.rows.filter((r) => r.batch_id === "shared-batch")).toHaveLength(2);
  });

  it("markFailedWithProposal stores the reviewable payload alongside the error", async () => {
    const f = makeFakeClient();
    await insertRecord(f.client, {
      id: "r1",
      batchId: "b1",
      chunkId: "chunk-1",
      startedAt: "2026-01-01T00:00:00Z",
    });
    await markFailedWithProposal(
      f.client,
      "r1",
      { code: "JUDGE_REJECTED", msg: "[0] tail invented" },
      {
        triples: [{ head: "Alice", tail: "Acme" }],
        verdicts: [{ index: 0, grounded: false, reason: "tail invented" }],
      }
    );
    const row = f.rows[0];
    expect(row?.status).toBe("failed");
    expect(row?.error_code).toBe("JUDGE_REJECTED");
    expect(row?.proposed_payload).toEqual({
      triples: [{ head: "Alice", tail: "Acme" }],
      verdicts: [{ index: 0, grounded: false, reason: "tail invented" }],
    });
    // The payload binds as jsonb SQL-side; the fake sees the JSON string.
    const update = f.calls.find((c) =>
      c.text.includes("proposed_payload")
    );
    expect(update?.text).toContain("proposed_payload = $4::jsonb");
    expect(typeof update?.values[3]).toBe("string");
  });

  it("listFailed shows judge failures (only SELF_LOOP_REJECTED is hidden)", async () => {
    const f = makeFakeClient();
    await insertRecord(f.client, {
      id: "r1",
      batchId: "b1",
      chunkId: "chunk-1",
      startedAt: "2026-01-01T00:00:00Z",
    });
    await markFailedWithProposal(
      f.client,
      "r1",
      { code: "JUDGE_REJECTED", msg: "not grounded" },
      { triples: [], verdicts: [] }
    );
    await insertRecord(f.client, {
      id: "r2",
      batchId: "b1",
      chunkId: "chunk-2",
      startedAt: "2026-01-01T00:00:00Z",
    });
    await markFailed(f.client, "r2", {
      code: "SELF_LOOP_REJECTED",
      msg: "all outputs were self-loops",
    });
    const failed = await listFailed(f.client);
    // Judge failures belong to the maintenance lane — re-extract can fix them.
    expect(failed.map((r) => r.id)).toEqual(["r1"]);
  });
});

// ─── extract-verify T2: the review actions (promote / discard) ─────────────

const SILENT_LOGGER: Logger = {
  level: "error",
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const CHUNK_ROW = { id: "chunk-1", content: "Alice works at Acme Corp." };

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

const judgeNo = async (input: JudgeInput) => ({
  kind: "ok" as const,
  verdicts: input.candidates.map((_, index) => ({
    index,
    grounded: false,
    reason: "tail not stated",
  })),
});

function pipelineDeps(llm: FakeLLMClient) {
  return {
    llm,
    embedder: new FakeEmbedder(8),
    logger: SILENT_LOGGER,
    now: () => "2026-02-01T00:00:00.000Z",
  };
}

/** The judge-sealed failed record T2's actions operate on. */
async function seedJudgeFailure(f: {
  client: Queryable;
}): Promise<string> {
  await insertRecord(f.client, {
    id: "rec-1",
    batchId: "b1",
    chunkId: "chunk-1",
    startedAt: "2026-01-01T00:00:00Z",
  });
  await markFailedWithProposal(
    f.client,
    "rec-1",
    { code: "JUDGE_REJECTED", msg: "judge rejected 1 of 1 triples" },
    {
      triples: [PROPOSED],
      verdicts: [{ index: 0, grounded: false, reason: "tail not stated" }],
    }
  );
  return "rec-1";
}

describe("discardRecord", () => {
  it("stamps discarded_at, hides the row from listFailed() and touches no graph", async () => {
    const f = makeFakeClient();
    await insertRecord(f.client, {
      id: "r1",
      batchId: "b1",
      chunkId: "chunk-1",
      startedAt: "2026-01-01T00:00:00Z",
    });
    await markFailed(f.client, "r1", { code: "5xx", msg: "boom" });
    await discardRecord(f.client, "r1");
    expect(f.rows[0]?.discarded_at).not.toBeNull();
    expect(await listFailed(f.client)).toEqual([]);
    // The filter is SQL-side, so the DB applies it, not the caller.
    const listCall = f.calls.find((c) =>
      c.text.includes("SELECT * FROM extraction_records")
    );
    expect(listCall?.text).toContain("discarded_at IS NULL");
    // Discard never replays: zero triple / outbox writes, and the row itself
    // stays readable (a status stamp, not a delete).
    expect(
      f.calls.some((c) =>
        /INSERT INTO (triples|entities|projection_outbox)/.test(c.text)
      )
    ).toBe(false);
    expect(f.rows).toHaveLength(1);
  });

  it("is idempotent: the second discard writes nothing", async () => {
    const f = makeFakeClient();
    await insertRecord(f.client, {
      id: "r1",
      batchId: "b1",
      chunkId: "chunk-1",
      startedAt: "2026-01-01T00:00:00Z",
    });
    await markFailed(f.client, "r1", { code: "5xx", msg: "boom" });
    await discardRecord(f.client, "r1");
    await discardRecord(f.client, "r1");
    const stamps = f.calls.filter((c) => c.text.includes("SET discarded_at"));
    expect(stamps).toHaveLength(1);
  });

  it("refuses a non-failed record typed and writes nothing", async () => {
    const f = makeFakeClient();
    await insertRecord(f.client, {
      id: "r1",
      batchId: "b1",
      chunkId: "chunk-1",
      startedAt: "2026-01-01T00:00:00Z",
    });
    await markSucceeded(f.client, "r1", { triplesCount: 2, unmappedCount: 0 });
    const err = await discardRecord(f.client, "r1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GraphragError);
    expect((err as GraphragError).code).toBe("INVALID_INPUT");
    expect((err as Error).message).toMatch(/only failed records can be discarded/);
    expect(f.rows[0]?.discarded_at).toBeNull();
  });

  it("refuses an unknown record id typed", async () => {
    const f = makeFakeClient();
    const err = await discardRecord(f.client, "nope").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GraphragError);
    expect((err as Error).message).toMatch(/not found/);
  });
});

describe("promoteRecord", () => {
  it("replays the held proposal into triples + outbox and leaves the failed state", async () => {
    const f = makeFakeClient({ chunks: [CHUNK_ROW] });
    await seedJudgeFailure(f);
    await promoteRecord(pipelineDeps(new FakeLLMClient({ queue: [] })), f.client, "rec-1");
    const texts = f.calls.map((c) => c.text);
    const at = (frag: string) => texts.findIndex((t) => t.includes(frag));
    // One transaction, the SAME persist/outbox functions the batch uses.
    expect(at("BEGIN")).toBeGreaterThanOrEqual(0);
    expect(at("BEGIN")).toBeLessThan(at("INSERT INTO triples"));
    expect(at("INSERT INTO triples")).toBeLessThan(
      at("INSERT INTO projection_outbox")
    );
    expect(at("INSERT INTO projection_outbox")).toBeLessThan(
      at("SET status = 'succeeded'")
    );
    expect(at("SET status = 'succeeded'")).toBeLessThan(at("COMMIT"));
    expect(texts.some((t) => t.trim() === "ROLLBACK")).toBe(false);
    // The record leaves the failed lane, counts and all.
    const row = f.rows[0]!;
    expect(row.status).toBe("succeeded");
    expect(row.triples_count).toBe(1);
    expect(row.unmapped_count).toBe(0);
    expect(await listFailed(f.client)).toEqual([]);
  });

  it("refuses a succeeded record typed, with zero writes", async () => {
    const f = makeFakeClient({ chunks: [CHUNK_ROW] });
    await insertRecord(f.client, {
      id: "rec-1",
      batchId: "b1",
      chunkId: "chunk-1",
      startedAt: "2026-01-01T00:00:00Z",
    });
    await markSucceeded(f.client, "rec-1", { triplesCount: 1, unmappedCount: 0 });
    const err = await promoteRecord(
      pipelineDeps(new FakeLLMClient({ queue: [] })),
      f.client,
      "rec-1"
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GraphragError);
    expect((err as GraphragError).code).toBe("INVALID_INPUT");
    expect((err as Error).message).toMatch(/only failed records can be promoted/);
    expect(f.calls.some((c) => c.text.includes("INSERT INTO triples"))).toBe(
      false
    );
    expect(f.calls.some((c) => c.text.trim() === "ROLLBACK")).toBe(true);
  });

  it("refuses a failed record that holds no proposed_payload typed", async () => {
    const f = makeFakeClient({ chunks: [CHUNK_ROW] });
    await insertRecord(f.client, {
      id: "rec-1",
      batchId: "b1",
      chunkId: "chunk-1",
      startedAt: "2026-01-01T00:00:00Z",
    });
    await markFailed(f.client, "rec-1", { code: "5xx", msg: "boom" });
    const err = await promoteRecord(
      pipelineDeps(new FakeLLMClient({ queue: [] })),
      f.client,
      "rec-1"
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GraphragError);
    expect((err as Error).message).toMatch(/proposed_payload/);
    expect(f.calls.some((c) => c.text.includes("INSERT INTO triples"))).toBe(
      false
    );
  });

  it("refuses a discarded record typed", async () => {
    const f = makeFakeClient({ chunks: [CHUNK_ROW] });
    await seedJudgeFailure(f);
    await discardRecord(f.client, "rec-1");
    const err = await promoteRecord(
      pipelineDeps(new FakeLLMClient({ queue: [] })),
      f.client,
      "rec-1"
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GraphragError);
    expect((err as Error).message).toMatch(/discarded/);
    expect(f.calls.some((c) => c.text.includes("INSERT INTO triples"))).toBe(
      false
    );
  });

  it("refuses an unknown record id typed", async () => {
    const f = makeFakeClient({ chunks: [CHUNK_ROW] });
    const err = await promoteRecord(
      pipelineDeps(new FakeLLMClient({ queue: [] })),
      f.client,
      "rec-9"
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GraphragError);
    expect((err as Error).message).toMatch(/not found/);
  });

  it("refuses when the record's chunk row is gone, rolling back", async () => {
    const f = makeFakeClient(); // no chunk rows
    await seedJudgeFailure(f);
    const err = await promoteRecord(
      pipelineDeps(new FakeLLMClient({ queue: [] })),
      f.client,
      "rec-1"
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GraphragError);
    expect((err as Error).message).toMatch(/no longer exists/);
    expect(f.calls.some((c) => c.text.trim() === "ROLLBACK")).toBe(true);
    expect(f.rows[0]?.status).toBe("failed");
  });

  it("an all-self-loop payload becomes a SELF_LOOP_REJECTED failure, not a false success", async () => {
    const f = makeFakeClient({ chunks: [CHUNK_ROW] });
    await insertRecord(f.client, {
      id: "rec-1",
      batchId: "b1",
      chunkId: "chunk-1",
      startedAt: "2026-01-01T00:00:00Z",
    });
    await markFailedWithProposal(
      f.client,
      "rec-1",
      { code: "JUDGE_REJECTED", msg: "not grounded" },
      {
        triples: [{ ...PROPOSED, tail: "Alice", tailType: "person" }],
        verdicts: [{ index: 0, grounded: false, reason: "self-loop" }],
      }
    );
    await promoteRecord(
      pipelineDeps(new FakeLLMClient({ queue: [] })),
      f.client,
      "rec-1"
    );
    const row = f.rows[0]!;
    expect(row.status).toBe("failed");
    expect(row.error_code).toBe(SELF_LOOP_REJECTED_CODE);
    expect(f.calls.some((c) => c.text.includes("INSERT INTO triples"))).toBe(
      false
    );
    expect(
      f.calls.some((c) => c.text.includes("INSERT INTO projection_outbox"))
    ).toBe(false);
    expect(f.calls.some((c) => c.text.trim() === "COMMIT")).toBe(true);
  });
});

describe("the review lane end-to-end (processBatch → listFailed → action)", () => {
  it("a judge failure surfaces through listFailed() and a promote then retires it", async () => {
    const f = makeFakeClient({ chunks: [CHUNK_ROW] });
    const llm = new FakeLLMClient({
      queue: [{ kind: "ok", outputs: [PROPOSED] }],
      scriptedJudge: judgeNo,
    });
    const summary = await processBatch(
      pipelineDeps(llm),
      f.client,
      [{ id: CHUNK_ROW.id, content: CHUNK_ROW.content }],
      { batchSize: 1 }
    );
    expect(summary.failed).toBe(1);
    // Drain safety again from the record side: the sealed leg wrote no graph.
    expect(
      f.calls.some((c) =>
        /INSERT INTO (triples|projection_outbox)/.test(c.text)
      )
    ).toBe(false);
    // Requirement 1: the failed chunk is discoverable through the records lane.
    const failed = await listFailed(f.client);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      chunk_id: "chunk-1",
      error_code: "JUDGE_REJECTED",
    });
    // Promote replays exactly that held proposal.
    await promoteRecord(
      pipelineDeps(new FakeLLMClient({ queue: [] })),
      f.client,
      failed[0]!.id as string
    );
    expect(f.calls.some((c) => c.text.includes("INSERT INTO triples"))).toBe(
      true
    );
    expect(await listFailed(f.client)).toEqual([]);
    expect(f.rows.some((r) => r.status === "succeeded")).toBe(true);
  });

  it("a re-extract run after a judge failure dials the judge again before any write", async () => {
    const f = makeFakeClient();
    let judgeCalls = 0;
    const countingJudge = async (input: JudgeInput) => {
      judgeCalls += 1;
      return judgeNo(input);
    };
    const llm = new FakeLLMClient({
      queue: [
        { kind: "ok", outputs: [PROPOSED] },
        { kind: "ok", outputs: [PROPOSED] },
      ],
      scriptedJudge: countingJudge,
    });
    const chunk = [{ id: CHUNK_ROW.id, content: CHUNK_ROW.content }];
    await processBatch(pipelineDeps(llm), f.client, chunk, { batchSize: 1 });
    // The --only-failed runner re-feeds the same chunk through the SAME batch
    // code: the judge is dialed again, and a second reject still writes no
    // graph (the triples gate is the judge, not the retry path).
    await processBatch(pipelineDeps(llm), f.client, chunk, { batchSize: 1 });
    expect(judgeCalls).toBe(2);
    expect(f.calls.some((c) => c.text.includes("INSERT INTO triples"))).toBe(
      false
    );
    expect((await listFailed(f.client)).length).toBe(2);
  });
});
