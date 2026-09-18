/**
 * Unit tests for the lifted extract batch/pipeline surface
 * (`src/core/extraction/pipeline.ts`).
 *
 * The pipeline was lifted out of `src/cli/extract.ts` so that a second
 * caller (the MCP extract tool, T3) can run the same scan → batch →
 * per-chunk-transaction orchestration without importing `src/cli`. These
 * tests pin the three selector shapes the core surface must cover:
 *
 *   1. the CLI's undifferentiated pending scan (optional since/only-failed
 *      filters stay caller-supplied),
 *   2. an explicit chunk_ids list,
 *   3. a per-source_ref pending scan with a caller-supplied batch cap.
 *
 * Plus one end-to-end `processBatch` run on a fake Queryable proving the
 * persist/batch is callable from core without going through CLI argv:
 * per-chunk BEGIN/COMMIT, outbox emit inside the transaction, and
 * mark-and-continue on a failed sibling chunk.
 */
import { describe, it, expect } from "vitest";

import type { Queryable } from "../../src/core/extraction/records.js";
import {
  selectPendingChunks,
  selectChunksByIds,
  selectPendingChunksBySourceRef,
  processBatch,
  type ExtractPipelineDeps,
} from "../../src/core/extraction/pipeline.js";
import { FakeLLMClient } from "../../src/core/extraction/llm-client.js";
import { FakeEmbedder } from "../../src/core/embedder.js";
import { SELF_LOOP_REJECTED_CODE } from "../../src/core/extraction/records.js";
import {
  EXTRACT_METHOD_CONFLICT_CODE,
  FAST_EXTRACT_UNIMPLEMENTED_CODE,
} from "../../src/core/extraction/method.js";
import type { Logger } from "../../src/logging.js";

/** Recording fake Queryable; rows are chosen per SQL text (and binds). */
class FakeQueryable implements Queryable {
  queries: string[] = [];
  valuesList: unknown[][] = [];
  rowsFor: (text: string, values: unknown[]) => any[] = () => [];

  async query(text: string, values: unknown[] = []) {
    this.queries.push(text);
    this.valuesList.push(values);
    return { rows: this.rowsFor(text, values) };
  }

  /** Index of the first query containing `fragment`, or -1. */
  indexOf(fragment: string): number {
    return this.queries.findIndex((q) => q.includes(fragment));
  }
}

const SILENT_LOGGER: Logger = {
  level: "error",
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function makeDeps(llm: FakeLLMClient): ExtractPipelineDeps {
  return {
    llm,
    embedder: new FakeEmbedder(8),
    logger: SILENT_LOGGER,
    now: () => "2026-01-01T00:00:00.000Z",
  };
}

const GROUNDED_OUTPUT = {
  head: "Alice",
  headType: "person",
  relationRaw: "works at",
  relationNorm: "RELATED_TO",
  tail: "Acme Corp",
  tailType: "system",
  description: "Alice works at Acme Corp",
  evidenceSpan: "Alice works at Acme Corp",
  confidence: 0.9,
};

describe("selectPendingChunks (CLI pending scan)", () => {
  it("scans chunks with no succeeded extraction record, ordered by created_at", async () => {
    const client = new FakeQueryable();
    client.rowsFor = () => [{ id: "c1", content: "hello" }];

    const chunks = await selectPendingChunks(client, { batchSize: 7 });

    expect(chunks).toEqual([{ id: "c1", content: "hello" }]);
    const sql = client.queries[0]!;
    expect(sql).toContain(
      "NOT EXISTS (SELECT 1 FROM extraction_records r WHERE r.chunk_id = c.id AND r.status = 'succeeded')"
    );
    expect(sql).toContain("ORDER BY c.created_at");
    expect(sql).toContain("LIMIT $1");
    expect(client.valuesList[0]).toEqual([7]);
  });

  it("applies --since as a created_at lower bound before the LIMIT", async () => {
    const client = new FakeQueryable();
    await selectPendingChunks(client, {
      batchSize: 5,
      since: "2026-01-01T00:00:00Z",
    });

    const sql = client.queries[0]!;
    expect(sql).toContain("c.created_at >= $1");
    expect(sql).toContain("LIMIT $2");
    expect(client.valuesList[0]).toEqual(["2026-01-01T00:00:00Z", 5]);
  });

  it("applies --only-failed excluding SELF_LOOP_REJECTED rows", async () => {
    const client = new FakeQueryable();
    await selectPendingChunks(client, { batchSize: 5, onlyFailed: true });

    const sql = client.queries[0]!;
    expect(sql).toContain("row_number() OVER (PARTITION BY chunk_id");
    expect(sql).toContain("error_code != 'SELF_LOOP_REJECTED'");
    // Both filters compose with AND; the since filter stays absent.
    expect(sql).toContain(" AND ");
  });
});

describe("selectChunksByIds (explicit chunk_ids selector)", () => {
  it("loads exactly the requested ids and preserves the caller's order", async () => {
    const client = new FakeQueryable();
    // DB returns rows in a different order than requested.
    client.rowsFor = () => [
      { id: "c2", content: "second" },
      { id: "c1", content: "first" },
      { id: "c3", content: "third" },
    ];

    const chunks = await selectChunksByIds(client, ["c3", "c1", "c2"]);

    expect(chunks).toEqual([
      { id: "c3", content: "third" },
      { id: "c1", content: "first" },
      { id: "c2", content: "second" },
    ]);
    const sql = client.queries[0]!;
    expect(sql).toContain("FROM chunks");
    expect(sql).toContain("IN ($1, $2, $3)");
    expect(client.valuesList[0]).toEqual(["c3", "c1", "c2"]);
  });

  it("dedupes repeated ids so one chunk is processed once", async () => {
    const client = new FakeQueryable();
    client.rowsFor = () => [{ id: "c1", content: "only" }];

    const chunks = await selectChunksByIds(client, ["c1", "c1"]);

    expect(chunks).toEqual([{ id: "c1", content: "only" }]);
    expect(client.valuesList[0]).toEqual(["c1"]);
  });

  it("returns an empty selection without querying when the id list is empty", async () => {
    const client = new FakeQueryable();
    const chunks = await selectChunksByIds(client, []);
    expect(chunks).toEqual([]);
    expect(client.queries).toHaveLength(0);
  });
});

describe("selectPendingChunksBySourceRef (source_ref selector with cap)", () => {
  it("scans pending chunks for the source_ref under the NOT EXISTS succeeded rule", async () => {
    const client = new FakeQueryable();
    client.rowsFor = () => [{ id: "c1", content: "a" }];

    const scan = await selectPendingChunksBySourceRef(client, "doc-1", 10);

    expect(scan).toEqual({
      chunks: [{ id: "c1", content: "a" }],
      hasMore: false,
    });
    const sql = client.queries[0]!;
    expect(sql).toContain("c.source_ref = $1");
    expect(sql).toContain(
      "NOT EXISTS (SELECT 1 FROM extraction_records r WHERE r.chunk_id = c.id AND r.status = 'succeeded')"
    );
    expect(sql).toContain("ORDER BY c.created_at");
    // Cap is enforced by a LIMIT of cap+1 so `hasMore` is observable.
    expect(client.valuesList[0]).toEqual(["doc-1", 11]);
  });

  it("reports hasMore and truncates to the cap when more pending chunks exist", async () => {
    const client = new FakeQueryable();
    client.rowsFor = () => [
      { id: "c1", content: "a" },
      { id: "c2", content: "b" },
      { id: "c3", content: "c" },
    ];

    const scan = await selectPendingChunksBySourceRef(client, "doc-1", 2);

    expect(scan.hasMore).toBe(true);
    expect(scan.chunks.map((c) => c.id)).toEqual(["c1", "c2"]);
  });

  it("returns zeros-shaped output for a source_ref with no pending chunks", async () => {
    const client = new FakeQueryable();
    const scan = await selectPendingChunksBySourceRef(client, "doc-404", 10);
    expect(scan).toEqual({ chunks: [], hasMore: false });
  });

  it("treats a non-positive cap as zero work while still reporting remaining pending", async () => {
    const client = new FakeQueryable();
    client.rowsFor = () => [{ id: "c1", content: "a" }];

    const scan = await selectPendingChunksBySourceRef(client, "doc-1", 0);

    expect(scan.chunks).toEqual([]);
    expect(scan.hasMore).toBe(true);
  });
});

describe("processBatch (core batch orchestration, no CLI argv)", () => {
  it("runs one transaction per chunk, emitting outbox intents inside it, and mark-and-continues past a failed sibling", async () => {
    const client = new FakeQueryable();
    const llm = new FakeLLMClient({
      queue: [
        { kind: "ok", outputs: [GROUNDED_OUTPUT] },
        { kind: "5xx", message: "provider down" },
      ],
    });

    const summary = await processBatch(
      makeDeps(llm),
      client,
      [
        { id: "chunk-ok", content: "Alice works at Acme Corp." },
        { id: "chunk-bad", content: "Bob works at Beta Corp." },
      ],
      { batchSize: 2 }
    );

    expect(summary.processed).toBe(2);
    expect(summary.succeeded).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.writeFailures).toBe(0);
    expect(summary.ungrounded).toBe(0);
    expect(summary.batchId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );

    // Transaction 1 (chunk-ok): BEGIN → record insert → entity/triple
    // writes → outbox emit → markSucceeded → COMMIT, in that order.
    const begin1 = client.indexOf("BEGIN");
    const record1 = client.indexOf("INSERT INTO extraction_records");
    const outbox1 = client.indexOf("INSERT INTO projection_outbox");
    const succeeded1 = client.indexOf("SET status = 'succeeded'");
    const commit1 = client.indexOf("COMMIT");
    expect(begin1).toBeGreaterThanOrEqual(0);
    expect(
      begin1 < record1 &&
        record1 < outbox1 &&
        outbox1 < succeeded1 &&
        succeeded1 < commit1
    ).toBe(true);

    // Transaction 2 (chunk-bad): the failed chunk is marked failed with the
    // LLM error code and still commits its own record row.
    const failed2 = client.indexOf("SET status = 'failed'");
    expect(failed2).toBeGreaterThan(commit1);
    const failedValues = client.valuesList[failed2]!;
    expect(failedValues).toContain("5xx");
    expect(client.indexOf("ROLLBACK")).toBe(-1);
  });

  it("counts per-triple ungrounded rejections without failing the chunk", async () => {
    const client = new FakeQueryable();
    const llm = new FakeLLMClient({
      queue: [
        {
          kind: "ok",
          outputs: [
            {
              ...GROUNDED_OUTPUT,
              evidenceSpan: "not a substring of the chunk",
            },
          ],
        },
      ],
    });

    const summary = await processBatch(
      makeDeps(llm),
      client,
      [{ id: "chunk-1", content: "Alice works at Acme Corp." }],
      { batchSize: 1 }
    );

    expect(summary.succeeded).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.ungrounded).toBe(1);
    // The ungrounded triple never lands: no INSERT INTO triples fired.
    expect(client.indexOf("INSERT INTO triples")).toBe(-1);
  });

  it("marks an all-self-loop chunk failed with the SELF_LOOP_REJECTED sentinel", async () => {
    const client = new FakeQueryable();
    const llm = new FakeLLMClient({
      queue: [
        {
          kind: "ok",
          outputs: [{ ...GROUNDED_OUTPUT, tail: "Alice", tailType: "person" }],
        },
      ],
    });

    const summary = await processBatch(
      makeDeps(llm),
      client,
      [{ id: "chunk-1", content: "Alice works at Alice." }],
      { batchSize: 1 }
    );

    expect(summary.succeeded).toBe(0);
    expect(summary.failed).toBe(1);
    const failedIdx = client.indexOf("SET status = 'failed'");
    expect(failedIdx).toBeGreaterThanOrEqual(0);
    expect(client.valuesList[failedIdx]).toContain(SELF_LOOP_REJECTED_CODE);
  });
});

// ─── T1 (graph-index-standard-fast): extract-method version spine ────────

/** SQL fragment that identifies the per-chunk conflict SELECT. */
const CONFLICT_SELECT = "SELECT sd.source_ref, sd.extract_method";

describe("processBatch extract-method routing (T1 seam)", () => {
  it("default method is standard: LLM runs and the success leg records the method", async () => {
    const client = new FakeQueryable();
    const llm = new FakeLLMClient({
      queue: [{ kind: "ok", outputs: [GROUNDED_OUTPUT] }],
    });

    const summary = await processBatch(
      makeDeps(llm),
      client,
      [{ id: "chunk-1", content: "Alice works at Acme Corp." }],
      { batchSize: 1 }
    );

    expect(summary.succeeded).toBe(1);
    const recordIdx = client.indexOf("UPDATE source_documents");
    expect(recordIdx).toBeGreaterThanOrEqual(0);
    expect(client.valuesList[recordIdx]).toEqual(["chunk-1", "standard"]);
    // Recording rides the chunk transaction BEFORE it commits (the version
    // metadata must not survive a rolled-back chunk).
    const commitIdx = client.indexOf("COMMIT");
    expect(recordIdx).toBeLessThan(commitIdx);
  });

  it("method 'fast' fails every chunk with FAST_EXTRACT_UNIMPLEMENTED and never calls the LLM", async () => {
    const client = new FakeQueryable();
    // Empty queue: any LLM call would throw "queue exhausted".
    const llm = new FakeLLMClient({ queue: [] });

    const summary = await processBatch(
      makeDeps(llm),
      client,
      [{ id: "chunk-1", content: "Alice works at Acme Corp." }],
      { batchSize: 1, method: "fast" }
    );

    expect(summary.failed).toBe(1);
    expect(summary.succeeded).toBe(0);
    const failedIdx = client.indexOf("SET status = 'failed'");
    expect(failedIdx).toBeGreaterThanOrEqual(0);
    expect(client.valuesList[failedIdx]).toContain(
      FAST_EXTRACT_UNIMPLEMENTED_CODE
    );
    // The sealed leg writes no ledger rows and never records a method.
    expect(client.indexOf("INSERT INTO triples")).toBe(-1);
    expect(client.indexOf("UPDATE source_documents")).toBe(-1);
  });

  it("a recorded method that differs fails the chunk with EXTRACT_METHOD_CONFLICT, no LLM call", async () => {
    const client = new FakeQueryable();
    // Simulate the SQL's `<> $2` filter: the stored row only surfaces when
    // it differs from the requested method.
    client.rowsFor = (text, values) =>
      text.includes(CONFLICT_SELECT) && values[1] !== "fast"
        ? [{ source_ref: "doc-1", extract_method: "fast" }]
        : [];
    const llm = new FakeLLMClient({ queue: [] });

    const outcomes: string[] = [];
    const summary = await processBatch(
      makeDeps(llm),
      client,
      [{ id: "chunk-1", content: "Alice works at Acme Corp." }],
      {
        batchSize: 1,
        method: "standard",
        onChunkOutcome: (o) => outcomes.push(o.kind),
      }
    );

    expect(summary.failed).toBe(1);
    const failedIdx = client.indexOf("SET status = 'failed'");
    expect(client.valuesList[failedIdx]).toContain(
      EXTRACT_METHOD_CONFLICT_CODE
    );
    // The message names the conflicting 资料 locator for the operator.
    expect(
      client.valuesList[failedIdx]!.some(
        (v) => typeof v === "string" && v.includes("doc-1")
      )
    ).toBe(true);
    // Conflict is checked BEFORE extraction: no ledger writes, no method
    // overwrite — the recorded version keeps its original method.
    expect(client.indexOf("INSERT INTO triples")).toBe(-1);
    expect(client.indexOf("UPDATE source_documents")).toBe(-1);
    expect(outcomes).toEqual(["failed"]);
  });

  it("re-extracting with the SAME recorded method is not a conflict (idempotent repeat)", async () => {
    const client = new FakeQueryable();
    client.rowsFor = (text, values) =>
      text.includes(CONFLICT_SELECT) && values[1] !== "standard"
        ? [{ source_ref: "doc-1", extract_method: "standard" }]
        : [];
    const llm = new FakeLLMClient({
      queue: [{ kind: "ok", outputs: [GROUNDED_OUTPUT] }],
    });

    const summary = await processBatch(
      makeDeps(llm),
      client,
      [{ id: "chunk-1", content: "Alice works at Acme Corp." }],
      { batchSize: 1, method: "standard" }
    );

    expect(summary.succeeded).toBe(1);
    expect(summary.failed).toBe(0);
    // The record write stays idempotent: same method re-recorded verbatim.
    expect(
      client.valuesList[client.indexOf("UPDATE source_documents")]
    ).toEqual(["chunk-1", "standard"]);
  });

  it("chunks whose 资料 row has no recorded method proceed and claim the version", async () => {
    const client = new FakeQueryable();
    const llm = new FakeLLMClient({
      queue: [{ kind: "ok", outputs: [GROUNDED_OUTPUT] }],
    });

    const summary = await processBatch(
      makeDeps(llm),
      client,
      [{ id: "chunk-1", content: "Alice works at Acme Corp." }],
      { batchSize: 1, method: "standard" }
    );

    expect(summary.succeeded).toBe(1);
    // Conflict SELECT ran before the record insert marked the chunk pending-
    // extraction, proving the guard is pre-flight, not post-hoc.
    expect(client.indexOf(CONFLICT_SELECT)).toBeLessThan(
      client.indexOf("SET status = 'succeeded'")
    );
  });
});
