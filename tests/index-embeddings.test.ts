/**
 * T6 acceptance — the THREE index embedding classes
 * (specs/graph-index-standard-fast.md assumption 11; fin ADR 0058).
 *
 * With a Fake/recording embedder, each class is embedded AT INDEX TIME and
 * the query is never the first embed of that text:
 *
 *   1. window/slice text — every pushed slice is embedded verbatim (one
 *      batch) by the push handler before any chunk row exists; this repo
 *      never re-chunks (ADR-0004), so the pushed slice IS the class.
 *   2. entity description (standard only) — re-embedded after the T3
 *      describe UPDATE; unit-level composition and the sealed-skip failure
 *      classes live in tests/extraction/enrich.test.ts and the transaction
 *      seam in tests/extraction/pipeline.test.ts.
 *   3. community summary text — embedded inside the T5 all-or-nothing
 *      rebuild; composition and failure classes are pinned in
 *      tests/cli/community-summary.unit.test.ts.
 *
 * This file proves class 1 end-to-end at its own seam plus the shared
 * "the stored vector predates any query" witness for classes 1–3.
 */
import { describe, expect, it } from "vitest";

import {
  PushInputSchema,
  createPushHandler,
  type PushDeps,
} from "../src/tools/push.js";
import { FakeEmbedder, type EmbeddingClient } from "../src/core/embedder.js";
import { MemoryBackend } from "../src/core/storage/memory-backend.js";

const TEST_DIM = 32;
const VALID_AT = "2024-06-01T00:00:00.000Z";

/** Records every batch handed to the embedder; delegates vectors. */
class RecordingEmbedder {
  readonly available = true;
  calls: string[][] = [];
  private readonly fake = new FakeEmbedder(TEST_DIM);

  async embed(texts: string[]): Promise<number[][]> {
    this.calls.push([...texts]);
    return this.fake.embed(texts);
  }
}

function makeDeps(embedder: EmbeddingClient): PushDeps {
  return { embedder, storage: new MemoryBackend(TEST_DIM) };
}

function envelope(slices: Array<{ content: string; index: number }>) {
  return {
    source_ref: "docs/window.md",
    content: "alpha beta gamma delta",
    chunks: slices,
    metadata: { kind: "doc" },
    valid_from: "2024-01-01T00:00:00.000Z",
    valid_until: "2024-12-31T00:00:00.000Z",
  };
}

describe("class 1 — pushed window/slice text embeds at push time", () => {
  it("embeds each slice's text verbatim, once, in one batch", async () => {
    const embedder = new RecordingEmbedder();
    const deps = makeDeps(embedder);
    const handler = createPushHandler(deps);

    await handler(
      envelope([
        { content: "alpha beta", index: 0 },
        { content: "gamma delta", index: 1 },
      ])
    );

    // Exact composition: the slice content itself — no decorations, no
    // second cut, and never an empty text (push refuses empty slices).
    expect(embedder.calls).toEqual([["alpha beta", "gamma delta"]]);
  });

  it("single-slice boundary: the body equals the slice and embeds once", async () => {
    const embedder = new RecordingEmbedder();
    const handler = createPushHandler(makeDeps(embedder));

    await handler(envelope([{ content: "alpha beta gamma delta", index: 0 }]));

    expect(embedder.calls).toEqual([["alpha beta gamma delta"]]);
  });

  it("an empty slice text is refused at the schema boundary, before any embed", () => {
    const result = PushInputSchema.safeParse(
      envelope([{ content: "", index: 0 }])
    );
    expect(result.success).toBe(false);
  });

  it("the stored chunk vector predates any query: search needs no embed call", async () => {
    const embedder = new RecordingEmbedder();
    const deps = makeDeps(embedder);
    const handler = createPushHandler(deps);
    await handler(
      envelope([
        { content: "alpha beta", index: 0 },
        { content: "gamma delta", index: 1 },
      ])
    );
    // Reset the recorder: a later query-side lookup by vector must not
    // re-embed (or first-embed) the slice class.
    embedder.calls = [];

    const [sliceVector] = await new FakeEmbedder(TEST_DIM).embed([
      "gamma delta",
    ]);
    const hits = await deps.storage.search(sliceVector!, {
      limit: 1,
      validAt: VALID_AT,
    });

    expect(hits).toHaveLength(1);
    expect(hits[0]?.content).toBe("gamma delta");
    expect(embedder.calls).toEqual([]);
  });
});
