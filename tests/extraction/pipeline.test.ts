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
  batchFailureCode,
  processBatch,
  type BatchSummary,
  type ExtractPipelineDeps,
} from "../../src/core/extraction/pipeline.js";
import type { EmbeddingClient } from "../../src/core/embedder.js";
import { createMergeEmbedBudget } from "../../src/core/entities/merge-budget.js";
import { FakeLLMClient } from "../../src/core/extraction/llm-client.js";
import type { LLMClient } from "../../src/core/extraction/llm-client.js";
import { FakeEmbedder } from "../../src/core/embedder.js";
import {
  JUDGE_DOWN_CODE,
  JUDGE_REJECTED_CODE,
} from "../../src/core/extraction/judge.js";
import { SELF_LOOP_REJECTED_CODE } from "../../src/core/extraction/records.js";
import { deriveMergeEmbedCap } from "../../src/core/extraction/persist.js";
import {
  createMergeEmbedBudget,
  ENTITY_MERGE_EMBED_LIMIT,
} from "../../src/core/entities/merge-budget.js";
import { EXTRACT_METHOD_CONFLICT_CODE } from "../../src/core/extraction/method.js";
import { FAST_EMPTY_GRAPH_CODE } from "../../src/core/extraction/fast.js";
import type { Logger } from "../../src/logging.js";

/** Recording fake Queryable; rows are chosen per SQL text (and binds). */
class FakeQueryable implements Queryable {
  queries: string[] = [];
  valuesList: unknown[][] = [];
  rowsFor: (text: string, values: unknown[]) => any[] = () => [];
  /** The commit phase re-reads `chunks.content` by id, so the fake needs the
   *  text the lifecycle was handed — `runBatch` registers it per run. */
  readonly chunkText = new Map<string, string>();

  async query(text: string, values: unknown[] = []) {
    this.queries.push(text);
    this.valuesList.push(values);
    if (text.includes("FROM chunks c WHERE c.id = $1")) {
      const id = String(values[0]);
      return { rows: [{ id, content: this.chunkText.get(id) ?? "" }] };
    }
    return { rows: this.rowsFor(text, values) };
  }

  /** Index of the first query containing `fragment` at or after `from`, or -1. */
  indexOf(fragment: string, from = 0): number {
    return this.queries.findIndex((q, i) => i >= from && q.includes(fragment));
  }

  /** Index of the last query containing `fragment` before `before`, or -1. */
  lastIndexOf(fragment: string, before: number): number {
    for (let i = before; i >= 0; i -= 1) {
      if (this.queries[i]!.includes(fragment)) return i;
    }
    return -1;
  }
}

const SILENT_LOGGER: Logger = {
  level: "error",
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function makeDeps(llm: LLMClient): ExtractPipelineDeps {
  return {
    llm,
    embedder: new FakeEmbedder(8),
    logger: SILENT_LOGGER,
    now: () => "2026-01-01T00:00:00.000Z",
    mergeBudget: createMergeEmbedBudget(),
  };
}

/**
 * The seam the commit phase needs: phase E stages outputs only, so phase C
 * re-reads the chunk text by id. The fake answers from what the run handed
 * over, which is exactly what a real Postgres would return.
 */
function runBatch(
  deps: ExtractPipelineDeps,
  client: FakeQueryable,
  chunks: Array<{ id: string; content: string }>,
  opts?: Parameters<typeof processBatch>[3]
): Promise<BatchSummary> {
  for (const chunk of chunks) client.chunkText.set(chunk.id, chunk.content);
  return processBatch(deps, client, chunks, opts);
}

const GROUNDED_OUTPUT = {
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

  it("applies --only-failed excluding SELF_LOOP_REJECTED and discarded rows", async () => {
    const client = new FakeQueryable();
    await selectPendingChunks(client, { batchSize: 5, onlyFailed: true });

    const sql = client.queries[0]!;
    expect(sql).toContain("row_number() OVER (PARTITION BY chunk_id");
    expect(sql).toContain("error_code != 'SELF_LOOP_REJECTED'");
    // A MERGE_GRAY_HOLD row is a pair-level maintenance item, never the
    // chunk's own latest status: it must leave the rn=1 partition entirely.
    expect(sql).toContain(
      "WHERE error_code IS DISTINCT FROM 'MERGE_GRAY_HOLD'"
    );
    // T2: a discarded review record must not be re-picked by the re-extract
    // scan either (the operator said no to THAT proposal, not to the chunk).
    expect(sql).toContain("discarded_at IS NULL");
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

    const summary = await runBatch(
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
    // The sealed failure leg's code travels to the caller (job-level
    // decisions must not re-query extraction_records).
    expect(summary.failureCodes).toEqual(["5xx"]);
    expect(summary.batchId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );

    // Transaction 1 (chunk-ok): BEGIN → record insert → entity/triple
    // writes → outbox emit → markSucceeded → COMMIT, in that order. The
    // failing sibling seals its own transaction in phase E, so these are the
    // successful leg's boundaries, not the first BEGIN/COMMIT in the log
    // (ADR-0013 Decision 6).
    const outbox1 = client.indexOf("INSERT INTO projection_outbox");
    const succeeded1 = client.indexOf("SET status = 'succeeded'");
    const record1 = client.lastIndexOf("INSERT INTO extraction_records", outbox1);
    const begin1 = client.lastIndexOf("BEGIN", record1);
    const commit1 = client.indexOf("COMMIT", succeeded1);
    expect(begin1).toBeGreaterThanOrEqual(0);
    expect(
      begin1 < record1 &&
        record1 < outbox1 &&
        outbox1 < succeeded1 &&
        succeeded1 < commit1
    ).toBe(true);

    // Transaction 2 (chunk-bad): the failed chunk is marked failed with the
    // LLM error code and still commits its own record row. It seals in phase E,
    // which now precedes chunk-ok's commit (ADR-0013 Decision 6).
    const failed2 = client.indexOf("SET status = 'failed'");
    expect(failed2).toBeGreaterThanOrEqual(0);
    expect(failed2).toBeLessThan(begin1);
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

    const summary = await runBatch(
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

    const summary = await runBatch(
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

    const summary = await runBatch(
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

  it("method 'fast' runs the pure NLP extractor, typed-skips its unknown type at persist, and never calls the LLM", async () => {
    const client = new FakeQueryable();
    // Empty queue: any LLM call would throw "queue exhausted" and the chunk
    // would land as a write-failure, not a success.
    const llm = new FakeLLMClient({ queue: [] });

    const summary = await runBatch(
      makeDeps(llm),
      client,
      [{ id: "chunk-1", content: "the a Alice Bob" }],
      { batchSize: 1, method: "fast" }
    );

    // "alice"/"bob" survive stopword filtering → one co-occurrence edge.
    // entity-type-and-filter T1: fast nodes carry the unclassified type
    // "concept" — outside the closed persist set — so the edge is
    // typed-skipped (no entity row, no triple), fail-closed rather than a
    // fallback bucket. The chunk itself still succeeds (mark-and-continue).
    expect(summary.succeeded).toBe(1);
    expect(summary.failed).toBe(0);
    expect(client.indexOf("INSERT INTO triples")).toBe(-1);
    expect(client.indexOf("INSERT INTO entities")).toBe(-1);
    // The success leg still claims the version for fast (T1 spine unchanged).
    const recordIdx = client.indexOf("UPDATE source_documents");
    expect(client.valuesList[recordIdx]).toEqual(["chunk-1", "fast"]);
  });

  it("method 'fast' on a Chinese chunk with no edges is a typed FAST_EMPTY_GRAPH chunk fail", async () => {
    const client = new FakeQueryable();
    const llm = new FakeLLMClient({ queue: [] });

    const summary = await runBatch(
      makeDeps(llm),
      client,
      [{ id: "chunk-1", content: "的了 于 与 之" }],
      { batchSize: 1, method: "fast" }
    );

    expect(summary.failed).toBe(1);
    expect(summary.failureCodes).toEqual([FAST_EMPTY_GRAPH_CODE]);
    const failedIdx = client.indexOf("SET status = 'failed'");
    expect(failedIdx).toBeGreaterThanOrEqual(0);
    expect(client.valuesList[failedIdx]).toContain(FAST_EMPTY_GRAPH_CODE);
    // The failed leg writes no ledger rows and records no method.
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
    const summary = await runBatch(
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

    const summary = await runBatch(
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

    const summary = await runBatch(
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

// ─── T3 (graph-index-standard-fast): standard describe + claims ──────────

/**
 * A FakeLLMClient carrying the OPTIONAL enrichment methods, so the
 * pipeline's standard leg actually runs describe + claims.
 */
function makeEnrichLLM(extractQueue: any[], overrides: any) {
  return new FakeLLMClient({ queue: extractQueue, ...overrides });
}

const describeDrafts = async (input: any) => ({
  kind: "ok",
  descriptions: input.entities.map((e: any) => ({
    canonicalName: e.canonicalName,
    description: `${e.canonicalName} summary`,
  })),
});

const claimsOk = async () => ({
  kind: "ok",
  claims: [
    {
      entity: "Alice",
      claim: "Alice works at Acme Corp.",
      validFrom: null,
      validTo: null,
      confidence: 0.8,
      evidenceSpan: "",
    },
  ],
});

describe("processBatch standard post-merge enrichment (T3)", () => {
  it("runs describe + claims after the merge writes and inside the chunk transaction", async () => {
    const client = new FakeQueryable();
    const llm = makeEnrichLLM(
      [{ kind: "ok", outputs: [GROUNDED_OUTPUT] }],
      { scriptedDescribe: describeDrafts, scriptedClaims: claimsOk }
    );

    const summary = await runBatch(
      makeDeps(llm),
      client,
      [{ id: "chunk-1", content: "Alice works at Acme Corp." }],
      { batchSize: 1, method: "standard" }
    );

    expect(summary.succeeded).toBe(1);
    // Ordering inside the one transaction: merge/persist writes → the
    // survivor description UPDATE + the claims replace → outbox intents →
    // COMMIT. Enrichment rides the SAME transaction (a rolled-back chunk
    // leaves no descriptions or claims behind), and it runs AFTER the
    // canonical merge wrote the survivor rows.
    const tripleInsert = client.indexOf("INSERT INTO triples");
    const describeUpdate = client.indexOf("jsonb_set");
    const claimsDelete = client.indexOf("DELETE FROM claims");
    const claimsInsert = client.indexOf("INSERT INTO claims");
    const outbox = client.indexOf("INSERT INTO projection_outbox");
    const commit = client.indexOf("COMMIT");
    expect(tripleInsert).toBeGreaterThanOrEqual(0);
    expect(describeUpdate).toBeGreaterThan(tripleInsert);
    expect(claimsDelete).toBeGreaterThan(tripleInsert);
    expect(claimsInsert).toBeGreaterThan(claimsDelete);
    expect(outbox).toBeGreaterThan(claimsInsert);
    expect(commit).toBeGreaterThan(outbox);
  });

  it("the fast method never dials describe/claims and never writes them", async () => {
    const client = new FakeQueryable();
    let describeCalls = 0;
    let claimCalls = 0;
    const llm = makeEnrichLLM([], {
      scriptedDescribe: async (input: any) => {
        describeCalls += 1;
        return describeDrafts(input);
      },
      scriptedClaims: async () => {
        claimCalls += 1;
        return claimsOk();
      },
    });

    const summary = await runBatch(
      makeDeps(llm),
      client,
      [{ id: "chunk-1", content: "the a Alice Bob" }],
      { batchSize: 1, method: "fast" }
    );

    // Fast persists its co-occurrence edges (T4) but enrichment stays
    // standard-only (spec: Fast has no descriptions, no claims): the chunk
    // succeeds without a single describe/claims touch or write.
    expect(summary.succeeded).toBe(1);
    expect(describeCalls).toBe(0);
    expect(claimCalls).toBe(0);
    expect(client.indexOf("jsonb_set")).toBe(-1);
    expect(client.indexOf("DELETE FROM claims")).toBe(-1);
    expect(client.indexOf("INSERT INTO claims")).toBe(-1);
  });

  it("an enrichment miss (failed describe + failed claims) keeps the chunk successful", async () => {
    const client = new FakeQueryable();
    const llm = makeEnrichLLM(
      [{ kind: "ok", outputs: [GROUNDED_OUTPUT] }],
      {
        scriptedDescribe: async () => ({
          kind: "failed",
          errorCode: "5xx",
          errorMsg: "provider down",
        }),
        scriptedClaims: async () => ({
          kind: "failed",
          errorCode: "format",
          errorMsg: "bad json",
        }),
      }
    );

    const summary = await runBatch(
      makeDeps(llm),
      client,
      [{ id: "chunk-1", content: "Alice works at Acme Corp." }],
      { batchSize: 1, method: "standard" }
    );

    // ADR 0069 / 0071: misses skip their leg; the C job is not failed.
    expect(summary.succeeded).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.writeFailures).toBe(0);
    expect(client.indexOf("jsonb_set")).toBe(-1);
    expect(client.indexOf("INSERT INTO claims")).toBe(-1);
    expect(client.indexOf("SET status = 'succeeded'")).toBeGreaterThanOrEqual(
      0
    );
    expect(client.indexOf("COMMIT")).toBeGreaterThanOrEqual(0);
  });

  it("a throwing enrichment client is sealed per leg and never rolls the chunk back", async () => {
    const client = new FakeQueryable();
    const llm = makeEnrichLLM(
      [{ kind: "ok", outputs: [GROUNDED_OUTPUT] }],
      {
        scriptedDescribe: async () => {
          throw new Error("socket reset");
        },
        scriptedClaims: async () => {
          throw new Error("socket reset");
        },
      }
    );

    const summary = await runBatch(
      makeDeps(llm),
      client,
      [{ id: "chunk-1", content: "Alice works at Acme Corp." }],
      { batchSize: 1, method: "standard" }
    );

    expect(summary.succeeded).toBe(1);
    expect(summary.writeFailures).toBe(0);
    expect(client.indexOf("ROLLBACK")).toBe(-1);
  });
});

// ─── T6 (graph-index-standard-fast): entity-description re-embedding ─────

/** Embedder recording every batch, delegating vectors to FakeEmbedder. */
class RecordingEmbedder {
  readonly available = true;
  calls: string[][] = [];
  private readonly fake = new FakeEmbedder(8);

  async embed(texts: string[]): Promise<number[][]> {
    this.calls.push([...texts]);
    return this.fake.embed(texts);
  }
}

// ─── T5 gap (graph-index-standard-fast): producer-side C-state demotion ──

/** SQL fragment identifying the singleton `community_index_state` UPDATE. */
const STATE_DEMOTION = "UPDATE community_index_state";

describe("processBatch producer-side C-state demotion (T5 review gap)", () => {
  it("standard chunk that changes the graph demotes ready→stale inside the chunk transaction", async () => {
    const client = new FakeQueryable();
    const llm = new FakeLLMClient({
      queue: [{ kind: "ok", outputs: [GROUNDED_OUTPUT] }],
    });

    const summary = await runBatch(
      makeDeps(llm),
      client,
      [{ id: "chunk-1", content: "Alice works at Acme Corp." }],
      { batchSize: 1 }
    );

    expect(summary.succeeded).toBe(1);
    // The demotion rides the SAME transaction as the graph rows it makes
    // stale: after the triple INSERT, before COMMIT. A chunk that committed
    // new edges while the state row still said `ready` is exactly the gap
    // this closes.
    const begin = client.indexOf("BEGIN");
    const tripleInsert = client.indexOf("INSERT INTO triples");
    const demotion = client.indexOf(STATE_DEMOTION);
    const commit = client.indexOf("COMMIT");
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(tripleInsert).toBeGreaterThanOrEqual(0);
    expect(demotion).toBeGreaterThan(tripleInsert);
    expect(demotion).toBeLessThan(commit);
    expect(client.valuesList[demotion]).toEqual(["stale", "ready"]);
  });

  it("fast chunk typed-skipped by the closed set changes no graph and emits no demotion", async () => {
    const client = new FakeQueryable();
    // Empty queue: fast never dials the LLM; a call would throw and the
    // chunk would land as a write-failure, not the expected success.
    const llm = new FakeLLMClient({ queue: [] });

    const summary = await runBatch(
      makeDeps(llm),
      client,
      [{ id: "chunk-1", content: "the a Alice Bob" }],
      { batchSize: 1, method: "fast" }
    );

    // entity-type-and-filter T1: fast's unclassified type is typed-skipped,
    // so the graph never moves — and a chunk that moved nothing must not
    // demote the community index (same posture as the all-self-loop test).
    expect(summary.succeeded).toBe(1);
    const tripleInsert = client.indexOf("INSERT INTO triples");
    const demotion = client.indexOf(STATE_DEMOTION);
    expect(tripleInsert).toBe(-1);
    expect(demotion).toBe(-1);
  });

  it("a chunk whose outputs were all rejected as self-loops emits no demotion", async () => {
    const client = new FakeQueryable();
    const llm = new FakeLLMClient({
      queue: [
        {
          kind: "ok",
          outputs: [{ ...GROUNDED_OUTPUT, tail: "Alice", tailType: "person" }],
        },
      ],
    });

    const summary = await runBatch(
      makeDeps(llm),
      client,
      [{ id: "chunk-1", content: "Alice works at Alice." }],
      { batchSize: 1 }
    );

    // SC5 failed leg: the chunk persisted no graph rows, so the summary
    // generation is still current — the state row must not move.
    expect(summary.failed).toBe(1);
    expect(client.indexOf(STATE_DEMOTION)).toBe(-1);
  });

  it("a chunk with zero outputs is an empty-proposal judge fail and emits no demotion", async () => {
    const client = new FakeQueryable();
    const llm = new FakeLLMClient({ queue: [{ kind: "ok", outputs: [] }] });

    const summary = await runBatch(
      makeDeps(llm),
      client,
      [{ id: "chunk-1", content: "Alice works at Acme Corp." }],
      { batchSize: 1 }
    );

    // extract-verify T1: an empty proposal is a reject class — the chunk
    // never reaches persist, so there is nothing to demote either.
    expect(summary.failed).toBe(1);
    expect(summary.failureCodes).toEqual([JUDGE_REJECTED_CODE]);
    expect(client.indexOf("INSERT INTO triples")).toBe(-1);
    expect(client.indexOf(STATE_DEMOTION)).toBe(-1);
  });

  it("the demotion guard is SQL-level: only the singleton ready row is touched", async () => {
    const client = new FakeQueryable();
    const llm = new FakeLLMClient({
      queue: [{ kind: "ok", outputs: [GROUNDED_OUTPUT] }],
    });

    await runBatch(
      makeDeps(llm),
      client,
      [{ id: "chunk-1", content: "Alice works at Acme Corp." }],
      { batchSize: 1 }
    );

    // Absent row → the UPDATE matches nothing (a no-op, never an INSERT).
    // in_progress/failed → the WHERE status='ready' clause skips it, so a
    // demotion never resurrects a failed build nor interrupts an in-flight
    // rebuild. The guard, not client-side branching, carries the semantics
    // (real-row enforcement is pinned by tests/schema-bootstrap.test.ts).
    const demotion = client.indexOf(STATE_DEMOTION);
    expect(demotion).toBeGreaterThanOrEqual(0);
    const sql = client.queries[demotion]!;
    expect(sql).toContain("SET status = $1");
    expect(sql).toContain("updated_at = now()");
    expect(sql).toContain("WHERE id = 1 AND status = $2");
    expect(client.valuesList[demotion]).toEqual(["stale", "ready"]);
  });

  it("a demotion write error rolls the chunk back like any other write", async () => {
    const client = new FakeQueryable();
    const baseQuery = client.query.bind(client);
    client.query = async (text: string, values: unknown[] = []) => {
      if (text.includes(STATE_DEMOTION)) {
        // Record first so the failure point is observable in the sequence.
        client.queries.push(text);
        client.valuesList.push(values);
        throw new Error("simulated community_index_state write failure");
      }
      return baseQuery(text, values);
    };
    const llm = new FakeLLMClient({
      queue: [{ kind: "ok", outputs: [GROUNDED_OUTPUT] }],
    });

    const summary = await runBatch(
      makeDeps(llm),
      client,
      [{ id: "chunk-1", content: "Alice works at Acme Corp." }],
      { batchSize: 1 }
    );

    // The demotion is part of the all-or-nothing chunk transaction: if it
    // fails, the new triples roll back with it — no committed graph change
    // is left sitting on a `ready` state.
    expect(summary.writeFailures).toBe(1);
    expect(summary.succeeded).toBe(0);
    expect(client.indexOf("ROLLBACK")).toBeGreaterThan(
      client.indexOf(STATE_DEMOTION)
    );
    expect(client.indexOf("COMMIT")).toBe(-1);
  });
});

describe("processBatch entity-description embedding class (T6)", () => {
  it("standard re-embeds each summarized description inside the chunk transaction", async () => {
    const client = new FakeQueryable();
    const embedder = new RecordingEmbedder();
    const llm = makeEnrichLLM(
      [{ kind: "ok", outputs: [GROUNDED_OUTPUT] }],
      { scriptedDescribe: describeDrafts, scriptedClaims: claimsOk }
    );

    const summary = await runBatch(
      { ...makeDeps(llm), embedder },
      client,
      [{ id: "chunk-1", content: "Alice works at Acme Corp." }],
      { batchSize: 1, method: "standard" }
    );

    expect(summary.succeeded).toBe(1);
    // The description-embedding SSOT text (name | summarized description)
    // is dialed at INDEX time — the query never embeds this class first.
    const batch = embedder.calls.find((texts) => texts.length === 2);
    expect(batch).toEqual([
      "Acme Corp | Acme Corp summary",
      "Alice | Alice summary",
    ]);
    // The vector UPDATE rides the same transaction: after the description
    // UPDATE, before COMMIT.
    const describeUpdate = client.indexOf("jsonb_set");
    const vectorUpdate = client.indexOf("SET embedding");
    const commit = client.indexOf("COMMIT");
    expect(vectorUpdate).toBeGreaterThan(describeUpdate);
    expect(commit).toBeGreaterThan(vectorUpdate);
  });

  it("the fast method never produces the description-vector class", async () => {
    const client = new FakeQueryable();
    const embedder = new RecordingEmbedder();
    const llm = makeEnrichLLM([], {
      scriptedDescribe: describeDrafts,
      scriptedClaims: claimsOk,
    });

    const summary = await runBatch(
      { ...makeDeps(llm), embedder },
      client,
      [{ id: "chunk-1", content: "the a Alice Bob" }],
      { batchSize: 1, method: "fast" }
    );

    // Fast DOES embed its insert-time entity vectors (persist path) but has
    // no description class: no re-embed UPDATE, no describe batch.
    expect(summary.succeeded).toBe(1);
    expect(client.indexOf("SET embedding")).toBe(-1);
    expect(client.indexOf("jsonb_set")).toBe(-1);
    expect(embedder.calls.every((texts) => !texts.some((t) => t.includes("summary")))).toBe(
      true
    );
  });
});

// ─── extract-verify T1: grounded judge gates every persist path ───────────

describe("processBatch grounded judge gate (extract-verify T1)", () => {
  it("a rejected triple fails the chunk: no triples, no outbox, failed record with the proposal payload", async () => {
    const client = new FakeQueryable();
    const llm = new FakeLLMClient({
      queue: [{ kind: "ok", outputs: [GROUNDED_OUTPUT] }],
      scriptedJudge: async () => ({
        kind: "ok",
        verdicts: [
          { index: 0, grounded: false, reason: "tail invented by the model" },
        ],
      }),
    });

    const summary = await runBatch(
      makeDeps(llm),
      client,
      [{ id: "chunk-1", content: "Alice works at Acme Corp." }],
      { batchSize: 1 }
    );

    expect(summary.succeeded).toBe(0);
    expect(summary.failed).toBe(1);
    expect(summary.failureCodes).toEqual([JUDGE_REJECTED_CODE]);
    // Nothing becomes graph fact: zero triple writes AND zero projection
    // intents (Neo4j never hears about the rejected proposal).
    expect(client.indexOf("INSERT INTO triples")).toBe(-1);
    expect(client.indexOf("INSERT INTO entities")).toBe(-1);
    expect(client.indexOf("INSERT INTO projection_outbox")).toBe(-1);
    // Spec acceptance "资料 count unchanged": the rejected leg never touches
    // the source_documents ledger — no method recording, no row write.
    expect(client.indexOf("UPDATE source_documents")).toBe(-1);
    expect(client.indexOf("INSERT INTO source_documents")).toBe(-1);
    // The failed leg keeps its record row + payload and commits (mark, not roll back).
    const failedIdx = client.indexOf("proposed_payload");
    expect(failedIdx).toBeGreaterThanOrEqual(0);
    expect(client.valuesList[failedIdx]).toContain(JUDGE_REJECTED_CODE);
    expect(
      client.valuesList[failedIdx]!.some(
        (v) =>
          typeof v === "string" && v.includes("tail invented by the model")
      )
    ).toBe(true);
    // The stored payload is enough to replay later: triples + verdicts.
    const payload = JSON.parse(
      client.valuesList[failedIdx]!.find(
        (v) => typeof v === "string" && v.includes('"triples"')
      ) as string
    );
    expect(payload.triples).toHaveLength(1);
    expect(payload.triples[0].head).toBe("Alice");
    expect(payload.verdicts[0].grounded).toBe(false);
    expect(client.indexOf("COMMIT")).toBeGreaterThan(failedIdx);
    expect(client.indexOf("ROLLBACK")).toBe(-1);
  });

  it("a judge down (throwing adapter) is fail-closed: JUDGE_DOWN leg, zero graph writes", async () => {
    const client = new FakeQueryable();
    const llm = new FakeLLMClient({
      queue: [{ kind: "ok", outputs: [GROUNDED_OUTPUT] }],
      scriptedJudge: async () => {
        throw new Error("judge timed out");
      },
    });

    const summary = await runBatch(
      makeDeps(llm),
      client,
      [{ id: "chunk-1", content: "Alice works at Acme Corp." }],
      { batchSize: 1 }
    );

    expect(summary.failed).toBe(1);
    expect(summary.failureCodes).toEqual([JUDGE_DOWN_CODE]);
    expect(client.indexOf("INSERT INTO triples")).toBe(-1);
    expect(client.indexOf("INSERT INTO projection_outbox")).toBe(-1);
    const failedIdx = client.indexOf("proposed_payload");
    expect(client.valuesList[failedIdx]).toContain(JUDGE_DOWN_CODE);
    expect(
      client.valuesList[failedIdx]!.some(
        (v) => typeof v === "string" && v.includes("judge timed out")
      )
    ).toBe(true);
  });

  it("a client without the judge adapter fails the chunk closed", async () => {
    const client = new FakeQueryable();
    const llm = {
      extract: async () => ({ kind: "ok", outputs: [GROUNDED_OUTPUT] }),
    } as unknown as LLMClient;

    const summary = await runBatch(
      makeDeps(llm),
      client,
      [{ id: "chunk-1", content: "Alice works at Acme Corp." }],
      { batchSize: 1 }
    );

    expect(summary.failed).toBe(1);
    expect(summary.failureCodes).toEqual([JUDGE_DOWN_CODE]);
    expect(client.indexOf("INSERT INTO triples")).toBe(-1);
  });

  it("the batch continues past a judge-rejected chunk", async () => {
    const client = new FakeQueryable();
    const llm = new FakeLLMClient({
      queue: [
        { kind: "ok", outputs: [GROUNDED_OUTPUT] },
        { kind: "ok", outputs: [GROUNDED_OUTPUT] },
      ],
      scriptedJudge: async (input) => ({
        kind: "ok",
        verdicts: input.candidates.map((_, index) => ({
          index,
          grounded: input.chunkText !== "Alice works at Acme Corp.",
          reason: "scripted",
        })),
      }),
    });

    const outcomes: string[] = [];
    const summary = await runBatch(
      makeDeps(llm),
      client,
      [
        { id: "chunk-reject", content: "Alice works at Acme Corp." },
        { id: "chunk-pass", content: "Alice works at Acme Corp. Too." },
      ],
      { batchSize: 2, onChunkOutcome: (o) => outcomes.push(o.kind) }
    );

    expect(summary.processed).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.succeeded).toBe(1);
    expect(outcomes).toEqual(["failed", "ok"]);
    // The passing sibling still persisted: exactly the judge leg of chunk 1
    // precedes it, and the batch's second transaction committed normally.
    expect(client.indexOf("INSERT INTO triples")).toBeGreaterThanOrEqual(0);
  });

  it("a fast-method chunk is judged too: reject means zero triples, zero outbox", async () => {
    const client = new FakeQueryable();
    let judgeCalls = 0;
    const llm = new FakeLLMClient({
      queue: [],
      scriptedJudge: async (input) => {
        judgeCalls += 1;
        return {
          kind: "ok",
          verdicts: input.candidates.map((_, index) => ({
            index,
            grounded: false,
            reason: "co-occurrence alone is not grounded",
          })),
        };
      },
    });

    const summary = await runBatch(
      makeDeps(llm),
      client,
      [{ id: "chunk-1", content: "the a Alice Bob" }],
      { batchSize: 1, method: "fast" }
    );

    // The judge gate applies to fast chunks even though the fast extractor
    // itself dials no model.
    expect(judgeCalls).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.failureCodes).toEqual([JUDGE_REJECTED_CODE]);
    expect(client.indexOf("INSERT INTO triples")).toBe(-1);
    expect(client.indexOf("INSERT INTO entities")).toBe(-1);
    expect(client.indexOf("INSERT INTO projection_outbox")).toBe(-1);
    expect(client.indexOf("UPDATE source_documents")).toBe(-1);
    const failedIdx = client.indexOf("proposed_payload");
    expect(failedIdx).toBeGreaterThanOrEqual(0);
    expect(client.valuesList[failedIdx]).toContain(JUDGE_REJECTED_CODE);
    expect(client.indexOf("COMMIT")).toBeGreaterThan(failedIdx);
  });

  it("the judge runs after extract and BEFORE any persist write", async () => {
    const client = new FakeQueryable();
    let sawGraphWrite = true;
    const llm = new FakeLLMClient({
      queue: [{ kind: "ok", outputs: [GROUNDED_OUTPUT] }],
      scriptedJudge: async (input) => {
        // Proof of ordering: at judge time no triple/outbox write has run.
        sawGraphWrite = client.queries.some(
          (q) =>
            q.includes("INSERT INTO triples") ||
            q.includes("INSERT INTO projection_outbox")
        );
        return allYes(input);
      },
    });

    await runBatch(
      makeDeps(llm),
      client,
      [{ id: "chunk-1", content: "Alice works at Acme Corp." }],
      { batchSize: 1 }
    );

    expect(sawGraphWrite).toBe(false);
  });

  function allYes(input: { candidates: { head: string }[] }) {
    return {
      kind: "ok",
      verdicts: input.candidates.map((_, index) => ({
        index,
        grounded: true,
        reason: "stated",
      })),
    };
  }
});

/**
 * The entity-merge embed cap (ADR-0013): one cap per lifecycle, derived after
 * the extract phase and before the commit phase, counted per merge-gate
 * RESOLUTION and refused loudly.
 */

/** Counts the raw provider requests a lifecycle spent, under the real vectors. */
class CountingEmbedder implements EmbeddingClient {
  requests = 0;
  constructor(private readonly inner: EmbeddingClient) {}
  async embed(texts: string[]): Promise<number[][]> {
    this.requests += 1;
    return await this.inner.embed(texts);
  }
}

/** A logger that keeps what it was told, so the cap lines can be asserted. */
function recordingLogger(): { logger: Logger; lines: { msg: string; fields?: unknown }[] } {
  const lines: { msg: string; fields?: unknown }[] = [];
  const logger: Logger = {
    level: "info",
    debug: () => {},
    info: (msg, fields) => lines.push({ msg, fields }),
    warn: () => {},
    error: (msg, fields) => lines.push({ msg, fields }),
  };
  return { logger, lines };
}

/**
 * One live candidate that never matches an incoming name exactly, so every
 * resolution reaches L2 and embeds, and a human judge that refuses every gray
 * pair — the loser is never materialized, so a repeated key costs another
 * resolution instead of hitting the zero-cost L0 path.
 */
const GRAY_HEAD = {
  head: "Alicia Smith",
  headType: "person",
  relationRaw: "works at",
  relationNorm: "RELATED_TO",
  tail: "Acme Corp",
  tailType: "organization",
  description: "Alicia Smith works at Acme Corp on the billing platform",
  evidenceSpan: "Alicia Smith works at Acme Corp on the billing platform",
  confidence: 0.9,
};

function grayHarness(outputs: number): {
  client: FakeQueryable;
  llm: FakeLLMClient;
  embedder: CountingEmbedder;
  deps: ExtractPipelineDeps;
  lines: { msg: string; fields?: unknown }[];
} {
  const client = new FakeQueryable();
  client.rowsFor = (text) => {
    if (text.includes("FROM entities WHERE retired = false")) {
      return [
        {
          id: "alice-1",
          canonical_name: "Alice Smith",
          type: "person",
          embedding: null,
          description: "Alice Smith works at Acme Corp on the billing platform",
        },
      ];
    }
    return [];
  };
  const llm = new FakeLLMClient({
    queue: [
      {
        kind: "ok",
        outputs: Array.from({ length: outputs }, () => ({ ...GRAY_HEAD })),
      },
    ],
  });
  const embedder = new CountingEmbedder(new FakeEmbedder(8));
  const { logger, lines } = recordingLogger();
  const deps: ExtractPipelineDeps = {
    llm,
    embedder,
    logger,
    now: () => "2026-01-01T00:00:00.000Z",
    mergeBudget: createMergeEmbedBudget(),
    mergeJudge: async () => "human",
  };
  return { client, llm, embedder, deps, lines };
}

const GRAY_CHUNK = "Alicia Smith works at Acme Corp on the billing platform.";

describe("entity-merge embed cap — one cap per lifecycle", () => {
  it("row 1: a fresh source's resolutions are bounded and reported", async () => {
    // Characterization: before the cap there was no bound at all and the
    // completion line carried no cap, so both assertions below failed.
    const client = new FakeQueryable();
    const { logger, lines } = recordingLogger();
    const llm = new FakeLLMClient({
      queue: [{ kind: "ok", outputs: [{ ...GROUNDED_OUTPUT }] }],
    });
    const embedder = new CountingEmbedder(new FakeEmbedder(8));

    await runBatch(
      {
        llm,
        embedder,
        logger,
        now: () => "2026-01-01T00:00:00.000Z",
        mergeBudget: createMergeEmbedBudget(),
      },
      client,
      [{ id: "chunk-1", content: "Alice works at Acme Corp." }],
      { batchSize: 1, sourceRef: "doc-1/1/main" }
    );

    const done = lines.filter((line) => line.msg === "extract-batch-complete");
    expect(done).toHaveLength(1);
    const fields = done[0]!.fields as Record<string, unknown>;
    // A new entity resolves with no live candidate, so the fresh source spends
    // no merge-gate request at all — and says so, rather than staying silent.
    expect(fields.embed_cap).toBe(deriveMergeEmbedCap([GROUNDED_OUTPUT], 1).embedCap);
    expect(fields.embed_calls).toBe(0);
    expect(fields.source_ref).toBe("doc-1/1/main");
  });

  it("row 3: a population the cap derivation filters out yields cap = N and no breach", async () => {
    // A type outside the closed set is filtered by BOTH the cap derivation and
    // persistOutputs, so it contributes neither E nor T nor a resolution.
    const client = new FakeQueryable();
    const { logger, lines } = recordingLogger();
    const llm = new FakeLLMClient({
      queue: [
        {
          kind: "ok",
          outputs: [{ ...GROUNDED_OUTPUT, headType: "unicorn" }],
        },
      ],
    });
    const embedder = new CountingEmbedder(new FakeEmbedder(8));

    const summary = await runBatch(
      {
        llm,
        embedder,
        logger,
        now: () => "2026-01-01T00:00:00.000Z",
        mergeBudget: createMergeEmbedBudget(),
      },
      client,
      [{ id: "chunk-1", content: "Alice works at Acme Corp." }],
      { batchSize: 1 }
    );

    expect(deriveMergeEmbedCap([{ ...GROUNDED_OUTPUT, headType: "unicorn" }], 1)).toEqual({
      embedCap: 1,
      calls: 0,
    });
    const fields = lines.find((line) => line.msg === "extract-batch-complete")
      ?.fields as Record<string, unknown>;
    expect(fields.embed_cap).toBe(1);
    expect(fields.embed_calls).toBe(0);
    expect(summary.succeeded).toBe(1);
    expect(lines.some((line) => line.msg === "entity-merge-embed-limit")).toBe(false);
  });

  it("row 4: a sealed-failed leg contributes nothing to N and keeps its own code", async () => {
    const onlyFailed = await (async () => {
      const client = new FakeQueryable();
      const { logger } = recordingLogger();
      const llm = new FakeLLMClient({
        queue: [{ kind: "ok", outputs: [{ ...GROUNDED_OUTPUT }] }],
      });
      await runBatch(
        {
          llm,
          logger,
          embedder: new FakeEmbedder(8),
          now: () => "2026-01-01T00:00:00.000Z",
          mergeBudget: createMergeEmbedBudget(),
        },
        client,
        [{ id: "chunk-ok", content: "Alice works at Acme Corp." }],
        { batchSize: 1 }
      );
      return client;
    })();

    const client = new FakeQueryable();
    const { logger } = recordingLogger();
    const llm = new FakeLLMClient({
      queue: [
        { kind: "ok", outputs: [{ ...GROUNDED_OUTPUT }] },
        { kind: "5xx", message: "upstream refused" },
      ],
    });
    const summary = await runBatch(
      {
        llm,
        logger,
        embedder: new FakeEmbedder(8),
        now: () => "2026-01-01T00:00:00.000Z",
        mergeBudget: createMergeEmbedBudget(),
      },
      client,
      [
        { id: "chunk-ok", content: "Alice works at Acme Corp." },
        { id: "chunk-bad", content: "Bob works at Beta Corp." },
      ],
      { batchSize: 2 }
    );

    // N counts the staged `ok` leg only, so the failed sibling leaves the cap
    // exactly where the same source would be with that chunk omitted.
    expect(deriveMergeEmbedCap([{ ...GROUNDED_OUTPUT }], 1).embedCap).toBe(4);
    // The failure is visible as its OWN code, never as the budget's.
    expect(summary.failureCodes).toEqual(["5xx"]);
    expect(batchFailureCode(summary)).toBe("5xx");
    expect(batchFailureCode(summary)).not.toBe(ENTITY_MERGE_EMBED_LIMIT);
    // Phase E committed the sealed failure record, so it is readable now.
    const sealed = client.queries.findIndex((q) => q.includes("SET status = 'failed'"));
    expect(sealed).toBeGreaterThanOrEqual(0);
    expect(onlyFailed.queries.some((q) => q.includes("SET status = 'failed'"))).toBe(
      false
    );
  });

  it("row 8: exactly embed_cap resolutions pass and the (cap+1)-th embeds nothing", async () => {
    // Five identical gray pairs: the human judge never materializes the loser,
    // so each one re-embeds instead of hitting the zero-cost L0 path. E=2,
    // T=1, N=1 → cap 4, and the fifth resolution is refused.
    const breached = grayHarness(5);
    await expect(
      runBatch(
        breached.deps,
        breached.client,
        [{ id: "chunk-1", content: GRAY_CHUNK }],
        { batchSize: 1 }
      )
    ).rejects.toMatchObject({
      failureCode: ENTITY_MERGE_EMBED_LIMIT,
    });
    const breach = breached.lines.find(
      (line) => line.msg === "entity-merge-embed-limit"
    )?.fields as Record<string, unknown>;
    expect(breach.embed_cap).toBe(4);
    expect(breach.embed_calls).toBe(4);

    // The refusal cost nothing: the identical run that fits inside the cap
    // spends the SAME number of provider requests, so the (cap+1)-th
    // resolution issued no call of its own.
    const permitted = grayHarness(4);
    await runBatch(
      permitted.deps,
      permitted.client,
      [{ id: "chunk-1", content: GRAY_CHUNK }],
      { batchSize: 1 }
    );
    expect(permitted.embedder.requests).toBeGreaterThan(0);
    expect(breached.embedder.requests).toBe(permitted.embedder.requests);
  });

  it("row 9: one resolution over a multi-row candidate set charges once", async () => {
    const client = new FakeQueryable();
    client.rowsFor = (text) => {
      if (text.includes("FROM entities WHERE retired = false")) {
        return ["Zoe Prior", "Zack Pond", "Zara Quill"].map((name, index) => ({
          id: `candidate-${index}`,
          canonical_name: name,
          type: "person",
          embedding: null,
          description: `${name} works at Acme Corp on the billing platform`,
        }));
      }
      return [];
    };
    const llm = new FakeLLMClient({
      queue: [
        {
          kind: "ok",
          outputs: [
            { ...GRAY_HEAD, tail: "Yara Young", tailType: "person" },
          ],
        },
      ],
    });
    const embedder = new CountingEmbedder(new FakeEmbedder(8));
    const { logger, lines } = recordingLogger();

    await runBatch(
      {
        llm,
        embedder,
        logger,
        now: () => "2026-01-01T00:00:00.000Z",
        mergeBudget: createMergeEmbedBudget(),
      },
      client,
      [{ id: "chunk-1", content: "Alicia Smith works at Yara Young today." }],
      { batchSize: 1 }
    );

    // One resolution charged even though three candidates made the gate ask
    // several times: the counter counts RESOLUTIONS, and the requests are
    // strictly greater — asserted here rather than tolerated silently.
    const fields = lines.find((line) => line.msg === "extract-batch-complete")
      ?.fields as Record<string, unknown>;
    // One charge per output role, however many candidates each one weighs.
    expect(fields.embed_calls).toBe(2);
    expect(embedder.requests).toBeGreaterThan(fields.embed_calls as number);
  });

  it("row 10: staged output bytes above the ceiling refuse before any merge", async () => {
    const client = new FakeQueryable();
    const { logger, lines } = recordingLogger();
    const llm = new FakeLLMClient({
      queue: [{ kind: "ok", outputs: [{ ...GROUNDED_OUTPUT }] }],
    });

    await expect(
      runBatch(
        {
          llm,
          embedder: new FakeEmbedder(8),
          logger,
          now: () => "2026-01-01T00:00:00.000Z",
          mergeBudget: createMergeEmbedBudget(),
        },
        client,
        [{ id: "chunk-1", content: "Alice works at Acme Corp." }],
        { batchSize: 1, stageMaxBytes: 8 }
      )
    ).rejects.toMatchObject({
      failureCode: ENTITY_MERGE_EMBED_LIMIT,
      name: "MergeStageScopeError",
    });

    // Nothing committed and no merge ran: phase E is the only phase reached.
    expect(client.indexOf("INSERT INTO triples")).toBe(-1);
    expect(lines.some((line) => line.msg === "entity-merge-stage-limit")).toBe(true);
  });
});

describe("entity-merge embed cap — a breach is a run-level failure", () => {
  it("row 5: rolls back only the in-flight chunk and keeps earlier successes", async () => {
    const client = new FakeQueryable();
    client.rowsFor = (text) => {
      if (text.includes("FROM entities WHERE retired = false")) {
        return [
          {
            id: "alice-1",
            canonical_name: "Alice Smith",
            type: "person",
            embedding: null,
            description: "Alice Smith works at Acme Corp on the billing platform",
          },
        ];
      }
      return [];
    };
    const { logger, lines } = recordingLogger();
    const llm = new FakeLLMClient({
      queue: [
        { kind: "ok", outputs: [{ ...GROUNDED_OUTPUT }] },
        { kind: "5xx", message: "upstream refused" },
        { kind: "ok", outputs: Array.from({ length: 20 }, () => ({ ...GRAY_HEAD })) },
      ],
    });
    const deps: ExtractPipelineDeps = {
      llm,
      embedder: new FakeEmbedder(8),
      logger,
      now: () => "2026-01-01T00:00:00.000Z",
      mergeBudget: createMergeEmbedBudget(),
      mergeJudge: async () => "human",
    };

    await expect(
      runBatch(
        deps,
        client,
        [
          { id: "chunk-1", content: "Alice works at Acme Corp." },
          { id: "chunk-2", content: "Bob works at Beta Corp." },
          { id: "chunk-3", content: GRAY_CHUNK },
        ],
        { batchSize: 3, sourceRef: "doc-1/1/main" }
      )
    ).rejects.toMatchObject({ failureCode: ENTITY_MERGE_EMBED_LIMIT });

    // The chunk committed before the breach keeps its succeeded record...
    const succeeded = client.queries.filter((q) =>
      q.includes("SET status = 'succeeded'")
    );
    const breach = lines.filter((line) => line.msg === "entity-merge-embed-limit");
    expect(succeeded).toHaveLength(1);
    // ...and the in-flight chunk rolled back rather than sealing a write failure.
    expect(client.indexOf("ROLLBACK")).toBeGreaterThanOrEqual(0);
    // Phase E's sealed failure record survives the breach.
    const failed = client.valuesList[
      client.indexOf("SET status = 'failed'")
    ]!;
    expect(failed).toContain("5xx");

    expect(breach).toHaveLength(1);
    expect(Object.keys(breach[0]!.fields as object).sort()).toEqual([
      "embed_calls",
      "embed_cap",
      "source_ref",
    ]);
    // Spent resolutions are not refunded: the counter still shows what was spent.
    expect(breach[0]?.fields as Record<string, unknown>).toMatchObject({
      embed_calls: (breach[0]?.fields as Record<string, unknown>).embed_cap,
    });
    // No `ceiling` alias, no raw-request counter, and no ledger column for any
    // of it: the only place the cap is persisted is the failure code.
    expect(client.queries.every((q) => !q.includes("embed_cap"))).toBe(true);
  });
});
