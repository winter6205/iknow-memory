/**
 * T1 + T4 (graph-index-standard-fast): the extract-method dispatch seam.
 *
 * `runExtractMethod` is the single routing point between the batch
 * orchestrator and a per-version extract method:
 *   - "standard" delegates to the existing `extractChunk` path unchanged,
 *   - "fast" (unsealed by T4) delegates to the pure NLP co-occurrence
 *     extractor in fast.ts — it never receives the LLM client at all, so a
 *     fast run cannot dial a model.
 *
 * Boundary classes covered here (test.md): normal (both methods route),
 * failure (fast typed failures; no LLM), invalid input (unknown method
 * value), empty input (empty chunk reaches each leg's pre-flight
 * validation), plus the version-spine SQL helpers (`findChunkMethodConflict`,
 * `recordChunkExtractMethod`) which pin the conflict-read / record-write
 * statements the pipeline runs per chunk.
 */
import { describe, it, expect } from "vitest";

import { FakeLLMClient } from "../../src/core/extraction/llm-client.js";
import {
  EXTRACT_METHOD_CONFLICT_CODE,
  InvalidExtractMethodError,
  findChunkMethodConflict,
  isExtractMethod,
  parseExtractMethod,
  recordChunkExtractMethod,
  runExtractMethod,
} from "../../src/core/extraction/method.js";
import { FAST_EMPTY_GRAPH_CODE } from "../../src/core/extraction/fast.js";
import { EMPTY_CHUNK_CODE } from "../../src/core/extraction/extract.js";
import type { ExtractionOutput } from "../../src/core/extraction/types.js";
import type { Queryable } from "../../src/core/extraction/records.js";

const OUTPUT: ExtractionOutput = {
  head: "Alice",
  headType: "person",
  relationRaw: "works at",
  relationNorm: "RELATED_TO",
  tail: "Acme",
  tailType: "system",
  description: "Alice works at Acme",
  evidenceSpan: "Alice works at Acme",
  confidence: 0.9,
};

const chunk = { id: "chunk-1", content: "Alice works at Acme." };

/** Recording fake Queryable; rows keyed off the SQL text + binds. */
class FakeQueryable implements Queryable {
  queries: string[] = [];
  valuesList: unknown[][] = [];
  rowsFor: (text: string, values: unknown[]) => any[] = () => [];

  async query(text: string, values: unknown[] = []) {
    this.queries.push(text);
    this.valuesList.push(values);
    return { rows: this.rowsFor(text, values) };
  }
}

describe("parseExtractMethod / isExtractMethod", () => {
  it("accepts the two vocabulary members verbatim", () => {
    expect(parseExtractMethod("standard")).toBe("standard");
    expect(parseExtractMethod("fast")).toBe("fast");
  });

  it("rejects an unknown method with a typed INVALID_INPUT error", () => {
    const err = ((): unknown => {
      try {
        parseExtractMethod("turbo");
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(err).toBeInstanceOf(InvalidExtractMethodError);
    expect((err as InvalidExtractMethodError).code).toBe("INVALID_INPUT");
    expect((err as Error).message).toContain("turbo");
  });

  it("rejects the empty string (empty-input boundary)", () => {
    expect(() => parseExtractMethod("")).toThrow(InvalidExtractMethodError);
    expect(isExtractMethod("")).toBe(false);
  });

  it("isExtractMethod is false for non-string junk", () => {
    expect(isExtractMethod("Standard")).toBe(false);
    expect(isExtractMethod(null)).toBe(false);
    expect(isExtractMethod(undefined)).toBe(false);
    expect(isExtractMethod(1)).toBe(false);
    expect(isExtractMethod("standard")).toBe(true);
    expect(isExtractMethod("fast")).toBe(true);
  });
});

describe("runExtractMethod — standard leg", () => {
  it("routes to the existing extractChunk path and returns its ok outcome", async () => {
    const llm = new FakeLLMClient({
      queue: [{ kind: "ok", outputs: [OUTPUT] }],
    });
    const result = await runExtractMethod("standard", chunk, { llm });
    expect(result).toEqual({ kind: "ok", outputs: [OUTPUT] });
  });

  it("inherits extractChunk's pre-flight validation (empty chunk → EMPTY_CHUNK, no LLM)", async () => {
    // Empty queue: any LLM call throws "queue exhausted", so a clean
    // EMPTY_CHUNK outcome proves extractChunk's validation ran before the LLM.
    const llm = new FakeLLMClient({ queue: [] });
    const result = await runExtractMethod(
      "standard",
      { id: "chunk-1", content: "   " },
      { llm }
    );
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") throw new Error("narrow");
    expect(result.errorCode).toBe(EMPTY_CHUNK_CODE);
  });
});

describe("runExtractMethod — fast leg (T4, pure NLP)", () => {
  it("routes to the co-occurrence extractor and never touches the LLM", async () => {
    // Poison witness: ANY extract call is counted. The fast leg must not
    // increment it — the seam does not even forward the client downstream.
    let calls = 0;
    const llm = new FakeLLMClient({
      scripted: async () => {
        calls += 1;
        return { kind: "ok", outputs: [OUTPUT] };
      },
    });
    const result = await runExtractMethod(
      "fast",
      { id: "chunk-1", content: "the a Alice Bob" },
      { llm }
    );
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("narrow");
    // stopword-filtered terms alice/bob form exactly one fast edge.
    expect(result.outputs).toHaveLength(1);
    expect(result.outputs[0]).toMatchObject({
      head: "alice",
      tail: "bob",
      relationRaw: "co_occurs_with",
      extractor: "fast",
    });
    expect(calls).toBe(0);
  });

  it("inherits the empty-chunk pre-flight (EMPTY_CHUNK) with no LLM", async () => {
    const llm = new FakeLLMClient({ queue: [] });
    const result = await runExtractMethod(
      "fast",
      { id: "chunk-1", content: "   " },
      { llm }
    );
    expect(result).toMatchObject({
      kind: "failed",
      errorCode: EMPTY_CHUNK_CODE,
    });
  });

  it("an empty Chinese graph is the typed FAST_EMPTY_GRAPH failure, not a silent zero", async () => {
    const llm = new FakeLLMClient({ queue: [] });
    const result = await runExtractMethod(
      "fast",
      { id: "chunk-1", content: "的了 于 与 之" },
      { llm }
    );
    expect(result).toMatchObject({
      kind: "failed",
      errorCode: FAST_EMPTY_GRAPH_CODE,
    });
  });
});

describe("runExtractMethod — invalid method value", () => {
  it("throws InvalidExtractMethodError for runtime junk and never calls the LLM", async () => {
    let calls = 0;
    const llm = new FakeLLMClient({
      scripted: async () => {
        calls += 1;
        return { kind: "ok", outputs: [] };
      },
    });
    await expect(
      runExtractMethod("regex" as never, chunk, { llm })
    ).rejects.toBeInstanceOf(InvalidExtractMethodError);
    expect(calls).toBe(0);
  });
});

describe("findChunkMethodConflict", () => {
  const CONFLICT_SELECT_MARKER = "sd.extract_method";

  it("returns null when the store reports no conflicting row", async () => {
    const client = new FakeQueryable();
    const conflict = await findChunkMethodConflict(
      client,
      "chunk-1",
      "standard"
    );
    expect(conflict).toBeNull();
    expect(client.queries).toHaveLength(1);
    expect(client.queries[0]).toContain(CONFLICT_SELECT_MARKER);
    expect(client.queries[0]).toContain("source_documents");
    expect(client.valuesList[0]).toEqual(["chunk-1", "standard"]);
  });

  it("reports the recorded method when a row conflicts with the request", async () => {
    const client = new FakeQueryable();
    client.rowsFor = () => [{ source_ref: "doc-1", extract_method: "fast" }];
    const conflict = await findChunkMethodConflict(
      client,
      "chunk-1",
      "standard"
    );
    expect(conflict).toEqual({ sourceRef: "doc-1", recorded: "fast" });
  });

  it("ignores rows without a usable extract_method (fake-store noise guard)", async () => {
    // Several existing test fakes answer every `FROM chunks` SELECT with
    // chunk rows; a row that carries no extract_method is not a conflict.
    const client = new FakeQueryable();
    client.rowsFor = () => [{ id: "chunk-1", content: "hello" }];
    const conflict = await findChunkMethodConflict(
      client,
      "chunk-1",
      "standard"
    );
    expect(conflict).toBeNull();
  });
});

describe("recordChunkExtractMethod", () => {
  it("writes the method onto the chunk's 资料 row, guarded against overwrite", async () => {
    const client = new FakeQueryable();
    await recordChunkExtractMethod(client, "chunk-1", "standard");
    expect(client.queries).toHaveLength(1);
    const sql = client.queries[0]!;
    expect(sql).toContain("UPDATE source_documents");
    // The guard is the typed contract: only a NULL or same-method row is
    // written — a conflicting recorded method is never silently replaced.
    expect(sql).toContain("extract_method IS NULL");
    expect(client.valuesList[0]).toEqual(["chunk-1", "standard"]);
  });
});

describe("typed codes", () => {
  it("names the version conflict and the empty-fast failure", () => {
    expect(EXTRACT_METHOD_CONFLICT_CODE).toBe("EXTRACT_METHOD_CONFLICT");
    expect(FAST_EMPTY_GRAPH_CODE).toBe("FAST_EMPTY_GRAPH");
  });
});
