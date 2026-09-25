/**
 * T3 — One ingest/push envelope (operator-console T3).
 *
 * The new envelope is:
 *   { source_ref, content: <资料 body>, chunks: [{ content, index }], ...optional }
 *
 * These tests pin the new wire shape: schema validation, one-slice ingest,
 * multi-slice ingest, missing-source_ref rejection, overflow 1MB reject,
 * substring invariant, the source_doc_id + ordinal back-pointer contract,
 * and the re-push rebuild semantics.
 */
import { describe, expect, it } from "vitest";

import {
  computeContentIdentity,
  computeSourceDocId,
  IngestInputSchema,
  createIngestHandler,
  type IngestDeps,
} from "../../src/tools/ingest.js";
import { createPushHandler } from "../../src/tools/push.js";
import { FakeEmbedder } from "../../src/core/embedder.js";
import { GraphragError } from "../../src/core/errors.js";
import { MemoryBackend } from "../../src/core/storage/memory-backend.js";
import type {
  StorageReadResult,
  StorageSourceDocView,
} from "../../src/core/types.js";

const TEST_DIM = 32;

function makeDeps(): IngestDeps & {
  storage: MemoryBackend;
  embedder: FakeEmbedder;
} {
  return {
    embedder: new FakeEmbedder(TEST_DIM),
    storage: new MemoryBackend(TEST_DIM),
  };
}

describe("IngestInputSchema — new envelope", () => {
  it("accepts a one-slice envelope (body equals the only slice)", () => {
    const result = IngestInputSchema.safeParse({
      source_ref: "docs/x.md",
      content: "single body",
      chunks: [{ content: "single body", index: 0 }],
    });
    expect(result.success).toBe(true);
  });

  it("accepts a multi-slice envelope with monotonic indexes 0..N-1", () => {
    const body = "alpha middle omega";
    const result = IngestInputSchema.safeParse({
      source_ref: "docs/multi.md",
      content: body,
      chunks: [
        { content: "alpha", index: 0 },
        { content: "middle", index: 1 },
        { content: "omega", index: 2 },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a missing source_ref", () => {
    const result = IngestInputSchema.safeParse({
      content: "body",
      chunks: [{ content: "body", index: 0 }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty source_ref", () => {
    const result = IngestInputSchema.safeParse({
      source_ref: "",
      content: "body",
      chunks: [{ content: "body", index: 0 }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a missing content body", () => {
    const result = IngestInputSchema.safeParse({
      source_ref: "docs/x.md",
      chunks: [{ content: "x", index: 0 }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a missing chunks array in the new envelope (no legacy fallback shape)", () => {
    // Without `chunks` AND with `content: <string>` the schema falls
    // back to the legacy single path (backward-compat per the design
    // guidance). To exercise the new envelope's required `chunks`, we
    // disambiguate via the new envelope branch by sending an empty
    // chunks array; that fails schema validation.
    const result = IngestInputSchema.safeParse({
      source_ref: "docs/x.md",
      content: "body",
      chunks: [],
    });
    expect(result.success).toBe(false);
  });

  it("accepts the legacy single-content shape as a one-slice envelope (backward compat)", () => {
    // The design guidance keeps the legacy shape valid: a call without
    // `chunks` is treated as a one-slice envelope (body = content,
    // chunks = [{ content, index: 0 }]). Old fin push_port calls go
    // through this path during the migration window.
    const result = IngestInputSchema.safeParse({
      source_ref: "docs/x.md",
      content: "single body",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a chunk whose index is not monotonic 0..N-1 (gap)", () => {
    const result = IngestInputSchema.safeParse({
      source_ref: "docs/x.md",
      content: "abcdef",
      chunks: [
        { content: "abc", index: 0 },
        { content: "def", index: 2 },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a chunk whose index is not monotonic 0..N-1 (duplicate)", () => {
    const result = IngestInputSchema.safeParse({
      source_ref: "docs/x.md",
      content: "abcdef",
      chunks: [
        { content: "abc", index: 0 },
        { content: "def", index: 0 },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a one-slice envelope whose slice text does not equal the body", () => {
    const result = IngestInputSchema.safeParse({
      source_ref: "docs/x.md",
      content: "the body",
      chunks: [{ content: "the slice", index: 0 }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a multi-slice envelope whose slices are not contiguous substrings of the body", () => {
    const result = IngestInputSchema.safeParse({
      source_ref: "docs/x.md",
      content: "hello world",
      chunks: [
        { content: "hello", index: 0 },
        { content: "missing", index: 1 },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects any unknown top-level key (strict)", () => {
    const result = IngestInputSchema.safeParse({
      source_ref: "docs/x.md",
      content: "body",
      chunks: [{ content: "body", index: 0 }],
      force: true,
    });
    expect(result.success).toBe(false);
  });
});

describe("createIngestHandler — one-slice envelope", () => {
  it("stores exactly one 资料 row and one chunk row", async () => {
    const deps = makeDeps();
    const handler = createIngestHandler(deps);
    await handler({
      source_ref: "docs/single.md",
      content: "hello world",
      chunks: [{ content: "hello world", index: 0 }],
    });

    const docResult = await deps.storage.getSourceDoc("docs/single.md");
    expect(docResult.ok).toBe(true);
    if (!docResult.ok) throw new Error("expected source doc");
    expect(docResult.value.content).toBe("hello world");
    expect(docResult.value.source_ref).toBe("docs/single.md");

    const chunks = await deps.storage.listChunksBySourceDoc(docResult.value.id);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.content).toBe("hello world");
    expect(chunks[0]?.ordinal).toBe(0);
    expect(chunks[0]?.source_doc_id).toBe(docResult.value.id);
  });

  it("returns one chunk_id and a source_doc_id", async () => {
    const deps = makeDeps();
    const handler = createIngestHandler(deps);
    const result = await handler({
      source_ref: "docs/single.md",
      content: "hello world",
      chunks: [{ content: "hello world", index: 0 }],
    });
    const body = JSON.parse(result.content[0]!.text!) as {
      chunk_ids: string[];
      source_doc_id?: string;
    };
    expect(body.chunk_ids).toHaveLength(1);
    expect(typeof body.source_doc_id).toBe("string");
  });

  it("retrieves the slice byte-identically (no concatenated-body hit)", async () => {
    const deps = makeDeps();
    const handler = createIngestHandler(deps);
    const slice = "你好，世界！\r\n\t第二行\n\n结尾  ";
    await handler({
      source_ref: "docs/cjk.md",
      content: slice,
      chunks: [{ content: slice, index: 0 }],
    });

    const [vec] = await deps.embedder.embed([slice]);
    const hits = await deps.storage.search(vec!, {
      limit: 10,
      validAt: "2099-01-01T00:00:00.000Z",
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.content).toBe(slice);
  });
});

describe("createIngestHandler — multi-slice envelope", () => {
  it("stores one 资料 and N chunks with ordinals 0..N-1", async () => {
    const deps = makeDeps();
    const handler = createIngestHandler(deps);
    const body = "alpha middle omega";
    await handler({
      source_ref: "docs/multi.md",
      content: body,
      chunks: [
        { content: "alpha", index: 0 },
        { content: "middle", index: 1 },
        { content: "omega", index: 2 },
      ],
    });

    const docResult = await deps.storage.getSourceDoc("docs/multi.md");
    expect(docResult.ok).toBe(true);
    if (!docResult.ok) throw new Error("expected source doc");
    const chunks = await deps.storage.listChunksBySourceDoc(docResult.value.id);
    expect(chunks).toHaveLength(3);
    expect(chunks.map((c) => c.ordinal)).toEqual([0, 1, 2]);
    expect(chunks.map((c) => c.content)).toEqual(["alpha", "middle", "omega"]);
  });

  it("retrieve never returns the concatenated body as one hit", async () => {
    const deps = makeDeps();
    const handler = createIngestHandler(deps);
    const body = "alpha middle omega";
    await handler({
      source_ref: "docs/multi.md",
      content: body,
      chunks: [
        { content: "alpha", index: 0 },
        { content: "middle", index: 1 },
        { content: "omega", index: 2 },
      ],
    });

    // Embed the body itself and search — the body was NOT stored as a chunk,
    // so cosine to the closest slice should be low (FakeEmbedder is
    // deterministic but produces a distinct vector for distinct inputs).
    const [bodyVec] = await deps.embedder.embed([body]);
    const hits = await deps.storage.search(bodyVec!, {
      limit: 10,
      validAt: "2099-01-01T00:00:00.000Z",
      filters: { source_ref: "docs/multi.md" },
    });
    expect(hits).toHaveLength(3);
    // No hit has the full body content.
    for (const hit of hits) {
      expect(hit.content).not.toBe(body);
    }
    expect(hits.map((h) => h.content).sort()).toEqual([
      "alpha",
      "middle",
      "omega",
    ]);
  });
});

describe("createIngestHandler — chunk overflow 1MB refuse", () => {
  it("rejects a chunk whose content exceeds 1MB with CONTENT_TOO_LARGE", async () => {
    const deps = makeDeps();
    const handler = createIngestHandler(deps);
    const huge = "x".repeat(1_048_577); // MAX_CONTENT_BYTES + 1
    await expect(
      handler({
        source_ref: "docs/big.md",
        content: "prefix " + huge + " suffix",
        chunks: [
          { content: "prefix", index: 0 },
          { content: huge, index: 1 },
          { content: "suffix", index: 2 },
        ],
      })
    ).rejects.toMatchObject({ code: "CONTENT_TOO_LARGE" });
  });
});

describe("createIngestHandler — re-push rebuilds chunks", () => {
  it("re-pushing the same source_ref with different slices rebuilds chunks (no duplicate 资料)", async () => {
    const deps = makeDeps();
    const handler = createIngestHandler(deps);

    await handler({
      source_ref: "docs/repush.md",
      content: "alpha beta",
      chunks: [
        { content: "alpha", index: 0 },
        { content: "beta", index: 1 },
      ],
    });
    const firstDoc = await deps.storage.getSourceDoc("docs/repush.md");
    expect(firstDoc.ok).toBe(true);
    if (!firstDoc.ok) throw new Error("expected source doc");
    const firstId = firstDoc.value.id;

    // Re-push with different slices (different body identity).
    await handler({
      source_ref: "docs/repush.md",
      content: "gamma delta epsilon",
      chunks: [
        { content: "gamma", index: 0 },
        { content: "delta", index: 1 },
        { content: "epsilon", index: 2 },
      ],
    });

    const secondDoc = await deps.storage.getSourceDoc("docs/repush.md");
    expect(secondDoc.ok).toBe(true);
    if (!secondDoc.ok) throw new Error("expected source doc");
    expect(secondDoc.value.id).toBe(firstId);
    expect(secondDoc.value.content).toBe("gamma delta epsilon");

    const chunks = await deps.storage.listChunksBySourceDoc(firstId);
    expect(chunks).toHaveLength(3);
    expect(chunks.map((c) => c.content)).toEqual(["gamma", "delta", "epsilon"]);
    expect(chunks.map((c) => c.ordinal)).toEqual([0, 1, 2]);
  });

  it("idempotent re-push returns the same chunk ids and grows no rows", async () => {
    const deps = makeDeps();
    const handler = createIngestHandler(deps);
    const body = "alpha beta";
    const slices = [
      { content: "alpha", index: 0 },
      { content: "beta", index: 1 },
    ];

    const r1 = await handler({
      source_ref: "docs/idem.md",
      content: body,
      chunks: slices,
    });
    const r2 = await handler({
      source_ref: "docs/idem.md",
      content: body,
      chunks: slices,
    });
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
});

describe("createIngestHandler — 资料 status (corpus-ready retrieve T3)", () => {
  it("lands 就绪 once the chunk rows are durable", async () => {
    // docs/CONTEXT.md 资料集合: "Ready means status ready and chunk count ≥ 1",
    // and ingest is a documented way into the 资料集合. A 资料 written here
    // must therefore be able to reach 就绪 — leaving it at 进行中 with
    // count ≥ 1 makes the page's own definition unreachable on this path.
    const deps = makeDeps();
    const handler = createIngestHandler(deps);
    await handler({
      source_ref: "docs/ingest-ready.md",
      content: "hello world",
      chunks: [{ content: "hello world", index: 0 }],
    });

    const read = await deps.storage.getSourceDoc("docs/ingest-ready.md");
    if (!read.ok) throw new Error("expected source doc");
    expect(read.value.status).toBe("ready");
    expect(read.value.failure_code).toBeNull();
    expect(read.value.chunk_count).toBe(1);
  });

  it("leaves a re-ingest of the same locator 就绪, not 进行中", async () => {
    const deps = makeDeps();
    const handler = createIngestHandler(deps);
    const envelope = {
      source_ref: "docs/ingest-twice.md",
      content: "first body",
      chunks: [{ content: "first body", index: 0 }],
    };
    await handler(envelope);
    await handler({
      source_ref: "docs/ingest-twice.md",
      content: "second body",
      chunks: [{ content: "second body", index: 0 }],
    });

    const read = await deps.storage.getSourceDoc("docs/ingest-twice.md");
    if (!read.ok) throw new Error("expected source doc");
    expect(read.value.status).toBe("ready");
    expect(read.value.chunk_count).toBe(1);
  });

  it("does not clear 失败 on a later push of a DIFFERENT 资料", async () => {
    // 就绪 is per 资料: marking one ready must not touch a sibling's status.
    const deps = makeDeps();
    const handler = createIngestHandler(deps);
    await handler({
      source_ref: "docs/ingest-a.md",
      content: "a body",
      chunks: [{ content: "a body", index: 0 }],
    });
    await deps.storage.recordSourceDocFailure(
      "docs/ingest-a.md",
      "INVALID_INPUT"
    );
    await handler({
      source_ref: "docs/ingest-b.md",
      content: "b body",
      chunks: [{ content: "b body", index: 0 }],
    });

    const a = await deps.storage.getSourceDoc("docs/ingest-a.md");
    if (!a.ok) throw new Error("expected source doc");
    expect(a.value.status).toBe("failed");
    const b = await deps.storage.getSourceDoc("docs/ingest-b.md");
    if (!b.ok) throw new Error("expected source doc");
    expect(b.value.status).toBe("ready");
  });
});

describe("MemoryBackend — source-doc seam", () => {
  it("upsertSourceDoc keyed by source_ref returns the same id for the same locator", async () => {
    const backend = new MemoryBackend(TEST_DIM);
    const doc1 = await backend.upsertSourceDoc({
      id: "00000000-0000-0000-0000-000000000001",
      source_ref: "docs/one.md",
      title: null,
      content: "first",
      created_at: "2024-01-01T00:00:00.000Z",
    });
    const doc2 = await backend.upsertSourceDoc({
      id: "00000000-0000-0000-0000-000000000001",
      source_ref: "docs/one.md",
      title: "renamed",
      content: "second",
      created_at: "2024-02-01T00:00:00.000Z",
    });
    expect(doc2.id).toBe(doc1.id);
    expect(doc2.content).toBe("second");
  });

  it("getSourceDoc returns NOT_FOUND for an unknown locator", async () => {
    const backend = new MemoryBackend(TEST_DIM);
    const r: StorageReadResult<StorageSourceDocView> =
      await backend.getSourceDoc("docs/nope.md");
    expect(r).toEqual({ ok: false, code: "NOT_FOUND" });
  });
});

/**
 * One 资料 resolves to exactly one CURRENT content_identity, whichever writer
 * touched the row last. `ingest` therefore declares the same body-level value
 * `push` declares: a write that omitted it would blank the identity a previous
 * push stored, and every later index-job submit for that source would come
 * back as an identity mismatch. The identity is read back through the storage
 * read port, never from a spy of the write call.
 */
describe("createIngestHandler — document content_identity", () => {
  function pushItem(content: string, sourceRef: string) {
    return {
      content,
      source_ref: sourceRef,
      metadata: { kind: "test" },
      valid_from: "2024-01-01T00:00:00Z",
      valid_until: "2024-12-31T00:00:00Z",
    };
  }

  async function storedDoc(
    storage: MemoryBackend,
    sourceRef: string
  ): Promise<StorageSourceDocView> {
    const read = await storage.getSourceDoc(sourceRef);
    if (!read.ok) {
      throw new Error(`expected a 资料 row for ${sourceRef}`);
    }
    return read.value;
  }

  it("declares the body-level identity computed with the DEFAULT versions", async () => {
    const deps = makeDeps();
    const body = "the whole 资料 body ingested verbatim";
    const handler = createIngestHandler(deps);
    await handler({
      source_ref: "docs/identity.md",
      content: body,
      chunks: [{ content: body, index: 0 }],
    });

    const doc = await storedDoc(deps.storage, "docs/identity.md");
    expect(doc.content_identity).toBe(computeContentIdentity(body));
  });

  it("a caller-side version override does not move the document identity", async () => {
    const body = "overridden versions body";
    const deps = {
      ...makeDeps(),
      identityVersions: { normalizationRuleVersion: "normalization-v9" },
    };
    const handler = createIngestHandler(deps);
    await handler({
      source_ref: "docs/override.md",
      content: body,
      chunks: [{ content: body, index: 0 }],
    });

    // The pair half must stay reproducible by the other writer, so it ignores
    // the per-slice overrides entirely.
    expect(
      (await storedDoc(deps.storage, "docs/override.md")).content_identity
    ).toBe(computeContentIdentity(body));
  });

  it("publishes the identity it stored, so a Host can form the submit pair", async () => {
    const deps = makeDeps();
    const body = "published identity";
    const handler = createIngestHandler(deps);
    const result = await handler({
      source_ref: "docs/published.md",
      content: body,
      chunks: [{ content: body, index: 0 }],
    });
    const body1 = JSON.parse(result.content[0]!.text!) as {
      source_doc_id: string;
      content_identity: string;
    };
    expect(body1.content_identity).toBe(computeContentIdentity(body));
    expect(
      (await storedDoc(deps.storage, "docs/published.md")).content_identity
    ).toBe(body1.content_identity);
  });

  it("push then ingest-upsert of the same body leaves the pair unchanged", async () => {
    const deps = makeDeps();
    const body = "shared across both writers";
    const pushed = await createPushHandler({
      embedder: new FakeEmbedder(TEST_DIM),
      storage: deps.storage,
    })({ items: [pushItem(body, "docs/cross-writer.md")] });
    const pushBody = JSON.parse(pushed.content[0]!.text!) as {
      content_identity: string;
    };

    const ingested = await createIngestHandler(deps)({
      source_ref: "docs/cross-writer.md",
      content: body,
      chunks: [{ content: body, index: 0 }],
    });
    const ingestBody = JSON.parse(ingested.content[0]!.text!) as {
      content_identity: string;
    };

    expect(ingestBody.content_identity).toBe(pushBody.content_identity);
    const doc = await storedDoc(deps.storage, "docs/cross-writer.md");
    expect(doc.content_identity).toBe(computeContentIdentity(body));
  });

  it("an ingest of a different body overwrites the pushed identity, never nulls it", async () => {
    const deps = makeDeps();
    const pushedBody = "version one from push";
    await createPushHandler({
      embedder: new FakeEmbedder(TEST_DIM),
      storage: deps.storage,
    })({ items: [pushItem(pushedBody, "docs/overwrite.md")] });

    const newBody = "version two from ingest";
    await createIngestHandler(deps)({
      source_ref: "docs/overwrite.md",
      content: newBody,
      chunks: [{ content: newBody, index: 0 }],
    });

    const doc = await storedDoc(deps.storage, "docs/overwrite.md");
    expect(doc.content_identity).not.toBeNull();
    expect(doc.content_identity).toBe(computeContentIdentity(newBody));
    expect(doc.content_identity).not.toBe(computeContentIdentity(pushedBody));
  });

  it("a legacy batch repeating one source_ref publishes the identity the row actually holds", async () => {
    const deps = makeDeps();
    const result = await createIngestHandler(deps)({
      source_ref: "docs/legacy-batch.md",
      content: ["first item", "second item"],
    });
    const body = JSON.parse(result.content[0]!.text!) as {
      source_doc_id?: string;
      content_identity?: string;
      source_doc_ids?: string[];
      content_identities?: string[];
    };
    // One locator, one row: both envelopes address the same 资料, so the
    // response carries ONE id and ONE identity — the last write, mirroring
    // the upsert. Per-envelope publication would name an identity no row
    // ever held.
    expect(body.source_doc_ids).toBeUndefined();
    expect(body.content_identities).toBeUndefined();
    expect(body.source_doc_id).toBe(computeSourceDocId("docs/legacy-batch.md"));
    expect(body.content_identity).toBe(computeContentIdentity("second item"));
    // Read the row back through the storage read port: what was published is
    // what is stored.
    const doc = await storedDoc(deps.storage, "docs/legacy-batch.md");
    expect(doc.content).toBe("second item");
    expect(doc.content_identity).toBe(body.content_identity);
  });

  it("a mixed legacy batch publishes one aligned entry per distinct source_ref", async () => {
    const deps = makeDeps();
    // Items 0 and 1 inherit the top-level locator (one 资料, last write
    // wins); the object item names its own 资料.
    const result = await createIngestHandler(deps)({
      source_ref: "docs/mixed-a.md",
      content: [
        "a first slice",
        "a final slice",
        { content: "own row body", source_ref: "docs/mixed-b.md" },
      ],
    });
    const body = JSON.parse(result.content[0]!.text!) as {
      source_doc_ids: string[];
      content_identities: string[];
    };
    expect(body.source_doc_ids).toEqual([
      computeSourceDocId("docs/mixed-a.md"),
      computeSourceDocId("docs/mixed-b.md"),
    ]);
    expect(body.content_identities).toEqual([
      computeContentIdentity("a final slice"),
      computeContentIdentity("own row body"),
    ]);
    // Every published pair equals the stored row for that source_ref, in the
    // published order — the arrays are aligned, not merely equal in length.
    const storedA = await storedDoc(deps.storage, "docs/mixed-a.md");
    const storedB = await storedDoc(deps.storage, "docs/mixed-b.md");
    expect([storedA.content_identity, storedB.content_identity]).toEqual(
      body.content_identities
    );
  });
});
