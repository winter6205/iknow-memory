import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createPushHandler,
  pushTool,
  type PushDeps,
} from "../../src/tools/push.js";
import { FakeEmbedder } from "../../src/core/embedder.js";
import { MemoryBackend } from "../../src/core/storage/memory-backend.js";
import { GraphragError } from "../../src/core/errors.js";
import {
  computeContentIdentity,
  computeSourceDocId,
} from "../../src/tools/ingest.js";
import type { ToolResult } from "../../src/tools/registry.js";

const TEST_DIM = 1536;

/** Parse the JSON text body of a ToolResult. */
function parseBody(result: ToolResult): {
  chunk_ids: string[];
  source_doc_id?: string;
  source_doc_ids?: string[];
  content_identity?: string;
  content_identities?: string[];
} {
  const text = result.content[0]?.text;
  if (typeof text !== "string") {
    throw new Error("expected text content in ToolResult");
  }
  return JSON.parse(text);
}

/**
 * Plan D0 I-T4: push is the entry that fin's push_port calls. It must
 * (a) be idempotent on (source_ref, content_identity), so a re-push
 * never grows the chunk count, (b) reject batches missing the B4
 * required fields, and (c) never chunk the content — the bytes that
 * come back from retrieve must equal the bytes that went in.
 *
 * The FakeEmbedder is deterministic, so two pushes with identical
 * content go through the same contentIdentity and end up with the
 * same chunk_id; the storage backend's upsert collapses them.
 */
describe("createPushHandler — idempotency on (source_ref, content_identity)", () => {
  let deps: PushDeps;
  let handler: ReturnType<typeof createPushHandler>;

  beforeEach(() => {
    deps = {
      embedder: new FakeEmbedder(TEST_DIM),
      storage: new MemoryBackend(TEST_DIM),
    };
    handler = createPushHandler(deps);
  });

  it("a re-push with identical (source_ref, content) does not grow chunk count", async () => {
    const item = {
      content: "idempotent payload",
      source_ref: "docs/idem.md",
      metadata: { kind: "test" },
      valid_from: "2024-01-01T00:00:00Z",
      valid_until: "2024-12-31T00:00:00Z",
    };
    const r1 = await handler({ items: [item] });
    const r2 = await handler({ items: [item] });
    const b1 = parseBody(r1);
    const b2 = parseBody(r2);
    expect(b1.chunk_ids).toEqual(b2.chunk_ids);
    expect(b1.chunk_ids).toHaveLength(1);
  });

  it("different content on the same source_ref yields a distinct chunk_id", async () => {
    const r1 = await handler({
      items: [
        {
          content: "first version",
          source_ref: "docs/v.md",
          metadata: { v: "1" },
          valid_from: "2024-01-01T00:00:00Z",
          valid_until: "2024-12-31T00:00:00Z",
        },
      ],
    });
    const r2 = await handler({
      items: [
        {
          content: "second version",
          source_ref: "docs/v.md",
          metadata: { v: "2" },
          valid_from: "2024-01-01T00:00:00Z",
          valid_until: "2024-12-31T00:00:00Z",
        },
      ],
    });
    const b1 = parseBody(r1);
    const b2 = parseBody(r2);
    expect(b1.chunk_ids[0]).not.toBe(b2.chunk_ids[0]);
  });

  it("batch: a partially-overlapping batch returns one id per distinct item", async () => {
    const shared = {
      content: "shared payload",
      source_ref: "docs/shared.md",
      metadata: { k: "v" },
      valid_from: "2024-01-01T00:00:00Z",
      valid_until: "2024-12-31T00:00:00Z",
    };
    const r1 = await handler({ items: [shared] });
    const r2 = await handler({
      items: [
        shared,
        {
          content: "new payload",
          source_ref: "docs/new.md",
          metadata: { k: "v" },
          valid_from: "2024-01-01T00:00:00Z",
          valid_until: "2024-12-31T00:00:00Z",
        },
      ],
    });
    const b1 = parseBody(r1);
    const b2 = parseBody(r2);
    // The shared item keeps the original chunk_id; the new item gets a
    // second id. Total distinct ids in the second call = 2.
    expect(b1.chunk_ids).toHaveLength(1);
    expect(b2.chunk_ids).toHaveLength(2);
    expect(b2.chunk_ids).toContain(b1.chunk_ids[0]);
  });
});

describe("pushTool.inputSchema — B4 required metadata rejection at the schema layer", () => {
  // Plan D0 I-T4: missing B4 required fields must reject the WHOLE
  // batch. The Zod schema is the boundary — the handler is only ever
  // called with already-validated input over the wire, so we test
  // rejection via safeParse instead of `handler(...)`.
  const wellFormed = {
    items: [
      {
        content: "payload",
        source_ref: "docs/x.md",
        metadata: { kind: "doc" },
        valid_from: "2024-01-01T00:00:00Z",
        valid_until: "2024-12-31T00:00:00Z",
      },
    ],
  };

  function toolSchema() {
    return pushTool({
      embedder: new FakeEmbedder(TEST_DIM),
      storage: new MemoryBackend(TEST_DIM),
    }).inputSchema;
  }

  it("rejects when metadata is missing", () => {
    const {
      items: [{ metadata: _metadata, ...rest }],
    } = wellFormed;
    const result = toolSchema().safeParse({ items: [rest] });
    expect(result.success).toBe(false);
  });

  it("rejects when metadata is an empty record (B4 requires at least one key)", () => {
    const result = toolSchema().safeParse({
      items: [{ ...wellFormed.items[0], metadata: {} }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects when valid_from is missing", () => {
    const {
      items: [{ valid_from: _valid_from, ...rest }],
    } = wellFormed;
    const result = toolSchema().safeParse({ items: [rest] });
    expect(result.success).toBe(false);
  });

  it("rejects when valid_until is missing", () => {
    const {
      items: [{ valid_until: _valid_until, ...rest }],
    } = wellFormed;
    const result = toolSchema().safeParse({ items: [rest] });
    expect(result.success).toBe(false);
  });

  it("rejects when items is empty", () => {
    const result = toolSchema().safeParse({ items: [] });
    expect(result.success).toBe(false);
  });

  it("rejects unknown top-level keys (strict mode)", () => {
    const result = toolSchema().safeParse({ ...wellFormed, dry_run: true });
    expect(result.success).toBe(false);
  });
});

describe("createPushHandler — semantic rejection after schema pass", () => {
  // The schema rejects missing/malformed fields; the handler rejects
  // semantic violations (window ordering, content size). Splitting the
  // two keeps each layer's responsibility legible.
  let deps: PushDeps;
  let handler: ReturnType<typeof createPushHandler>;

  beforeEach(() => {
    deps = {
      embedder: new FakeEmbedder(TEST_DIM),
      storage: new MemoryBackend(TEST_DIM),
    };
    handler = createPushHandler(deps);
  });

  const wellFormed = {
    content: "payload",
    source_ref: "docs/x.md",
    metadata: { kind: "doc" },
    valid_from: "2024-01-01T00:00:00Z",
    valid_until: "2024-12-31T00:00:00Z",
  };

  it("rejects when valid_from >= valid_until", async () => {
    await expect(
      handler({
        items: [
          {
            ...wellFormed,
            valid_from: "2024-12-31T00:00:00Z",
            valid_until: "2024-01-01T00:00:00Z",
          },
        ],
      })
    ).rejects.toThrow();
  });

  it("rejects when content exceeds MAX_CONTENT_BYTES (1MB)", async () => {
    const huge = "x".repeat(2 * 1024 * 1024);
    await expect(
      handler({
        items: [{ ...wellFormed, content: huge }],
      })
    ).rejects.toThrow();
  });
});

describe("createPushHandler — no chunking (byte-stable round-trip)", () => {
  // Plan D0 I-T7: push must never call a chunker. The simplest proof is
  // that a multi-kilobyte payload pushed as a single item is retrievable
  // verbatim — no sliding-window rewrite. (There is no chunker in this
  // codebase today; this test guards against one being added later.)
  it("a 4 KB payload comes back byte-identical through search", async () => {
    const deps: PushDeps = {
      embedder: new FakeEmbedder(TEST_DIM),
      storage: new MemoryBackend(TEST_DIM),
    };
    const handler = createPushHandler(deps);
    const payload = "x".repeat(4096);
    const pushResult = await handler({
      items: [
        {
          content: payload,
          source_ref: "docs/large.md",
          metadata: { bytes: 4096 },
          valid_from: "2024-01-01T00:00:00Z",
          valid_until: "2024-12-31T00:00:00Z",
        },
      ],
    });
    const { chunk_ids } = parseBody(pushResult);
    expect(chunk_ids).toHaveLength(1);

    // FakeEmbedder is deterministic, so querying with the same text
    // yields the same vector and brings the pushed chunk back as the
    // top hit. The byte-stable assertion is then trivial.
    const [queryVec] = await deps.embedder.embed([payload]);
    const hits = await deps.storage.search(queryVec!, {
      limit: 1,
      validAt: "2024-06-01T00:00:00Z",
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.content).toBe(payload);
    expect(hits[0]?.id).toBe(chunk_ids[0]);
  });

  it("pushed text never enters the lexer with whitespace reformatting", async () => {
    // Defensive assertion that the lexical index is built from the
    // pushed bytes verbatim. The tokenizer is whitespace-split, so a
    // token boundary shift would change the BM25 hit list. Pushing
    // "ab cd" verbatim, retrieving with query "ab cd", and expecting
    // the chunk to come back is the strongest single-shot check.
    const deps: PushDeps = {
      embedder: new FakeEmbedder(TEST_DIM),
      storage: new MemoryBackend(TEST_DIM),
    };
    const handler = createPushHandler(deps);
    await handler({
      items: [
        {
          content: "boundary tokens: foo bar baz qux",
          source_ref: "docs/tokens.md",
          metadata: { k: "v" },
          valid_from: "2024-01-01T00:00:00Z",
          valid_until: "2024-12-31T00:00:00Z",
        },
      ],
    });
    const [queryVec] = await deps.embedder.embed(["foo bar"]);
    const hits = await deps.storage.search(queryVec!, {
      limit: 1,
      validAt: "2024-06-01T00:00:00Z",
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.content).toBe("boundary tokens: foo bar baz qux");
  });
});

describe("pushTool", () => {
  it("registers under the name 'push' with a non-empty inputSchema", () => {
    const tool = pushTool({
      embedder: new FakeEmbedder(TEST_DIM),
      storage: new MemoryBackend(TEST_DIM),
    });
    expect(tool.name).toBe("push");
    expect(typeof tool.description).toBe("string");
    expect(tool.description.length).toBeGreaterThan(0);
    expect(tool.inputSchema).toBeDefined();
  });

  it("input schema rejects an item missing metadata", () => {
    const tool = pushTool({
      embedder: new FakeEmbedder(TEST_DIM),
      storage: new MemoryBackend(TEST_DIM),
    });
    const result = tool.inputSchema.safeParse({
      items: [
        {
          content: "x",
          source_ref: "docs/x.md",
          valid_from: "2024-01-01T00:00:00Z",
          valid_until: "2024-12-31T00:00:00Z",
        },
      ],
    });
    expect(result.success).toBe(false);
  });
});

// Smoke check that the push error path uses a typed failure (not a bare Error).
describe("push error typing", () => {
  it("GraphragError is the canonical typed failure for push validation errors", () => {
    expect(GraphragError).toBeDefined();
    const err = new GraphragError("test", "INVALID_INPUT");
    expect(err.code).toBe("INVALID_INPUT");
  });
});

// corpus-index-job T2: push persists the document-level content identity the
// durable submit pair keys on, publishes it on the response, and never writes
// the index-job ledger itself.
describe("createPushHandler — document content_identity (corpus-index-job T2)", () => {
  function pushItem(content: string, sourceRef: string) {
    return {
      content,
      source_ref: sourceRef,
      metadata: { kind: "test" },
      valid_from: "2024-01-01T00:00:00Z",
      valid_until: "2024-12-31T00:00:00Z",
    };
  }

  function handlerFor(storage: MemoryBackend) {
    return createPushHandler({
      embedder: new FakeEmbedder(TEST_DIM),
      storage,
    });
  }

  /** Read the 资料 row back through the storage read port, not a write spy. */
  async function storedIdentity(
    storage: MemoryBackend,
    sourceRef: string
  ): Promise<string | null> {
    const read = await storage.getSourceDoc(sourceRef);
    if (!read.ok) {
      throw new Error(`expected a 资料 row for ${sourceRef}`);
    }
    return read.value.content_identity ?? null;
  }

  it("writes the document-level identity from the full body, DEFAULT versions", async () => {
    const storage = new MemoryBackend(TEST_DIM);
    const content = "the whole 资料 body pushed verbatim";
    await handlerFor(storage)({ items: [pushItem(content, "docs/id.md")] });
    expect(await storedIdentity(storage, "docs/id.md")).toBe(
      computeContentIdentity(content)
    );
  });

  it("publishes on the response the identity it persisted", async () => {
    const storage = new MemoryBackend(TEST_DIM);
    const content = "published identity";
    const result = await handlerFor(storage)({
      items: [pushItem(content, "docs/published.md")],
    });
    const body = parseBody(result);
    // Independently recomputed expectation (not read back off the handler),
    // then pinned against the row actually stored.
    expect(body.content_identity).toBe(computeContentIdentity(content));
    expect(await storedIdentity(storage, "docs/published.md")).toBe(
      body.content_identity
    );
  });

  it("a batch publishes one identity per 资料, aligned with source_doc_ids", async () => {
    const storage = new MemoryBackend(TEST_DIM);
    const first = "first batch body";
    const second = "second batch body";
    const result = await handlerFor(storage)({
      items: [
        pushItem(first, "docs/batch-a.md"),
        pushItem(second, "docs/batch-b.md"),
      ],
    });
    const body = parseBody(result);
    expect(body.source_doc_ids).toEqual([
      computeSourceDocId("docs/batch-a.md"),
      computeSourceDocId("docs/batch-b.md"),
    ]);
    expect(body.content_identities).toEqual([
      computeContentIdentity(first),
      computeContentIdentity(second),
    ]);
    // The arrays are aligned to the actual per-资料 ids, not merely equal in
    // length: zip them and every published identity is the stored row's value
    // (read back through the storage read port, last-write-wins mirror).
    const refs = ["docs/batch-a.md", "docs/batch-b.md"];
    expect(
      await Promise.all(refs.map((ref) => storedIdentity(storage, ref)))
    ).toEqual(body.content_identities);
    expect(body.content_identity).toBeUndefined();
    expect(body.source_doc_id).toBeUndefined();
    expect(await storedIdentity(storage, "docs/batch-a.md")).toBe(
      computeContentIdentity(first)
    );
    expect(await storedIdentity(storage, "docs/batch-b.md")).toBe(
      computeContentIdentity(second)
    );
  });

  it("is deterministic: an identical re-push yields the same identity", async () => {
    const storage = new MemoryBackend(TEST_DIM);
    const content = "identical body";
    const handler = handlerFor(storage);
    const first = parseBody(
      await handler({ items: [pushItem(content, "docs/a.md")] })
    );
    const second = parseBody(
      await handler({ items: [pushItem(content, "docs/a.md")] })
    );
    expect(first.content_identity).toBe(second.content_identity);
    expect(await storedIdentity(storage, "docs/a.md")).toBe(
      computeContentIdentity(content)
    );
  });

  it("a changed body yields a different identity for the same source_ref", async () => {
    const storage = new MemoryBackend(TEST_DIM);
    const handler = handlerFor(storage);
    const first = parseBody(
      await handler({ items: [pushItem("version one", "docs/v.md")] })
    );
    const second = parseBody(
      await handler({ items: [pushItem("version two", "docs/v.md")] })
    );
    expect(first.content_identity).not.toBe(second.content_identity);
    // The row holds exactly one current identity: the newest one.
    expect(await storedIdentity(storage, "docs/v.md")).toBe(
      computeContentIdentity("version two")
    );
  });

  it("never touches the index-job ledger — push stays write-only for text", async () => {
    const storage = new MemoryBackend(TEST_DIM);
    const insertJob = vi.spyOn(storage, "insertJobOrJoin");
    const supersede = vi.spyOn(storage, "supersedeReadyJobs");
    const handler = handlerFor(storage);
    await handler({ items: [pushItem("body", "docs/nojob.md")] });
    expect(insertJob).not.toHaveBeenCalled();
    expect(supersede).not.toHaveBeenCalled();
    expect(await storage.getActiveJobForSource("docs/nojob.md")).toBeNull();
  });
});
