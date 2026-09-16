/**
 * T3 — One push envelope (operator-console T3).
 *
 * Push takes the same envelope as ingest but with stricter metadata
 * (B4: required with at least one key) and stricter valid window
 * (valid_from + valid_until required).
 */
import { describe, expect, it } from "vitest";

import {
  PushInputSchema,
  createPushHandler,
  type PushDeps,
} from "../../src/tools/push.js";
import { FakeEmbedder } from "../../src/core/embedder.js";
import { MemoryBackend } from "../../src/core/storage/memory-backend.js";
import { GraphragError } from "../../src/core/errors.js";

const TEST_DIM = 32;

function makeDeps(): PushDeps {
  return {
    embedder: new FakeEmbedder(TEST_DIM),
    storage: new MemoryBackend(TEST_DIM),
  };
}

describe("PushInputSchema — new envelope", () => {
  it("accepts a one-slice envelope (body equals the only slice)", () => {
    const result = PushInputSchema.safeParse({
      source_ref: "docs/x.md",
      content: "single body",
      chunks: [{ content: "single body", index: 0 }],
      metadata: { kind: "doc" },
      valid_from: "2024-01-01T00:00:00.000Z",
      valid_until: "2024-12-31T00:00:00.000Z",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a multi-slice envelope with monotonic indexes 0..N-1", () => {
    const result = PushInputSchema.safeParse({
      source_ref: "docs/multi.md",
      content: "alpha middle omega",
      chunks: [
        { content: "alpha", index: 0 },
        { content: "middle", index: 1 },
        { content: "omega", index: 2 },
      ],
      metadata: { kind: "doc" },
      valid_from: "2024-01-01T00:00:00.000Z",
      valid_until: "2024-12-31T00:00:00.000Z",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a missing source_ref", () => {
    const result = PushInputSchema.safeParse({
      content: "body",
      chunks: [{ content: "body", index: 0 }],
      metadata: { kind: "doc" },
      valid_from: "2024-01-01T00:00:00.000Z",
      valid_until: "2024-12-31T00:00:00.000Z",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty source_ref", () => {
    const result = PushInputSchema.safeParse({
      source_ref: "",
      content: "body",
      chunks: [{ content: "body", index: 0 }],
      metadata: { kind: "doc" },
      valid_from: "2024-01-01T00:00:00.000Z",
      valid_until: "2024-12-31T00:00:00.000Z",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a missing metadata (B4 required)", () => {
    const result = PushInputSchema.safeParse({
      source_ref: "docs/x.md",
      content: "body",
      chunks: [{ content: "body", index: 0 }],
      valid_from: "2024-01-01T00:00:00.000Z",
      valid_until: "2024-12-31T00:00:00.000Z",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty metadata (B4 requires at least one key)", () => {
    const result = PushInputSchema.safeParse({
      source_ref: "docs/x.md",
      content: "body",
      chunks: [{ content: "body", index: 0 }],
      metadata: {},
      valid_from: "2024-01-01T00:00:00.000Z",
      valid_until: "2024-12-31T00:00:00.000Z",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a missing valid_from", () => {
    const result = PushInputSchema.safeParse({
      source_ref: "docs/x.md",
      content: "body",
      chunks: [{ content: "body", index: 0 }],
      metadata: { k: "v" },
      valid_until: "2024-12-31T00:00:00.000Z",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a missing valid_until", () => {
    const result = PushInputSchema.safeParse({
      source_ref: "docs/x.md",
      content: "body",
      chunks: [{ content: "body", index: 0 }],
      metadata: { k: "v" },
      valid_from: "2024-01-01T00:00:00.000Z",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty chunks array", () => {
    const result = PushInputSchema.safeParse({
      source_ref: "docs/x.md",
      content: "body",
      chunks: [],
      metadata: { k: "v" },
      valid_from: "2024-01-01T00:00:00.000Z",
      valid_until: "2024-12-31T00:00:00.000Z",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a one-slice envelope whose slice text does not equal the body", () => {
    const result = PushInputSchema.safeParse({
      source_ref: "docs/x.md",
      content: "the body",
      chunks: [{ content: "the slice", index: 0 }],
      metadata: { k: "v" },
      valid_from: "2024-01-01T00:00:00.000Z",
      valid_until: "2024-12-31T00:00:00.000Z",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a multi-slice envelope whose slices are not contiguous substrings of the body", () => {
    const result = PushInputSchema.safeParse({
      source_ref: "docs/x.md",
      content: "hello world",
      chunks: [
        { content: "hello", index: 0 },
        { content: "missing", index: 1 },
      ],
      metadata: { k: "v" },
      valid_from: "2024-01-01T00:00:00.000Z",
      valid_until: "2024-12-31T00:00:00.000Z",
    });
    expect(result.success).toBe(false);
  });

  it("rejects any unknown top-level key (strict)", () => {
    const result = PushInputSchema.safeParse({
      source_ref: "docs/x.md",
      content: "body",
      chunks: [{ content: "body", index: 0 }],
      metadata: { k: "v" },
      valid_from: "2024-01-01T00:00:00.000Z",
      valid_until: "2024-12-31T00:00:00.000Z",
      dry_run: true,
    });
    expect(result.success).toBe(false);
  });
});

describe("createPushHandler — new envelope semantics", () => {
  it("stores one 资料 and one chunk for a one-slice envelope", async () => {
    const deps = makeDeps();
    const handler = createPushHandler(deps);
    await handler({
      source_ref: "docs/single.md",
      content: "hello world",
      chunks: [{ content: "hello world", index: 0 }],
      metadata: { kind: "doc" },
      valid_from: "2024-01-01T00:00:00.000Z",
      valid_until: "2024-12-31T00:00:00.000Z",
    });

    const doc = await deps.storage.getSourceDoc("docs/single.md");
    expect(doc.ok).toBe(true);
    if (!doc.ok) throw new Error("expected source doc");
    const chunks = await deps.storage.listChunksBySourceDoc(doc.value.id);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.content).toBe("hello world");
  });

  it("stores one 资料 and N chunks for a multi-slice envelope", async () => {
    const deps = makeDeps();
    const handler = createPushHandler(deps);
    const body = "alpha middle omega";
    await handler({
      source_ref: "docs/multi.md",
      content: body,
      chunks: [
        { content: "alpha", index: 0 },
        { content: "middle", index: 1 },
        { content: "omega", index: 2 },
      ],
      metadata: { kind: "doc" },
      valid_from: "2024-01-01T00:00:00.000Z",
      valid_until: "2024-12-31T00:00:00.000Z",
    });

    const doc = await deps.storage.getSourceDoc("docs/multi.md");
    expect(doc.ok).toBe(true);
    if (!doc.ok) throw new Error("expected source doc");
    const chunks = await deps.storage.listChunksBySourceDoc(doc.value.id);
    expect(chunks).toHaveLength(3);
    expect(chunks.map((c) => c.ordinal)).toEqual([0, 1, 2]);
  });

  it("re-pushing the same source_ref with different slices rebuilds chunks without growing 资料 rows", async () => {
    const deps = makeDeps();
    const handler = createPushHandler(deps);
    const meta = { kind: "doc" };

    await handler({
      source_ref: "docs/repush.md",
      content: "alpha beta",
      chunks: [
        { content: "alpha", index: 0 },
        { content: "beta", index: 1 },
      ],
      metadata: meta,
      valid_from: "2024-01-01T00:00:00.000Z",
      valid_until: "2024-12-31T00:00:00.000Z",
    });
    const doc1 = await deps.storage.getSourceDoc("docs/repush.md");
    expect(doc1.ok).toBe(true);
    if (!doc1.ok) throw new Error("expected source doc");

    await handler({
      source_ref: "docs/repush.md",
      content: "gamma delta",
      chunks: [
        { content: "gamma", index: 0 },
        { content: "delta", index: 1 },
      ],
      metadata: meta,
      valid_from: "2024-01-01T00:00:00.000Z",
      valid_until: "2024-12-31T00:00:00.000Z",
    });
    const doc2 = await deps.storage.getSourceDoc("docs/repush.md");
    expect(doc2.ok).toBe(true);
    if (!doc2.ok) throw new Error("expected source doc");
    expect(doc2.value.id).toBe(doc1.value.id);

    const chunks = await deps.storage.listChunksBySourceDoc(doc2.value.id);
    expect(chunks).toHaveLength(2);
    expect(chunks.map((c) => c.content)).toEqual(["gamma", "delta"]);
  });

  it("idempotent re-push returns the same chunk ids and grows no rows", async () => {
    const deps = makeDeps();
    const handler = createPushHandler(deps);
    const envelope = {
      source_ref: "docs/idem.md",
      content: "alpha beta",
      chunks: [
        { content: "alpha", index: 0 },
        { content: "beta", index: 1 },
      ],
      metadata: { kind: "doc" },
      valid_from: "2024-01-01T00:00:00.000Z",
      valid_until: "2024-12-31T00:00:00.000Z",
    };

    const r1 = await handler(envelope);
    const r2 = await handler(envelope);
    const b1 = JSON.parse(r1.content[0]!.text!) as { chunk_ids: string[] };
    const b2 = JSON.parse(r2.content[0]!.text!) as { chunk_ids: string[] };
    expect(b2.chunk_ids).toEqual(b1.chunk_ids);
    expect(b2.chunk_ids).toHaveLength(2);

    const doc = await deps.storage.getSourceDoc("docs/idem.md");
    expect(doc.ok).toBe(true);
    if (!doc.ok) throw new Error("expected source doc");
    const chunks = await deps.storage.listChunksBySourceDoc(doc.value.id);
    expect(chunks).toHaveLength(2);
  });

  it("rejects chunk overflow 1MB with CONTENT_TOO_LARGE", async () => {
    const deps = makeDeps();
    const handler = createPushHandler(deps);
    const huge = "x".repeat(1_048_577);
    await expect(
      handler({
        source_ref: "docs/big.md",
        content: "prefix " + huge + " suffix",
        chunks: [
          { content: "prefix", index: 0 },
          { content: huge, index: 1 },
          { content: "suffix", index: 2 },
        ],
        metadata: { kind: "doc" },
        valid_from: "2024-01-01T00:00:00.000Z",
        valid_until: "2024-12-31T00:00:00.000Z",
      })
    ).rejects.toBeInstanceOf(GraphragError);
  });

  it("rejects when valid_from >= valid_until", async () => {
    const deps = makeDeps();
    const handler = createPushHandler(deps);
    await expect(
      handler({
        source_ref: "docs/x.md",
        content: "body",
        chunks: [{ content: "body", index: 0 }],
        metadata: { kind: "doc" },
        valid_from: "2024-12-31T00:00:00.000Z",
        valid_until: "2024-01-01T00:00:00.000Z",
      })
    ).rejects.toBeInstanceOf(GraphragError);
  });
});

/**
 * The handler-side `validatePushEnvelope` is defense in depth behind the
 * Zod refine: it re-walks the fin freeze invariant so a future schema
 * regression that loosens the rule is still refused server-side. These
 * call the handler directly, bypassing `inputSchema`, which is exactly the
 * regression they defend against.
 */
describe("createPushHandler — slice invariants enforced behind the schema", () => {
  function envelope(overrides: {
    content: string;
    chunks: Array<{ content: string; index: number }>;
  }): Parameters<ReturnType<typeof createPushHandler>>[0] {
    return {
      source_ref: "docs/x.md",
      content: overrides.content,
      chunks: overrides.chunks,
      metadata: { kind: "doc" },
      valid_from: "2024-01-01T00:00:00.000Z",
      valid_until: "2024-12-31T00:00:00.000Z",
    };
  }

  it("refuses a non-dense index with the same wording the schema uses", async () => {
    const deps = makeDeps();
    const handler = createPushHandler(deps);
    await expect(
      handler(
        envelope({
          content: "abcdef",
          chunks: [
            { content: "abc", index: 0 },
            { content: "def", index: 2 },
          ],
        })
      )
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message:
        "push: chunks[].index must be dense 0..1 (got 2 at position 1)",
    });
  });

  it("refuses a non-contiguous slice with the same wording the schema uses", async () => {
    const deps = makeDeps();
    const handler = createPushHandler(deps);
    await expect(
      handler(
        envelope({
          content: "hello world",
          chunks: [
            { content: "hello", index: 0 },
            { content: "missing", index: 1 },
          ],
        })
      )
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message:
        "push: chunks[1] is not a contiguous substring of content",
    });
  });

  it("refuses a one-slice mismatch with the same wording the schema uses", async () => {
    // The slice must be IN the body for this to reach the one-slice rule: a
    // slice that is absent entirely trips the contiguous check first.
    const deps = makeDeps();
    const handler = createPushHandler(deps);
    await expect(
      handler(
        envelope({
          content: "hello world",
          chunks: [{ content: "hello", index: 0 }],
        })
      )
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message:
        "push: one-slice envelope requires chunk content to equal body",
    });
  });

  it("prefers CONTENT_TOO_LARGE over the structural invariants", async () => {
    // Precedence contract: an oversized slice reports the retryable size
    // refusal even when the slice list is ALSO structurally invalid, so a
    // caller never sees INVALID_INPUT for a body it could have shrunk.
    const deps = makeDeps();
    const handler = createPushHandler(deps);
    const huge = "x".repeat(1_048_577);
    await expect(
      handler(
        envelope({
          content: huge,
          chunks: [
            { content: "not-in-the-body", index: 0 },
            { content: huge, index: 1 },
          ],
        })
      )
    ).rejects.toMatchObject({ code: "CONTENT_TOO_LARGE" });
  });
});
