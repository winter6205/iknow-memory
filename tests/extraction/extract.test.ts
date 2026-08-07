import { describe, it, expect, vi } from "vitest";
import { FakeLLMClient } from "../../src/core/extraction/llm-client.js";
import {
  extractChunk,
  EMPTY_CHUNK_CODE,
  OVERSIZED_CHUNK_CODE,
} from "../../src/core/extraction/extract.js";
import type { ExtractionOutput } from "../../src/core/extraction/types.js";

function makeOutput(
  overrides: Partial<ExtractionOutput> = {}
): ExtractionOutput {
  return {
    head: "Alice",
    headType: "Person",
    relationRaw: "works at",
    relationNorm: "works_for",
    tail: "Acme",
    tailType: "Organization",
    description: "Alice works at Acme as a senior engineer.",
    evidenceSpan: "Alice works at Acme",
    confidence: 0.92,
    ...overrides,
  };
}

const chunk = { id: "chunk-1", content: "Alice works at Acme." };

describe("extractChunk", () => {
  it("happy path: returns {kind:'ok'} with the LLM outputs", async () => {
    const outputs = [makeOutput(), makeOutput({ head: "Bob", tail: "Beta" })];
    const llm = new FakeLLMClient({ queue: [{ kind: "ok", outputs }] });
    const result = await extractChunk(chunk, { llm });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("narrow");
    expect(result.outputs).toHaveLength(2);
  });

  it("empty chunk content → failed EMPTY_CHUNK, no LLM call", async () => {
    const extract = vi.fn(async () => ({ kind: "ok", outputs: [] }));
    const llm = { extract };
    const result = await extractChunk(
      { id: "c", content: "   \n\t " },
      { llm }
    );
    expect(result).toEqual({
      kind: "failed",
      errorCode: EMPTY_CHUNK_CODE,
      errorMsg: expect.any(String),
    });
    expect(extract).not.toHaveBeenCalled();
  });

  it("oversized chunk → failed OVERSIZED_CHUNK, no LLM call", async () => {
    const extract = vi.fn(async () => ({ kind: "ok", outputs: [] }));
    const llm = { extract };
    const long = "a".repeat(50_000);
    const result = await extractChunk(
      { id: "c", content: long },
      { llm, maxContentLength: 1000 }
    );
    expect(result).toEqual({
      kind: "failed",
      errorCode: OVERSIZED_CHUNK_CODE,
      errorMsg: expect.any(String),
    });
    expect(extract).not.toHaveBeenCalled();
  });

  it("5xx → failed outcome carrying the retry-class code, no retry", async () => {
    const extract = vi.fn(async () => ({
      kind: "5xx",
      message: "upstream 500",
    }));
    const llm = { extract };
    const result = await extractChunk(chunk, { llm });
    expect(result).toEqual({
      kind: "failed",
      errorCode: "5xx",
      errorMsg: "upstream 500",
    });
    // extractChunk itself does not retry — a single logical call.
    expect(extract).toHaveBeenCalledTimes(1);
  });

  it("4xx → failed outcome carrying the retry-class code, no retry", async () => {
    const extract = vi.fn(async () => ({
      kind: "4xx",
      message: "bad request",
    }));
    const llm = { extract };
    const result = await extractChunk(chunk, { llm });
    expect(result).toEqual({
      kind: "failed",
      errorCode: "4xx",
      errorMsg: "bad request",
    });
    expect(extract).toHaveBeenCalledTimes(1);
  });

  it("format → failed outcome carrying the retry-class code, no retry", async () => {
    const extract = vi.fn(async () => ({
      kind: "format",
      message: "bad json",
    }));
    const llm = { extract };
    const result = await extractChunk(chunk, { llm });
    expect(result).toEqual({
      kind: "failed",
      errorCode: "format",
      errorMsg: "bad json",
    });
    expect(extract).toHaveBeenCalledTimes(1);
  });

  it("never throws on an LLM failure so the batch may proceed (mark-and-continue)", async () => {
    const llm = new FakeLLMClient({
      queue: [
        { kind: "5xx", message: "boom" },
        { kind: "ok", outputs: [makeOutput()] },
      ],
    });
    const failed = await extractChunk(chunk, { llm });
    expect(failed.kind).toBe("failed");
    const ok = await extractChunk(chunk, { llm });
    expect(ok.kind).toBe("ok");
  });
});
