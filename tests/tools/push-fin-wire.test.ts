/**
 * T2 (corpus-ready retrieve) — fin's REAL wire.
 *
 * fin's `mcp_push_port._to_push_item` sends:
 *   { items: [{ content: <body>, source_ref, chunks: [{index, content}],
 *               metadata: {fmt, doc_type, section, source_sha256,
 *                          parse_rule_version, params_table_version},
 *               valid_from: <now>, valid_until: "9999-12-31T23:59:59.999Z" }] }
 *
 * i.e. the batch `items[]` arm carrying a per-item `chunks[]` slice list.
 * Before this ticket the items schema was `z.object` (strips unknown keys):
 * `chunks` was silently dropped, the whole body was stored as ONE chunk,
 * and the response carried 1 chunk_id for N pushed slices — which fin's
 * `_chunk_ids_of` rejects with `PushProtocolError`. With a single slice the
 * bug is invisible, which is why the pre-existing 1-slice live tests pass.
 */
import { describe, expect, it } from "vitest";

import {
  createPushHandler,
  pushTool,
  type PushDeps,
} from "../../src/tools/push.js";
import { createRetrieveHandler } from "../../src/tools/retrieve.js";
import { FakeEmbedder } from "../../src/core/embedder.js";
import { MemoryBackend } from "../../src/core/storage/memory-backend.js";
import type { ToolResult } from "../../src/tools/registry.js";

const TEST_DIM = 32;

/** fin's mandatory metadata pre-screen (PushMetadataIncompleteError otherwise). */
function finMetadata(): Record<string, unknown> {
  return {
    fmt: "md",
    doc_type: "spec",
    section: "retrieve",
    source_sha256: "0".repeat(64),
    parse_rule_version: "1",
    params_table_version: "1",
  };
}

function finItem(
  sourceRef: string,
  body: string,
  slices: Array<{ index: number; content: string }>
): Record<string, unknown> {
  return {
    content: body,
    source_ref: sourceRef,
    chunks: slices,
    metadata: finMetadata(),
    valid_from: new Date().toISOString(),
    valid_until: "9999-12-31T23:59:59.999Z",
  };
}

function makeDeps(): PushDeps & {
  storage: MemoryBackend;
  embedder: FakeEmbedder;
} {
  return {
    embedder: new FakeEmbedder(TEST_DIM),
    storage: new MemoryBackend(TEST_DIM),
  };
}

function parseBody(result: ToolResult): {
  chunk_ids: string[];
  source_doc_id?: string;
} {
  const text = result.content[0]?.text;
  if (typeof text !== "string") {
    throw new Error("expected text content in ToolResult");
  }
  return JSON.parse(text);
}

const BODY = "alpha middle omega";
const SLICES = [
  { index: 0, content: "alpha" },
  { index: 1, content: "middle" },
  { index: 2, content: "omega" },
];

describe("push items[] arm — fin's per-item chunks[] wire", () => {
  it("accepts the wire and returns one chunk_id per slice", async () => {
    const deps = makeDeps();
    const handler = createPushHandler(deps);
    const result = await handler({
      items: [finItem("docs/fin.md", BODY, SLICES)],
    });
    const body = parseBody(result);
    expect(body.chunk_ids).toHaveLength(3);
    expect(typeof body.source_doc_id).toBe("string");
  });

  it("persists N chunk rows with ordinals 0..N-1 under ONE source_ref", async () => {
    const deps = makeDeps();
    const handler = createPushHandler(deps);
    await handler({ items: [finItem("docs/fin.md", BODY, SLICES)] });

    const doc = await deps.storage.getSourceDoc("docs/fin.md");
    expect(doc.ok).toBe(true);
    if (!doc.ok) throw new Error("expected source doc");
    const chunks = await deps.storage.listChunksBySourceDoc(doc.value.id);
    expect(chunks).toHaveLength(3);
    expect(chunks.map((c) => c.ordinal)).toEqual([0, 1, 2]);
    expect(chunks.map((c) => c.content)).toEqual(["alpha", "middle", "omega"]);
    // No 资料 row accumulation: one source_ref ⇒ one 资料.
    const listed = await deps.storage.listSourceDocs({ limit: 50, offset: 0 });
    expect(listed.items).toHaveLength(1);
    expect(listed.total).toBe(1);
  });

  it("retrieve returns every slice byte-identically with source_ref intact", async () => {
    const deps = makeDeps();
    const push = createPushHandler(deps);
    await push({ items: [finItem("docs/fin.md", BODY, SLICES)] });

    const retrieve = createRetrieveHandler({
      embedder: deps.embedder,
      storage: deps.storage,
    });
    const result = await retrieve({ query: "middle" });
    const body = JSON.parse(result.content[0]!.text!) as {
      chunks: Array<{ content: string; source_ref: string }>;
    };
    expect(body.chunks.length).toBeGreaterThanOrEqual(1);
    const texts = body.chunks.map((c) => c.content);
    expect(texts).toContain("middle");
    for (const chunk of body.chunks) {
      expect(chunk.source_ref).toBe("docs/fin.md");
      // Byte-identity: the stored slice equals the pushed slice.
      const pushed = SLICES.find((s) => s.content === chunk.content);
      expect(pushed).toBeDefined();
      expect(
        Buffer.compare(
          Buffer.from(chunk.content, "utf8"),
          Buffer.from(pushed!.content, "utf8")
        )
      ).toBe(0);
    }
  });

  it("keeps the pure-legacy item (no chunks) as a one-slice envelope", async () => {
    const deps = makeDeps();
    const handler = createPushHandler(deps);
    const item = finItem("docs/legacy.md", "whole body", []);
    delete item.chunks;
    const result = await handler({ items: [item] });
    const body = parseBody(result);
    expect(body.chunk_ids).toHaveLength(1);

    const doc = await deps.storage.getSourceDoc("docs/legacy.md");
    if (!doc.ok) throw new Error("expected source doc");
    const chunks = await deps.storage.listChunksBySourceDoc(doc.value.id);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.content).toBe("whole body");
    expect(chunks[0]?.ordinal).toBe(0);
  });

  it("returns ids in slice order across a mixed batch", async () => {
    const deps = makeDeps();
    const handler = createPushHandler(deps);
    const solo = finItem("docs/mixed-b.md", "solo body", []);
    delete solo.chunks; // pure-legacy item: no chunks[] key at all
    const result = await handler({
      items: [
        finItem("docs/mixed-a.md", "one two", [
          { index: 0, content: "one" },
          { index: 1, content: "two" },
        ]),
        solo,
        finItem("docs/mixed-c.md", "x y z", [
          { index: 0, content: "x" },
          { index: 1, content: "y" },
          { index: 2, content: "z" },
        ]),
      ],
    });
    const body = parseBody(result);
    expect(body.chunk_ids).toHaveLength(6);

    const docC = await deps.storage.getSourceDoc("docs/mixed-c.md");
    if (!docC.ok) throw new Error("expected source doc");
    const chunksC = await deps.storage.listChunksBySourceDoc(docC.value.id);
    expect(chunksC.map((c) => c.id)).toEqual(body.chunk_ids.slice(3));
  });

  it("is idempotent: an identical re-push returns the same ids and grows no rows", async () => {
    const deps = makeDeps();
    const handler = createPushHandler(deps);
    const wire = { items: [finItem("docs/fin.md", BODY, SLICES)] };
    const r1 = parseBody(await handler(structuredClone(wire)));
    const r2 = parseBody(await handler(structuredClone(wire)));
    expect(r2.chunk_ids).toEqual(r1.chunk_ids);

    const doc = await deps.storage.getSourceDoc("docs/fin.md");
    if (!doc.ok) throw new Error("expected source doc");
    const chunks = await deps.storage.listChunksBySourceDoc(doc.value.id);
    expect(chunks).toHaveLength(3);
  });

  it("collapses slices with identical text onto one row (content-id scheme)", async () => {
    // The chunk id is derived from (source_ref, content_identity), so two
    // slices carrying the SAME text are the same chunk: `upsert` merges
    // them into one row and returns the same id twice. The response stays
    // one id per slice — fin's `block_ids` is parallel to the slice list
    // (mcp_push_port.py) — but the ROW count is the number of DISTINCT
    // slices, not the slice count. Pinned so the difference is explicit.
    const deps = makeDeps();
    const handler = createPushHandler(deps);
    const result = await handler({
      items: [
        finItem("docs/dup.md", "aa", [
          { index: 0, content: "a" },
          { index: 1, content: "a" },
        ]),
      ],
    });
    const body = parseBody(result);
    const ids = body.chunk_ids as string[];
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);

    const doc = await deps.storage.getSourceDoc("docs/dup.md");
    if (!doc.ok) throw new Error("expected source doc");
    const chunks = await deps.storage.listChunksBySourceDoc(doc.value.id);
    expect(chunks).toHaveLength(1);
    expect(doc.value.chunk_count).toBe(1);
  });

  it("rebuilds chunk rows on a re-push with a different slice set", async () => {
    const deps = makeDeps();
    const handler = createPushHandler(deps);
    await handler({ items: [finItem("docs/fin.md", BODY, SLICES)] });
    await handler({
      items: [
        finItem("docs/fin.md", "gamma delta", [
          { index: 0, content: "gamma" },
          { index: 1, content: "delta" },
        ]),
      ],
    });

    const doc = await deps.storage.getSourceDoc("docs/fin.md");
    if (!doc.ok) throw new Error("expected source doc");
    const chunks = await deps.storage.listChunksBySourceDoc(doc.value.id);
    expect(chunks).toHaveLength(2);
    expect(chunks.map((c) => c.content)).toEqual(["gamma", "delta"]);
  });
});

describe("push items[] arm — invariants preserved on the per-item chunks[] wire", () => {
  function reject(items: unknown[]): boolean {
    return pushTool({
      embedder: new FakeEmbedder(TEST_DIM),
      storage: new MemoryBackend(TEST_DIM),
    }).inputSchema.safeParse({ items }).success;
  }

  it("rejects non-dense indexes (gap)", () => {
    expect(
      reject([
        finItem("docs/x.md", "abcdef", [
          { index: 0, content: "abc" },
          { index: 2, content: "def" },
        ]),
      ])
    ).toBe(false);
  });

  it("rejects duplicate indexes", () => {
    expect(
      reject([
        finItem("docs/x.md", "abcdef", [
          { index: 0, content: "abc" },
          { index: 0, content: "def" },
        ]),
      ])
    ).toBe(false);
  });

  it("rejects a one-slice item whose slice differs from the body", () => {
    expect(
      reject([
        finItem("docs/x.md", "the body", [{ index: 0, content: "the slice" }]),
      ])
    ).toBe(false);
  });

  it("rejects slices that are not contiguous substrings of the body", () => {
    expect(
      reject([
        finItem("docs/x.md", "hello world", [
          { index: 0, content: "hello" },
          { index: 1, content: "missing" },
        ]),
      ])
    ).toBe(false);
  });

  it("rejects an empty chunks array on an item", () => {
    expect(reject([finItem("docs/x.md", "body", [])])).toBe(false);
  });
});

describe("push items[] arm — semantic rejections after schema pass", () => {
  it("rejects a slice over 1MB with CONTENT_TOO_LARGE", async () => {
    const deps = makeDeps();
    const handler = createPushHandler(deps);
    const huge = "x".repeat(1_048_577);
    await expect(
      handler({
        items: [
          finItem("docs/big.md", "prefix " + huge + " suffix", [
            { index: 0, content: "prefix" },
            { index: 1, content: huge },
            { index: 2, content: "suffix" },
          ]),
        ],
      })
    ).rejects.toMatchObject({ code: "CONTENT_TOO_LARGE" });
  });

  it("rejects valid_from >= valid_until", async () => {
    const deps = makeDeps();
    const handler = createPushHandler(deps);
    const item = finItem("docs/x.md", BODY, SLICES);
    item.valid_from = "2024-12-31T00:00:00.000Z";
    item.valid_until = "2024-01-01T00:00:00.000Z";
    await expect(handler({ items: [item] })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });
});
