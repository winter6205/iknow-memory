/**
 * T3 regression — one `items[]` batch must not carry the same `source_ref`
 * twice.
 *
 * A 资料 is keyed by `source_ref` (`source_documents.source_ref` is UNIQUE)
 * and the rebuild-on-repush contract is per-`source_ref`: the write path
 * deletes the 资料's previous chunk rows before inserting the new set. Two
 * envelopes for the SAME 资料 in ONE batch is therefore a contradictory
 * input — envelope B's rebuild sweep deletes the rows envelope A just
 * inserted, while the handler's `chunk_ids` response still lists A's ids
 * (and the ES mirror still indexes them).
 *
 * The observed failure mode is a SILENT false success: 2 ids returned,
 * 1 row persisted. fin's `_chunk_ids_of` length check passes (it only
 * counts), so the loss is invisible across the wire and the `chunk_ids`
 * contract in specs/mcp-tool-surface.md ("Response: chunk_ids plus
 * source_doc_id …") is violated.
 *
 * Fail-closed is the chosen fix: refuse the batch by name before any write.
 * Silently de-duplicating or letting the last envelope win would both make
 * the returned `chunk_ids` a lie about rows that never persisted. The
 * cross-backend assertion below is written to hold for EITHER fix shape —
 * refuse (preferred) or hoist — so it fails any implementation whose
 * response names rows it did not persist.
 */
import { describe, expect, it } from "vitest";

import {
  PushInputSchema,
  createPushHandler,
  type PushDeps,
} from "../../src/tools/push.js";
import { FakeEmbedder } from "../../src/core/embedder.js";
import { MemoryBackend } from "../../src/core/storage/memory-backend.js";
import type { StorageBackend } from "../../src/core/types.js";
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
  } as Record<string, unknown>;
}

function parseBody(result: ToolResult): Record<string, unknown> {
  const text = result.content[0]?.text;
  if (typeof text !== "string") {
    throw new Error("expected text content in ToolResult");
  }
  return JSON.parse(text) as Record<string, unknown>;
}

/**
 * The invariant the High finding is about, checked against whatever the tool
 * answered:
 *
 *  - refused → NOTHING may be persisted under that ref;
 *  - answered → every returned `chunk_id` must resolve to a row that is
 *    actually retrievable, and every persisted row (for the returned
 *    `source_doc_id`) must appear in the response.
 *
 * A response that names a row the store does not hold fails here, which is
 * exactly the e67f46a behaviour (2 ids returned, 1 row persisted).
 */
async function expectReturnedIdsMatchPersisted(
  storage: StorageBackend,
  sourceRef: string,
  outcome: { refused: true } | { refused: false; ids: string[] }
): Promise<void> {
  const doc = await storage.getSourceDoc(sourceRef);
  if (outcome.refused) {
    expect(
      doc,
      "batch was refused, so no 资料 row may exist under that source_ref"
    ).toEqual({ ok: false, code: "NOT_FOUND" });
    return;
  }
  if (!doc.ok) throw new Error("expected source doc");
  const persisted = await storage.listChunksBySourceDoc(doc.value.id);
  const persistedIds = persisted.map((c) => c.id).sort();
  expect(
    [...outcome.ids].sort(),
    "returned chunk_ids must name exactly the rows that persisted"
  ).toEqual(persistedIds);
}

describe("push — duplicate source_ref inside ONE items[] batch", () => {
  it("rejects the batch at the schema boundary, naming the repeated source_ref", () => {
    const result = PushInputSchema.safeParse({
      items: [
        finItem("SAME-REF", "alpha body text", [
          { index: 0, content: "alpha body text" },
        ]),
        finItem("SAME-REF", "beta body text", [
          { index: 0, content: "beta body text" },
        ]),
      ],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const message = result.error.issues.map((i) => i.message).join("\n");
    expect(message).toContain("source_ref");
    expect(message).toContain("SAME-REF");
    expect(message).toContain("items[1]");
    expect(message).toContain("items[0]");
  });

  it("rejects at the handler boundary and persists NOTHING", async () => {
    const deps = makeDeps();
    const handler = createPushHandler(deps);
    const outcome = await handler({
      items: [
        finItem("docs/dup.md", "alpha body text", [
          { index: 0, content: "alpha body text" },
        ]),
        finItem("docs/dup.md", "beta body text", [
          { index: 0, content: "beta body text" },
        ]),
      ],
    })
      .then((result) => ({ refused: false as const, result }))
      .catch(() => ({ refused: true as const }));

    // The preferred fix is a refusal; if a future implementation instead
    // hoists the sweep, the correspondence assertion below still polices it.
    expect(outcome.refused).toBe(true);
    await expectReturnedIdsMatchPersisted(deps.storage, "docs/dup.md", {
      refused: true,
    });
    const page = await deps.storage.listSourceDocs();
    expect(page.total).toBe(0);
  });

  it("no returned chunk_id is a lie: ids match the persisted rows", async () => {
    // Against e67f46a this is the failing assertion: the tool answered with
    // 2 ids while only the SECOND envelope's row survived.
    const deps = makeDeps();
    const handler = createPushHandler(deps);
    const outcome = await handler({
      items: [
        finItem("SAME-REF", "alpha body text", [
          { index: 0, content: "alpha body text" },
        ]),
        finItem("SAME-REF", "beta body text", [
          { index: 0, content: "beta body text" },
        ]),
      ],
    })
      .then((result) => ({
        refused: false as const,
        ids: parseBody(result).chunk_ids as string[],
      }))
      .catch(() => ({ refused: true as const }));

    await expectReturnedIdsMatchPersisted(deps.storage, "SAME-REF", outcome);
  });

  it("refuses even when the duplicate is three items deep", async () => {
    const deps = makeDeps();
    const handler = createPushHandler(deps);
    await expect(
      handler({
        items: [
          finItem("a.md", "alpha body text", [
            { index: 0, content: "alpha body text" },
          ]),
          finItem("b.md", "beta body text", [
            { index: 0, content: "beta body text" },
          ]),
          finItem("a.md", "gamma body text", [
            { index: 0, content: "gamma body text" },
          ]),
        ],
      })
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });

    // The third item repeats the FIRST: the message must name both positions.
    await expect(
      handler({
        items: [
          finItem("a.md", "alpha body text", [
            { index: 0, content: "alpha body text" },
          ]),
          finItem("b.md", "beta body text", [
            { index: 0, content: "beta body text" },
          ]),
          finItem("a.md", "gamma body text", [
            { index: 0, content: "gamma body text" },
          ]),
        ],
      })
    ).rejects.toThrow(/items\[2\].*items\[0\]/s);

    // The refusal is batch-wide: neither the unique sibling nor the
    // duplicated 资料 may be written.
    for (const ref of ["a.md", "b.md"]) {
      await expectReturnedIdsMatchPersisted(deps.storage, ref, {
        refused: true,
      });
    }
  });

  it("accepts the same source_ref again in a LATER call (rebuild-on-repush)", async () => {
    // The refusal is scoped to ONE batch: a re-push of the same 资料 in a
    // separate call is the documented rebuild path and must keep working.
    const deps = makeDeps();
    const handler = createPushHandler(deps);
    const first = await handler({
      items: [
        finItem("docs/repush.md", "alpha body text", [
          { index: 0, content: "alpha body text" },
        ]),
      ],
    });
    await expectReturnedIdsMatchPersisted(deps.storage, "docs/repush.md", {
      refused: false,
      ids: parseBody(first).chunk_ids as string[],
    });

    const second = await handler({
      items: [
        finItem("docs/repush.md", "beta body text", [
          { index: 0, content: "beta body text" },
        ]),
      ],
    });
    const ids = parseBody(second).chunk_ids as string[];

    const doc = await deps.storage.getSourceDoc("docs/repush.md");
    if (!doc.ok) throw new Error("expected source doc");
    const chunks = await deps.storage.listChunksBySourceDoc(doc.value.id);
    expect(chunks.map((c) => c.id)).toEqual(ids);
    expect(chunks.map((c) => c.content)).toEqual(["beta body text"]);
  });
});
