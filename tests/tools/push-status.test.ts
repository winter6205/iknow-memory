/**
 * T3 (corpus-ready retrieve) — push persists 就绪 / 失败 on the 资料.
 *
 * Status is persisted, not inferred: a push that lands chunks records
 * 就绪; a push that throws records 失败 with the stable error code on the
 * 资料 it was pushing. A failure for a locator the store has never seen
 * must NOT invent a 资料 row — the 资料页 only shows 失败 for documents it
 * can actually show.
 */
import { describe, expect, it } from "vitest";

import { createPushHandler, type PushDeps } from "../../src/tools/push.js";
import { createRetrieveHandler } from "../../src/tools/retrieve.js";
import { FakeEmbedder } from "../../src/core/embedder.js";
import { MemoryBackend } from "../../src/core/storage/memory-backend.js";
import { SOURCE_DOC_STATUS } from "../../src/core/types.js";
import type { ToolResult } from "../../src/tools/registry.js";

const TEST_DIM = 32;

function makeDeps(): PushDeps & {
  storage: MemoryBackend;
  embedder: FakeEmbedder;
} {
  return {
    embedder: new FakeEmbedder(TEST_DIM),
    storage: new MemoryBackend(TEST_DIM),
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
    metadata: { fmt: "md", doc_type: "spec" },
    valid_from: "2024-01-01T00:00:00.000Z",
    valid_until: "9999-12-31T23:59:59.999Z",
  };
}

function parseBody(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text!) as Record<string, unknown>;
}

describe("push persists 资料 status (corpus-ready retrieve T3)", () => {
  it("a successful multi-slice push lands 就绪 with the derived count", async () => {
    const deps = makeDeps();
    const handler = createPushHandler(deps);
    await handler({
      items: [
        finItem("docs/ready.md", "alpha middle omega", [
          { index: 0, content: "alpha" },
          { index: 1, content: "middle" },
          { index: 2, content: "omega" },
        ]),
      ],
    });

    const read = await deps.storage.getSourceDoc("docs/ready.md");
    if (!read.ok) throw new Error("expected source doc");
    expect(read.value.status).toBe(SOURCE_DOC_STATUS.READY);
    expect(read.value.failure_code).toBeNull();
    expect(read.value.chunk_count).toBe(3);
  });

  it("a push rejected at validation never becomes 就绪 and names 失败 once the 资料 exists", async () => {
    const deps = makeDeps();
    const handler = createPushHandler(deps);

    // First a healthy push, so the 资料 row exists.
    await handler({
      items: [
        finItem("docs/later-bad.md", "good body", [
          { index: 0, content: "good body" },
        ]),
      ],
    });
    const before = await deps.storage.getSourceDoc("docs/later-bad.md");
    if (!before.ok) throw new Error("expected source doc");
    expect(before.value.status).toBe(SOURCE_DOC_STATUS.READY);

    // Now a push with a window inversion for the SAME 资料: validation
    // throws before any write, and the failure must be recorded.
    const bad = finItem("docs/later-bad.md", "body", [
      { index: 0, content: "body" },
    ]);
    bad.valid_from = "2024-12-31T00:00:00.000Z";
    bad.valid_until = "2024-01-01T00:00:00.000Z";
    await expect(handler({ items: [bad] })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });

    const after = await deps.storage.getSourceDoc("docs/later-bad.md");
    if (!after.ok) throw new Error("expected source doc");
    expect(after.value.status).toBe(SOURCE_DOC_STATUS.FAILED);
    expect(after.value.failure_code).toBe("INVALID_INPUT");
    // The failure does not touch the successful chunks already stored.
    expect(after.value.chunk_count).toBe(1);
  });

  it("a failed push for an UNKNOWN source_ref invents no 资料 row", async () => {
    const deps = makeDeps();
    const handler = createPushHandler(deps);
    const bad = finItem("docs/never-seen.md", "body", [
      { index: 0, content: "body" },
    ]);
    bad.valid_from = "2024-12-31T00:00:00.000Z";
    bad.valid_until = "2024-01-01T00:00:00.000Z";
    await expect(handler({ items: [bad] })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });

    const read = await deps.storage.getSourceDoc("docs/never-seen.md");
    expect(read).toEqual({ ok: false, code: "NOT_FOUND" });
    const page = await deps.storage.listSourceDocs();
    expect(page.total).toBe(0);
  });

  it("an embedder outage records 失败 with the embedding code", async () => {
    const deps = makeDeps();
    const handler = createPushHandler(deps);
    await handler({
      items: [
        finItem("docs/embed.md", "first body", [
          { index: 0, content: "first body" },
        ]),
      ],
    });

    const failing = createPushHandler({
      ...deps,
      embedder: new (class {
        async embed(): Promise<number[][]> {
          throw new Error("provider down");
        }
      })() as unknown as PushDeps["embedder"],
    });
    await expect(
      failing({
        items: [
          finItem("docs/embed.md", "second body", [
            { index: 0, content: "second body" },
          ]),
        ],
      })
    ).rejects.toBeInstanceOf(Error);

    const read = await deps.storage.getSourceDoc("docs/embed.md");
    if (!read.ok) throw new Error("expected source doc");
    expect(read.value.status).toBe(SOURCE_DOC_STATUS.FAILED);
    expect(read.value.failure_code).toBe("STORAGE_ERROR");
  });

  it("a re-push after a failure returns the 资料 to 就绪", async () => {
    const deps = makeDeps();
    const handler = createPushHandler(deps);
    const bad = finItem("docs/retry.md", "body", [
      { index: 0, content: "body" },
    ]);
    bad.valid_from = "2024-12-31T00:00:00.000Z";
    bad.valid_until = "2024-01-01T00:00:00.000Z";
    await expect(handler({ items: [bad] })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });

    await handler({
      items: [
        finItem("docs/retry.md", "body", [{ index: 0, content: "body" }]),
      ],
    });
    const read = await deps.storage.getSourceDoc("docs/retry.md");
    if (!read.ok) throw new Error("expected source doc");
    expect(read.value.status).toBe(SOURCE_DOC_STATUS.READY);
    expect(read.value.failure_code).toBeNull();
    expect(read.value.chunk_count).toBe(1);
  });
});

describe("push failure attribution is per 资料, not per batch (corpus-ready retrieve T3)", () => {
  /**
   * Wrap a MemoryBackend so the Nth `upsert` call throws. With per-envelope
   * chunk writes this fails exactly one 资料; with a single batch-wide write
   * it fails the whole batch — which is the behaviour these tests pin.
   */
  function failingNthUpsert(
    storage: MemoryBackend,
    failOnCall: number
  ): { storage: MemoryBackend; calls: () => number } {
    const real = storage.upsert.bind(storage);
    let calls = 0;
    (storage as unknown as { upsert: unknown }).upsert = async (
      records: never
    ) => {
      calls += 1;
      if (calls === failOnCall) throw new Error("chunk upsert outage");
      return real(records);
    };
    return { storage, calls: () => calls };
  }

  it("an envelope whose own write landed stays 就绪 when a sibling's write fails", async () => {
    // A batch is a convenience, not a transaction: A's rows are durable, so
    // stamping A 失败 would name a failure that never happened to A.
    const deps = makeDeps();
    const handler = createPushHandler(deps);
    await handler({
      items: [
        finItem("docs/sibling-a.md", "alpha", [{ index: 0, content: "alpha" }]),
      ],
    });

    const { calls } = failingNthUpsert(deps.storage, 2);
    await expect(
      handler({
        items: [
          finItem("docs/sibling-a.md", "beta", [
            { index: 0, content: "beta" },
          ]),
          finItem("docs/sibling-b.md", "gamma", [
            { index: 0, content: "gamma" },
          ]),
        ],
      })
    ).rejects.toBeInstanceOf(Error);
    expect(calls()).toBe(2);

    const a = await deps.storage.getSourceDoc("docs/sibling-a.md");
    if (!a.ok) throw new Error("expected source doc");
    expect(a.value.status).toBe(SOURCE_DOC_STATUS.READY);
    expect(a.value.failure_code).toBeNull();
    expect(a.value.chunk_count).toBe(1);

    const b = await deps.storage.getSourceDoc("docs/sibling-b.md");
    if (!b.ok) throw new Error("expected source doc");
    expect(b.value.status).toBe(SOURCE_DOC_STATUS.FAILED);
    expect(b.value.failure_code).toBe("STORAGE_ERROR");
  });

  it("an envelope that landed before an embed-stage refusal is not stamped 就绪", async () => {
    // The embed stage runs BEFORE any write, so its failure legitimately
    // covers the whole batch: no 资料 was written and each is named 失败.
    const deps = makeDeps();
    const handler = createPushHandler(deps);
    const failing = createPushHandler({
      ...deps,
      embedder: new (class {
        async embed(): Promise<number[][]> {
          throw new Error("provider down");
        }
      })() as unknown as PushDeps["embedder"],
    });
    await handler({
      items: [
        finItem("docs/embed-a.md", "seed", [{ index: 0, content: "seed" }]),
        finItem("docs/embed-b.md", "seed", [{ index: 0, content: "seed" }]),
      ],
    });

    await expect(
      failing({
        items: [
          finItem("docs/embed-a.md", "next a", [
            { index: 0, content: "next a" },
          ]),
          finItem("docs/embed-b.md", "next b", [
            { index: 0, content: "next b" },
          ]),
        ],
      })
    ).rejects.toBeInstanceOf(Error);

    for (const ref of ["docs/embed-a.md", "docs/embed-b.md"]) {
      const read = await deps.storage.getSourceDoc(ref);
      if (!read.ok) throw new Error("expected source doc");
      expect(read.value.status).toBe(SOURCE_DOC_STATUS.FAILED);
      expect(read.value.failure_code).toBe("STORAGE_ERROR");
      // The embed stage wrote nothing, so the earlier chunks survive.
      expect(read.value.chunk_count).toBe(1);
    }
  });

  it("names ONLY the envelope whose validation threw", async () => {
    // The validation stage walks the batch in order; the cursor must name
    // the envelope that actually failed, not every 资料 in the batch.
    const deps = makeDeps();
    const handler = createPushHandler(deps);
    await handler({
      items: [
        finItem("docs/val-a.md", "a", [{ index: 0, content: "a" }]),
        finItem("docs/val-b.md", "b", [{ index: 0, content: "b" }]),
        finItem("docs/val-c.md", "c", [{ index: 0, content: "c" }]),
      ],
    });

    const bad = finItem("docs/val-b.md", "b", [{ index: 0, content: "b" }]);
    bad.valid_from = "2024-12-31T00:00:00.000Z";
    bad.valid_until = "2024-01-01T00:00:00.000Z";
    await expect(
      handler({
        items: [
          finItem("docs/val-a.md", "a", [{ index: 0, content: "a" }]),
          bad,
          finItem("docs/val-c.md", "c", [{ index: 0, content: "c" }]),
        ],
      })
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });

    const statuses: Record<string, string | undefined> = {};
    for (const ref of ["docs/val-a.md", "docs/val-b.md", "docs/val-c.md"]) {
      const read = await deps.storage.getSourceDoc(ref);
      if (!read.ok) throw new Error("expected source doc");
      statuses[ref] = read.value.status;
    }
    expect(statuses).toEqual({
      "docs/val-a.md": SOURCE_DOC_STATUS.READY,
      "docs/val-b.md": SOURCE_DOC_STATUS.FAILED,
      "docs/val-c.md": SOURCE_DOC_STATUS.READY,
    });
  });
});

describe("push status does not disturb retrieve (corpus-ready retrieve T3)", () => {
  it("retrieve returns only the successful chunks of a 失败 资料", async () => {
    const deps = makeDeps();
    const handler = createPushHandler(deps);
    await handler({
      items: [
        finItem("docs/mixed.md", "alpha beta", [
          { index: 0, content: "alpha" },
          { index: 1, content: "beta" },
        ]),
      ],
    });
    const bad = finItem("docs/mixed.md", "gamma", [
      { index: 0, content: "gamma" },
    ]);
    bad.valid_from = "2024-12-31T00:00:00.000Z";
    bad.valid_until = "2024-01-01T00:00:00.000Z";
    await expect(handler({ items: [bad] })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });

    const retrieve = createRetrieveHandler({
      embedder: deps.embedder,
      storage: deps.storage,
    });
    const result = await retrieve({ query: "alpha" });
    const body = parseBody(result) as { chunks: Array<{ content: string }> };
    expect(body.chunks.map((c) => c.content)).toEqual(["alpha", "beta"]);
  });
});
