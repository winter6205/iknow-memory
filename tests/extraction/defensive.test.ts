/**
 * T8 defensive contract for `extractChunk` — 5 boundary classes per
 * arthurpower:defensive-contract-validator.
 *
 *   empty      → content="" / whitespace → failed EMPTY_CHUNK, no LLM call
 *   negative   → malformed chunk.id (empty/missing) is NOT validated by
 *                extractChunk; the call proceeds to the LLM. This documents
 *                actual behavior: the LLM client is the only enforcement
 *                point for chunk.id, and extractChunk trusts the orchestrator.
 *   overflow   → content longer than maxContentLength → failed
 *                OVERSIZED_CHUNK, no LLM call
 *   concurrent → two extractChunk calls in parallel on the same chunk both
 *                succeed; LLM sees both calls
 *   exception  → LLM client that REJECTS (throws) — documented as a bug:
 *                extract.ts header comment claims "never throws on an LLM
 *                failure" but the implementation does not wrap
 *                ctx.llm.extract in try/catch, so a throwing client
 *                propagates. The test pins current behavior with a clear
 *                "BUG" comment; the coordinator decides whether to wrap.
 */
import { describe, it, expect, vi } from "vitest";
import {
  extractChunk,
  EMPTY_CHUNK_CODE,
  OVERSIZED_CHUNK_CODE,
  LLM_EXCEPTION_CODE,
} from "../../src/core/extraction/extract.js";
import type { ExtractionOutput } from "../../src/core/extraction/types.js";

const VALID_OUTPUT: ExtractionOutput = {
  head: "Alice",
  headType: "Person",
  relationRaw: "works at",
  relationNorm: "MEMBER_OF",
  tail: "Acme",
  tailType: "Organization",
  description: "Alice works at Acme as an engineer",
  evidenceSpan: "Alice works at Acme",
  confidence: 0.9,
};

describe("extractChunk — empty boundary", () => {
  it("returns failed EMPTY_CHUNK for empty content and skips the LLM", async () => {
    const extract = vi.fn(async () => ({
      kind: "ok",
      outputs: [VALID_OUTPUT],
    }));
    const out = await extractChunk(
      { id: "chunk-empty", content: "" },
      { llm: { extract } }
    );
    expect(out).toEqual({
      kind: "failed",
      errorCode: EMPTY_CHUNK_CODE,
      errorMsg: expect.any(String),
    });
    expect(extract).not.toHaveBeenCalled();
  });

  it("returns failed EMPTY_CHUNK for whitespace-only content", async () => {
    const extract = vi.fn(async () => ({ kind: "ok", outputs: [] }));
    const out = await extractChunk(
      { id: "chunk-ws", content: "   \n\t  " },
      { llm: { extract } }
    );
    expect(out.kind).toBe("failed");
    if (out.kind !== "failed") throw new Error("narrow");
    expect(out.errorCode).toBe(EMPTY_CHUNK_CODE);
    expect(extract).not.toHaveBeenCalled();
  });
});

describe("extractChunk — negative boundary (malformed chunk.id)", () => {
  it("does not validate chunk.id and proceeds to the LLM when id is empty", async () => {
    const extract = vi.fn(async () => ({
      kind: "ok",
      outputs: [VALID_OUTPUT],
    }));
    const out = await extractChunk(
      { id: "", content: "Alice works at Acme" },
      { llm: { extract } }
    );
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") throw new Error("narrow");
    expect(out.outputs).toHaveLength(1);
    expect(extract).toHaveBeenCalledTimes(1);
  });
});

describe("extractChunk — overflow boundary", () => {
  it("returns failed OVERSIZED_CHUNK when content exceeds maxContentLength", async () => {
    const extract = vi.fn(async () => ({ kind: "ok", outputs: [] }));
    const out = await extractChunk(
      { id: "chunk-big", content: "x".repeat(11) },
      { llm: { extract }, maxContentLength: 10 }
    );
    expect(out).toEqual({
      kind: "failed",
      errorCode: OVERSIZED_CHUNK_CODE,
      errorMsg: expect.any(String),
    });
    expect(extract).not.toHaveBeenCalled();
  });

  it("boundary value: content length exactly equal to maxContentLength is allowed", async () => {
    const extract = vi.fn(async () => ({ kind: "ok", outputs: [] }));
    const out = await extractChunk(
      { id: "c-edge", content: "y".repeat(10) },
      { llm: { extract }, maxContentLength: 10 }
    );
    expect(out.kind).toBe("ok");
    expect(extract).toHaveBeenCalledTimes(1);
  });
});

describe("extractChunk — concurrent boundary", () => {
  it("two parallel extractChunk invocations on the same chunk both succeed and the LLM sees both calls in order", async () => {
    const seen: string[] = [];
    const llm = {
      async extract(text: string) {
        seen.push(text);
        return { kind: "ok" as const, outputs: [VALID_OUTPUT] };
      },
    };
    const chunk = { id: "chunk-conc", content: "Alice works at Acme" };
    const [a, b] = await Promise.all([
      extractChunk(chunk, { llm }),
      extractChunk(chunk, { llm }),
    ]);
    expect(a.kind).toBe("ok");
    expect(b.kind).toBe("ok");
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe("Alice works at Acme");
    expect(seen[1]).toBe("Alice works at Acme");
  });
});

describe("extractChunk — exception boundary (LLM client that throws)", () => {
  it("does not throw on an LLM exception; returns a sealed failed outcome with LLM_EXCEPTION so the batch can mark-and-continue", async () => {
    const throwingLlm = {
      extract: async (): Promise<never> => {
        throw new Error("sdk exploded");
      },
    };
    const out = await extractChunk(
      { id: "chunk-throw", content: "some text" },
      { llm: throwingLlm }
    );
    expect(out).toEqual({
      kind: "failed",
      errorCode: LLM_EXCEPTION_CODE,
      errorMsg: expect.any(String),
    });
  });
});
